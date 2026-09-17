/**
 * Notebook reading.
 *
 * A notebook is JSON, and the code in it is a list of source lines per cell.
 * Concatenating the code cells produces something the Python scanner can read
 * directly, with a line map back to the cell it came from -- which matters,
 * because "cell 7" is how a person navigates a notebook and "line 214 of the
 * ipynb" is not.
 *
 * Outputs are never read. They are the largest part of a notebook by far,
 * they routinely contain base64 images, and nothing in DEADWEIGHT's question
 * depends on them.
 */

import { MAX_NOTEBOOK_CELLS } from './limits.ts'

export interface NotebookCode {
  /** Concatenated source of every code cell, newline separated. */
  readonly source: string
  /** For each 1-indexed line of `source`, the 1-indexed code cell it came from. */
  readonly cellOfLine: readonly number[]
  readonly cellCount: number
}

export function readNotebook(text: string): NotebookCode | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const cells = (doc as Record<string, unknown>)['cells']
  if (!Array.isArray(cells)) return null

  const lines: string[] = []
  const cellOfLine: number[] = []
  let codeCells = 0

  for (const cell of cells.slice(0, MAX_NOTEBOOK_CELLS)) {
    if (cell === null || typeof cell !== 'object') continue
    const record = cell as Record<string, unknown>
    if (record['cell_type'] !== 'code') continue
    codeCells += 1
    const source = record['source']
    const body =
      typeof source === 'string'
        ? source.split('\n')
        : Array.isArray(source)
          ? source.flatMap((s) => (typeof s === 'string' ? s.replace(/\n$/, '').split('\n') : []))
          : []
    for (const line of body) {
      // Cell magics and shell escapes are not Python and would confuse the
      // scanner's bracket matching; blank them but keep the line, so numbers
      // stay aligned with the notebook.
      lines.push(/^\s*[!%]/.test(line) ? '' : line)
      cellOfLine.push(codeCells)
    }
    // A blank separator so a statement at the end of one cell cannot join a
    // statement at the start of the next.
    lines.push('')
    cellOfLine.push(codeCells)
  }

  if (codeCells === 0) return null
  return { source: lines.join('\n'), cellOfLine, cellCount: codeCells }
}

export function cellForLine(notebook: NotebookCode, line: number): number | null {
  return notebook.cellOfLine[line - 1] ?? null
}
