/**
 * Browser adapters.
 *
 * Two sources of a `SourceTree` in the tab: a directory the user picked, and
 * the bundled demo project. Both are handed to the same `analyze` the CLI
 * runs, so what a visitor sees the demo do is what the tool does.
 *
 * Nothing here uploads anything. The files are read through the File API in
 * the page and never leave it -- there is no `fetch` anywhere in the engine
 * or the app, and CI asserts that by scanning the built bundle.
 *
 * As in the CLI, an artifact is read in bounded slices for recognition and
 * streamed in chunks for hashing. `File.slice` makes that cheap: a
 * multi-gigabyte checkpoint costs two 64 KiB reads to classify.
 */

import { MAX_TREE_ENTRIES, SKIPPED_DIRECTORIES } from '../engine/limits.ts'
import { normalisePath } from '../engine/source.ts'
import type { SourceTree, TreeEntry } from '../engine/source.ts'
import { DEMO_FILES, DEMO_PROJECT_NAME } from '../demo-tree.generated.ts'
import { memoryTree } from '../engine/source.ts'
import type { MemoryFile } from '../engine/source.ts'

/* -------------------------------------------------------------------------- */
/* A picked directory                                                         */
/* -------------------------------------------------------------------------- */

export interface PickedTree {
  readonly tree: SourceTree
  readonly truncated: boolean
  readonly skipped: number
}

/**
 * Build a tree from the FileList a `<input type="file" webkitdirectory>`
 * produces.
 *
 * `webkitRelativePath` includes the picked directory as its first segment,
 * which is dropped so that paths are repository-relative and the same globs
 * work as in the CLI.
 */
export function treeFromFileList(files: FileList | readonly File[]): PickedTree {
  const list = Array.from(files as ArrayLike<File>)
  const byPath = new Map<string, File>()
  let skipped = 0
  let truncated = false

  for (const file of list) {
    if (byPath.size >= MAX_TREE_ENTRIES) {
      truncated = true
      break
    }
    const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name
    const segments = raw.split('/')
    const relative = segments.length > 1 ? segments.slice(1).join('/') : raw
    const path = normalisePath(relative)
    if (path === null) {
      skipped += 1
      continue
    }
    if (path.split('/').some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
      skipped += 1
      continue
    }
    byPath.set(path, file)
  }

  const root = list[0]
  const rootName =
    ((root as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath ?? '').split(
      '/',
    )[0] ?? 'project'

  const entries: TreeEntry[] = [...byPath.entries()]
    .map(([path, file]) => ({ path, size: file.size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const decoder = new TextDecoder('utf-8', { fatal: false })

  const tree: SourceTree = {
    name: rootName === '' ? 'project' : rootName,
    entries,
    async readText(path, maxBytes) {
      const file = byPath.get(path)
      if (file === undefined) return null
      try {
        const buffer = await file.slice(0, maxBytes).arrayBuffer()
        return decoder.decode(buffer)
      } catch {
        return null
      }
    },
    async readBytes(path, from, length) {
      const file = byPath.get(path)
      if (file === undefined) return null
      try {
        const start = from < 0 ? Math.max(0, file.size + from) : Math.min(from, file.size)
        const end = Math.min(file.size, start + length)
        if (end <= start) return new Uint8Array(0)
        return new Uint8Array(await file.slice(start, end).arrayBuffer())
      } catch {
        return null
      }
    },
    async *stream(path, chunkSize) {
      const file = byPath.get(path)
      if (file === undefined) return
      for (let at = 0; at < file.size; at += chunkSize) {
        try {
          yield new Uint8Array(await file.slice(at, Math.min(file.size, at + chunkSize)).arrayBuffer())
        } catch {
          return
        }
      }
    },
  }

  return { tree, truncated, skipped }
}

/**
 * Build a tree from a drag-and-drop, walking directory entries.
 *
 * Depth and entry count are bounded here as well as in the engine, because
 * the walk itself is the expensive part and a dropped home directory should
 * stop early rather than after reading forty thousand files.
 */
export async function treeFromDataTransfer(items: DataTransferItemList): Promise<PickedTree | null> {
  const roots: FileSystemEntry[] = []
  for (const item of Array.from(items)) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null })
      .webkitGetAsEntry?.()
    if (entry !== null && entry !== undefined) roots.push(entry)
  }
  if (roots.length === 0) return null

  const files: File[] = []
  let truncated = false
  let skipped = 0

  const readEntry = async (entry: FileSystemEntry, prefix: string, depth: number): Promise<void> => {
    if (truncated || depth > 24) return
    if (files.length >= MAX_TREE_ENTRIES) {
      truncated = true
      return
    }
    if (entry.isFile) {
      const file = await new Promise<File | null>((done) => {
        ;(entry as FileSystemFileEntry).file(
          (f) => done(f),
          () => done(null),
        )
      })
      if (file === null) {
        skipped += 1
        return
      }
      Object.defineProperty(file, 'webkitRelativePath', {
        value: `${prefix}${file.name}`,
        configurable: true,
      })
      files.push(file)
      return
    }
    if (!entry.isDirectory) return
    if (SKIPPED_DIRECTORIES.has(entry.name) && depth > 0) {
      skipped += 1
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries returns at most 100 at a time and signals the end with [].
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((done) => {
        reader.readEntries(
          (list) => done(list),
          () => done([]),
        )
      })
      if (batch.length === 0) break
      for (const child of batch) {
        await readEntry(child, `${prefix}${entry.name}/`, depth + 1)
      }
    }
  }

  for (const root of roots) await readEntry(root, '', 0)
  if (files.length === 0) return null

  const built = treeFromFileList(files)
  return { ...built, truncated: built.truncated || truncated, skipped: built.skipped + skipped }
}

/* -------------------------------------------------------------------------- */
/* The demo project                                                           */
/* -------------------------------------------------------------------------- */

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** The bundled synthetic project, as a tree the real engine can analyse. */
export function demoTree(): SourceTree {
  const files: MemoryFile[] = DEMO_FILES.map((file) =>
    file.base64 === undefined
      ? { path: file.path, text: file.text ?? '' }
      : { path: file.path, bytes: decodeBase64(file.base64) },
  )
  return memoryTree(DEMO_PROJECT_NAME, files)
}

export { DEMO_PROJECT_NAME }
