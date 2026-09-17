/**
 * Format classification.
 *
 * The rule the whole product rests on: DEADWEIGHT identifies an artifact by
 * *recognising* it, never by loading it. That means reading a bounded prefix
 * (and, for archives, a bounded suffix), matching magic numbers, and listing
 * container member names. No loader, no deserialiser, no decompression.
 *
 * Bytes beat extensions. A `.bin` that is really a zip holding `data.pkl` is
 * a PyTorch archive with a pickle inside it; a `.safetensors` whose first
 * bytes are `PK` is something worth a finding of its own. Where the two
 * disagree the verdict records the mismatch rather than picking silently.
 */

import {
  isHdf5,
  isTflite,
  looksLikeMsgpack,
  looksLikeOnnx,
  readGguf,
  readNpy,
  readSafetensorsHeader,
} from './containers.ts'
import { formatSpec } from './formats.ts'
import { ARTIFACT_HEAD_BYTES, ARTIFACT_TAIL_BYTES } from './limits.ts'
import { looksLikePickle, read as readPickle } from './pickle.ts'
import { extname } from './source.ts'
import type { SourceTree } from './source.ts'
import type { FormatId, FormatVerdict, PickleObservation } from './types.ts'
import { isZip, listZip, listZipFromHead } from './zip.ts'

export interface ClassifiedArtifact {
  readonly verdict: FormatVerdict
  readonly pickle: PickleObservation | null
  readonly tensorHeader: { readonly entries: number; readonly metadata: Record<string, string> } | null
  readonly containerMembers: readonly string[]
}

/** Extension-only guess, used when the bytes are unavailable or unhelpful. */
function byExtension(path: string): FormatId {
  switch (extname(path)) {
    case '.pkl':
    case '.pickle':
    case '.p':
      return 'pickle'
    case '.pt':
    case '.pth':
    case '.ckpt':
      return 'pytorch-zip'
    case '.ptl':
      return 'torchscript'
    case '.bin':
      return 'pytorch-zip'
    case '.joblib':
    case '.jbl':
      return 'joblib'
    case '.npy':
      return 'numpy-npy'
    case '.npz':
      return 'numpy-npz'
    case '.safetensors':
      return 'safetensors'
    case '.onnx':
      return 'onnx'
    case '.gguf':
    case '.ggml':
      return 'gguf'
    case '.tflite':
      return 'tflite'
    case '.h5':
    case '.hdf5':
      return 'keras-h5'
    case '.keras':
      return 'keras-v3'
    case '.msgpack':
      return 'flax-msgpack'
    case '.pb':
      return 'tf-savedmodel'
    default:
      return 'unknown'
  }
}

/** What a zip's member names say it is. */
function classifyZipMembers(members: readonly string[]): {
  format: FormatId
  note: string
} | null {
  const hasCode = members.some((m) => /(^|\/)code\//.test(m) || m.endsWith('.py'))
  const hasDataPkl = members.some((m) => /(^|\/)data\.pkl$/.test(m))
  const hasConstants = members.some((m) => /(^|\/)constants\.pkl$/.test(m))
  const hasKerasConfig = members.some((m) => m === 'config.json' || m === 'metadata.json')
  const allNpy = members.length > 0 && members.every((m) => m.endsWith('.npy'))

  if (hasCode && (hasDataPkl || hasConstants)) {
    return { format: 'torchscript', note: 'zip archive containing a code/ tree and a pickle stream' }
  }
  if (hasDataPkl) {
    return { format: 'pytorch-zip', note: 'zip archive containing a data.pkl member' }
  }
  if (hasKerasConfig) {
    return { format: 'keras-v3', note: 'zip archive containing config.json' }
  }
  if (allNpy) {
    return { format: 'numpy-npz', note: 'zip archive of .npy members' }
  }
  return null
}

/**
 * Classify one artifact from its bytes.
 *
 * `head` is the first ARTIFACT_HEAD_BYTES; `tail` the last ARTIFACT_TAIL_BYTES
 * with `tailOffset` its position in the file. Either may be empty, in which
 * case the verdict falls back to the extension and says so.
 */
export function classifyBytes(
  path: string,
  head: Uint8Array,
  tail: Uint8Array,
  tailOffset: number,
  fileSize: number,
): ClassifiedArtifact {
  const extGuess = byExtension(path)
  const ext = extname(path)
  let members: readonly string[] = []

  const finish = (
    format: FormatId,
    basis: FormatVerdict['basis'],
    note: string,
    extra?: Partial<ClassifiedArtifact>,
  ): ClassifiedArtifact => {
    const mismatch =
      basis !== 'extension' &&
      extGuess !== 'unknown' &&
      format !== 'unknown' &&
      !compatible(extGuess, format)
        ? `extension suggests ${formatSpec(extGuess).label}, bytes are ${formatSpec(format).label}`
        : undefined
    return {
      verdict: mismatch
        ? { format, basis, note, extensionMismatch: mismatch }
        : { format, basis, note },
      pickle: extra?.pickle ?? null,
      tensorHeader: extra?.tensorHeader ?? null,
      containerMembers: extra?.containerMembers ?? members,
    }
  }

  if (head.length === 0) {
    return finish(
      extGuess,
      extGuess === 'unknown' ? 'none' : 'extension',
      fileSize === 0
        ? 'file is empty'
        : 'file could not be read; classification falls back to the extension',
    )
  }

  /* --- container formats first: the member list settles the question ----- */
  if (isZip(head)) {
    const listing = tail.length > 0 ? listZip(tail, tailOffset) : { entries: [], partial: true }
    members =
      listing.entries.length > 0 ? listing.entries.map((e) => e.name) : listZipFromHead(head)
    const byMembers = classifyZipMembers(members)
    if (byMembers) {
      return finish(byMembers.format, 'container', byMembers.note)
    }
    if (ext === '.npz') return finish('numpy-npz', 'container', 'zip archive, .npz extension')
    return finish(
      extGuess === 'unknown' ? 'unknown' : extGuess,
      'container',
      members.length > 0
        ? `zip archive; members did not match a known model layout (${members.length} entries)`
        : 'zip archive; central directory was outside the bytes read',
    )
  }

  /* --- single-file magic numbers ----------------------------------------- */
  const gguf = readGguf(head)
  if (gguf) return finish('gguf', 'magic', `GGUF magic, format version ${gguf.version}`)

  if (isHdf5(head)) return finish('keras-h5', 'magic', 'HDF5 superblock signature')

  if (isTflite(head)) return finish('tflite', 'magic', 'FlatBuffer identifier TFL3 at offset 4')

  const npy = readNpy(head)
  if (npy) {
    return finish(
      'numpy-npy',
      'magic',
      npy.objectDtype
        ? `NumPy ${npy.version} header declaring an object dtype, which only loads with pickling enabled`
        : `NumPy ${npy.version} header with a numeric dtype`,
    )
  }

  const st = readSafetensorsHeader(head, fileSize)
  if (st) {
    return finish(
      'safetensors',
      'magic',
      st.entries > 0
        ? `length-prefixed JSON header, ${st.entries} tensor entries`
        : `length-prefixed JSON header of ${st.headerBytes} bytes`,
      { tensorHeader: { entries: st.entries, metadata: st.metadata } },
    )
  }

  if (looksLikePickle(head)) {
    const observation = readPickle(head)
    const format: FormatId =
      ext === '.pt' || ext === '.pth' || ext === '.ckpt'
        ? 'pytorch-legacy'
        : ext === '.joblib' || ext === '.jbl'
          ? 'joblib'
          : 'pickle'
    const protocol = observation.protocol === null ? 'protocol 0/1' : `protocol ${observation.protocol}`
    return finish(
      format,
      'magic',
      observation.invokesCallable
        ? `pickle stream, ${protocol}, ${observation.invokingOpcodes.join('/')} present`
        : `pickle stream, ${protocol}`,
      { pickle: observation },
    )
  }

  // zlib and lz4 wrappers are what joblib writes with compression on.
  if (ext === '.joblib' || ext === '.jbl') {
    const zlib = head[0] === 0x78
    const lz4 = head[0] === 0x04 && head[1] === 0x22 && head[2] === 0x4d && head[3] === 0x18
    if (zlib || lz4) {
      return finish(
        'joblib',
        'magic',
        `${zlib ? 'zlib' : 'lz4'}-compressed stream; joblib compresses a pickle and DEADWEIGHT does not decompress it to look`,
      )
    }
  }

  if (ext === '.onnx' && looksLikeOnnx(head)) {
    return finish('onnx', 'magic', 'protobuf beginning with an ir_version field')
  }
  if (ext === '.msgpack' && looksLikeMsgpack(head)) {
    return finish('flax-msgpack', 'magic', 'msgpack map marker')
  }
  if (ext === '.pb' || path.endsWith('saved_model.pb')) {
    return finish('tf-savedmodel', 'extension', 'SavedModel protobuf by filename')
  }
  if (looksLikeOnnx(head) && ext === '') {
    return finish('onnx', 'magic', 'protobuf beginning with an ir_version field')
  }

  if (extGuess !== 'unknown') {
    return finish(
      extGuess,
      'extension',
      'leading bytes matched no known signature; classification falls back to the extension',
    )
  }

  return finish('unknown', 'none', 'leading bytes matched no known signature')
}

/** Whether an extension guess and a byte verdict are the same thing. */
function compatible(guess: FormatId, actual: FormatId): boolean {
  if (guess === actual) return true
  const pytorchFamily: FormatId[] = ['pytorch-zip', 'pytorch-legacy', 'torchscript', 'pickle']
  if (pytorchFamily.includes(guess) && pytorchFamily.includes(actual)) return true
  if (guess === 'pickle' && actual === 'joblib') return true
  if (guess === 'joblib' && actual === 'pickle') return true
  return false
}

/** Read the slices one artifact needs and classify it. */
export async function classifyArtifact(
  tree: SourceTree,
  path: string,
  size: number,
): Promise<ClassifiedArtifact> {
  const head = (await tree.readBytes(path, 0, ARTIFACT_HEAD_BYTES)) ?? new Uint8Array(0)
  // Small files are their own tail, which saves a second read.
  const want = size > ARTIFACT_HEAD_BYTES ? Math.min(ARTIFACT_TAIL_BYTES, size) : 0
  const tail: Uint8Array =
    want === 0 ? head : ((await tree.readBytes(path, -want, want)) ?? new Uint8Array(0))
  const tailOffset = want === 0 ? 0 : size - tail.length
  return classifyBytes(path, head, tail, tailOffset, size)
}
