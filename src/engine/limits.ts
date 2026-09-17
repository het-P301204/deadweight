/**
 * Hard limits.
 *
 * DEADWEIGHT is pointed at code it did not write, in a directory it was handed
 * by someone who may not have looked inside it. Every read is bounded before
 * it happens, and every bound is named here rather than inlined, so that the
 * threat model in SECURITY.md can point at one file.
 */

/** Longest repo-relative path accepted. Anything longer is skipped with a notice. */
export const MAX_PATH_LENGTH = 1024

/** Deepest directory nesting walked. Guards against symlink and junction loops. */
export const MAX_WALK_DEPTH = 24

/** Most entries the walker will visit in one analysis. */
export const MAX_TREE_ENTRIES = 40_000

/** Largest source file read in full for scanning. Larger files are skipped. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024

/** Largest notebook read. Notebooks carry base64 outputs and get big fast. */
export const MAX_NOTEBOOK_BYTES = 8 * 1024 * 1024

/** Largest manifest / lockfile / evidence document read. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

/**
 * Bytes read from the head of a binary artifact for format classification.
 * The analyser never reads an artifact in order to interpret it, only to
 * recognise it; 64 KiB reaches the zip central directory of a small archive
 * and the whole header of a safetensors file.
 */
export const ARTIFACT_HEAD_BYTES = 64 * 1024

/** Bytes read from the tail, for zip central directories in larger archives. */
export const ARTIFACT_TAIL_BYTES = 64 * 1024

/**
 * Largest artifact hashed end to end. Above this the digest covers the head,
 * the tail and the length, and is labelled `head-tail` so that evidence
 * binding never silently compares it with a scanner's full-file hash.
 */
export const MAX_FULL_DIGEST_BYTES = 256 * 1024 * 1024

/** Pickle opcodes scanned before the reader gives up and reports truncation. */
export const MAX_PICKLE_OPCODES = 20_000

/** Bytes of a pickle stream the opcode reader will walk. */
export const MAX_PICKLE_BYTES = 1024 * 1024

/** Largest safetensors header accepted. The spec has no limit; memory does. */
export const MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024

/** Zip entries enumerated per archive. */
export const MAX_ZIP_ENTRIES = 4096

/** Longest single source line scanned. Minified bundles are not source. */
export const MAX_LINE_LENGTH = 4000

/** Source lines scanned per file. */
export const MAX_LINES = 60_000

/**
 * Characters retained of any identifier read out of an artifact's bytes: a
 * pickle global, a container member name, a tensor metadata key or value.
 *
 * These are the only strings in the recognition path that come from the
 * artifact itself rather than from source code, and they reach both the JSON
 * report and the terminal. Unclipped, one of them can be as long as the
 * entire head slice -- a 64 KiB name produced a 65,000-character line in a
 * report about a 64 KiB file.
 */
export const MAX_IDENTIFIER_CHARS = 200

/** Characters of a call snippet retained for display. */
export const MAX_SNIPPET_CHARS = 220

/** Characters of any single argument retained. */
export const MAX_ARG_CHARS = 160

/** Notebook cells read per notebook. */
export const MAX_NOTEBOOK_CELLS = 2000

/** Evidence records ingested per document. */
export const MAX_EVIDENCE_RECORDS = 5000

/** Directory names never walked. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'build',
  'target',
  '.gradle',
  '.idea',
  '.vscode-test',
  'site-packages',
  '.terraform',
])

/**
 * Truncate a display string on a character boundary and mark it, so that a
 * long line in someone else's repository cannot push a wall of text into a
 * report or a terminal.
 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/**
 * Strip control characters from anything that came out of a scanned file
 * before it reaches a terminal. A filename containing an ANSI escape or a
 * bidirectional override is a real technique for making a report say
 * something other than what it found.
 */
// Built from a string so the source file itself stays free of the very
// characters it is filtering. Every codepoint is written as an escape.
const CONTROL = new RegExp(
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F' +
    '\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]',
  'g',
)

export function sanitise(text: string): string {
  return text.replace(CONTROL, '\uFFFD')
}
