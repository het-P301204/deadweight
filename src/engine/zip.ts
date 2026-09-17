/**
 * A zip central-directory reader that lists names and nothing else.
 *
 * PyTorch archives, Keras v3 files and .npz files are all zips, and what they
 * contain tells you what loading them will do -- a `data.pkl` member means a
 * pickle stream, a `code/` tree means TorchScript, a `config.json` means a
 * Keras architecture. Reading the member *names* answers that. Reading the
 * member *contents* is not necessary and is not done: nothing here
 * decompresses, and the reader never allocates a buffer sized by a field in
 * the file.
 *
 * Only the central directory is parsed, from the end-of-central-directory
 * record, and every offset is validated against the slice actually in hand.
 */

import { MAX_IDENTIFIER_CHARS, MAX_ZIP_ENTRIES, clip, sanitise } from './limits.ts'

/**
 * A member name as it will be reported. Same reasoning as the pickle reader:
 * these bytes are chosen by the archive, and a name carrying an ANSI escape
 * or running to the end of the slice must not reach a report or a terminal.
 */
function reportable(text: string): string {
  return clip(sanitise(text), MAX_IDENTIFIER_CHARS)
}

export interface ZipEntry {
  readonly name: string
  readonly compressedSize: number
  readonly uncompressedSize: number
}

export interface ZipListing {
  readonly entries: readonly ZipEntry[]
  /** True when the directory was found but only partially inside the slice. */
  readonly partial: boolean
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

const UTF8 = new TextDecoder('utf-8', { fatal: false })

function u16(d: Uint8Array, at: number): number {
  return (d[at] as number) | ((d[at + 1] as number) << 8)
}

function u32(d: Uint8Array, at: number): number {
  return (
    (((d[at] as number) |
      ((d[at + 1] as number) << 8) |
      ((d[at + 2] as number) << 16) |
      ((d[at + 3] as number) << 24)) >>>
      0)
  )
}

/** True when the buffer starts with a zip local file header. */
export function isZip(head: Uint8Array): boolean {
  return head.length >= 4 && u32(head, 0) === SIG_LOCAL
}

/**
 * List members from a buffer that contains the end of the archive.
 *
 * `tailOffset` is the absolute offset of `tail[0]` within the file, so that
 * the central directory offset recorded in the EOCD can be translated into an
 * index inside the slice. When the directory starts before the slice does,
 * the listing comes back empty and `partial` is true rather than guessing.
 */
export function listZip(tail: Uint8Array, tailOffset: number): ZipListing {
  const eocd = findEocd(tail)
  if (eocd === -1) return { entries: [], partial: true }

  const count = u16(tail, eocd + 10)
  const dirOffset = u32(tail, eocd + 16)
  const start = dirOffset - tailOffset

  // `Number.isInteger` rather than just the range check: a NaN `start` makes
  // both comparisons false, so the guard passed and the loop bound `at + 46 >
  // tail.length` was false too. Nothing in the tree can reach that today --
  // `classifyArtifact` always passes a literal offset -- but this is exported
  // engine API and the guard should not depend on a caller being careful.
  if (!Number.isInteger(start) || start < 0 || start >= tail.length) {
    return { entries: [], partial: true }
  }

  const entries: ZipEntry[] = []
  let at = start
  let partial = false

  for (let i = 0; i < Math.min(count, MAX_ZIP_ENTRIES); i += 1) {
    if (at + 46 > tail.length) {
      partial = true
      break
    }
    if (u32(tail, at) !== SIG_CENTRAL) {
      partial = true
      break
    }
    const nameLength = u16(tail, at + 28)
    const extraLength = u16(tail, at + 30)
    const commentLength = u16(tail, at + 32)
    const compressedSize = u32(tail, at + 20)
    const uncompressedSize = u32(tail, at + 24)
    const nameStart = at + 46
    if (nameStart + nameLength > tail.length) {
      partial = true
      break
    }
    const name = reportable(UTF8.decode(tail.subarray(nameStart, nameStart + nameLength)))
    entries.push({ name, compressedSize, uncompressedSize })
    at = nameStart + nameLength + extraLength + commentLength
  }

  if (entries.length < count) partial = true
  return { entries, partial }
}

/**
 * Locate the end-of-central-directory record.
 *
 * It sits at the end of the file, followed by a comment of up to 65535 bytes.
 * The scan runs backwards over at most that window plus the record, which
 * bounds the work regardless of how large the archive claims to be.
 */
function findEocd(tail: Uint8Array): number {
  const window = Math.min(tail.length, 0xffff + 22)
  for (let at = tail.length - 22; at >= tail.length - window; at -= 1) {
    if (at < 0) break
    if (u32(tail, at) === SIG_EOCD) return at
  }
  return -1
}

/** Read member names from the local headers at the front of an archive. */
export function listZipFromHead(head: Uint8Array): readonly string[] {
  const names: string[] = []
  let at = 0
  while (at + 30 <= head.length && names.length < MAX_ZIP_ENTRIES) {
    if (u32(head, at) !== SIG_LOCAL) break
    const nameLength = u16(head, at + 26)
    const extraLength = u16(head, at + 28)
    const compressedSize = u32(head, at + 18)
    const nameStart = at + 30
    if (nameStart + nameLength > head.length) break
    names.push(reportable(UTF8.decode(head.subarray(nameStart, nameStart + nameLength))))
    // A streamed archive writes sizes to a trailing data descriptor and zero
    // here, so walking forward stops being reliable; the caller still has the
    // first name, which is the one that identifies the archive kind.
    if (compressedSize === 0) break
    at = nameStart + nameLength + extraLength + compressedSize
  }
  return names
}
