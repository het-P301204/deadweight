/**
 * The Model BOM.
 *
 * The product's main output: an inventory of every AI artifact the project
 * loads, with the facts DEADWEIGHT resolved about each one and the ones it
 * could not. It carries no timestamp, so two analyses of the same tree
 * produce an identical document and a diff between two of them shows what
 * changed in the project rather than what changed about the run.
 *
 * Exports are here rather than in a menu because this is the screen someone
 * came to in order to attach something to a change record.
 */

import { useMemo, useState } from 'react'

import { bomToCsv } from '../engine/bom.ts'
import type { BomEntry, ModelBom } from '../engine/bom.ts'
import { COVERAGE_NOTE, toCycloneDx } from '../engine/cyclonedx.ts'
import { canonicalJson } from '../engine/hash.ts'
import { byReach, ENVIRONMENT_META } from '../engine/context.ts'
import type { ArtifactRecord, Report } from '../engine/types.ts'
import { LoadStripe } from '../ui/LoadStripe.tsx'
import {
  BindingBadge,
  Button,
  ContextBadge,
  CopyButton,
  Disclosure,
  EmptyState,
  ExecutionIndicator,
  cx,
} from '../ui/primitives.tsx'
import { SURFACE, TYPE } from '../ui/tokens.ts'
import { applyFilters } from './filter.ts'
import type { Filters } from './filter.ts'

type Export = 'canonical' | 'cyclonedx' | 'csv'

const EXPORTS: ReadonlyArray<{
  id: Export
  label: string
  filename: string
  mime: string
  note: string
}> = [
  {
    id: 'canonical',
    label: 'DEADWEIGHT BOM',
    filename: 'model-bom.json',
    mime: 'application/json',
    note: 'The native schema, fully documented in docs/schema-format.md. Canonical JSON: keys sorted, no timestamp, byte-identical for identical input.',
  },
  {
    id: 'cyclonedx',
    label: 'CycloneDX 1.6',
    filename: 'model-bom.cdx.json',
    mime: 'application/json',
    note: COVERAGE_NOTE,
  },
  {
    id: 'csv',
    label: 'CSV',
    filename: 'model-bom.csv',
    mime: 'text/csv',
    note: 'One row per artifact for a spreadsheet. Cells beginning with a formula character are prefixed with an apostrophe, because a model path is attacker-influenceable text and a spreadsheet evaluates cells that start with =.',
  },
]

export function Bom({
  report,
  bom,
  filters,
  searchIndex,
  onSelectArtifact,
}: {
  report: Report
  bom: ModelBom
  filters: Filters
  searchIndex: ReadonlyMap<string, string>
  onSelectArtifact: (id: string) => void
}) {
  const [format, setFormat] = useState<Export>('canonical')

  const visibleIds = useMemo(
    () => new Set(applyFilters(report.records, filters, searchIndex).map((r) => r.artifact.id)),
    [report.records, filters, searchIndex],
  )
  const entries = useMemo(
    () => bom.entries.filter((entry) => visibleIds.has(entry.id)),
    [bom.entries, visibleIds],
  )
  const stripes = useMemo(
    () => new Map(report.records.map((r) => [r.artifact.id, r])),
    [report.records],
  )

  const serialised = useMemo(() => {
    const filtered: ModelBom = { ...bom, entries }
    switch (format) {
      case 'cyclonedx':
        return JSON.stringify(toCycloneDx(filtered), null, 2)
      case 'csv':
        return bomToCsv(filtered)
      case 'canonical':
      default:
        return canonicalJson(filtered)
    }
  }, [bom, entries, format])

  const active = EXPORTS.find((item) => item.id === format) as (typeof EXPORTS)[number]

  const download = (): void => {
    const blob = new Blob([serialised], { type: active.mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = active.filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8 md:px-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={TYPE.eyebrow}>AI Model Bill of Materials</p>
          <h1 className="mt-2 font-display text-2xl font-medium tracking-tight text-ink-0">
            {report.project}
          </h1>
          <p className={cx(TYPE.note, 'mt-2 max-w-3xl')}>
            {bom.entries.length} entr{bom.entries.length === 1 ? 'y' : 'ies'}, digest{' '}
            <span className="font-mono">{bom.digest.slice(0, 16)}</span>. No timestamp is emitted:
            two analyses of the same tree produce an identical document, so a diff between two of
            them is a diff of the project.
          </p>
        </div>
      </header>

      {/* export ---------------------------------------------------------- */}
      <section className={cx(SURFACE.panel, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line-1 px-5 py-4">
          <div className="flex rounded border border-line-2 p-0.5" role="group" aria-label="Export format">
            {EXPORTS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFormat(item.id)}
                aria-pressed={format === item.id}
                className={cx(
                  'rounded px-3 py-1.5 text-xs transition-colors duration-90',
                  format === item.id
                    ? 'bg-accent/15 text-accent-strong'
                    : 'text-ink-2 hover:text-ink-0',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <CopyButton value={serialised} label="Copy" />
          <Button variant="primary" onClick={download}>
            Download {active.filename}
          </Button>
        </div>
        <div className="px-5 py-4">
          <p className={cx(TYPE.note, 'max-w-4xl')}>{active.note}</p>
          <div className="mt-4">
            <Disclosure summary={`Preview (${serialised.length.toLocaleString()} characters)`}>
              <pre
                className={cx(
                  SURFACE.well,
                  'max-h-80 overflow-auto p-3 font-mono text-2xs leading-relaxed text-ink-2 scroll-thin',
                )}
              >
                {serialised.slice(0, 20_000)}
                {serialised.length > 20_000 && '\n… truncated for preview'}
              </pre>
            </Disclosure>
          </div>
          {entries.length !== bom.entries.length && (
            <p className={cx(TYPE.note, 'mt-3 text-unknown')}>
              The filters from the explorer are applied: this export contains {entries.length} of{' '}
              {bom.entries.length} entries.
            </p>
          )}
        </div>
      </section>

      {/* the table -------------------------------------------------------- */}
      {entries.length === 0 ? (
        <div className={SURFACE.panel}>
          <EmptyState headline="No entries match the current filters" body="Clear the filters in the explorer to see the whole inventory." />
        </div>
      ) : (
        <section className={cx(SURFACE.panel, 'overflow-hidden')}>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[1340px] text-left">
              <caption className="sr-only">Model bill of materials</caption>
              {/* Explicit widths. Without them the browser squeezed the format
                  column until every label wrapped, which made the row heights
                  uneven and destroyed the scan down the behaviour column. */}
              <colgroup>
                {[76, 250, 150, 200, 178, 214, 150, 116].map((width, index) => (
                  <col key={index} style={{ width }} />
                ))}
              </colgroup>
              <thead>
                <tr className="border-b border-line-1 bg-surface-2/50">
                  {[
                    'Stripe',
                    'Artifact',
                    'Format',
                    'Load behaviour',
                    'Context',
                    'Source',
                    'Evidence',
                    'Digest',
                  ].map((label) => (
                    <th key={label} scope="col" className={cx(TYPE.eyebrow, 'px-4 py-2.5')}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <BomRow
                    key={entry.id}
                    entry={entry}
                    record={stripes.get(entry.id)}
                    onSelect={() => onSelectArtifact(entry.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* what a BOM entry means ------------------------------------------- */}
      <section className={cx(SURFACE.panel, 'p-5')}>
        <p className={TYPE.eyebrow}>Reading an entry</p>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [
              'Load behaviour',
              'What loading does in the loading process. `guarded` means the format carries a surface and a call-site flag is suppressing it; the entry records the flag and what removing it would do.',
            ],
            [
              'Context',
              'Where the load happens, and whether that was declared in the project configuration or inferred from a path rule. `unresolved` is a real value and is never converted to a safe one.',
            ],
            [
              'Evidence',
              'Scanner results, each bound to an artifact digest. A record whose digest is not the file on disk is stale, not passing. No evidence state changes a load behaviour.',
            ],
            [
              'Digest',
              'sha256 over the artifact. `head-tail` coverage means the file exceeded the full-hash limit, and such a digest is deliberately not compared with a scanner whole-file hash.',
            ],
          ].map(([term, definition]) => (
            <div key={term}>
              <dt className="text-xs font-medium text-ink-0">{term}</dt>
              <dd className={cx(TYPE.note, 'mt-1.5')}>{definition}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

function BomRow({
  entry,
  record,
  onSelect,
}: {
  entry: BomEntry
  record: ArtifactRecord | undefined
  onSelect: () => void
}) {
  // One badge per environment, most consequential first, so a truncated
  // column never hides production behind a notebook.
  const sortedContexts = [...new Map(entry.contexts.map((c) => [c.environment, c])).values()].sort(
    (a, b) => byReach(a.environment, b.environment),
  )

  const binding =
    entry.evidence.length === 0
      ? 'absent'
      : entry.evidence.some((e) => e.binding === 'stale')
        ? 'stale'
        : entry.evidence.some((e) => e.binding === 'current')
          ? 'current'
          : 'unbound'

  return (
    <tr
      onClick={onSelect}
      className="cursor-pointer border-b border-line-1 transition-colors duration-90 last:border-b-0 hover:bg-surface-2"
    >
      <td className="px-4 py-3">
        {record !== undefined && (
          <LoadStripe
            stripe={record.stripe}
            behaviour={record.behaviour.behaviour}
            size="xs"
            interactive={false}
          />
        )}
      </td>
      <td className="max-w-[280px] px-4 py-3">
        <span className="block truncate font-mono text-xs text-ink-0">{entry.locator}</span>
        {entry.version !== null && (
          <span className="mt-0.5 block font-mono text-2xs text-ink-3">{entry.version}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="block truncate text-xs text-ink-1">{entry.format.label}</span>
        <span className="mt-0.5 block font-mono text-2xs text-ink-3">by {entry.format.basis}</span>
      </td>
      <td className="px-4 py-3">
        <ExecutionIndicator behaviour={entry.load.behaviour} size="sm" />
        {entry.load.guard !== null && (
          <span className="mt-1 block font-mono text-2xs text-ink-3">{entry.load.guard}</span>
        )}
        {entry.load.unresolvedReason !== null && (
          <span
            className="mt-1 block truncate font-mono text-2xs text-unknown"
            title={entry.load.unresolvedReason}
          >
            {entry.load.unresolvedReason}
          </span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <span className="flex flex-wrap items-center gap-1">
          {entry.contexts.length === 0 ? (
            <span className="font-mono text-2xs text-ink-3">&mdash;</span>
          ) : (
            sortedContexts.map((context) => (
              <ContextBadge
                key={context.environment}
                environment={context.environment}
                basis={context.basis}
                privileged={context.privileged}
              />
            ))
          )}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-2xs text-ink-2">
          {entry.origin === 'in-tree'
            ? 'repository'
            : entry.origin === 'remote-reference'
              ? 'remote'
              : 'not found'}
        </span>
        {entry.loadSites[0] !== undefined && (
          <span className="mt-0.5 block truncate font-mono text-2xs text-ink-3">
            {entry.loadSites[0].file}:{entry.loadSites[0].line}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <BindingBadge binding={binding} />
        {entry.evidence.length > 0 && (
          <span className="mt-1 block font-mono text-2xs text-ink-3">
            {[...new Set(entry.evidence.map((e) => e.scanner))].join(', ')}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {entry.digest === null ? (
          <span className="font-mono text-2xs text-ink-3">&mdash;</span>
        ) : (
          <>
            <span className="font-mono text-2xs text-ink-2">
              {entry.digest.value.slice(0, 12)}
            </span>
            {entry.digest.coverage === 'head-tail' && (
              <span className="mt-0.5 block font-mono text-2xs text-unknown">head-tail</span>
            )}
          </>
        )}
      </td>
    </tr>
  )
}

/** The environment label helper, exported so the BOM and the explorer agree. */
export { ENVIRONMENT_META }
