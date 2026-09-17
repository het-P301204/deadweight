/**
 * The malformed corpus.
 *
 * `fixtures/malformed/` is walked rather than listed, so adding a fixture
 * adds a test. Two sets of assertions:
 *
 *   The tree as a whole must analyse. The analyser is pointed at code it did
 *   not write, and "it threw" is not an acceptable answer to a file someone
 *   committed.
 *
 *   The configuration fixtures must each *raise*, with a message that names
 *   the problem. A configuration DEADWEIGHT could not understand and silently
 *   ignored would leave every load context mislabelled.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { analyze } from './analyze.ts'
import { readConfig } from './config.ts'
import { AnalysisError } from './errors.ts'
import { memoryTree } from './source.ts'
import type { MemoryFile } from './source.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const CORPUS = join(ROOT, 'fixtures', 'malformed')

/**
 * Control characters that must never reach a report, built from their code
 * points. Writing the class as a literal put raw NUL and escape bytes in this
 * file, which made `git` treat the whole thing as binary -- so the test most
 * worth reading was the one nobody could read.
 */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(27)}]`,
)

/**
 * Every string anywhere in a value that carries a control character.
 *
 * Returns the offenders rather than a boolean so a failure names the field.
 * Walks the object because the serialised form cannot be tested: see the
 * assertion below.
 */
export function offendingStrings(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return CONTROL_CHARACTERS.test(value) ? [`${path} = ${JSON.stringify(value.slice(0, 80))}`] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, at) => offendingStrings(item, `${path}[${at}]`))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => {
      // A hostile key is as much of a problem as a hostile value.
      const here = CONTROL_CHARACTERS.test(key) ? [`${path} has key ${JSON.stringify(key)}`] : []
      return [...here, ...offendingStrings(item, `${path}.${key}`)]
    })
  }
  return []
}

async function walk(directory: string): Promise<string[]> {
  const out: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) out.push(...(await walk(path)))
    else if (item.isFile()) out.push(path)
  }
  return out
}

const absolute = await walk(CORPUS)
const paths = absolute.map((p) => relative(CORPUS, p).split(sep).join('/')).sort()

/** The corpus as one tree, with the configuration fixtures left out. */
async function corpusTree(): Promise<MemoryFile[]> {
  const files: MemoryFile[] = []
  for (const path of paths) {
    if (path.startsWith('config/')) continue
    files.push({ path, bytes: new Uint8Array(await readFile(join(CORPUS, path))) })
  }
  return files
}

describe('the malformed corpus', () => {
  it('has fixtures to test', () => {
    expect(paths.length).toBeGreaterThan(15)
  })

  it('analyses as one tree without throwing', async () => {
    const report = await analyze(memoryTree('malformed', await corpusTree()))
    expect(report.schema).toBe('deadweight.report/1')
  })

  it('analyses each artifact fixture on its own without throwing', async () => {
    for (const path of paths.filter((p) => p.startsWith('weights/'))) {
      const tree = memoryTree('one', [
        { path, bytes: new Uint8Array(await readFile(join(CORPUS, path))) },
        { path: 'requirements.txt', text: 'torch==2.5.1\n' },
      ])
      await expect(analyze(tree), path).resolves.toBeDefined()
    }
  })

  it('produces a complete record for every artifact it reports', async () => {
    const report = await analyze(memoryTree('malformed', await corpusTree()))
    for (const record of report.records) {
      expect(record.stripe, record.artifact.locator).toHaveLength(6)
      expect(record.behaviour.mechanism.length).toBeGreaterThan(0)
      expect(record.alternative.summary.length).toBeGreaterThan(0)
      if (record.behaviour.behaviour === 'unknown') {
        expect(record.behaviour.unknownReason, record.artifact.locator).not.toBeNull()
      }
    }
  })

  it('never reports a malformed artifact as data only', async () => {
    const report = await analyze(memoryTree('malformed', await corpusTree()))
    for (const record of report.records) {
      // Every artifact in this corpus is broken, mislabelled or unreadable.
      // None of them has earned a clean verdict.
      if (record.artifact.locator.startsWith('weights/')) {
        expect(record.behaviour.behaviour, record.artifact.locator).not.toBe('data')
      }
    }
  })

  it('emits nothing with a control character in it', async () => {
    const report = await analyze(memoryTree('malformed', await corpusTree()))
    // Walked over the live object, not over `JSON.stringify(report)`.
    // Serialising escapes every control character into a `\uXXXX` sequence of
    // ASCII, so the previous form of this assertion could never match and
    // passed on every input -- which is why a pickle able to write ANSI
    // escapes into the report went unnoticed until someone looked.
    expect(offendingStrings(report)).toEqual([])
  })

  it('does not let a prototype-polluting document pollute anything', async () => {
    await analyze(memoryTree('malformed', await corpusTree()))
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('finds no load site in the file whose loaders are all decoys', async () => {
    const source = await readFile(join(CORPUS, 'src/decoys.py'), 'utf8')
    const report = await analyze(
      memoryTree('decoys', [
        { path: 'src/decoys.py', text: source },
        { path: 'requirements.txt', text: 'torch==2.5.1\n' },
      ]),
    )
    expect(report.summary.loadSites).toBe(0)
  })

  it('refuses each malformed configuration, naming the problem', async () => {
    const expectations: Record<string, RegExp> = {
      'tab-indent.yaml': /tab indentation/,
      'unknown-environment.yaml': /not an environment/,
      'unknown-section.yaml': /unknown section/,
      'absolute-glob.yaml': /repository-relative/,
      'traversing-glob.yaml': /repository-relative/,
      'orphan-item.yaml': /environment/,
      'not-json.json': /could not be understood/,
      'environments-not-object.json': /must be an object/,
    }

    const configs = paths.filter((p) => p.startsWith('config/'))
    expect(configs.length).toBe(Object.keys(expectations).length)

    for (const path of configs) {
      const name = path.slice('config/'.length)
      const body = await readFile(join(CORPUS, path), 'utf8')
      // Presented at the root, which is where a project configuration lives.
      const target = name.endsWith('.json') ? 'deadweight.json' : 'deadweight.yaml'
      const tree = memoryTree('config', [{ path: target, text: body }])
      const pattern = expectations[name]
      expect(pattern, `no expectation recorded for ${name}`).toBeDefined()
      await expect(readConfig(tree, tree.entries), name).rejects.toThrow(
        pattern as RegExp,
      )
      await expect(readConfig(tree, tree.entries), name).rejects.toThrow(AnalysisError)
    }
  })
})
