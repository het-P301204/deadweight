/**
 * Inventory indicators.
 *
 * These are counts of state, not scores. The overview shows them as what they
 * are -- how many artifacts are in each condition -- and never combines them,
 * because "4.7" would imply the analysis knows something it does not.
 *
 * The matrix is the one aggregate that earns its place: behaviour crossed with
 * environment, which is the shape of the actual question. A pickle in a
 * sandbox and a pickle in production are two cells, and keeping them two cells
 * is the point.
 */

import { ENVIRONMENTS } from './config.ts'
import { formatSpec } from './formats.ts'
import { LOAD_BEHAVIOURS } from './types.ts'
import type {
  ArtifactRecord,
  EnvironmentId,
  LoadBehaviour,
  LoadSite,
  Summary,
} from './types.ts'

export function matrixKey(behaviour: LoadBehaviour, environment: EnvironmentId): string {
  return `${behaviour}|${environment}`
}

export function buildSummary(
  records: readonly ArtifactRecord[],
  orphanLoadSites: readonly LoadSite[],
): Summary {
  const behaviour: Record<LoadBehaviour, number> = {
    code: 0,
    directive: 0,
    guarded: 0,
    data: 0,
    unknown: 0,
  }
  const environments = Object.fromEntries(ENVIRONMENTS.map((e) => [e, 0])) as Record<
    EnvironmentId,
    number
  >
  const formats: Record<string, number> = {}
  const matrix: Record<string, number> = {}

  let privilegedLoads = 0
  let migrationsAvailable = 0
  let loadSites = orphanLoadSites.length
  let evidenceRecords = 0
  let staleEvidence = 0

  for (const record of records) {
    behaviour[record.behaviour.behaviour] += 1

    const label = formatSpec(record.artifact.format.format).label
    formats[label] = (formats[label] ?? 0) + 1

    loadSites += record.loadSites.length
    evidenceRecords += record.evidence.length
    staleEvidence += record.evidence.filter((e) => e.binding === 'stale').length

    if (record.contexts.some((c) => c.privileged)) privilegedLoads += 1
    if (
      record.alternative.kind === 'sibling-present' ||
      record.alternative.kind === 'loader-guard-available' ||
      record.alternative.kind === 'conversion-available'
    ) {
      migrationsAvailable += 1
    }

    // An artifact loaded in three environments counts once in each, which is
    // why the matrix rows do not sum to the artifact count. The UI says so.
    const seen = new Set<EnvironmentId>()
    for (const context of record.contexts) {
      if (seen.has(context.environment)) continue
      seen.add(context.environment)
      environments[context.environment] += 1
      const key = matrixKey(record.behaviour.behaviour, context.environment)
      matrix[key] = (matrix[key] ?? 0) + 1
    }
    if (record.contexts.length === 0) {
      environments['unresolved'] += 1
      const key = matrixKey(record.behaviour.behaviour, 'unresolved')
      matrix[key] = (matrix[key] ?? 0) + 1
    }
  }

  return {
    artifacts: records.length,
    behaviour,
    privilegedLoads,
    migrationsAvailable,
    loadSites,
    unresolvedLoadSites: orphanLoadSites.length,
    evidenceRecords,
    staleEvidence,
    environments,
    formats,
    matrix,
  }
}

/** The indicators shown on the overview, in order, with their explanations. */
export interface Indicator {
  readonly id: string
  readonly label: string
  readonly value: number
  readonly of: number | null
  readonly tone: 'neutral' | 'code' | 'directive' | 'guarded' | 'data' | 'unknown'
  readonly note: string
}

export function indicators(summary: Summary): readonly Indicator[] {
  return [
    {
      id: 'artifacts',
      label: 'Artifacts',
      value: summary.artifacts,
      of: null,
      tone: 'neutral',
      note: `Model and skill artifacts this project loads, discovered across ${summary.loadSites} load site${summary.loadSites === 1 ? '' : 's'}.`,
    },
    {
      id: 'code',
      label: 'Executes on load',
      value: summary.behaviour.code,
      of: summary.artifacts,
      tone: 'code',
      note: 'Loading runs code in the loading process. Not a prediction about the file’s contents: a property of the format and the call.',
    },
    {
      id: 'directive',
      label: 'Directs on load',
      value: summary.behaviour.directive,
      of: summary.artifacts,
      tone: 'directive',
      note: 'Loading injects instructions into a model context. Nothing executes; what executes afterwards is whatever the instructions direct.',
    },
    {
      id: 'guarded',
      label: 'Guarded',
      value: summary.behaviour.guarded,
      of: summary.artifacts,
      tone: 'guarded',
      note: 'The format carries an execution surface and a flag at the call site is suppressing it. Safe only while that flag holds.',
    },
    {
      id: 'data',
      label: 'Data only',
      value: summary.behaviour.data,
      of: summary.artifacts,
      tone: 'data',
      note: 'No execution or instruction surface in the format. Loading parses data.',
    },
    {
      id: 'unknown',
      label: 'Unknown',
      value: summary.behaviour.unknown,
      of: summary.artifacts,
      tone: 'unknown',
      note: 'DEADWEIGHT could not resolve what loading does. Each one states its reason and none of them is counted as safe.',
    },
    {
      id: 'privileged',
      label: 'Privileged loads',
      value: summary.privilegedLoads,
      of: summary.artifacts,
      tone: 'neutral',
      note: 'The loading file shows credential, secret or process-execution capability, so the process performing the load has that reach.',
    },
    {
      id: 'migrations',
      label: 'Safe format available',
      value: summary.migrationsAvailable,
      of: summary.artifacts,
      tone: 'neutral',
      note: 'A data-oriented format or a call-site guard is available, so the surface can be removed rather than trusted.',
    },
  ]
}

/** Non-zero behaviours, for compact distribution bars. */
export function behaviourDistribution(
  summary: Summary,
): ReadonlyArray<{ behaviour: LoadBehaviour; count: number; share: number }> {
  const total = LOAD_BEHAVIOURS.reduce((sum, b) => sum + summary.behaviour[b], 0)
  return LOAD_BEHAVIOURS.map((behaviour) => ({
    behaviour,
    count: summary.behaviour[behaviour],
    share: total === 0 ? 0 : summary.behaviour[behaviour] / total,
  })).filter((d) => d.count > 0)
}
