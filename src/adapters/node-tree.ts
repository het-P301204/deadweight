/**
 * Node filesystem adapter.
 *
 * Turns a directory on disk into a `SourceTree`. This is the only file in the
 * CLI path that touches `node:fs`, which keeps the engine runnable in a
 * browser tab unchanged.
 *
 * The walk is defensive in three ways that matter for a tool pointed at an
 * unfamiliar repository:
 *
 *   Symbolic links are listed and not followed. A link pointing at `/` turns
 *   an unbounded walk into an unbounded walk of the whole machine, and a link
 *   pointing back up the tree turns it into a loop.
 *
 *   Every path is normalised and rejected -- not repaired -- if it escapes the
 *   root, and every read re-derives the absolute path from the root rather
 *   than trusting a path that came out of a listing.
 *
 *   Depth, entry count and the skip list are enforced during the walk, not
 *   after it.
 */

import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { MAX_TREE_ENTRIES, MAX_WALK_DEPTH, SKIPPED_DIRECTORIES } from '../engine/limits.ts'
import { normalisePath } from '../engine/source.ts'
import type { SourceTree, TreeEntry } from '../engine/source.ts'

export interface WalkResult {
  readonly tree: SourceTree
  readonly truncated: boolean
  readonly skippedDirectories: number
}

export async function walkDirectory(root: string, name?: string): Promise<WalkResult> {
  const absoluteRoot = resolve(root)
  const info = await stat(absoluteRoot)
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`)

  const entries: TreeEntry[] = []
  let truncated = false
  let skippedDirectories = 0

  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || truncated) return
    let listing
    try {
      listing = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of listing) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true
        return
      }
      const childRelative = relative === '' ? item.name : `${relative}/${item.name}`
      const normalised = normalisePath(childRelative)
      if (normalised === null) continue

      if (item.isSymbolicLink()) {
        entries.push({ path: normalised, size: 0, link: true })
        continue
      }
      if (item.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(item.name)) {
          skippedDirectories += 1
          continue
        }
        await visit(join(directory, item.name), normalised, depth + 1)
        continue
      }
      if (!item.isFile()) continue
      try {
        const fileInfo = await stat(join(directory, item.name))
        entries.push({ path: normalised, size: fileInfo.size })
      } catch {
        entries.push({ path: normalised, size: 0 })
      }
    }
  }

  await visit(absoluteRoot, '', 0)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  /** Re-derive the absolute path from the root and refuse anything outside it. */
  const absolute = (path: string): string | null => {
    const normalised = normalisePath(path)
    if (normalised === null) return null
    const full = resolve(absoluteRoot, ...normalised.split('/'))
    if (!full.startsWith(absoluteRoot + sep) && full !== absoluteRoot) return null
    if (isAbsolute(normalised)) return null
    return full
  }

  const tree: SourceTree = {
    name: name ?? absoluteRoot.split(sep).filter(Boolean).pop() ?? absoluteRoot,
    entries,
    async readText(path, maxBytes) {
      const full = absolute(path)
      if (full === null) return null
      let handle
      try {
        handle = await open(full, 'r')
        const buffer = Buffer.alloc(maxBytes)
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
        return buffer.subarray(0, bytesRead).toString('utf8')
      } catch {
        return null
      } finally {
        await handle?.close()
      }
    },
    async readBytes(path, from, length) {
      const full = absolute(path)
      if (full === null) return null
      let handle
      try {
        handle = await open(full, 'r')
        const info = await handle.stat()
        const start = from < 0 ? Math.max(0, info.size + from) : Math.min(from, info.size)
        const want = Math.max(0, Math.min(length, info.size - start))
        if (want === 0) return new Uint8Array(0)
        const buffer = Buffer.alloc(want)
        const { bytesRead } = await handle.read(buffer, 0, want, start)
        return new Uint8Array(buffer.subarray(0, bytesRead))
      } catch {
        return null
      } finally {
        await handle?.close()
      }
    },
    async *stream(path, chunkSize) {
      const full = absolute(path)
      if (full === null) return
      const source = createReadStream(full, { highWaterMark: chunkSize })
      try {
        for await (const chunk of source) {
          yield new Uint8Array(chunk as Buffer)
        }
      } catch {
        // A file that disappears mid-hash yields what was read; the digest is
        // then marked incomplete by the caller rather than thrown away.
      } finally {
        source.destroy()
      }
    },
  }

  return { tree, truncated, skippedDirectories }
}
