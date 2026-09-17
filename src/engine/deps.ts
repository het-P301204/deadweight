/**
 * Dependency resolution.
 *
 * This file exists because of one fact, and the fact is the product's whole
 * argument:
 *
 *     torch.load(path)
 *
 * executed whatever the file said to execute, on every call, until PyTorch
 * 2.6 changed the default of `weights_only` to True. The line of code did not
 * change. Whether it is a remote code execution primitive depends on a number
 * written in a requirements file three directories away.
 *
 * The same shape recurs: `numpy.load` and `allow_pickle`, `keras.load_model`
 * and `safe_mode`, `yaml.load` and its Loader argument. So DEADWEIGHT reads
 * the project's declared dependencies, and where the version is not pinned
 * tightly enough to decide the default, the load behaviour is UNKNOWN with
 * that as the stated reason -- not "probably fine".
 *
 * The parsers are deliberately shallow. This is not a resolver; it reads what
 * the repository declares. A declaration it cannot understand produces an
 * `unpinned` entry, which is the honest answer.
 */

import { MAX_MANIFEST_BYTES, clip, sanitise } from './limits.ts'
import { basename } from './source.ts'
import type { SourceTree, TreeEntry } from './source.ts'
import type { ResolvedDependency } from './types.ts'

/* -------------------------------------------------------------------------- */
/* Version arithmetic                                                         */
/* -------------------------------------------------------------------------- */

/** Parse a dotted release into numeric components. Pre-release tags are dropped. */
export function parseVersion(raw: string): number[] | null {
  const cleaned = raw.trim().replace(/^v/i, '')
  const match = /^(\d+(?:\.\d+)*)/.exec(cleaned)
  if (!match) return null
  const parts = (match[1] as string).split('.').map((p) => Number.parseInt(p, 10))
  return parts.every((n) => Number.isFinite(n)) ? parts : null
}

/** -1, 0 or 1. Missing components compare as zero, so 2.6 === 2.6.0. */
export function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function atLeast(version: string | null, target: string): boolean | null {
  if (version === null) return null
  const a = parseVersion(version)
  const b = parseVersion(target)
  if (a === null || b === null) return null
  return compareVersions(a, b) >= 0
}

/* -------------------------------------------------------------------------- */
/* Constraint reading                                                         */
/* -------------------------------------------------------------------------- */

interface ParsedConstraint {
  readonly version: string | null
  readonly pin: ResolvedDependency['pin']
}

/**
 * Reduce a PEP 440 style constraint to "the version this will install, if the
 * declaration forces one".
 *
 * `==2.5.1` forces one. `>=2.6` does not force a version but does force a
 * *floor*, which is enough to decide a default that changed at a known
 * release, so it is kept as a range with its lower bound. `>=2.0` spans the
 * change and is therefore useless for the question, which the behaviour
 * resolver detects by comparing the floor against the release it cares about.
 */
export function parseConstraint(raw: string): ParsedConstraint {
  const text = raw.trim()
  if (text === '' || text === '*') return { version: null, pin: 'unpinned' }

  const exact = /^==\s*([0-9][^,\s;]*)/.exec(text)
  if (exact) {
    const v = (exact[1] as string).replace(/\.\*$/, '')
    return { version: v, pin: v.includes('*') ? 'range' : 'exact' }
  }

  // `~=2.6.1` and `^2.6.1` both floor at the stated version.
  const compatible = /^[~^]=?\s*([0-9][^,\s;]*)/.exec(text)
  if (compatible) return { version: compatible[1] as string, pin: 'range' }

  const floor = /(?:^|,)\s*>=\s*([0-9][^,\s;]*)/.exec(text)
  if (floor) return { version: floor[1] as string, pin: 'range' }

  const bare = /^([0-9][^,\s;]*)$/.exec(text)
  if (bare) return { version: bare[1] as string, pin: 'exact' }

  return { version: null, pin: 'unpinned' }
}

/* -------------------------------------------------------------------------- */
/* Manifest parsers                                                           */
/* -------------------------------------------------------------------------- */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function normaliseName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/_/g, '-')
  // A requirement line with an extras marker: `torch[opt]`.
  const stripped = name.replace(/\[.*$/, '')
  return NAME.test(stripped) ? stripped : null
}

function pushDependency(
  into: Map<string, ResolvedDependency>,
  name: string,
  constraint: string,
  source: string,
  override: boolean,
): void {
  const key = normaliseName(name)
  if (key === null) return
  const parsed = parseConstraint(constraint)
  const existing = into.get(key)
  // A lockfile beats a requirements range beats a bare mention.
  const rank = (p: ResolvedDependency['pin']): number =>
    p === 'exact' ? 2 : p === 'range' ? 1 : 0
  if (existing && !override && rank(existing.pin) >= rank(parsed.pin)) return
  into.set(key, {
    name: key,
    version: parsed.version,
    pin: parsed.pin,
    source,
    constraint: clip(sanitise(constraint || key), 80),
  })
}

function parseRequirements(
  text: string,
  source: string,
  into: Map<string, ResolvedDependency>,
): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('-')) continue
    // Drop environment markers and inline comments.
    const body = (line.split(';')[0] as string).split(' #')[0] as string
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?)\s*(.*)$/.exec(body.trim())
    if (!match) continue
    pushDependency(into, match[1] as string, (match[2] as string) ?? '', source, false)
  }
}

/**
 * pyproject.toml, read line by line rather than with a TOML parser.
 *
 * Only two tables matter -- `[project] dependencies` and
 * `[tool.poetry.dependencies]` -- and a line reader that understands those
 * two shapes is less surface than a general TOML parser would be. Anything
 * it does not recognise is left out, which shows up as an unpinned
 * dependency rather than as a wrong version.
 */
function parsePyproject(
  text: string,
  source: string,
  into: Map<string, ResolvedDependency>,
): void {
  let table = ''
  let inArray = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      table = header[1] as string
      inArray = false
      continue
    }

    if (table === 'project' && /^dependencies\s*=\s*\[/.test(line)) {
      inArray = true
      const rest = line.slice(line.indexOf('[') + 1)
      collectArrayItems(rest, source, into)
      if (rest.includes(']')) inArray = false
      continue
    }
    if (inArray) {
      collectArrayItems(line, source, into)
      if (line.includes(']')) inArray = false
      continue
    }

    if (table === 'tool.poetry.dependencies' || table === 'tool.poetry.group.dev.dependencies') {
      const entry = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/.exec(line)
      if (!entry) continue
      const value = (entry[2] as string).trim()
      const quoted = /^["']([^"']*)["']/.exec(value)
      if (quoted) {
        pushDependency(into, entry[1] as string, quoted[1] as string, source, false)
        continue
      }
      const inline = /version\s*=\s*["']([^"']*)["']/.exec(value)
      pushDependency(into, entry[1] as string, inline ? (inline[1] as string) : '', source, false)
    }
  }
}

function collectArrayItems(
  segment: string,
  source: string,
  into: Map<string, ResolvedDependency>,
): void {
  for (const match of segment.matchAll(/["']([^"']+)["']/g)) {
    const spec = match[1] as string
    const parsed = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?)\s*(.*)$/.exec(
      (spec.split(';')[0] as string).trim(),
    )
    if (!parsed) continue
    pushDependency(into, parsed[1] as string, (parsed[2] as string) ?? '', source, false)
  }
}

/** poetry.lock and uv.lock: repeated `[[package]] name = .. version = ..` blocks. */
function parseTomlLock(
  text: string,
  source: string,
  into: Map<string, ResolvedDependency>,
): void {
  let pending: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '[[package]]') {
      pending = null
      continue
    }
    const name = /^name\s*=\s*["']([^"']+)["']$/.exec(line)
    if (name) {
      pending = name[1] as string
      continue
    }
    const version = /^version\s*=\s*["']([^"']+)["']$/.exec(line)
    if (version && pending !== null) {
      pushDependency(into, pending, `==${version[1] as string}`, source, true)
      pending = null
    }
  }
}

/** Pipfile.lock and package-lock.json: JSON with a version per entry. */
function parseJsonLock(
  text: string,
  source: string,
  into: Map<string, ResolvedDependency>,
): void {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return
  }
  if (doc === null || typeof doc !== 'object') return
  const root = doc as Record<string, unknown>

  for (const section of ['default', 'develop', 'dependencies', 'packages']) {
    const block = root[section]
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const version = (value as Record<string, unknown>)['version']
      if (typeof version !== 'string') continue
      const clean = version.replace(/^==/, '')
      pushDependency(into, basename(name), `==${clean}`, source, true)
    }
  }
}

/** package.json dependencies, for the JavaScript inference stacks. */
function parsePackageJson(
  text: string,
  source: string,
  into: Map<string, ResolvedDependency>,
): void {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return
  }
  if (doc === null || typeof doc !== 'object') return
  const root = doc as Record<string, unknown>
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = root[section]
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      pushDependency(into, name.replace(/^@[^/]+\//, ''), value, source, false)
    }
  }
}

/** conda environment.yml: a `dependencies:` list of `name=version` strings. */
function parseCondaEnvironment(
  text: string,
  source: string,
  into: Map<string, ResolvedDependency>,
): void {
  let inDeps = false
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^dependencies:\s*$/.test(rawLine)) {
      inDeps = true
      continue
    }
    if (inDeps && /^\S/.test(rawLine)) {
      inDeps = false
      continue
    }
    if (!inDeps) continue
    const item = /^\s*-\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*([=<>~!].*)?$/.exec(rawLine)
    if (!item) continue
    const constraint = (item[2] ?? '').trim().replace(/^=(?!=)/, '==')
    pushDependency(into, item[1] as string, constraint, source, false)
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const MANIFESTS: ReadonlyArray<{
  match: (path: string) => boolean
  parse: (text: string, source: string, into: Map<string, ResolvedDependency>) => void
}> = [
  { match: (p) => /(^|\/)requirements[^/]*\.txt$/.test(p), parse: parseRequirements },
  { match: (p) => /(^|\/)constraints[^/]*\.txt$/.test(p), parse: parseRequirements },
  { match: (p) => /(^|\/)pyproject\.toml$/.test(p), parse: parsePyproject },
  { match: (p) => /(^|\/)(poetry|uv|pdm)\.lock$/.test(p), parse: parseTomlLock },
  { match: (p) => /(^|\/)Pipfile\.lock$/.test(p), parse: parseJsonLock },
  { match: (p) => /(^|\/)environment\.ya?ml$/.test(p), parse: parseCondaEnvironment },
  { match: (p) => /(^|\/)package\.json$/.test(p), parse: parsePackageJson },
]

export function isManifest(path: string): boolean {
  return MANIFESTS.some((m) => m.match(path))
}

export async function resolveDependencies(
  tree: SourceTree,
  entries: readonly TreeEntry[],
): Promise<readonly ResolvedDependency[]> {
  const into = new Map<string, ResolvedDependency>()

  // Lockfiles last so their exact versions win over a requirements range.
  const ordered = [...entries].sort((a, b) => rank(a.path) - rank(b.path))

  for (const entry of ordered) {
    const handler = MANIFESTS.find((m) => m.match(entry.path))
    if (!handler) continue
    if (entry.size > MAX_MANIFEST_BYTES) continue
    const text = await tree.readText(entry.path, MAX_MANIFEST_BYTES)
    if (text === null) continue
    handler.parse(text, entry.path, into)
  }

  return [...into.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function rank(path: string): number {
  if (/\.lock$/.test(path) || /Pipfile\.lock$/.test(path)) return 2
  if (/requirements[^/]*\.txt$/.test(path)) return 1
  return 0
}

/**
 * The project's own name, as it declares it.
 *
 * A directory name is whatever the person cloning chose; `atlas-triage` in a
 * pyproject is what the project calls itself, and it is what should appear on
 * a BOM someone attaches to a change record.
 */
export async function readProjectName(
  tree: SourceTree,
  entries: readonly TreeEntry[],
): Promise<string | null> {
  const pyproject = entries.find((e) => e.path === 'pyproject.toml')
  if (pyproject !== undefined && pyproject.size <= MAX_MANIFEST_BYTES) {
    const text = await tree.readText(pyproject.path, MAX_MANIFEST_BYTES)
    if (text !== null) {
      // Only the `[project]` table: `[tool.poetry]` and `[tool.ruff]` also
      // have `name` keys and neither is the project's name.
      const section = /\[project\]([\s\S]*?)(\n\[|$)/.exec(text)
      const name = section === null ? null : /^name\s*=\s*["']([^"']+)["']/m.exec(section[1] as string)
      if (name !== null) return clip(sanitise(name[1] as string), 80)
    }
  }

  const packageJson = entries.find((e) => e.path === 'package.json')
  if (packageJson !== undefined && packageJson.size <= MAX_MANIFEST_BYTES) {
    const text = await tree.readText(packageJson.path, MAX_MANIFEST_BYTES)
    if (text !== null) {
      try {
        const doc = JSON.parse(text) as { name?: unknown }
        if (typeof doc.name === 'string' && doc.name !== '') {
          return clip(sanitise(doc.name), 80)
        }
      } catch {
        // A package.json that does not parse is not a name.
      }
    }
  }

  return null
}

/** Look one dependency up by its normalised name. */
export function findDependency(
  deps: readonly ResolvedDependency[],
  name: string,
): ResolvedDependency | null {
  const key = name.toLowerCase().replace(/_/g, '-')
  return deps.find((d) => d.name === key) ?? null
}
