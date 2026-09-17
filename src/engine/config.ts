/**
 * Project configuration.
 *
 * One thing DEADWEIGHT genuinely cannot infer is which paths in a repository
 * run in production. It can see that a file constructs a FastAPI app; it
 * cannot see whether that app is deployed, or with what credentials. So the
 * environment of a load site is either *declared* here or *inferred* from a
 * path rule, and the product shows which of the two it was.
 *
 * The file is read as JSON, or as a two-level subset of YAML written out by
 * hand rather than by a YAML engine -- because shipping a deserialiser to
 * read a file from an untrusted repository, in this product of all products,
 * would be absurd.
 */

import { AnalysisError } from './errors.ts'
import { MAX_MANIFEST_BYTES, clip } from './limits.ts'
import { normalisePath } from './source.ts'
import type { SourceTree, TreeEntry } from './source.ts'
import type { EnvironmentId } from './types.ts'

export const ENVIRONMENTS: readonly EnvironmentId[] = [
  'production',
  'staging',
  'service',
  'ci',
  'build',
  'notebook',
  'test',
  'development',
  'sandbox',
  'unresolved',
]

const DECLARABLE: ReadonlySet<string> = new Set([
  'production',
  'staging',
  'service',
  'ci',
  'build',
  'notebook',
  'test',
  'development',
  'sandbox',
])

export interface ProjectConfig {
  /** Environment name to the globs that declare it. */
  readonly environments: ReadonlyMap<EnvironmentId, readonly string[]>
  /** Extra globs excluded from the walk. */
  readonly ignore: readonly string[]
  /** Path the configuration was read from, for attribution in the UI. */
  readonly source: string | null
}

export const EMPTY_CONFIG: ProjectConfig = {
  environments: new Map(),
  ignore: [],
  source: null,
}

const CONFIG_NAMES = ['deadweight.json', 'deadweight.yaml', 'deadweight.yml', '.deadweight.yaml']

export function findConfigEntry(entries: readonly TreeEntry[]): TreeEntry | null {
  for (const name of CONFIG_NAMES) {
    const found = entries.find((e) => e.path === name)
    if (found) return found
  }
  return null
}

export async function readConfig(
  tree: SourceTree,
  entries: readonly TreeEntry[],
): Promise<ProjectConfig> {
  const entry = findConfigEntry(entries)
  if (entry === null) return EMPTY_CONFIG
  if (entry.size > MAX_MANIFEST_BYTES) {
    throw new AnalysisError('bad-config', `${entry.path} is larger than the manifest limit.`)
  }
  const text = await tree.readText(entry.path, MAX_MANIFEST_BYTES)
  if (text === null) throw new AnalysisError('bad-config', `${entry.path} could not be read.`)

  return entry.path.endsWith('.json')
    ? parseJsonConfig(text, entry.path)
    : parseYamlConfig(text, entry.path)
}

function parseJsonConfig(text: string, source: string): ProjectConfig {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (error) {
    throw new AnalysisError('bad-config', `${source}: ${(error as Error).message}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AnalysisError('bad-config', `${source}: expected an object at the top level.`)
  }
  const root = doc as Record<string, unknown>
  const environments = new Map<EnvironmentId, readonly string[]>()
  const block = root['environments']
  if (block !== undefined) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      throw new AnalysisError('bad-config', `${source}: "environments" must be an object.`)
    }
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      const globs = readGlobs(value, name, source)
      if (globs.length > 0) environments.set(checkEnvironment(name, source), globs)
    }
  }
  return {
    environments,
    ignore: root['ignore'] === undefined ? [] : readGlobs(root['ignore'], 'ignore', source),
    source,
  }
}

/**
 * A two-level YAML subset: a top-level key, then `- item` lines beneath it.
 * Anything else raises rather than being skipped, so a configuration that
 * looks like it declares production but does not cannot pass silently.
 */
function parseYamlConfig(text: string, source: string): ProjectConfig {
  const environments = new Map<EnvironmentId, string[]>()
  const ignore: string[] = []
  let section: 'environments' | 'ignore' | null = null
  let current: EnvironmentId | null = null

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    if (raw.includes('\t')) {
      throw new AnalysisError('bad-config', `${source}:${i + 1}: tab indentation is not accepted.`)
    }

    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()

    if (indent === 0) {
      const key = /^([A-Za-z_][\w-]*)\s*:\s*$/.exec(line)
      if (!key) {
        throw new AnalysisError('bad-config', `${source}:${i + 1}: expected \`environments:\` or \`ignore:\`.`)
      }
      const name = (key[1] as string).toLowerCase()
      if (name !== 'environments' && name !== 'ignore') {
        throw new AnalysisError('bad-config', `${source}:${i + 1}: unknown section "${name}".`)
      }
      section = name
      current = null
      continue
    }

    if (section === 'ignore') {
      const item = /^-\s+(.+)$/.exec(line)
      if (!item) throw new AnalysisError('bad-config', `${source}:${i + 1}: expected a \`- glob\` item.`)
      ignore.push(checkGlob(unquote(item[1] as string), source, i + 1))
      continue
    }

    if (section !== 'environments') {
      throw new AnalysisError('bad-config', `${source}:${i + 1}: value outside a known section.`)
    }

    const key = /^([A-Za-z_][\w-]*)\s*:\s*$/.exec(line)
    if (key) {
      current = checkEnvironment((key[1] as string).toLowerCase(), source)
      if (!environments.has(current)) environments.set(current, [])
      continue
    }
    const item = /^-\s+(.+)$/.exec(line)
    if (!item || current === null) {
      throw new AnalysisError('bad-config', `${source}:${i + 1}: expected a \`- glob\` item under an environment.`)
    }
    ;(environments.get(current) as string[]).push(checkGlob(unquote(item[1] as string), source, i + 1))
  }

  return { environments, ignore, source }
}

function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value.trim())
  return clip(match ? (match[2] as string) : value.trim(), 256)
}

/**
 * Globs are matched against repository-relative paths, so an absolute or
 * traversing pattern can only be a mistake or an attempt. Checked in both
 * parsers -- the YAML reader used to accept what the JSON reader refused.
 */
function checkGlob(pattern: string, source: string, line: number | null): string {
  if (normalisePath(pattern.replace(/\*/g, 'x')) === null) {
    throw new AnalysisError(
      'bad-config',
      `${source}${line === null ? '' : `:${line}`}: the pattern "${clip(pattern, 60)}" is not a repository-relative path.`,
    )
  }
  return pattern
}

function checkEnvironment(name: string, source: string): EnvironmentId {
  if (!DECLARABLE.has(name)) {
    throw new AnalysisError(
      'bad-config',
      `${source}: "${clip(name, 40)}" is not an environment DEADWEIGHT recognises. Use one of ${[...DECLARABLE].join(', ')}.`,
    )
  }
  return name as EnvironmentId
}

function readGlobs(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new AnalysisError('bad-config', `${source}: "${clip(key, 40)}" must be an array of globs.`)
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new AnalysisError('bad-config', `${source}: "${clip(key, 40)}" contains a non-string entry.`)
    }
    out.push(checkGlob(clip(item, 256), source, null))
  }
  return out
}
