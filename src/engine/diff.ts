/**
 * BOM diff.
 *
 * What changed between two inventories, and -- more usefully -- *which of the
 * seven facts* changed. "model.pt changed" is a git commit. "model.pt went
 * from guarded to executes-on-load because the torch pin moved" is the thing
 * a security engineer needs to see in a pull request.
 *
 * So a changed entry carries a list of field-level changes, each naming what
 * moved and in which direction. Direction is the useful ordering: a change
 * that opens an execution surface sorts above one that closes it, and a
 * change that neither opens nor closes sorts last.
 */

import type { BomEntry, ModelBom } from './bom.ts'
import type { LoadBehaviour } from './types.ts'

export type ChangeDirection = 'opened' | 'closed' | 'lateral'

export interface FieldChange {
  readonly field:
    | 'behaviour'
    | 'guard'
    | 'format'
    | 'digest'
    | 'load-sites'
    | 'context'
    | 'privilege'
    | 'evidence'
    | 'alternative'
  readonly label: string
  readonly before: string
  readonly after: string
  readonly direction: ChangeDirection
  readonly note: string
}

export interface BomDiff {
  readonly added: readonly BomEntry[]
  readonly removed: readonly BomEntry[]
  readonly changed: ReadonlyArray<{
    readonly before: BomEntry
    readonly after: BomEntry
    readonly changes: readonly FieldChange[]
  }>
  readonly unchanged: number
  readonly identical: boolean
}

/** How exposed each behaviour is, for deciding whether a change opened or closed. */
const EXPOSURE: Record<LoadBehaviour, number> = {
  code: 4,
  directive: 3,
  unknown: 2,
  guarded: 1,
  data: 0,
}

export function diffBoms(before: ModelBom, after: ModelBom): BomDiff {
  const beforeById = new Map(before.entries.map((e) => [e.id, e]))
  const afterById = new Map(after.entries.map((e) => [e.id, e]))

  const added = after.entries.filter((e) => !beforeById.has(e.id))
  const removed = before.entries.filter((e) => !afterById.has(e.id))
  const changed: Array<{ before: BomEntry; after: BomEntry; changes: readonly FieldChange[] }> = []
  let unchanged = 0

  for (const entry of after.entries) {
    const previous = beforeById.get(entry.id)
    if (previous === undefined) continue
    const changes = compare(previous, entry)
    if (changes.length === 0) unchanged += 1
    else changed.push({ before: previous, after: entry, changes })
  }

  return {
    added: [...added].sort(byId),
    removed: [...removed].sort(byId),
    changed: [...changed].sort((a, b) => rank(a.changes) - rank(b.changes)),
    unchanged,
    identical: before.digest === after.digest,
  }
}

function byId(a: BomEntry, b: BomEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function rank(changes: readonly FieldChange[]): number {
  if (changes.some((c) => c.direction === 'opened')) return 0
  if (changes.some((c) => c.direction === 'lateral')) return 1
  return 2
}

function compare(before: BomEntry, after: BomEntry): readonly FieldChange[] {
  const changes: FieldChange[] = []

  if (before.load.behaviour !== after.load.behaviour) {
    const opened = EXPOSURE[after.load.behaviour] > EXPOSURE[before.load.behaviour]
    changes.push({
      field: 'behaviour',
      label: 'Load behaviour',
      before: before.load.behaviour,
      after: after.load.behaviour,
      direction: opened ? 'opened' : 'closed',
      note: opened
        ? `Loading this artifact now does more than it did: ${after.load.mechanism}`
        : `Loading this artifact now does less than it did: ${after.load.mechanism}`,
    })
  }

  if (before.load.guard !== after.load.guard) {
    changes.push({
      field: 'guard',
      label: 'Call-site guard',
      before: before.load.guard ?? 'none',
      after: after.load.guard ?? 'none',
      direction: after.load.guard === null ? 'opened' : 'closed',
      note:
        after.load.guard === null
          ? 'The flag that was suppressing the execution surface is gone.'
          : 'A flag now suppresses the execution surface. It is a guard, not a format change.',
    })
  }

  if (before.format.id !== after.format.id) {
    changes.push({
      field: 'format',
      label: 'Format',
      before: before.format.label,
      after: after.format.label,
      direction: 'lateral',
      note: 'The artifact at this path is a different kind of file than it was.',
    })
  }

  const beforeDigest = before.digest?.value ?? null
  const afterDigest = after.digest?.value ?? null
  if (beforeDigest !== afterDigest) {
    changes.push({
      field: 'digest',
      label: 'Digest',
      before: beforeDigest === null ? 'none' : beforeDigest.slice(0, 12),
      after: afterDigest === null ? 'none' : afterDigest.slice(0, 12),
      direction: 'lateral',
      note: 'The bytes changed, so any scanner evidence recorded against the previous digest is now about a file that is not here.',
    })
  }

  const beforeSites = before.loadSites.map((s) => `${s.file}:${s.line}`).sort()
  const afterSites = after.loadSites.map((s) => `${s.file}:${s.line}`).sort()
  if (beforeSites.join('|') !== afterSites.join('|')) {
    changes.push({
      field: 'load-sites',
      label: 'Load sites',
      before: beforeSites.length === 0 ? 'none' : beforeSites.join(', '),
      after: afterSites.length === 0 ? 'none' : afterSites.join(', '),
      direction: afterSites.length > beforeSites.length ? 'opened' : 'lateral',
      note:
        afterSites.length > beforeSites.length
          ? 'The artifact is now loaded from more places than it was.'
          : 'The set of places loading this artifact changed.',
    })
  }

  const beforeEnvironments = [...new Set(before.contexts.map((c) => c.environment))].sort()
  const afterEnvironments = [...new Set(after.contexts.map((c) => c.environment))].sort()
  if (beforeEnvironments.join('|') !== afterEnvironments.join('|')) {
    const escalated = ['production', 'staging', 'service', 'ci', 'build']
    const opened =
      afterEnvironments.some((e) => escalated.includes(e)) &&
      !beforeEnvironments.some((e) => escalated.includes(e))
    changes.push({
      field: 'context',
      label: 'Load context',
      before: beforeEnvironments.join(', ') || 'none',
      after: afterEnvironments.join(', ') || 'none',
      direction: opened ? 'opened' : 'lateral',
      note: opened
        ? 'The same artifact is now loaded somewhere a compromise reaches further.'
        : 'The environments this artifact is loaded in changed.',
    })
  }

  const beforePrivileged = before.contexts.some((c) => c.privileged)
  const afterPrivileged = after.contexts.some((c) => c.privileged)
  if (beforePrivileged !== afterPrivileged) {
    changes.push({
      field: 'privilege',
      label: 'Privileged load',
      before: beforePrivileged ? 'yes' : 'no',
      after: afterPrivileged ? 'yes' : 'no',
      direction: afterPrivileged ? 'opened' : 'closed',
      note: afterPrivileged
        ? 'The loading file now shows credential or process-execution capability that it did not before.'
        : 'The loading file no longer shows credential or process-execution capability.',
    })
  }

  const beforeEvidence = before.evidence.map((e) => `${e.scanner}:${e.binding}:${e.result}`).sort()
  const afterEvidence = after.evidence.map((e) => `${e.scanner}:${e.binding}:${e.result}`).sort()
  if (beforeEvidence.join('|') !== afterEvidence.join('|')) {
    const nowStale = after.evidence.some((e) => e.binding === 'stale')
    changes.push({
      field: 'evidence',
      label: 'Evidence',
      before: beforeEvidence.join(', ') || 'none',
      after: afterEvidence.join(', ') || 'none',
      direction: nowStale || after.evidence.length < before.evidence.length ? 'opened' : 'closed',
      note: nowStale
        ? 'Evidence is now bound to bytes that are not on disk.'
        : 'The recorded scanner evidence for this artifact changed.',
    })
  }

  if (before.alternative.kind !== after.alternative.kind) {
    changes.push({
      field: 'alternative',
      label: 'Safe alternative',
      before: before.alternative.kind,
      after: after.alternative.kind,
      direction: 'lateral',
      note: 'What is available to remove the execution surface changed.',
    })
  }

  return changes
}

/** `+ / - / ~` summary lines, for a terminal or a commit message. */
export function diffToText(diff: BomDiff): string {
  const lines: string[] = []
  for (const entry of diff.added) lines.push(`+ ${entry.locator}  ${entry.load.behaviour}`)
  for (const entry of diff.removed) lines.push(`- ${entry.locator}  ${entry.load.behaviour}`)
  for (const item of diff.changed) {
    lines.push(`~ ${item.after.locator}`)
    for (const change of item.changes) {
      lines.push(`    ${change.label}: ${change.before} -> ${change.after}  [${change.direction}]`)
    }
  }
  if (lines.length === 0) lines.push('No change.')
  return lines.join('\n')
}
