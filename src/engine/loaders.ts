/**
 * Loader registry.
 *
 * Each entry names one call that turns bytes on disk into a live object, and
 * says which of its arguments identifies those bytes. What the call *does* is
 * decided later, in behaviour.ts, because for several of these the answer
 * depends on a keyword argument and on the version of the library installed.
 *
 * Matching runs against a canonical dotted name that the source scanners
 * reconstruct through import aliases, so `import torch as T; T.load(p)` and
 * `from torch import load; load(p)` both resolve to `torch.load`.
 */

import type { LoaderEcosystem, LoaderSpec } from './types.ts'

export interface LoaderRule {
  readonly spec: LoaderSpec
  /** Patterns tested against the canonical dotted call name. */
  readonly patterns: readonly RegExp[]
  /** Positional indexes that may hold the artifact reference. */
  readonly positions: readonly number[]
  /** Keyword arguments that may hold the artifact reference. */
  readonly keywords: readonly string[]
}

function rule(
  id: string,
  ecosystem: LoaderEcosystem,
  label: string,
  distribution: string | null,
  summary: string,
  reference: string,
  patterns: readonly RegExp[],
  positions: readonly number[],
  keywords: readonly string[],
): LoaderRule {
  return {
    spec: { id, ecosystem, label, distribution, summary, reference },
    patterns,
    positions,
    keywords,
  }
}

export const LOADER_RULES: readonly LoaderRule[] = [
  /* ---- the pickle family, where the format decides and no flag helps ---- */
  rule(
    'pickle.load',
    'python',
    'pickle.load',
    null,
    'Runs the pickle opcode interpreter over the stream. There is no safe mode.',
    'pickle',
    [/^(pickle|cPickle|_pickle)\.(load|loads)$/, /^(pickle|_pickle)\.Unpickler$/],
    [0],
    ['file', 'data'],
  ),
  rule(
    'dill.load',
    'python',
    'dill.load',
    'dill',
    'An extended pickler that serialises more kinds of object, including functions, by extending the same opcode set.',
    'pickle',
    [/^dill\.(load|loads)$/],
    [0],
    ['file'],
  ),
  rule(
    'cloudpickle.load',
    'python',
    'cloudpickle.load',
    'cloudpickle',
    'A pickler that captures closures and module state for distribution to workers. Same opcode semantics on load.',
    'pickle',
    [/^cloudpickle\.(load|loads)$/],
    [0],
    ['file'],
  ),
  rule(
    'joblib.load',
    'python',
    'joblib.load',
    'joblib',
    'Reads a joblib dump, which is a pickle with out-of-band handling for large arrays.',
    'pickle',
    [/^joblib\.load$/, /^sklearn\.externals\.joblib\.load$/],
    [0],
    ['filename'],
  ),
  rule(
    'pandas.read_pickle',
    'python',
    'pandas.read_pickle',
    'pandas',
    'Unpickles a DataFrame or Series from disk.',
    'pickle',
    [/^pandas\.read_pickle$/],
    [0],
    ['filepath_or_buffer'],
  ),
  rule(
    'marshal.load',
    'python',
    'marshal.load',
    null,
    'Deserialises CPython code objects. The documentation states it is not intended to be secure against erroneous or maliciously constructed data.',
    'pickle',
    [/^marshal\.(load|loads)$/],
    [0],
    ['file'],
  ),

  /* ---- the version-dependent ones ------------------------------------- */
  rule(
    'torch.load',
    'python',
    'torch.load',
    'torch',
    'Reads a PyTorch checkpoint. Whether it unpickles freely or through a restricted unpickler depends on weights_only, whose default changed in PyTorch 2.6.',
    'torch-load',
    [/^torch\.load$/],
    [0],
    ['f'],
  ),
  rule(
    'torch.jit.load',
    'python',
    'torch.jit.load',
    'torch',
    'Loads a TorchScript archive, which carries a serialised program in addition to weights.',
    'torchscript',
    [/^torch\.jit\.load$/],
    [0],
    ['f'],
  ),
  rule(
    'torch.hub.load',
    'python',
    'torch.hub.load',
    'torch',
    'Fetches a repository and imports its hubconf.py to build the model.',
    'remote-code',
    [/^torch\.hub\.load$/],
    [0],
    ['repo_or_dir'],
  ),
  rule(
    'numpy.load',
    'python',
    'numpy.load',
    'numpy',
    'Reads .npy or .npz. Object arrays require allow_pickle, which has defaulted to False since NumPy 1.16.3.',
    'numpy-load',
    [/^numpy\.load$/],
    [0],
    ['file'],
  ),
  rule(
    'keras.load_model',
    'python',
    'keras.models.load_model',
    'keras',
    'Rebuilds a model from its stored configuration. Lambda layers deserialise Python bytecode; Keras 3 refuses to under its default safe_mode.',
    'keras-load-model',
    [
      /^keras(\.saving|\.models)?\.load_model$/,
      /^tensorflow\.keras(\.saving|\.models)?\.load_model$/,
      /^load_model$/,
    ],
    [0],
    ['filepath', 'model_path'],
  ),
  rule(
    'tensorflow.saved_model.load',
    'python',
    'tf.saved_model.load',
    'tensorflow',
    'Restores a graph and its concrete functions, which may include file and network operations.',
    'savedmodel',
    [/^tensorflow\.saved_model\.load$/, /^tensorflow\.keras\.models\.load_model$/],
    [0],
    ['export_dir'],
  ),

  /* ---- remote-code surfaces -------------------------------------------- */
  rule(
    'transformers.from_pretrained',
    'python',
    'from_pretrained',
    'transformers',
    'Resolves a model repository and loads its weights. With trust_remote_code the repository’s own Python is imported and run.',
    'from-pretrained',
    [
      /^transformers\.[A-Za-z0-9_]+\.from_pretrained$/,
      /^(Auto[A-Za-z0-9_]*|[A-Za-z0-9_]*(Model|Tokenizer|Processor|Config|Pipeline|FeatureExtractor|ImageProcessor))\.from_pretrained$/,
    ],
    [0],
    ['pretrained_model_name_or_path'],
  ),
  rule(
    'transformers.pipeline',
    'python',
    'transformers.pipeline',
    'transformers',
    'Builds a task pipeline, resolving and loading a model repository on the way.',
    'from-pretrained',
    [/^transformers\.pipeline$/, /^pipeline$/],
    [1],
    ['model'],
  ),
  rule(
    'datasets.load_dataset',
    'python',
    'datasets.load_dataset',
    'datasets',
    'Resolves a dataset repository. With trust_remote_code the repository’s loading script is executed.',
    'remote-code',
    [/^datasets\.load_dataset$/, /^load_dataset$/],
    [0],
    ['path'],
  ),
  rule(
    'sentence_transformers',
    'python',
    'SentenceTransformer',
    'sentence-transformers',
    'Loads a sentence-transformers repository, including any module definitions it declares.',
    'from-pretrained',
    [/^sentence_transformers\.SentenceTransformer$/, /^SentenceTransformer$/],
    [0],
    ['model_name_or_path'],
  ),
  rule(
    'ultralytics.YOLO',
    'python',
    'ultralytics.YOLO',
    'ultralytics',
    'Loads a YOLO checkpoint, which is a PyTorch archive read through torch.load.',
    'torch-load',
    [/^ultralytics\.YOLO$/, /^YOLO$/],
    [0],
    ['model'],
  ),

  /* ---- data-oriented loaders ------------------------------------------- */
  rule(
    'safetensors.load_file',
    'python',
    'safetensors.load_file',
    'safetensors',
    'Reads the JSON header and maps the tensor buffers. Nothing in the file names a callable.',
    'safetensors',
    [
      /^safetensors(\.torch|\.numpy|\.flax|\.paddle|\.tensorflow)?\.(load_file|load)$/,
      /^safetensors(\.torch)?\.safe_open$/,
      /^(load_file|safe_open)$/,
    ],
    [0],
    ['filename'],
  ),
  rule(
    'onnxruntime.InferenceSession',
    'python',
    'onnxruntime.InferenceSession',
    'onnxruntime',
    'Parses an ONNX graph and builds an execution plan. A graph naming a custom operator will load the library that implements it.',
    'onnx',
    [/^onnxruntime\.InferenceSession$/, /^InferenceSession$/],
    [0],
    ['path_or_bytes'],
  ),
  rule(
    'llama_cpp.Llama',
    'python',
    'llama_cpp.Llama',
    'llama-cpp-python',
    'Memory-maps a GGUF file and reads its key-value header.',
    'gguf',
    [/^llama_cpp\.Llama$/, /^Llama$/],
    [0],
    ['model_path'],
  ),

  /* ---- JavaScript ------------------------------------------------------- */
  rule(
    'js.transformers.from_pretrained',
    'javascript',
    'transformers.js from_pretrained',
    '@huggingface/transformers',
    'Resolves a model repository and loads ONNX weights for onnxruntime-web.',
    'from-pretrained',
    [/^(AutoModel[A-Za-z0-9_]*|AutoTokenizer|AutoProcessor)\.from_pretrained$/, /^pipeline$/],
    [0, 1],
    ['model'],
  ),
  rule(
    'js.onnxruntime',
    'javascript',
    'ort.InferenceSession.create',
    'onnxruntime-node',
    'Parses an ONNX graph and builds an execution plan.',
    'onnx',
    [/^(ort|onnxruntime)\.InferenceSession\.create$/, /^InferenceSession\.create$/],
    [0],
    ['path'],
  ),
  rule(
    'js.tfjs',
    'javascript',
    'tf.loadLayersModel',
    '@tensorflow/tfjs',
    'Fetches a model.json topology and its weight shards.',
    'savedmodel',
    [/^tf\.(loadLayersModel|loadGraphModel)$/, /^(loadLayersModel|loadGraphModel)$/],
    [0],
    ['pathOrIOHandler'],
  ),
  rule(
    'js.node-llama-cpp',
    'javascript',
    'node-llama-cpp loadModel',
    'node-llama-cpp',
    'Memory-maps a GGUF file.',
    'gguf',
    [/^llama\.loadModel$/, /^loadModel$/],
    [0],
    ['modelPath'],
  ),
]

const BY_ID = new Map<string, LoaderRule>(LOADER_RULES.map((r) => [r.spec.id, r]))

export function loaderRule(id: string): LoaderRule | null {
  return BY_ID.get(id) ?? null
}

export function loaderSpec(id: string): LoaderSpec | null {
  return BY_ID.get(id)?.spec ?? null
}

/** Resolve a canonical dotted call name to a loader id, or null. */
export function matchLoader(canonical: string, ecosystem: LoaderEcosystem): string | null {
  for (const r of LOADER_RULES) {
    if (r.spec.ecosystem !== ecosystem) continue
    for (const pattern of r.patterns) {
      if (pattern.test(canonical)) return r.spec.id
    }
  }
  return null
}

/**
 * Bare callable names any rule can match once imported directly. Used by the
 * scanners to decide whether an unqualified call is worth resolving at all,
 * which keeps the hot loop cheap on files that import none of this.
 */
export const BARE_NAMES: ReadonlySet<string> = new Set([
  'load',
  'loads',
  'load_model',
  'load_file',
  'load_dataset',
  'safe_open',
  'read_pickle',
  'pipeline',
  'from_pretrained',
  'InferenceSession',
  'Llama',
  'YOLO',
  'SentenceTransformer',
  'Unpickler',
  'loadLayersModel',
  'loadGraphModel',
  'loadModel',
  'create',
])
