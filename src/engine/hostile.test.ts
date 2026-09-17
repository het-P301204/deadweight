/**
 * Work the analysed repository can make the analyser do.
 *
 * Every other test here asks whether the analysis is *right*. These ask
 * whether it *finishes*, because DEADWEIGHT is pointed at code it did not
 * write and a file that makes it hang is a denial of service delivered by
 * the thing being analysed. Three of these were failing when they were
 * written:
 *
 *   A 2 MB line took about three quarters of an hour, because the expression
 *   that found calls backtracked quadratically over runs of name characters.
 *
 *   Sixteen thousand load sites against one artifact took 7.9 seconds, and
 *   forty thousand took 51, because resolving a reference scanned every path
 *   in the tree and the same reference was resolved twice.
 *
 *   Sibling lookup walked the whole tree once per artifact.
 *
 * The budgets are deliberately loose -- roughly a hundred times the measured
 * cost -- so that a slow machine does not fail the suite while a return of
 * quadratic behaviour still does.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { analyze } from './analyze.ts'
import { callSites } from './scan.ts'
import { memoryTree } from './source.ts'
import type { MemoryFile } from './source.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

/** Milliseconds a case may take. Generous; the point is the exponent. */
const BUDGET = 20_000

async function timed(files: readonly MemoryFile[]): Promise<number> {
  const started = performance.now()
  await analyze(memoryTree('hostile', files))
  return performance.now() - started
}

describe('work the analysed tree can demand', () => {
  it('scans a 2 MB single line', async () => {
    // A minified bundle. `MAX_SOURCE_BYTES` permits it, so it has to be read,
    // and reading it has to stay linear.
    expect(await timed([{ path: 'src/bundle.js', text: `x = ${'a'.repeat(2_000_000)}` }])).toBeLessThan(
      BUDGET,
    )
  })

  it('scans many long lines of near-miss loader text', async () => {
    const line = `torch${'a'.repeat(3900)}`
    const text = Array.from({ length: 2000 }, () => line).join('\n')
    expect(await timed([{ path: 'src/a.py', text }])).toBeLessThan(BUDGET)
  })

  it('resolves ten thousand load sites against one artifact', async () => {
    const files: MemoryFile[] = Array.from({ length: 10_000 }, (_, i) => ({
      path: `src/m${i}/f.py`,
      text: 'import torch\ntorch.load("model.pt")\n',
    }))
    files.push({ path: 'model.pt', bytes: new Uint8Array([0x80, 4, 0x95]) })
    expect(await timed(files)).toBeLessThan(BUDGET)
  })

  it('resolves ten thousand load sites whose target is not in the tree', async () => {
    // The unresolved path is the adversarial one: the reference cannot be
    // found, so the cheap exact-path lookup never hits.
    const files: MemoryFile[] = Array.from({ length: 10_000 }, (_, i) => ({
      path: `src/m${i}/f.py`,
      text: 'import torch\ntorch.load("nowhere.pt")\n',
    }))
    expect(await timed(files)).toBeLessThan(BUDGET)
  })

  it('handles two thousand artifacts sharing a directory', async () => {
    // Sibling lookup is per artifact; one directory holding all of them is
    // the case that used to be quadratic.
    const files: MemoryFile[] = []
    for (let i = 0; i < 2000; i += 1) {
      files.push({ path: `weights/m${i}.pt`, bytes: new Uint8Array([0x80, 4, 0x95]) })
      files.push({ path: `weights/m${i}.safetensors`, bytes: new Uint8Array(16) })
    }
    files.push({ path: 'src/load.py', text: 'import torch\ntorch.load("weights/m0.pt")\n' })
    expect(await timed(files)).toBeLessThan(BUDGET)
  })

  it('walks a pickle of two hundred thousand REDUCE opcodes', async () => {
    const bytes = new Uint8Array(200_002)
    bytes[0] = 0x80
    bytes[1] = 0x04
    bytes.fill(0x52, 2)
    expect(
      await timed([
        { path: 'model.pkl', bytes },
        { path: 'src/a.py', text: 'import torch\ntorch.load("model.pkl")\n' },
      ]),
    ).toBeLessThan(BUDGET)
  })

  it('reads a safetensors header claiming to be larger than the file', async () => {
    const bytes = new Uint8Array(72)
    // A 2^53-ish little-endian header length in front of 64 bytes of nothing.
    bytes.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00], 0)
    expect(await timed([{ path: 'model.safetensors', bytes }])).toBeLessThan(BUDGET)
  })

  it('reads a zip end-record claiming four billion entries', async () => {
    const bytes = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...new Array<number>(100).fill(0), 0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0,
    ])
    expect(await timed([{ path: 'model.zip', bytes }])).toBeLessThan(BUDGET)
  })

  it('reads a notebook nested a hundred thousand deep', async () => {
    const text = `{"cells":${'['.repeat(100_000)}${']'.repeat(100_000)}}`
    expect(await timed([{ path: 'n.ipynb', text }])).toBeLessThan(BUDGET)
  })
})

/**
 * The linear call finder against the expression it replaced.
 *
 * The old pattern is the specification here: the rewrite was for speed, and a
 * rewrite for speed that changes what is found is a regression in the only
 * thing the product does. Keeping the expression in the test is the cheapest
 * way to keep that promise checkable.
 */
describe('callSites matches the expression it replaced', () => {
  const REFERENCE = /([A-Za-z_][\w.]*)[ \t]*\(/g

  const cases = [
    'torch.load("m.pt")',
    'torch.load ("m.pt")',
    'torch.load\t("m.pt")',
    'torch.load  ("m.pt")',
    '1foo("x")',
    '.foo("x")',
    '..foo("x")',
    '_private("x")',
    'a.b.c.d("x")',
    'outer(inner(deep("x")))',
    '(',
    '()',
    '  (  )',
    'foo .bar("x")',
    'no_call_here',
    'x = (1 + 2)',
    'def f(a, b):\n    return g(a)(b)',
    'a(b(c(d(e(f(g("x")))))))',
    'obj.method().chained()',
    'numpy.load(f"{d}/m.npy", allow_pickle=True)',
    'keras.models.load_model("m.keras", safe_mode=False)',
    'pickle .loads(blob)',
    'A1(', // digit inside a name, not at the start
    '9(',
    '_(',
    '.(',
    'a\n(',
  ]

  for (const source of cases) {
    it(`agrees on ${JSON.stringify(source)}`, () => {
      REFERENCE.lastIndex = 0
      const expected = [...source.matchAll(REFERENCE)].map((match) => ({
        index: match.index,
        name: match[1] as string,
        open: (match.index ?? 0) + (match[0] as string).length - 1,
      }))
      expect([...callSites(source)]).toEqual(expected)
    })
  }

  it('agrees on a long generated source file', () => {
    // Long enough to exercise every branch, short enough that the reference
    // expression still returns this decade.
    const lines: string[] = []
    for (let i = 0; i < 400; i += 1) {
      lines.push(`import torch${i}`)
      lines.push(`  value_${i} = torch.load ("w/${i}.pt", weights_only=False)`)
      lines.push(`# a comment with parens ( and a name( in it`)
      lines.push(`obj${i}.method${i}(arg${i}(nested${i}()))`)
    }
    const source = lines.join('\n')
    REFERENCE.lastIndex = 0
    const expected = [...source.matchAll(REFERENCE)].map((match) => ({
      index: match.index,
      name: match[1] as string,
      open: (match.index ?? 0) + (match[0] as string).length - 1,
    }))
    expect([...callSites(source)]).toEqual(expected)
  })
})

/**
 * No source file may contain a control character.
 *
 * Three did. `FILLER` was a literal U+0001, so the line read
 * `export const FILLER = ''` and looked like an empty string; the NUL check
 * in the path normaliser was a literal NUL, which made the file *binary* to
 * `git`, `grep` and GitHub's blob viewer; and the malformed-corpus test
 * embedded NUL and escape bytes in a character class. All three worked and
 * none of them could be read, which for a project about bytes in files
 * somebody else wrote is the wrong way round. Build them from code points.
 */
describe('source hygiene', () => {
  const ALLOWED = new Set([9, 10, 13])

  async function sources(directory: string): Promise<string[]> {
    const out: string[] = []
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, item.name)
      if (item.isDirectory()) out.push(...(await sources(full)))
      else if (/\.(ts|tsx|css|js|json|md|html|yml)$/.test(item.name)) out.push(full)
    }
    return out
  }

  it('has no control characters in any source file', async () => {
    const files = [
      ...(await sources(join(ROOT, 'src'))),
      ...(await sources(join(ROOT, 'bin'))),
      ...(await sources(join(ROOT, 'scripts'))),
    ]
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i)
        if (code === 127 || (code < 32 && !ALLOWED.has(code))) {
          offenders.push(`${relative(ROOT, file)} has U+${code.toString(16).padStart(4, '0')}`)
          break
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
