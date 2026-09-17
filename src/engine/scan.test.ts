/**
 * Source scanning.
 *
 * The masking tests are the load-bearing ones: a load site inside a comment
 * or a string is a false positive, and a false positive in a security tool is
 * how the tool stops being read.
 */

import { describe, expect, it } from 'vitest'

import { maskPython, matchBracket, splitArguments } from './mask.ts'
import { scanJs, scanPython } from './scan.ts'

function siteFor(source: string, loader: string) {
  return scanPython('a.py', source).calls.find((c) => c.loaderId === loader)
}

describe('scanPython: discovery', () => {
  it('resolves a fully qualified call', () => {
    const site = siteFor('import torch\ntorch.load("m.pt")\n', 'torch.load')
    expect(site?.line).toBe(2)
    expect(site?.targetLiteral).toBe('m.pt')
  })

  it('resolves a call through a module alias', () => {
    expect(siteFor('import torch as T\nT.load("m.pt")\n', 'torch.load')?.targetLiteral).toBe('m.pt')
  })

  it('resolves a call imported by name', () => {
    expect(siteFor('from torch import load\nload("m.pt")\n', 'torch.load')?.targetLiteral).toBe(
      'm.pt',
    )
  })

  it('resolves a call imported under a different name', () => {
    expect(
      siteFor('from torch import load as tload\ntload("m.pt")\n', 'torch.load')?.targetLiteral,
    ).toBe('m.pt')
  })

  it('does not confuse a same-named function from another module', () => {
    // `json.load` is not a loader rule, and must not match `torch.load`.
    expect(siteFor('import json\njson.load(handle)\n', 'torch.load')).toBeUndefined()
  })

  it('records the enclosing function', () => {
    const source = 'import torch\n\ndef load_scorer():\n    return torch.load("m.pt")\n'
    expect(siteFor(source, 'torch.load')?.enclosing).toBe('load_scorer')
  })

  it('records the enclosing method rather than the class', () => {
    const source =
      'import torch\n\nclass Scorer:\n    def build(self):\n        return torch.load("m.pt")\n'
    expect(siteFor(source, 'torch.load')?.enclosing).toBe('build')
  })
})

describe('scanPython: masking', () => {
  it('ignores a loader call inside a comment', () => {
    expect(scanPython('a.py', 'import torch\n# torch.load("m.pt")\n').calls).toHaveLength(0)
  })

  it('ignores a loader call inside a string literal', () => {
    expect(scanPython('a.py', 'import torch\nhelp = "torch.load(x)"\n').calls).toHaveLength(0)
  })

  it('ignores a loader call inside a docstring', () => {
    const source = 'import torch\ndef f():\n    """Calls torch.load(path) eventually."""\n    pass\n'
    expect(scanPython('a.py', source).calls).toHaveLength(0)
  })

  it('bounds the argument list correctly when an argument contains a paren', () => {
    const site = siteFor('import torch\ntorch.load("a)b.pt", weights_only=True)\n', 'torch.load')
    expect(site?.targetLiteral).toBe('a)b.pt')
    expect(site?.args.some((a) => a.keyword === 'weights_only' && a.literal === 'true')).toBe(true)
  })

  it('handles a call split across lines', () => {
    const source = 'import torch\ntorch.load(\n    "m.pt",\n    weights_only=True,\n)\n'
    const site = siteFor(source, 'torch.load')
    expect(site?.targetLiteral).toBe('m.pt')
    expect(site?.args.find((a) => a.keyword === 'weights_only')?.literal).toBe('true')
  })
})

describe('scanPython: target resolution', () => {
  const resolve = (source: string): string | null | undefined =>
    siteFor(`import torch\n${source}`, 'torch.load')?.targetLiteral

  it('follows a module constant', () => {
    expect(resolve('M = "weights/m.pt"\ntorch.load(M)\n')).toBe('weights/m.pt')
  })

  it('follows os.path.join of literals', () => {
    expect(resolve('import os\ntorch.load(os.path.join("weights", "m.pt"))\n')).toBe(
      'weights/m.pt',
    )
  })

  it('follows pathlib composition', () => {
    expect(
      resolve('from pathlib import Path\nD = Path("weights")\ntorch.load(D / "m.pt")\n'),
    ).toBe('weights/m.pt')
  })

  it('follows an f-string whose placeholders are resolvable', () => {
    expect(resolve('D = "weights"\ntorch.load(f"{D}/m.pt")\n')).toBe('weights/m.pt')
  })

  it('follows a file handle back to the path it was opened on', () => {
    const site = scanPython(
      'a.py',
      'import pickle\nwith open("weights/m.pkl", "rb") as h:\n    pickle.load(h)\n',
    ).calls[0]
    expect(site?.targetLiteral).toBe('weights/m.pkl')
  })

  it('follows open() used inline', () => {
    const site = scanPython('a.py', 'import pickle\npickle.load(open("m.pkl", "rb"))\n').calls[0]
    expect(site?.targetLiteral).toBe('m.pkl')
  })

  it('binds each handle to its own nearest with-statement, not the first', () => {
    const source = [
      'import pickle',
      'def a():',
      '    with open("weights/first.pkl", "rb") as h:',
      '        return pickle.load(h)',
      'def b():',
      '    with open("weights/second.pkl", "rb") as h:',
      '        return pickle.load(h)',
    ].join('\n')
    const calls = scanPython('a.py', source).calls
    expect(calls.map((c) => c.targetLiteral)).toEqual(['weights/first.pkl', 'weights/second.pkl'])
  })

  it('leaves a run-time path unresolved rather than guessing', () => {
    const site = siteFor('import torch\ndef f(name):\n    return torch.load(f"m/{name}.pt")\n', 'torch.load')
    expect(site?.targetLiteral).toBeNull()
    expect(site?.targetExpression).toContain('name')
  })

  it('leaves an environment-derived path unresolved', () => {
    const source =
      'import os, torch\nfrom pathlib import Path\nR = Path(os.environ.get("ROOT", "models"))\ntorch.load(R / "m.pt")\n'
    expect(siteFor(source, 'torch.load')?.targetLiteral).toBeNull()
  })
})

describe('scanPython: privileges and frameworks', () => {
  it('records a cloud client and a named secret with their lines', () => {
    const source = [
      'import boto3',
      'import os',
      's3 = boto3.client("s3")',
      'KEY = os.environ["APP_SIGNING_SECRET"]',
    ].join('\n')
    const result = scanPython('api.py', source)
    expect(result.privileges.map((p) => p.kind).sort()).toEqual([
      'cloud-credentials',
      'secret-material',
    ])
    expect(result.privileges.find((p) => p.kind === 'cloud-credentials')?.line).toBe(3)
  })

  it('does not treat an unnamed environment read as secret material', () => {
    const result = scanPython('a.py', 'import os\nROOT = os.environ["APP_ROOT"]\n')
    expect(result.privileges).toHaveLength(0)
  })

  it('detects a service framework', () => {
    expect(scanPython('a.py', 'from fastapi import FastAPI\napp = FastAPI()\n').frameworks).toContain(
      'fastapi',
    )
  })
})

describe('scanJs', () => {
  it('resolves a named import and a const reference', () => {
    const source = [
      "import { AutoModel } from '@huggingface/transformers'",
      "const REPO = 'org/model'",
      'export const load = () => AutoModel.from_pretrained(REPO)',
    ].join('\n')
    const site = scanJs('a.ts', source).calls[0]
    expect(site?.loaderId).toBe('js.transformers.from_pretrained')
    expect(site?.targetLiteral).toBe('org/model')
  })

  it('ignores a call inside a block comment', () => {
    const source = [
      "import { AutoModel } from '@huggingface/transformers'",
      '/* AutoModel.from_pretrained("x") */',
    ].join('\n')
    expect(scanJs('a.ts', source).calls).toHaveLength(0)
  })

  it('ignores a call inside a template literal', () => {
    const source = [
      "import { AutoModel } from '@huggingface/transformers'",
      'const s = `AutoModel.from_pretrained("x")`',
    ].join('\n')
    expect(scanJs('a.ts', source).calls).toHaveLength(0)
  })
})

describe('mask primitives', () => {
  it('matches brackets past quoted punctuation', () => {
    const masked = maskPython('f("a)b", 1)')
    expect(matchBracket(masked.masked, 1)).toBe(10)
  })

  it('splits arguments at top level only', () => {
    const masked = maskPython('f(a, g(b, c), "d,e")')
    const ranges = splitArguments(masked.masked, 1, masked.masked.length - 1)
    expect(ranges).toHaveLength(3)
  })

  it('returns -1 for an unbalanced bracket instead of scanning forever', () => {
    const masked = maskPython('f(a, b')
    expect(matchBracket(masked.masked, 1)).toBe(-1)
  })

  it('keeps the mask the same length as the source', () => {
    const source = 'x = "abc"  # comment\ny = \'\'\'multi\nline\'\'\'\n'
    const masked = maskPython(source)
    expect(masked.masked).toHaveLength(source.length)
  })
})
