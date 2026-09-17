/**
 * Load behaviour resolution. This is the answer to the product's question.
 *
 * The resolver takes one load site, the artifact it resolves to, and the
 * versions the repository declares, and returns what loading does -- with the
 * reasoning attached, step by step, so that the UI can show why rather than
 * only what.
 *
 * Three rules govern everything here.
 *
 * 1. The call site decides, then the format. `pickle.load` runs the opcode
 *    interpreter over whatever bytes it is given, so the format of the target
 *    cannot make it safe. `torch.load` reads a PyTorch archive, so the flags
 *    on the call decide.
 *
 * 2. A default that changed is not a default you can assume. `torch.load`
 *    executed arbitrary code on every call until PyTorch 2.6 flipped
 *    `weights_only` to True. If the repository does not pin torch tightly
 *    enough to know which side of that change it is on, the answer is
 *    UNKNOWN, and the stated reason is that the version is unpinned.
 *
 * 3. A flag that suppresses execution is recorded as a guard, not as safety.
 *    `weights_only=True` is an allowlisting unpickler: it stops the stream
 *    naming arbitrary callables, and it is one keyword away from not doing
 *    that. The verdict is `guarded`, and it carries what the behaviour would
 *    become if the flag were removed.
 */

import { atLeast, findDependency, parseVersion, compareVersions } from './deps.ts'
import { formatSpec } from './formats.ts'
import type { RawCall } from './scan.ts'
import type {
  Artifact,
  BehaviourStep,
  BehaviourVerdict,
  LoadBehaviour,
  ResolvedDependency,
  UnknownReasonCode,
} from './types.ts'

interface Input {
  readonly call: RawCall
  readonly artifact: Artifact | null
  readonly deps: readonly ResolvedDependency[]
}

function argument(call: RawCall, keyword: string): string | null {
  const found = call.args.find((a) => a.keyword === keyword)
  return found?.literal ?? null
}

function hasArgument(call: RawCall, keyword: string): boolean {
  return call.args.some((a) => a.keyword === keyword)
}

function verdict(
  behaviour: LoadBehaviour,
  mechanism: string,
  steps: readonly BehaviourStep[],
  extra?: Partial<BehaviourVerdict>,
): BehaviourVerdict {
  return {
    behaviour,
    mechanism,
    steps,
    unknownReason: extra?.unknownReason ?? null,
    guard: extra?.guard ?? null,
  }
}

function unknown(
  reason: UnknownReasonCode,
  mechanism: string,
  steps: readonly BehaviourStep[],
): BehaviourVerdict {
  return verdict('unknown', mechanism, steps, { unknownReason: reason })
}

/**
 * Describe what a declared dependency tells us about a version threshold.
 *
 * `decided` is true only when every version the declaration permits falls on
 * the same side of the threshold. A floor below the threshold leaves the
 * question open even though a version is written down, which is the case the
 * product is really about.
 */
interface Threshold {
  readonly decided: boolean
  readonly atLeast: boolean
  readonly note: string
  readonly basis: string
}

function threshold(
  deps: readonly ResolvedDependency[],
  distribution: string,
  target: string,
): Threshold {
  const dep = findDependency(deps, distribution)
  if (dep === null) {
    return {
      decided: false,
      atLeast: false,
      note: `${distribution} is not declared anywhere DEADWEIGHT could read`,
      basis: 'no manifest entry',
    }
  }
  if (dep.version === null) {
    return {
      decided: false,
      atLeast: false,
      note: `${distribution} is declared as \`${dep.constraint}\`, which does not pin a version`,
      basis: dep.source,
    }
  }
  const reached = atLeast(dep.version, target)
  if (reached === null) {
    return {
      decided: false,
      atLeast: false,
      note: `${distribution} ${dep.version} could not be compared with ${target}`,
      basis: dep.source,
    }
  }
  if (dep.pin === 'exact') {
    return {
      decided: true,
      atLeast: reached,
      note: `${distribution} is pinned to ${dep.version}`,
      basis: dep.source,
    }
  }
  // A range decides the question only when its floor is already past the
  // threshold. `>=2.0` spans the change and therefore answers nothing.
  const floor = parseVersion(dep.version)
  const mark = parseVersion(target)
  const past = floor !== null && mark !== null && compareVersions(floor, mark) >= 0
  return past
    ? {
        decided: true,
        atLeast: true,
        note: `${distribution} is constrained to \`${dep.constraint}\`, so every permitted version is at least ${target}`,
        basis: dep.source,
      }
    : {
        decided: false,
        atLeast: false,
        note: `${distribution} is constrained to \`${dep.constraint}\`, which permits versions on both sides of ${target}`,
        basis: dep.source,
      }
}

/* -------------------------------------------------------------------------- */

const PICKLE_FAMILY: Readonly<Record<string, string>> = {
  'pickle.load': 'pickle.load',
  'dill.load': 'dill.load',
  'cloudpickle.load': 'cloudpickle.load',
  'joblib.load': 'joblib.load',
  'pandas.read_pickle': 'pandas.read_pickle',
  'marshal.load': 'marshal.load',
}

/**
 * Loaders that read a data-oriented format and nothing else.
 *
 * If one of these is pointed at a file whose bytes are a pickle-bearing
 * archive, the two facts contradict each other and DEADWEIGHT will not pick a
 * winner: either the file is mislabelled, or the call will fail. Both are
 * worth surfacing, and "data only" would be a wrong answer to either.
 */
const DATA_ONLY_LOADERS: ReadonlySet<string> = new Set([
  'safetensors.load_file',
  'onnxruntime.InferenceSession',
  'llama_cpp.Llama',
  'js.onnxruntime',
  'js.node-llama-cpp',
])

export function resolveBehaviour(input: Input): BehaviourVerdict {
  const { call, artifact, deps } = input
  const at = `${call.file}:${call.line}`

  /*
   * A data-oriented loader pointed at bytes that did not confirm the format.
   * The call reads one format and nothing in the file says it is that format,
   * so reporting a data-only load would be trusting the filename.
   */
  if (
    DATA_ONLY_LOADERS.has(call.loaderId) &&
    artifact !== null &&
    artifact.origin === 'in-tree' &&
    (artifact.format.basis === 'extension' || artifact.format.basis === 'none')
  ) {
    return unknown(
      'format-undetermined',
      `This line reads ${loaderFormatName(call.loaderId)}, and nothing in the file's bytes confirmed that it is one: ${artifact.format.note}. DEADWEIGHT will not report a data-only load on the strength of a filename.`,
      [
        { claim: `The call site is \`${call.canonical}\`.`, basis: at },
        { claim: artifact.format.note, basis: `${artifact.locator} (${artifact.format.basis})` },
        {
          claim: 'A loader that reads exactly one format, pointed at bytes that are not recognisably that format, either fails or the file is mislabelled.',
          basis: 'format not confirmed',
        },
      ],
    )
  }

  /* ---- the loader and the bytes disagree ------------------------------- */
  if (
    DATA_ONLY_LOADERS.has(call.loaderId) &&
    artifact !== null &&
    artifact.origin === 'in-tree' &&
    formatSpec(artifact.format.format).intrinsic === 'code'
  ) {
    return unknown(
      'format-undetermined',
      `This line reads ${loaderFormatName(call.loaderId)}, and the file it names is ${formatSpec(artifact.format.format).label}: ${artifact.format.note}. Either the artifact is mislabelled or this call fails, and DEADWEIGHT will not report a data-only load for a file that carries a pickle stream.`,
      [
        { claim: `The call site is \`${call.canonical}\`.`, basis: at },
        {
          claim: `The bytes identify the file as ${formatSpec(artifact.format.format).label}.`,
          basis: `${artifact.locator} (${artifact.format.basis})`,
        },
        {
          claim: 'A data-oriented loader cannot read a pickle-bearing archive, so one of these two facts is wrong.',
          basis: 'loader and format contradict',
        },
      ],
    )
  }

  /* ---- unconditional: the opcode interpreter runs, whatever the file ---- */
  if (PICKLE_FAMILY[call.loaderId] !== undefined) {
    const steps: BehaviourStep[] = [
      { claim: `The call site is \`${call.canonical}\`.`, basis: at },
      {
        claim:
          'Unpickling walks a stack language whose REDUCE, INST and NEWOBJ opcodes call objects the stream names by module and attribute.',
        basis: 'format: pickle',
      },
      {
        claim: 'There is no flag on this call that restricts which objects the stream may name.',
        basis: 'CPython pickle has no safe mode',
      },
    ]
    if (artifact?.pickle && artifact.pickle.globals.length > 0) {
      steps.push({
        claim: `The stream names ${artifact.pickle.globals.length} global${artifact.pickle.globals.length === 1 ? '' : 's'} (${artifact.pickle.globals.slice(0, 4).join(', ')}${artifact.pickle.globals.length > 4 ? ', …' : ''}).`,
        basis: 'opcode scan, no deserialisation',
      })
    }
    return verdict(
      'code',
      'Loading runs the pickle opcode interpreter, which calls whatever the file tells it to call. Reading the file is running it.',
      steps,
    )
  }

  switch (call.loaderId) {
    /* ---- the star of the show ------------------------------------------ */
    case 'torch.load': {
      const steps: BehaviourStep[] = [
        { claim: 'The call site is `torch.load`.', basis: at },
      ]

      if (hasArgument(call, 'pickle_module')) {
        steps.push({
          claim: 'A `pickle_module` argument is supplied, which replaces the unpickler and bypasses the allowlist entirely.',
          basis: at,
        })
        return verdict(
          'code',
          'A custom pickle module is passed to torch.load, so the restricted unpickler is not in the path and the stream may name any callable.',
          steps,
        )
      }

      const weightsOnly = argument(call, 'weights_only')
      if (weightsOnly === 'false') {
        steps.push({ claim: '`weights_only=False` is passed explicitly.', basis: at })
        steps.push({
          claim: 'The full unpickler is used, so the archive may name any importable callable.',
          basis: 'torch.load documentation',
        })
        return verdict(
          'code',
          'weights_only=False selects the unrestricted unpickler, so loading this checkpoint runs whatever the archive names.',
          steps,
        )
      }
      if (weightsOnly === 'true') {
        steps.push({ claim: '`weights_only=True` is passed explicitly.', basis: at })
        steps.push({
          claim:
            'torch.load then uses a restricted unpickler that refuses globals outside its allowlist, so the archive cannot name an arbitrary callable.',
          basis: 'torch.load documentation',
        })
        return verdict(
          'guarded',
          'The restricted unpickler is in the path. It is an allowlist rather than a sandbox: it stops the archive naming arbitrary callables, and it is one keyword argument away from not being there.',
          steps,
          { guard: { expression: 'weights_only=True', ifRemoved: 'code' } },
        )
      }

      const torch = threshold(deps, 'torch', '2.6')
      steps.push({
        claim: 'No `weights_only` argument is passed, so the default decides.',
        basis: at,
      })
      steps.push({
        claim: 'The default changed in PyTorch 2.6: before it, torch.load unpickled without restriction; from it, weights_only defaults to True.',
        basis: 'PyTorch 2.6 release notes',
      })
      steps.push({ claim: torch.note, basis: torch.basis })

      if (!torch.decided) {
        return unknown(
          'loader-default-unpinned',
          'What this line does depends on the installed PyTorch version, and the repository does not pin it tightly enough to say. Pinned below 2.6 it is arbitrary code execution; from 2.6 it is a restricted unpickler.',
          steps,
        )
      }
      if (torch.atLeast) {
        return verdict(
          'guarded',
          'The pinned PyTorch is 2.6 or later, where weights_only defaults to True, so the restricted unpickler is in the path. It is an allowlist, not a sandbox, and it is a version bump away from changing.',
          steps,
          { guard: { expression: 'weights_only default (PyTorch >= 2.6)', ifRemoved: 'code' } },
        )
      }
      return verdict(
        'code',
        'The pinned PyTorch is older than 2.6, where torch.load unpickles without restriction. Loading this checkpoint runs whatever the archive names.',
        steps,
      )
    }

    case 'torch.jit.load':
      return verdict(
        'code',
        'A TorchScript archive carries a serialised program, not only weights. Loading deserialises code for the TorchScript interpreter and unpickles the archive constants.',
        [
          { claim: 'The call site is `torch.jit.load`.', basis: at },
          {
            claim: 'The archive contains a code/ tree and a constants pickle.',
            basis: artifact ? `format: ${formatSpec(artifact.format.format).id}` : 'format: torchscript',
          },
          {
            claim: 'weights_only has no effect here; it is not an argument to this function.',
            basis: 'torch.jit.load signature',
          },
        ],
      )

    case 'torch.hub.load':
      return verdict(
        'code',
        'torch.hub.load fetches a repository and imports its hubconf.py to construct the model. The imported module runs at load.',
        [
          { claim: 'The call site is `torch.hub.load`.', basis: at },
          { claim: 'Construction goes through the repository’s own hubconf.py, which is imported.', basis: 'torch.hub documentation' },
          {
            claim: 'DEADWEIGHT does not fetch the repository, so what that module contains is outside this analysis.',
            basis: 'offline by design',
          },
        ],
      )

    case 'numpy.load': {
      const allowPickle = argument(call, 'allow_pickle')
      const steps: BehaviourStep[] = [{ claim: 'The call site is `numpy.load`.', basis: at }]
      if (allowPickle === 'true') {
        steps.push({ claim: '`allow_pickle=True` is passed.', basis: at })
        steps.push({
          claim: 'Object arrays in the file are then unpickled, with the usual opcode semantics.',
          basis: 'numpy.load documentation',
        })
        return verdict(
          'code',
          'allow_pickle=True permits numpy.load to unpickle object arrays, which runs whatever the stream names.',
          steps,
        )
      }
      steps.push({
        claim: allowPickle === 'false' ? '`allow_pickle=False` is passed.' : 'No `allow_pickle` argument, and it has defaulted to False since NumPy 1.16.3.',
        basis: allowPickle === 'false' ? at : 'numpy 1.16.3 release notes',
      })
      if (artifact?.format.format === 'numpy-npy' && artifact.format.note.includes('object dtype')) {
        steps.push({
          claim: 'The file declares an object dtype, so this call will raise rather than load it.',
          basis: 'npy header scan',
        })
      }
      return verdict(
        'data',
        'Without allow_pickle, numpy.load reads the header and the buffer and refuses object arrays. There is nothing in the file that names a callable.',
        steps,
        allowPickle === 'false'
          ? { guard: { expression: 'allow_pickle=False', ifRemoved: 'code' } }
          : undefined,
      )
    }
    case 'keras.load_model':
      return resolveKeras(call, deps, at)

    case 'tensorflow.saved_model.load':
      return verdict(
        'code',
        'Restoring a SavedModel rebuilds a graph and its concrete functions. The graph can contain operations with side effects, including file and network operations, which run when the restored function is called.',
        [
          { claim: `The call site is \`${call.canonical}\`.`, basis: at },
          { claim: 'A SavedModel stores a program, not only weights.', basis: 'format: tf-savedmodel' },
        ],
      )

    case 'transformers.from_pretrained':
    case 'transformers.pipeline':
    case 'sentence_transformers':
      return resolveFromPretrained(call, artifact, deps, at)

    case 'datasets.load_dataset': {
      const trust = argument(call, 'trust_remote_code')
      if (trust === 'true') {
        return verdict(
          'code',
          'trust_remote_code=True permits the dataset repository to ship a loading script, which is downloaded and executed.',
          [
            { claim: 'The call site is `datasets.load_dataset`.', basis: at },
            { claim: '`trust_remote_code=True` is passed.', basis: at },
            { claim: 'The repository’s loading script runs in this process.', basis: 'datasets documentation' },
          ],
        )
      }
      return verdict(
        'data',
        'Without trust_remote_code the loader reads the dataset’s data files and refuses to run a repository script.',
        [
          { claim: 'The call site is `datasets.load_dataset`.', basis: at },
          { claim: 'No `trust_remote_code` argument, which defaults to refusing repository scripts.', basis: 'datasets documentation' },
        ],
        { guard: { expression: 'trust_remote_code default (False)', ifRemoved: 'code' } },
      )
    }

    case 'ultralytics.YOLO':
      return verdict(
        'code',
        'A YOLO checkpoint is a PyTorch archive, and ultralytics reads it through its own torch.load call. The weights_only flag is inside the library, not on this line, so the caller cannot set it.',
        [
          { claim: 'The call site is `ultralytics.YOLO`.', basis: at },
          { claim: 'The checkpoint is a PyTorch archive containing a pickle stream.', basis: 'format: pytorch-zip' },
          {
            claim: 'The unpickler restriction is chosen by the library internally; there is no argument here that changes it.',
            basis: 'ultralytics loading path',
          },
        ],
      )

    case 'safetensors.load_file':
      return verdict(
        'data',
        'The loader reads a length-prefixed JSON header of tensor offsets and maps the buffers. There is no instruction in the file to interpret and nothing that names a callable.',
        [
          { claim: `The call site is \`${call.canonical}\`.`, basis: at },
          { claim: 'safetensors is a header of dtype, shape and byte range, then raw buffers.', basis: 'format: safetensors' },
          ...(artifact?.tensorHeader
            ? [
                {
                  claim: `The header parsed: ${artifact.tensorHeader.entries} tensor entries.`,
                  basis: 'header read, no deserialisation',
                },
              ]
            : []),
        ],
      )

    case 'onnxruntime.InferenceSession':
    case 'js.onnxruntime':
      return verdict(
        'data',
        'Parsing an ONNX file builds an operator graph from a protobuf; nothing in the file is executed to do it. The runtime then executes that graph, and a graph naming a custom operator will load the library implementing it.',
        [
          { claim: `The call site is \`${call.canonical}\`.`, basis: at },
          { claim: 'The file is a protobuf describing a computation graph.', basis: 'format: onnx' },
          {
            claim: 'Custom operators are the one path from graph to native code, and they require a library the host has registered.',
            basis: 'onnxruntime custom operators',
          },
        ],
      )

    case 'llama_cpp.Llama':
    case 'js.node-llama-cpp':
      return verdict(
        'data',
        'The loader memory-maps a GGUF file and reads its typed key-value header. No part of the format names a callable.',
        [
          { claim: `The call site is \`${call.canonical}\`.`, basis: at },
          { claim: 'GGUF is a key-value header followed by tensor buffers.', basis: 'format: gguf' },
        ],
      )

    case 'js.transformers.from_pretrained':
      return verdict(
        'data',
        'transformers.js resolves a repository and loads ONNX weights for onnxruntime. There is no equivalent of trust_remote_code: the library cannot import repository Python.',
        [
          { claim: `The call site is \`${call.canonical}\`.`, basis: at },
          { claim: 'The runtime is onnxruntime-web, and the weights are ONNX.', basis: 'format: onnx' },
          {
            claim: 'DEADWEIGHT does not fetch the repository, so the specific weights are outside this analysis.',
            basis: 'offline by design',
          },
        ],
      )

    case 'js.tfjs':
      return verdict(
        'data',
        'The loader fetches a model.json topology and its weight shards and rebuilds a graph from declared layer types. Custom layers must be registered by the application, not by the file.',
        [
          { claim: `The call site is \`${call.canonical}\`.`, basis: at },
          { claim: 'Layer classes are resolved from a registry the application controls.', basis: 'tfjs serialization' },
        ],
      )

    default:
      return unknown(
        'loader-unrecognised',
        'DEADWEIGHT matched this call to a loader it has no behaviour rule for, so it will not state what loading does.',
        [{ claim: `The call site is \`${call.canonical}\`.`, basis: at }],
      )
  }
}

/* -------------------------------------------------------------------------- */

function resolveKeras(
  call: RawCall,
  deps: readonly ResolvedDependency[],
  at: string,
): BehaviourVerdict {
  const steps: BehaviourStep[] = [
    { claim: `The call site is \`${call.canonical}\`.`, basis: at },
    {
      claim: 'Loading rebuilds the model from its stored configuration, and a Lambda layer’s configuration is marshalled Python bytecode.',
      basis: 'keras serialization',
    },
  ]

  const safeMode = argument(call, 'safe_mode')
  if (safeMode === 'false') {
    steps.push({ claim: '`safe_mode=False` is passed explicitly.', basis: at })
    return verdict(
      'code',
      'safe_mode=False permits Keras to deserialise Lambda-layer bytecode, so loading the file runs code the file supplies.',
      steps,
    )
  }
  if (safeMode === 'true') {
    steps.push({ claim: '`safe_mode=True` is passed explicitly.', basis: at })
    return verdict(
      'guarded',
      'safe_mode makes Keras refuse Lambda-layer bytecode. The surface is in the file; the flag is what closes it.',
      steps,
      { guard: { expression: 'safe_mode=True', ifRemoved: 'code' } },
    )
  }

  const keras = threshold(deps, 'keras', '3')
  const tf = threshold(deps, 'tensorflow', '2.16')
  const decided = keras.decided ? keras : tf
  steps.push({ claim: 'No `safe_mode` argument, so the default decides.', basis: at })
  steps.push({
    claim: 'Keras 3 defaults safe_mode to True and refuses Lambda bytecode; Keras 2, which TensorFlow bundled before 2.16, deserialises it.',
    basis: 'keras 3 release notes',
  })
  steps.push({ claim: decided.note, basis: decided.basis })

  if (!decided.decided) {
    return unknown(
      'loader-default-unpinned',
      'Whether this call will deserialise Lambda-layer bytecode depends on whether the environment resolves to Keras 2 or Keras 3, and the repository does not pin either tightly enough to say.',
      steps,
    )
  }
  return decided.atLeast
    ? verdict(
        'guarded',
        'The pinned version is Keras 3 or later, where safe_mode defaults to True and Lambda-layer bytecode is refused. The refusal is a default, and defaults move.',
        steps,
        { guard: { expression: 'safe_mode default (Keras >= 3)', ifRemoved: 'code' } },
      )
    : verdict(
        'code',
        'The pinned version is Keras 2, which deserialises Lambda-layer bytecode when rebuilding a model from its configuration.',
        steps,
      )
}

function resolveFromPretrained(
  call: RawCall,
  artifact: Artifact | null,
  deps: readonly ResolvedDependency[],
  at: string,
): BehaviourVerdict {
  const steps: BehaviourStep[] = [{ claim: `The call site is \`${call.canonical}\`.`, basis: at }]

  const trust = argument(call, 'trust_remote_code')
  if (trust === 'true') {
    steps.push({ claim: '`trust_remote_code=True` is passed.', basis: at })
    steps.push({
      claim: 'The repository’s own modelling code is downloaded and imported into this process to construct the model.',
      basis: 'transformers documentation',
    })
    steps.push({
      claim: 'The trust is placed in whatever that repository contains at the moment of the call, which no pin in this project constrains.',
      basis: 'remote repository',
    })
    return verdict(
      'code',
      'trust_remote_code=True imports Python from the model repository. The execution surface is not a serialisation format at all: it is a remote repository you have agreed to import.',
      steps,
    )
  }

  if (argument(call, 'use_safetensors') === 'true') {
    steps.push({ claim: '`use_safetensors=True` is passed.', basis: at })
    steps.push({
      claim: 'The loader then refuses a repository that offers only pickle-backed weights, rather than falling back to them.',
      basis: 'transformers documentation',
    })
    return verdict(
      'data',
      'Weights are read from safetensors, whose header-plus-buffers layout names no callable. The architecture still comes from the library, not the file.',
      steps,
      { guard: { expression: 'use_safetensors=True', ifRemoved: 'unknown' } },
    )
  }

  if (artifact !== null && artifact.origin === 'in-tree') {
    const spec = formatSpec(artifact.format.format)
    steps.push({
      claim: `The reference resolves to a file in this repository, recognised as ${spec.label}.`,
      basis: `${artifact.locator} (${artifact.format.basis})`,
    })
    if (spec.intrinsic === 'data') {
      return verdict('data', spec.mechanism, steps)
    }
    const torch = threshold(deps, 'torch', '2.6')
    steps.push({ claim: torch.note, basis: torch.basis })
    if (!torch.decided) {
      return unknown(
        'loader-default-unpinned',
        'The resolved weights are pickle-backed, so what loading does depends on the PyTorch version behind the call, and it is not pinned tightly enough to say.',
        steps,
      )
    }
    return torch.atLeast
      ? verdict(
          'guarded',
          'The resolved weights are pickle-backed, read by a PyTorch new enough to default to the restricted unpickler.',
          steps,
          { guard: { expression: 'weights_only default (PyTorch >= 2.6)', ifRemoved: 'code' } },
        )
      : verdict('code', spec.mechanism, steps)
  }

  steps.push({
    claim: call.targetLiteral
      ? `The reference \`${call.targetLiteral}\` is a remote repository, not a file in this project.`
      : 'The model reference is not a static string, so DEADWEIGHT cannot tell which repository it names.',
    basis: at,
  })
  steps.push({
    claim: 'DEADWEIGHT does not contact the network, so which weight files that repository offers -- safetensors, pickle, or both -- is outside this analysis.',
    basis: 'offline by design',
  })
  steps.push({
    claim: 'Without trust_remote_code the library will not import repository Python, so the remaining question is only which weight format is served.',
    basis: 'transformers documentation',
  })
  return unknown(
    call.targetLiteral ? 'remote-contents-unresolvable' : 'path-not-static',
    'The weights come from a repository this analysis cannot see. Pass use_safetensors=True to make the format a requirement rather than a preference, and the answer becomes knowable from the code alone.',
    steps,
  )
}

function loaderFormatName(loaderId: string): string {
  switch (loaderId) {
    case 'safetensors.load_file':
      return 'safetensors'
    case 'onnxruntime.InferenceSession':
    case 'js.onnxruntime':
      return 'ONNX'
    default:
      return 'GGUF'
  }
}

/**
 * How exposed each behaviour is.
 *
 * Used to pick an artifact's headline verdict when it is loaded from several
 * places with different flags. The most exposed site wins, because "this
 * checkpoint is loaded safely" is not true of a checkpoint that is also
 * loaded unsafely somewhere else in the same repository.
 */
export const EXPOSURE: Readonly<Record<LoadBehaviour, number>> = {
  code: 4,
  directive: 3,
  unknown: 2,
  guarded: 1,
  data: 0,
}

/** The most exposed verdict among a set of load sites. */
export function mostExposed(verdicts: readonly BehaviourVerdict[]): BehaviourVerdict | null {
  let best: BehaviourVerdict | null = null
  for (const candidate of verdicts) {
    if (best === null || EXPOSURE[candidate.behaviour] > EXPOSURE[best.behaviour]) best = candidate
  }
  return best
}

/** Behaviour of a load site whose artifact could not be resolved at all. */
export function unresolvedArtifactBehaviour(call: RawCall): BehaviourVerdict {
  return unknown(
    call.targetExpression === '' ? 'artifact-unresolved' : 'path-not-static',
    call.targetExpression === ''
      ? 'The loader was called without an argument DEADWEIGHT could identify as the artifact, so there is nothing to classify.'
      : 'The artifact path is built at run time. DEADWEIGHT will not guess which file this loads, so the load behaviour stays unresolved.',
    [
      { claim: `The call site is \`${call.canonical}\`.`, basis: `${call.file}:${call.line}` },
      {
        claim:
          call.targetExpression === ''
            ? 'No argument matched the loader’s artifact parameter.'
            : `The target is \`${call.targetExpression}\`, which does not reduce to a static string.`,
        basis: `${call.file}:${call.line}`,
      },
    ],
  )
}
