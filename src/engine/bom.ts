/**
 * The Model BOM.
 *
 * An inventory of every AI artifact the project loads, with the seven facts
 * DEADWEIGHT resolved about each one. It is the product's main output and the
 * thing you would attach to a change record.
 *
 * Two decisions shape the schema.
 *
 * It carries no timestamp and no run identifier. Two analyses of the same tree
 * produce byte-identical documents, so a diff between two BOMs shows what
 * changed in the project rather than what changed about the run. CI enforces
 * this by hashing two runs and comparing.
 *
 * It records unresolved states explicitly, with their reasons. A BOM that
 * omitted what the analyser could not determine would read as a clean bill of
 * health, which is the failure mode this whole product is arguing against.
 */

import { ENVIRONMENT_META } from './context.ts'
import { formatSpec } from './formats.ts'
import { canonicalJson, sha256Text } from './hash.ts'
import { BEHAVIOUR_LABEL } from './stripe.ts'
import type {
  AlternativeKind,
  ArtifactRecord,
  ContextBasis,
  EnvironmentId,
  EvidenceBinding,
  EvidenceResult,
  FindingKind,
  FormatBasis,
  FormatId,
  LoadBehaviour,
  PrivilegeKind,
  Report,
  Summary,
  UnknownReasonCode,
} from './types.ts'

export const BOM_SCHEMA = 'deadweight.bom/1'

export interface BomEntry {
  readonly id: string
  readonly name: string
  readonly version: string | null
  readonly locator: string
  readonly origin: string
  readonly format: {
    readonly id: FormatId
    readonly label: string
    readonly basis: FormatBasis
    readonly note: string
    readonly extensionMismatch: string | null
  }
  readonly digest: {
    readonly algorithm: 'sha256'
    readonly value: string
    readonly coverage: 'full' | 'head-tail'
  } | null
  readonly sizeBytes: number | null
  readonly load: {
    readonly behaviour: LoadBehaviour
    readonly label: string
    readonly mechanism: string
    readonly guard: string | null
    readonly guardRemovedBecomes: LoadBehaviour | null
    readonly unresolvedReason: UnknownReasonCode | null
  }
  readonly loadSites: ReadonlyArray<{
    readonly file: string
    readonly line: number
    readonly loader: string
    readonly enclosing: string | null
  }>
  readonly contexts: ReadonlyArray<{
    readonly environment: EnvironmentId
    readonly basis: ContextBasis
    readonly privileged: boolean
    readonly privileges: readonly PrivilegeKind[]
  }>
  readonly evidence: ReadonlyArray<{
    readonly scanner: string
    readonly version: string | null
    readonly result: EvidenceResult
    readonly binding: EvidenceBinding
    readonly detail: string
  }>
  readonly alternative: {
    readonly kind: AlternativeKind
    readonly targetFormat: FormatId | null
    readonly summary: string
    readonly resultingBehaviour: LoadBehaviour
  }
  readonly findings: readonly FindingKind[]
}

export interface ModelBom {
  readonly schema: typeof BOM_SCHEMA
  readonly project: string
  readonly generator: { readonly name: 'deadweight'; readonly schema: string }
  readonly entries: readonly BomEntry[]
  readonly summary: Summary
  /** Digest of the canonical entry list. Identical input gives an identical value. */
  readonly digest: string
}

export function buildBom(report: Report): ModelBom {
  const entries = report.records.map(toEntry)
  const body = {
    project: report.project,
    entries,
    summary: report.summary,
  }
  return {
    schema: BOM_SCHEMA,
    project: report.project,
    generator: { name: 'deadweight', schema: BOM_SCHEMA },
    entries,
    summary: report.summary,
    digest: sha256Text(canonicalJson(body)),
  }
}

function toEntry(record: ArtifactRecord): BomEntry {
  const { artifact, behaviour } = record
  const spec = formatSpec(artifact.format.format)
  return {
    id: artifact.id,
    name: artifact.name,
    version: artifact.version,
    locator: artifact.locator,
    origin: artifact.origin,
    format: {
      id: artifact.format.format,
      label: spec.label,
      basis: artifact.format.basis,
      note: artifact.format.note,
      extensionMismatch: artifact.format.extensionMismatch ?? null,
    },
    digest:
      artifact.digest === null
        ? null
        : {
            algorithm: artifact.digest.algorithm,
            value: artifact.digest.value,
            coverage: artifact.digest.coverage,
          },
    sizeBytes: artifact.sizeBytes,
    load: {
      behaviour: behaviour.behaviour,
      label: BEHAVIOUR_LABEL[behaviour.behaviour],
      mechanism: behaviour.mechanism,
      guard: behaviour.guard?.expression ?? null,
      guardRemovedBecomes: behaviour.guard?.ifRemoved ?? null,
      unresolvedReason: behaviour.unknownReason,
    },
    loadSites: record.loadSites.map((s) => ({
      file: s.file,
      line: s.line,
      loader: s.loader,
      enclosing: s.enclosing,
    })),
    contexts: record.contexts.map((c) => ({
      environment: c.environment,
      basis: c.basis,
      privileged: c.privileged,
      privileges: [...new Set(c.privileges.map((p) => p.kind))].sort(),
    })),
    evidence: record.evidence.map((e) => ({
      scanner: e.scanner,
      version: e.scannerVersion,
      result: e.result,
      binding: e.binding,
      detail: e.detail,
    })),
    alternative: {
      kind: record.alternative.kind,
      targetFormat: record.alternative.targetFormat,
      summary: record.alternative.summary,
      resultingBehaviour: record.alternative.resultingBehaviour,
    },
    findings: [...new Set(record.findings.map((f) => f.kind))].sort(),
  }
}

/* -------------------------------------------------------------------------- */
/* Flat exports                                                               */
/* -------------------------------------------------------------------------- */

const CSV_COLUMNS = [
  'artifact',
  'locator',
  'format',
  'format_basis',
  'load_behaviour',
  'guard',
  'unresolved_reason',
  'load_sites',
  'environments',
  'context_basis',
  'privileged',
  'evidence',
  'evidence_binding',
  'alternative',
  'sha256',
] as const

/**
 * CSV for a spreadsheet.
 *
 * Every field is quoted and any leading `=`, `+`, `-` or `@` is prefixed with
 * a single quote. A model path is attacker-influenceable text, and a
 * spreadsheet treats a cell starting with `=` as a formula, which is a real
 * way to turn an inventory into code execution on someone else's laptop.
 */
export function bomToCsv(bom: ModelBom): string {
  const rows = [CSV_COLUMNS.join(',')]
  for (const entry of bom.entries) {
    rows.push(
      [
        entry.name,
        entry.locator,
        entry.format.label,
        entry.format.basis,
        entry.load.behaviour,
        entry.load.guard ?? '',
        entry.load.unresolvedReason ?? '',
        entry.loadSites.map((s) => `${s.file}:${s.line}`).join(' '),
        entry.contexts.map((c) => c.environment).join(' '),
        entry.contexts.map((c) => c.basis).join(' '),
        entry.contexts.some((c) => c.privileged) ? 'yes' : 'no',
        entry.evidence.map((e) => e.scanner).join(' '),
        entry.evidence.map((e) => e.binding).join(' '),
        entry.alternative.kind,
        entry.digest?.value ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return rows.join('\n')
}

function csvCell(value: string): string {
  const neutralised = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${neutralised.replace(/"/g, '""')}"`
}

/** A one-line-per-artifact summary for a terminal or a commit message. */
export function bomToText(bom: ModelBom): string {
  // reduce, not a spread: `Math.max(...)` over 40,000 entries is an argument
  // list long enough to overflow the stack.
  const width = bom.entries.reduce((wide, e) => Math.max(wide, e.locator.length), 8)
  const lines = bom.entries.map((entry) => {
    const environments =
      entry.contexts.length === 0
        ? 'no-context'
        : [...new Set(entry.contexts.map((c) => ENVIRONMENT_META[c.environment].short))].join(',')
    return [
      entry.locator.padEnd(width),
      entry.load.behaviour.padEnd(9),
      entry.format.id.padEnd(16),
      environments.padEnd(12),
      entry.alternative.kind,
    ].join('  ')
  })
  return lines.join('\n')
}
