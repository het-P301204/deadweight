/**
 * Filtering and search, as pure functions over a report.
 *
 * Kept out of the components so they can be tested directly: "does the
 * production filter show the artifact loaded in production" is a property of
 * the product, not of a React tree.
 *
 * Search matches the things a person would actually type: a filename, a path
 * fragment, a loader name, a format, an environment, a finding kind. It is a
 * substring match on a precomputed haystack rather than a fuzzy score,
 * because a security tool that shows you a near-match when you asked for an
 * exact path is a tool that hides things.
 */

import { ENVIRONMENT_META } from '../engine/context.ts'
import { formatSpec } from '../engine/formats.ts'
import { loaderSpec } from '../engine/loaders.ts'
import type {
  AlternativeKind,
  ArtifactRecord,
  EnvironmentId,
  LoadBehaviour,
  Report,
} from '../engine/types.ts'

export type EvidenceFilter = 'bound' | 'stale' | 'unbound' | 'absent'
export type MigrationFilter = 'available' | 'none'

export interface Filters {
  readonly behaviour: readonly LoadBehaviour[]
  readonly environment: readonly EnvironmentId[]
  readonly format: readonly string[]
  readonly migration: readonly MigrationFilter[]
  readonly evidence: readonly EvidenceFilter[]
  readonly privilegedOnly: boolean
  readonly query: string
}

export const NO_FILTERS: Filters = {
  behaviour: [],
  environment: [],
  format: [],
  migration: [],
  evidence: [],
  privilegedOnly: false,
  query: '',
}

export function isFiltered(filters: Filters): boolean {
  return (
    filters.behaviour.length > 0 ||
    filters.environment.length > 0 ||
    filters.format.length > 0 ||
    filters.migration.length > 0 ||
    filters.evidence.length > 0 ||
    filters.privilegedOnly ||
    filters.query.trim() !== ''
  )
}

export function activeFilterCount(filters: Filters): number {
  return (
    filters.behaviour.length +
    filters.environment.length +
    filters.format.length +
    filters.migration.length +
    filters.evidence.length +
    (filters.privilegedOnly ? 1 : 0) +
    (filters.query.trim() === '' ? 0 : 1)
  )
}

/**
 * The character joining haystack fields.
 *
 * It has to be something no field can contain, so that a query cannot match
 * across a field boundary and claim a path contains a loader name. U+0001
 * qualifies, and building it from its code point keeps it visible in the
 * source: written as a literal the line reads `parts.join('  ')` and the next
 * person would reasonably delete the "stray" spaces.
 */
const HAYSTACK_SEPARATOR = String.fromCharCode(1)

/** Everything about a record a search should be able to reach. */
export function haystack(record: ArtifactRecord): string {
  const parts: string[] = [
    record.artifact.name,
    record.artifact.locator,
    record.artifact.id,
    record.artifact.version ?? '',
    record.artifact.format.format,
    formatSpec(record.artifact.format.format).label,
    record.behaviour.behaviour,
    record.behaviour.unknownReason ?? '',
    record.alternative.kind,
    record.artifact.digest?.value.slice(0, 16) ?? '',
  ]
  for (const site of record.loadSites) {
    parts.push(site.file, String(site.line), site.loader, loaderSpec(site.loader)?.label ?? '')
    if (site.enclosing !== null) parts.push(site.enclosing)
  }
  for (const context of record.contexts) {
    parts.push(context.environment, ENVIRONMENT_META[context.environment].label)
    for (const privilege of context.privileges) parts.push(privilege.kind, privilege.label)
  }
  for (const record_ of record.evidence) parts.push(record_.scanner, record_.binding, record_.result)
  for (const finding of record.findings) parts.push(finding.kind, finding.title)
  return parts.join(` ${HAYSTACK_SEPARATOR} `).toLowerCase()
}

function evidenceStateOf(record: ArtifactRecord): EvidenceFilter {
  if (record.evidence.length === 0) return 'absent'
  if (record.evidence.some((e) => e.binding === 'stale')) return 'stale'
  if (record.evidence.some((e) => e.binding === 'current')) return 'bound'
  return 'unbound'
}

const MIGRATION_AVAILABLE: ReadonlySet<AlternativeKind> = new Set<AlternativeKind>([
  'sibling-present',
  'loader-guard-available',
  'conversion-available',
])

export function migrationStateOf(record: ArtifactRecord): MigrationFilter {
  return MIGRATION_AVAILABLE.has(record.alternative.kind) ? 'available' : 'none'
}

/**
 * Apply the filters.
 *
 * Within a facet the values are OR'd, across facets they are AND'd, which is
 * the behaviour every filter bar in every tool has and therefore the one a
 * user already knows.
 */
export function applyFilters(
  records: readonly ArtifactRecord[],
  filters: Filters,
  index?: ReadonlyMap<string, string>,
): readonly ArtifactRecord[] {
  const query = filters.query.trim().toLowerCase()

  return records.filter((record) => {
    if (filters.behaviour.length > 0 && !filters.behaviour.includes(record.behaviour.behaviour)) {
      return false
    }
    if (filters.environment.length > 0) {
      const environments = record.contexts.map((c) => c.environment)
      const effective = environments.length === 0 ? (['unresolved'] as EnvironmentId[]) : environments
      if (!effective.some((e) => filters.environment.includes(e))) return false
    }
    if (filters.format.length > 0 && !filters.format.includes(record.artifact.format.format)) {
      return false
    }
    if (filters.migration.length > 0 && !filters.migration.includes(migrationStateOf(record))) {
      return false
    }
    if (filters.evidence.length > 0 && !filters.evidence.includes(evidenceStateOf(record))) {
      return false
    }
    if (filters.privilegedOnly && !record.contexts.some((c) => c.privileged)) return false
    if (query !== '') {
      const text = index?.get(record.artifact.id) ?? haystack(record)
      // Space-separated terms all have to match, so `pickle prod` narrows.
      for (const term of query.split(/\s+/)) {
        if (!text.includes(term)) return false
      }
    }
    return true
  })
}

/** Facet counts computed against the *other* facets, so a count is never zero-and-clickable. */
export interface FacetCounts {
  readonly behaviour: ReadonlyMap<LoadBehaviour, number>
  readonly environment: ReadonlyMap<EnvironmentId, number>
  readonly format: ReadonlyMap<string, number>
  readonly migration: ReadonlyMap<MigrationFilter, number>
  readonly evidence: ReadonlyMap<EvidenceFilter, number>
  readonly privileged: number
}

export function facetCounts(
  records: readonly ArtifactRecord[],
  filters: Filters,
  index?: ReadonlyMap<string, string>,
): FacetCounts {
  const without = <K extends keyof Filters>(key: K): readonly ArtifactRecord[] =>
    applyFilters(records, { ...filters, [key]: NO_FILTERS[key] }, index)

  const behaviour = new Map<LoadBehaviour, number>()
  for (const record of without('behaviour')) {
    behaviour.set(record.behaviour.behaviour, (behaviour.get(record.behaviour.behaviour) ?? 0) + 1)
  }

  const environment = new Map<EnvironmentId, number>()
  for (const record of without('environment')) {
    const seen = new Set<EnvironmentId>(
      record.contexts.length === 0 ? ['unresolved'] : record.contexts.map((c) => c.environment),
    )
    for (const id of seen) environment.set(id, (environment.get(id) ?? 0) + 1)
  }

  const format = new Map<string, number>()
  for (const record of without('format')) {
    const id = record.artifact.format.format
    format.set(id, (format.get(id) ?? 0) + 1)
  }

  const migration = new Map<MigrationFilter, number>()
  for (const record of without('migration')) {
    const state = migrationStateOf(record)
    migration.set(state, (migration.get(state) ?? 0) + 1)
  }

  const evidence = new Map<EvidenceFilter, number>()
  for (const record of without('evidence')) {
    const state = evidenceStateOf(record)
    evidence.set(state, (evidence.get(state) ?? 0) + 1)
  }

  return {
    behaviour,
    environment,
    format,
    migration,
    evidence,
    privileged: without('privilegedOnly').filter((r) => r.contexts.some((c) => c.privileged)).length,
  }
}

/* -------------------------------------------------------------------------- */
/* Sorting                                                                    */
/* -------------------------------------------------------------------------- */

export type SortKey = 'exposure' | 'artifact' | 'format' | 'context' | 'evidence'
export type SortDirection = 'asc' | 'desc'

const EXPOSURE: Record<LoadBehaviour, number> = {
  code: 0,
  unknown: 1,
  directive: 2,
  guarded: 3,
  data: 4,
}

export function sortRecords(
  records: readonly ArtifactRecord[],
  key: SortKey,
  direction: SortDirection,
): readonly ArtifactRecord[] {
  const sign = direction === 'asc' ? 1 : -1
  const value = (record: ArtifactRecord): string | number => {
    switch (key) {
      case 'artifact':
        return record.artifact.locator
      case 'format':
        return formatSpec(record.artifact.format.format).label
      case 'context':
        return record.contexts.map((c) => c.environment).sort().join(',') || 'zzz'
      case 'evidence':
        return record.evidence.length === 0 ? 'zzz' : evidenceStateOf(record)
      case 'exposure':
      default:
        // Privileged sorts above unprivileged within the same behaviour.
        return EXPOSURE[record.behaviour.behaviour] * 2 + (record.contexts.some((c) => c.privileged) ? 0 : 1)
    }
  }
  return [...records].sort((a, b) => {
    const left = value(a)
    const right = value(b)
    if (left === right) return a.artifact.id < b.artifact.id ? -1 : 1
    return (left < right ? -1 : 1) * sign
  })
}

/** Precompute the search index once per report rather than per keystroke. */
export function buildSearchIndex(report: Report): ReadonlyMap<string, string> {
  return new Map(report.records.map((record) => [record.artifact.id, haystack(record)]))
}
