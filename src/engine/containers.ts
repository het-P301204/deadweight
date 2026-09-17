/**
 * Header readers for the data-oriented formats.
 *
 * Each one reads the smallest prefix that proves what the file is. The
 * safetensors reader is the interesting case: its header is JSON, and parsing
 * that JSON is the whole of "loading" the metadata, which is precisely the
 * property that makes the format a safe alternative. It is still parsed under
 * a size cap, with the declared length validated against the file, because a
 * header claiming to be four gigabytes is a thing a file can claim.
 */

import { MAX_SAFETENSORS_HEADER_BYTES } from './limits.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: false })

export interface SafetensorsHeader {
  readonly entries: number
  readonly metadata: Record<string, string>
  readonly dtypes: readonly string[]
  readonly headerBytes: number
}

/**
 * Parse a safetensors header from the first bytes of the file.
 *
 * Layout: 8-byte little-endian header length, then that many bytes of JSON,
 * then raw tensor buffers. Returns null when the prefix is not a safetensors
 * header, without throwing on anything a hostile file can contain.
 */
export function readSafetensorsHeader(
  head: Uint8Array,
  fileSize: number,
): SafetensorsHeader | null {
  if (head.length < 9) return null

  let length = 0
  for (let i = 7; i >= 0; i -= 1) length = length * 256 + (head[i] as number)

  if (!Number.isFinite(length) || length <= 1) return null
  if (length > MAX_SAFETENSORS_HEADER_BYTES) return null
  // The header cannot be longer than the file that contains it.
  if (fileSize > 0 && length + 8 > fileSize) return null
  if (head[8] !== 0x7b) return null // '{'

  const available = Math.min(length, head.length - 8)
  const text = UTF8.decode(head.subarray(8, 8 + available))
  if (available < length) {
    // Header is longer than the slice read. It is still identifiably
    // safetensors, which is what the caller needs.
    return { entries: 0, metadata: {}, dtypes: [], headerBytes: length }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const metadata: Record<string, string> = {}
  const dtypes = new Set<string>()
  let entries = 0

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // `__proto__` from a parsed document is why this builds a fresh object
    // with explicit assignment rather than spreading the parse result.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (key === '__metadata__') {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [mk, mv] of Object.entries(value as Record<string, unknown>)) {
          if (mk === '__proto__' || mk === 'constructor' || mk === 'prototype') continue
          if (typeof mv === 'string') metadata[mk] = mv.slice(0, 256)
        }
      }
      continue
    }
    entries += 1
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const dtype = (value as Record<string, unknown>)['dtype']
      if (typeof dtype === 'string') dtypes.add(dtype)
    }
  }

  return { entries, metadata, dtypes: [...dtypes].sort(), headerBytes: length }
}

/** GGUF: magic `GGUF`, then a little-endian version. */
export function readGguf(head: Uint8Array): { version: number } | null {
  if (head.length < 8) return null
  if (head[0] !== 0x47 || head[1] !== 0x47 || head[2] !== 0x55 || head[3] !== 0x46) return null
  const version =
    (head[4] as number) |
    ((head[5] as number) << 8) |
    ((head[6] as number) << 16) |
    ((head[7] as number) << 24)
  return { version }
}

/** HDF5 superblock signature, which is what a Keras .h5 file opens with. */
export function isHdf5(head: Uint8Array): boolean {
  const sig = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length < sig.length) return false
  return sig.every((b, i) => head[i] === b)
}

/** TensorFlow Lite FlatBuffer: the identifier `TFL3` sits at offset 4. */
export function isTflite(head: Uint8Array): boolean {
  if (head.length < 8) return false
  return head[4] === 0x54 && head[5] === 0x46 && head[6] === 0x4c && head[7] === 0x33
}

/** NumPy .npy: magic `\x93NUMPY`. Also reports whether the dtype is object. */
export function readNpy(head: Uint8Array): { objectDtype: boolean; version: string } | null {
  const sig = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]
  if (head.length < 10) return null
  if (!sig.every((b, i) => head[i] === b)) return null
  const major = head[6] as number
  const minor = head[7] as number
  const headerLength =
    major === 1
      ? (head[8] as number) | ((head[9] as number) << 8)
      : ((head[8] as number) |
          ((head[9] as number) << 8) |
          ((head[10] as number) << 16) |
          ((head[11] as number) << 24)) >>>
        0
  const start = major === 1 ? 10 : 12
  const available = Math.min(headerLength, Math.max(0, head.length - start))
  const dict = UTF8.decode(head.subarray(start, start + available))
  // An object dtype is written `'descr': '|O'`, and it is the one case where
  // reading a .npy can unpickle.
  const objectDtype = /'descr':\s*'[<>|]?O/.test(dict)
  return { objectDtype, version: `${major}.${minor}` }
}

/**
 * ONNX is a protobuf with no magic number. The heuristic is the one the
 * format allows: field 1 (`ir_version`, a varint) encodes as tag byte 0x08,
 * and real models carry a `producer_name` or an `onnx` string early on.
 */
export function looksLikeOnnx(head: Uint8Array): boolean {
  if (head.length < 8) return false
  if (head[0] !== 0x08) return false
  const window = UTF8.decode(head.subarray(0, Math.min(head.length, 4096)))
  return (
    /pytorch|onnx|tf2onnx|keras2onnx|skl2onnx|producer|ai\.onnx/i.test(window) ||
    // A minimal graph may name none of those; accept a plausible ir_version.
    ((head[1] as number) > 0 && (head[1] as number) < 32)
  )
}

/** msgpack maps start with a fixmap, map16 or map32 marker. */
export function looksLikeMsgpack(head: Uint8Array): boolean {
  if (head.length < 2) return false
  const b = head[0] as number
  return (b >= 0x80 && b <= 0x8f) || b === 0xde || b === 0xdf
}
