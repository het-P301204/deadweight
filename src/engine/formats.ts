/**
 * Serialisation format registry.
 *
 * Each entry states what the format *is* and what reading it does, before any
 * loader flag is considered. `intrinsic` is the behaviour of the format on
 * its own; behaviour.ts then applies the call site's flags and the resolved
 * library version on top of it.
 *
 * Every `mechanism` string is shown verbatim in the product, so each one has
 * to be a claim about the format that is true without qualification. Where a
 * format's safety depends on something -- ONNX custom operators, safetensors
 * being only the weights and not the architecture -- the qualification is in
 * the sentence rather than left out of it.
 */

import type { FormatId, FormatSpec } from './types.ts'

const SPECS: readonly FormatSpec[] = [
  {
    id: 'pickle',
    label: 'Pickle',
    shape: 'Python pickle stream',
    intrinsic: 'code',
    mechanism:
      'Unpickling is an interpreter for a stack language whose REDUCE, INST and NEWOBJ opcodes call importable Python objects named in the stream. Reading the file is running it.',
    convertibleTo: ['safetensors', 'onnx'],
    extensions: ['.pkl', '.pickle', '.p'],
  },
  {
    id: 'pytorch-zip',
    label: 'PyTorch archive',
    shape: 'zip archive containing a pickle stream',
    intrinsic: 'code',
    mechanism:
      'The archive holds tensor storages beside a data.pkl that describes how to rebuild them. Rebuilding runs the pickle, so the execution surface is the pickle stream, not the zip.',
    convertibleTo: ['safetensors', 'onnx'],
    extensions: ['.pt', '.pth', '.bin', '.ckpt'],
  },
  {
    id: 'pytorch-legacy',
    label: 'PyTorch archive (legacy)',
    shape: 'bare pickle stream written by torch.save before the zip format',
    intrinsic: 'code',
    mechanism:
      'The pre-1.6 torch.save format is a pickle stream with tensor storages appended. It has the execution surface of any other pickle.',
    convertibleTo: ['safetensors'],
    extensions: ['.pt', '.pth'],
  },
  {
    id: 'torchscript',
    label: 'TorchScript archive',
    shape: 'zip archive containing serialised TorchScript',
    intrinsic: 'code',
    mechanism:
      'A TorchScript archive carries a serialised program, not only weights. Loading it deserialises code for the TorchScript interpreter to run, and the archive also contains pickled constants.',
    convertibleTo: ['onnx'],
    extensions: ['.pt', '.ptl'],
  },
  {
    id: 'joblib',
    label: 'joblib dump',
    shape: 'compressed pickle stream',
    intrinsic: 'code',
    mechanism:
      'joblib writes a pickle with its own out-of-band handling for large arrays. Loading it unpickles, with the same opcode semantics.',
    convertibleTo: ['safetensors', 'onnx'],
    extensions: ['.joblib', '.jbl'],
  },
  {
    id: 'numpy-npy',
    label: 'NumPy array',
    shape: 'header plus a raw buffer',
    intrinsic: 'data',
    mechanism:
      'A .npy file is a small ASCII header and a contiguous buffer. It carries no execution surface unless the declared dtype is object, which requires the caller to opt into pickling.',
    convertibleTo: [],
    extensions: ['.npy'],
  },
  {
    id: 'numpy-npz',
    label: 'NumPy archive',
    shape: 'zip archive of .npy members',
    intrinsic: 'data',
    mechanism:
      'Each member is a .npy. The archive is data unless a member holds an object array and the caller opted into pickling.',
    convertibleTo: [],
    extensions: ['.npz'],
  },
  {
    id: 'safetensors',
    label: 'safetensors',
    shape: 'JSON header of tensor offsets, then raw buffers',
    intrinsic: 'data',
    mechanism:
      'The format is a length-prefixed JSON header naming dtype, shape and byte range for each tensor, followed by the buffers. There is no instruction to interpret, so deserialising cannot call anything. It carries weights only, not the model architecture.',
    convertibleTo: [],
    extensions: ['.safetensors'],
  },
  {
    id: 'onnx',
    label: 'ONNX',
    shape: 'protocol buffer describing a computation graph',
    intrinsic: 'data',
    mechanism:
      'Parsing an ONNX file builds a graph of operators from a protobuf; no code in the file is executed to do it. The runtime then executes that graph, and a graph referencing a custom operator will load the shared library that implements it.',
    convertibleTo: [],
    extensions: ['.onnx'],
  },
  {
    id: 'gguf',
    label: 'GGUF',
    shape: 'key-value metadata block followed by tensor data',
    intrinsic: 'data',
    mechanism:
      'GGUF is a typed key-value header and tensor buffers. Reading it parses values; there is no callable named anywhere in the format.',
    convertibleTo: [],
    extensions: ['.gguf'],
  },
  {
    id: 'tflite',
    label: 'TensorFlow Lite',
    shape: 'FlatBuffer graph',
    intrinsic: 'data',
    mechanism:
      'A FlatBuffer is read in place with no parsing step that could invoke anything. Custom operators are resolved by the interpreter from a registry the host supplies, not from the file.',
    convertibleTo: [],
    extensions: ['.tflite'],
  },
  {
    id: 'keras-h5',
    label: 'Keras HDF5',
    shape: 'HDF5 container holding weights and a JSON architecture config',
    intrinsic: 'code',
    mechanism:
      'The weights are data, but the stored architecture config is rebuilt by deserialising layer definitions, and a Lambda layer deserialises marshalled Python bytecode. Whether that is reachable depends on the Keras version and safe_mode.',
    convertibleTo: ['onnx', 'safetensors'],
    extensions: ['.h5', '.hdf5'],
  },
  {
    id: 'keras-v3',
    label: 'Keras v3',
    shape: 'zip archive of config.json plus a weights file',
    intrinsic: 'code',
    mechanism:
      'Loading rebuilds layers from config.json. Keras 3 refuses Lambda-layer bytecode under its default safe_mode, so the surface is present in the format and suppressed at the call site.',
    convertibleTo: ['onnx', 'safetensors'],
    extensions: ['.keras'],
  },
  {
    id: 'tf-savedmodel',
    label: 'TensorFlow SavedModel',
    shape: 'directory of protobuf graph definitions and variables',
    intrinsic: 'code',
    mechanism:
      'A SavedModel restores a graph and its functions. The graph can reference operations with side effects, including file and network ops, which run when the restored function is called.',
    convertibleTo: ['onnx'],
    extensions: ['.pb'],
  },
  {
    id: 'flax-msgpack',
    label: 'Flax msgpack',
    shape: 'msgpack-encoded parameter tree',
    intrinsic: 'data',
    mechanism:
      'msgpack decodes to plain values; the parameter tree is data. Flax does not encode callables in the checkpoint.',
    convertibleTo: ['safetensors'],
    extensions: ['.msgpack'],
  },
  {
    id: 'agent-skill',
    label: 'Agent skill',
    shape: 'Markdown instructions with structured frontmatter',
    intrinsic: 'directive',
    mechanism:
      'Loading a skill places its text into a model context as instructions. Nothing executes at load, but the file exists to direct tool use, so its contents reach whatever the agent is permitted to do.',
    convertibleTo: [],
    extensions: ['.md'],
  },
  {
    id: 'mcp-server-manifest',
    label: 'MCP server manifest',
    shape: 'JSON declaring servers, transports and commands',
    intrinsic: 'code',
    mechanism:
      'A stdio server entry names a command the client spawns when the session starts. Loading the manifest is what causes that process to run, before any tool is called.',
    convertibleTo: [],
    extensions: ['.json'],
  },
  {
    id: 'agent-definition',
    label: 'Agent definition',
    shape: 'structured agent, tool or hook declaration',
    intrinsic: 'directive',
    mechanism:
      'The definition supplies a system prompt, a tool list and sometimes a hook command. Its text becomes instructions the model follows; its tool grants become what those instructions can reach.',
    convertibleTo: [],
    extensions: ['.yaml', '.yml', '.json', '.md'],
  },
  {
    id: 'prompt-template',
    label: 'Prompt template',
    shape: 'templated instruction text',
    intrinsic: 'directive',
    mechanism:
      'The template is interpolated into a model context. It executes nothing, and it determines what the model is told to do.',
    convertibleTo: [],
    extensions: ['.txt', '.md', '.jinja', '.j2'],
  },
  {
    id: 'remote-repository',
    label: 'Remote repository',
    shape: 'a model repository resolved at run time',
    intrinsic: 'unknown',
    mechanism:
      'The reference names a repository rather than a file. DEADWEIGHT makes no network requests, so which weight formats that repository serves -- and therefore what loading it does -- is outside this analysis.',
    convertibleTo: [],
    extensions: [],
  },
  {
    id: 'unknown',
    label: 'Unrecognised',
    shape: 'not identified',
    intrinsic: 'unknown',
    mechanism:
      'DEADWEIGHT could not identify the format from its leading bytes, its container structure or its extension, so it will not guess at what loading it would do.',
    convertibleTo: [],
    extensions: [],
  },
]

const BY_ID = new Map<FormatId, FormatSpec>(SPECS.map((s) => [s.id, s]))

export function formatSpec(id: FormatId): FormatSpec {
  return BY_ID.get(id) ?? (BY_ID.get('unknown') as FormatSpec)
}

export function allFormats(): readonly FormatSpec[] {
  return SPECS
}

/** Formats with no execution or instruction surface, used for migration targets. */
export const DATA_FORMATS: ReadonlySet<FormatId> = new Set<FormatId>([
  'safetensors',
  'onnx',
  'gguf',
  'tflite',
  'numpy-npy',
  'numpy-npz',
  'flax-msgpack',
])

/** Extensions DEADWEIGHT treats as candidate model artifacts during the walk. */
export const MODEL_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pt',
  '.pth',
  '.ptl',
  '.bin',
  '.ckpt',
  '.pkl',
  '.pickle',
  '.p',
  '.joblib',
  '.jbl',
  '.npy',
  '.npz',
  '.safetensors',
  '.onnx',
  '.gguf',
  '.ggml',
  '.tflite',
  '.h5',
  '.hdf5',
  '.keras',
  '.msgpack',
  '.pb',
])
