/**
 * Load behaviour resolution.
 *
 * This is the product's central claim under test: the same `torch.load(path)`
 * is arbitrary code execution or a restricted unpickler depending on a number
 * in a requirements file, and where the requirements file does not settle it,
 * the answer is UNKNOWN rather than a guess in either direction.
 */

import { describe, expect, it } from 'vitest'

import { mostExposed, resolveBehaviour } from './behaviour.ts'
import { parseConstraint, parseVersion, compareVersions } from './deps.ts'
import { scanPython } from './scan.ts'
import type { Artifact, BehaviourVerdict, ResolvedDependency } from './types.ts'

function deps(...specs: Array<[string, string]>): ResolvedDependency[] {
  return specs.map(([name, constraint]) => {
    const parsed = parseConstraint(constraint)
    return { name, version: parsed.version, pin: parsed.pin, source: 'requirements.txt', constraint }
  })
}

function verdictFor(
  source: string,
  dependencies: ResolvedDependency[],
  artifact: Artifact | null = null,
): BehaviourVerdict {
  const call = scanPython('a.py', source).calls[0]
  if (call === undefined) throw new Error(`no load site found in:\n${source}`)
  return resolveBehaviour({ call, artifact, deps: dependencies })
}

function checkpoint(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'weights/m.pt',
    name: 'm.pt',
    locator: 'weights/m.pt',
    origin: 'in-tree',
    format: { format: 'pytorch-zip', basis: 'container', note: 'zip with data.pkl' },
    sizeBytes: 1024,
    digest: null,
    version: null,
    pickle: null,
    tensorHeader: null,
    siblings: [],
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */

describe('torch.load', () => {
  const call = 'import torch\ntorch.load("weights/m.pt")\n'

  it('is UNKNOWN when the torch pin spans the release that changed the default', () => {
    const verdict = verdictFor(call, deps(['torch', '>=2.0']))
    expect(verdict.behaviour).toBe('unknown')
    expect(verdict.unknownReason).toBe('loader-default-unpinned')
    expect(verdict.mechanism).toContain('2.6')
  })

  it('is UNKNOWN when torch is not declared at all', () => {
    expect(verdictFor(call, deps()).behaviour).toBe('unknown')
  })

  it('executes code when torch is pinned below 2.6', () => {
    const verdict = verdictFor(call, deps(['torch', '==2.5.1']))
    expect(verdict.behaviour).toBe('code')
    expect(verdict.steps.some((s) => s.claim.includes('pinned to 2.5.1'))).toBe(true)
  })

  it('is guarded when torch is pinned at or above 2.6', () => {
    const verdict = verdictFor(call, deps(['torch', '==2.6.0']))
    expect(verdict.behaviour).toBe('guarded')
    expect(verdict.guard?.ifRemoved).toBe('code')
  })

  it('is guarded when the floor alone settles the question', () => {
    expect(verdictFor(call, deps(['torch', '>=2.6'])).behaviour).toBe('guarded')
    expect(verdictFor(call, deps(['torch', '~=2.7.1'])).behaviour).toBe('guarded')
  })

  it('takes an explicit weights_only=True over any version reasoning', () => {
    const verdict = verdictFor(
      'import torch\ntorch.load("m.pt", weights_only=True)\n',
      deps(['torch', '==2.0.0']),
    )
    expect(verdict.behaviour).toBe('guarded')
    expect(verdict.guard?.expression).toBe('weights_only=True')
  })

  it('takes an explicit weights_only=False over any version reasoning', () => {
    const verdict = verdictFor(
      'import torch\ntorch.load("m.pt", weights_only=False)\n',
      deps(['torch', '==2.9.0']),
    )
    expect(verdict.behaviour).toBe('code')
  })

  it('treats a custom pickle_module as a bypass of the allowlist', () => {
    const verdict = verdictFor(
      'import torch, dill\ntorch.load("m.pt", pickle_module=dill)\n',
      deps(['torch', '==2.8.0']),
    )
    expect(verdict.behaviour).toBe('code')
    expect(verdict.mechanism).toContain('custom pickle module')
  })

  it('never calls a guarded load "data only"', () => {
    expect(verdictFor(call, deps(['torch', '==2.8.0'])).behaviour).not.toBe('data')
  })
})

describe('the pickle family', () => {
  it('executes code regardless of the file it is given', () => {
    for (const source of [
      'import pickle\npickle.load(open("m.safetensors", "rb"))\n',
      'import joblib\njoblib.load("m.joblib")\n',
      'import dill\ndill.load(open("m", "rb"))\n',
      'import cloudpickle\ncloudpickle.load(open("m", "rb"))\n',
      'import pandas\npandas.read_pickle("m.pkl")\n',
      'import marshal\nmarshal.load(open("m", "rb"))\n',
    ]) {
      expect(verdictFor(source, deps(['torch', '==2.9.0'])).behaviour).toBe('code')
    }
  })

  it('quotes the globals the opcode scan found, without letting them decide', () => {
    const verdict = verdictFor(
      'import pickle\npickle.load(open("weights/m.pt", "rb"))\n',
      deps(),
      checkpoint({
        pickle: {
          protocol: 4,
          globals: ['os.system'],
          invokesCallable: true,
          invokingOpcodes: ['REDUCE'],
          truncated: false,
        },
      }),
    )
    expect(verdict.behaviour).toBe('code')
    expect(verdict.steps.some((s) => s.claim.includes('os.system'))).toBe(true)
  })

  it('still says code when the stream names nothing notable', () => {
    const verdict = verdictFor(
      'import pickle\npickle.load(open("weights/m.pt", "rb"))\n',
      deps(),
      checkpoint({
        pickle: {
          protocol: 4,
          globals: [],
          invokesCallable: false,
          invokingOpcodes: [],
          truncated: false,
        },
      }),
    )
    expect(verdict.behaviour).toBe('code')
  })
})

describe('numpy.load', () => {
  it('executes code with allow_pickle=True', () => {
    expect(
      verdictFor('import numpy\nnumpy.load("f.npy", allow_pickle=True)\n', deps()).behaviour,
    ).toBe('code')
  })

  it('is data only without it', () => {
    expect(verdictFor('import numpy\nnumpy.load("f.npy")\n', deps()).behaviour).toBe('data')
  })

  it('records the explicit False as a guard', () => {
    const verdict = verdictFor('import numpy\nnumpy.load("f.npy", allow_pickle=False)\n', deps())
    expect(verdict.behaviour).toBe('data')
    expect(verdict.guard?.expression).toBe('allow_pickle=False')
  })
})

describe('keras.models.load_model', () => {
  const call = 'from keras.models import load_model\nload_model("m.h5")\n'

  it('executes code against a Keras 2 pin', () => {
    expect(verdictFor(call, deps(['keras', '==2.15.0'])).behaviour).toBe('code')
  })

  it('is guarded against a Keras 3 pin', () => {
    expect(verdictFor(call, deps(['keras', '==3.5.0'])).behaviour).toBe('guarded')
  })

  it('falls back to the tensorflow pin when keras is not declared', () => {
    expect(verdictFor(call, deps(['tensorflow', '==2.15.1'])).behaviour).toBe('code')
    expect(verdictFor(call, deps(['tensorflow', '==2.17.0'])).behaviour).toBe('guarded')
  })

  it('is UNKNOWN when neither is pinned', () => {
    const verdict = verdictFor(call, deps(['keras', '>=2.12']))
    expect(verdict.behaviour).toBe('unknown')
    expect(verdict.unknownReason).toBe('loader-default-unpinned')
  })

  it('takes an explicit safe_mode over the version', () => {
    expect(
      verdictFor(
        'from keras.models import load_model\nload_model("m.h5", safe_mode=False)\n',
        deps(['keras', '==3.5.0']),
      ).behaviour,
    ).toBe('code')
  })
})

describe('transformers.from_pretrained', () => {
  it('executes code with trust_remote_code=True', () => {
    const verdict = verdictFor(
      'from transformers import AutoModel\nAutoModel.from_pretrained("org/m", trust_remote_code=True)\n',
      deps(['transformers', '==4.44.2']),
    )
    expect(verdict.behaviour).toBe('code')
    expect(verdict.mechanism).toContain('repository')
  })

  it('is data only with use_safetensors=True', () => {
    expect(
      verdictFor(
        'from transformers import AutoModel\nAutoModel.from_pretrained("org/m", use_safetensors=True)\n',
        deps(['transformers', '==4.44.2']),
      ).behaviour,
    ).toBe('data')
  })

  it('is UNKNOWN for a bare remote reference, because it does not fetch', () => {
    const verdict = verdictFor(
      'from transformers import AutoModel\nAutoModel.from_pretrained("org/m")\n',
      deps(['transformers', '==4.44.2']),
    )
    expect(verdict.behaviour).toBe('unknown')
    expect(verdict.unknownReason).toBe('remote-contents-unresolvable')
    expect(verdict.steps.some((s) => s.basis === 'offline by design')).toBe(true)
  })

  it('uses the resolved local format when the reference is a file in the tree', () => {
    const verdict = verdictFor(
      'from transformers import AutoModel\nAutoModel.from_pretrained("models/e.safetensors")\n',
      deps(['transformers', '==4.44.2']),
      checkpoint({
        locator: 'models/e.safetensors',
        format: { format: 'safetensors', basis: 'magic', note: 'JSON header' },
      }),
    )
    expect(verdict.behaviour).toBe('data')
  })
})

describe('data-oriented loaders', () => {
  it('reports safetensors, ONNX and GGUF loads as data only', () => {
    expect(
      verdictFor('from safetensors.torch import load_file\nload_file("m.safetensors")\n', deps())
        .behaviour,
    ).toBe('data')
    expect(
      verdictFor('import onnxruntime\nonnxruntime.InferenceSession("m.onnx")\n', deps()).behaviour,
    ).toBe('data')
    expect(
      verdictFor('from llama_cpp import Llama\nLlama(model_path="m.gguf")\n', deps()).behaviour,
    ).toBe('data')
  })

  it('names the custom-operator caveat for ONNX rather than omitting it', () => {
    const verdict = verdictFor(
      'import onnxruntime\nonnxruntime.InferenceSession("m.onnx")\n',
      deps(),
    )
    expect(verdict.mechanism).toContain('custom operator')
  })

  it('refuses to report data only when the bytes contradict the loader', () => {
    const verdict = verdictFor(
      'import onnxruntime\nonnxruntime.InferenceSession("models/mislabelled.safetensors")\n',
      deps(),
      checkpoint({
        locator: 'models/mislabelled.safetensors',
        format: {
          format: 'pytorch-zip',
          basis: 'container',
          note: 'zip archive containing a data.pkl member',
        },
      }),
    )
    expect(verdict.behaviour).toBe('unknown')
    expect(verdict.unknownReason).toBe('format-undetermined')
  })
})

describe('ultralytics.YOLO', () => {
  it('says the flag is not the caller’s to set', () => {
    const verdict = verdictFor(
      'from ultralytics import YOLO\nYOLO("weights/y.pt")\n',
      deps(['torch', '==2.9.0'], ['ultralytics', '==8.3.0']),
    )
    expect(verdict.behaviour).toBe('code')
    expect(verdict.mechanism).toContain('inside the library')
  })
})

describe('mostExposed', () => {
  const at = (behaviour: BehaviourVerdict['behaviour']): BehaviourVerdict => ({
    behaviour,
    mechanism: '',
    steps: [],
    unknownReason: null,
    guard: null,
  })

  it('picks code over every other state', () => {
    expect(mostExposed([at('data'), at('guarded'), at('code')])?.behaviour).toBe('code')
  })

  it('picks unknown over guarded, because unresolved is not safe', () => {
    expect(mostExposed([at('guarded'), at('unknown')])?.behaviour).toBe('unknown')
  })

  it('returns null for no load sites at all', () => {
    expect(mostExposed([])).toBeNull()
  })
})

describe('version arithmetic', () => {
  it('treats 2.6 and 2.6.0 as equal', () => {
    expect(compareVersions(parseVersion('2.6') as number[], parseVersion('2.6.0') as number[])).toBe(
      0,
    )
  })

  it('orders release candidates by their release number', () => {
    expect(parseVersion('2.6.0rc1')).toEqual([2, 6, 0])
  })

  it('reads the pin kind from a constraint', () => {
    expect(parseConstraint('==2.5.1')).toEqual({ version: '2.5.1', pin: 'exact' })
    expect(parseConstraint('>=2.0')).toEqual({ version: '2.0', pin: 'range' })
    expect(parseConstraint('~=2.6.1')).toEqual({ version: '2.6.1', pin: 'range' })
    expect(parseConstraint('')).toEqual({ version: null, pin: 'unpinned' })
    expect(parseConstraint('*')).toEqual({ version: null, pin: 'unpinned' })
  })

  it('reads a floor out of a compound constraint', () => {
    expect(parseConstraint('>=2.6,<3.0').version).toBe('2.6')
  })

  it('does not read an upper bound as a version', () => {
    expect(parseConstraint('<3.0')).toEqual({ version: null, pin: 'unpinned' })
  })
})
