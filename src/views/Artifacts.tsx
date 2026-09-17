/**
 * The artifact explorer.
 *
 * A list, not a data grid. Each row carries the load stripe, the path, what
 * loading does, the format, where, and whether the surface can be removed --
 * which is the whole seven-stage answer at a glance, in one line, because the
 * stripe absorbs four columns that would otherwise be badges.
 *
 * Keyboard: up and down move the cursor, Enter opens the drawer, `/` focuses
 * search, Escape clears it. The rows are real buttons in a real list, so a
 * screen reader gets the same order.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { distinctEnvironments } from '../engine/context.ts'
import { formatSpec } from '../engine/formats.ts'
import { BEHAVIOUR_LABEL } from '../engine/stripe.ts'
import type { ArtifactRecord, Report } from '../engine/types.ts'
import { LoadStripe, StripeLegend, stripeSummary } from '../ui/LoadStripe.tsx'
import {
  Button,
  ContextBadge,
  EmptyState,
  ExecutionIndicator,
  PathRef,
  cx,
} from '../ui/primitives.tsx'
import { BEHAVIOUR_STYLE, SURFACE, TYPE } from '../ui/tokens.ts'
import { FilterBar } from './FilterBar.tsx'
import { applyFilters, facetCounts, isFiltered, migrationStateOf, sortRecords } from './filter.ts'
import type { Filters, SortDirection, SortKey } from './filter.ts'

export function Artifacts({
  report,
  filters,
  searchIndex,
  sort,
  selected,
  onToggle,
  onTogglePrivileged,
  onQuery,
  onClear,
  onSort,
  onSelect,
}: {
  report: Report
  filters: Filters
  searchIndex: ReadonlyMap<string, string>
  sort: { key: SortKey; direction: SortDirection }
  selected: string | null
  onToggle: React.ComponentProps<typeof FilterBar>['onToggle']
  onTogglePrivileged: () => void
  onQuery: (value: string) => void
  onClear: () => void
  onSort: (key: SortKey) => void
  onSelect: (id: string | null) => void
}) {
  const search = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState(0)

  const counts = useMemo(
    () => facetCounts(report.records, filters, searchIndex),
    [report.records, filters, searchIndex],
  )
  const filtered = useMemo(
    () => applyFilters(report.records, filters, searchIndex),
    [report.records, filters, searchIndex],
  )
  const rows = useMemo(() => sortRecords(filtered, sort.key, sort.direction), [filtered, sort])

  // Adjusting state during render, rather than in an effect, when the list the
  // cursor indexes into is replaced. React re-renders immediately without
  // painting the stale cursor, which an effect would.
  const [lastRows, setLastRows] = useState(rows)
  if (lastRows !== rows) {
    setLastRows(rows)
    setCursor(0)
  }

  /*
   * Mirrored into a ref because key repeat outruns a render: with only the
   * state, ArrowDown followed immediately by Enter opens the row the arrow
   * key just moved off. The ref is the authority for the handler, the state
   * for the paint.
   */
  const cursorRef = useRef(cursor)

  // Synced after paint, for the case where something other than a key press
  // moved the cursor -- a filter change resetting it to the top. The key
  // handler writes the ref itself, so it is never behind.
  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  // Row navigation. Only active when focus is not in a field.
  useEffect(() => {
    const move = (delta: number): void => {
      const next = Math.min(rows.length - 1, Math.max(0, cursorRef.current + delta))
      cursorRef.current = next
      setCursor(next)
    }
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault()
        move(-1)
      } else if (event.key === 'Enter') {
        const record = rows[cursorRef.current]
        if (record !== undefined) {
          event.preventDefault()
          onSelect(record.artifact.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, onSelect])

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8 md:px-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={TYPE.eyebrow}>Artifact explorer</p>
          <h1 className="mt-2 font-display text-2xl font-medium tracking-tight text-ink-0">
            Every AI artifact this project loads
          </h1>
        </div>
        <StripeLegend className="hidden lg:flex" />
      </header>

      <section className={cx(SURFACE.panel, 'p-5')}>
        <FilterBar
          filters={filters}
          counts={counts}
          total={report.records.length}
          shown={rows.length}
          onToggle={onToggle}
          onTogglePrivileged={onTogglePrivileged}
          onQuery={onQuery}
          onClear={onClear}
          searchRef={search}
        />
      </section>

      {rows.length === 0 ? (
        <div className={SURFACE.panel}>
          <EmptyState
            headline={isFiltered(filters) ? 'Nothing matches these filters' : 'No artifacts found'}
            body={
              isFiltered(filters)
                ? 'The filters are AND-ed across facets and OR-ed within them. Widen one, or clear them all.'
                : 'DEADWEIGHT found no model or skill artifacts in this project, and no code that loads one. That is a real answer, not an empty one: nothing here has a load-time surface to report.'
            }
            actions={
              isFiltered(filters) ? (
                <Button variant="primary" onClick={onClear}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <section className={cx(SURFACE.panel, 'overflow-hidden')}>
          {/* column headers, desktop only ------------------------------- */}
          <div className="hidden border-b border-line-1 bg-surface-2/50 px-4 py-2.5 lg:grid lg:grid-cols-[76px_minmax(0,1fr)_168px_150px_136px_120px] lg:gap-4">
            <span className={TYPE.eyebrow}>Stripe</span>
            <SortHeader label="Artifact" id="artifact" sort={sort} onSort={onSort} />
            <SortHeader label="Load behaviour" id="exposure" sort={sort} onSort={onSort} />
            <SortHeader label="Format" id="format" sort={sort} onSort={onSort} />
            <SortHeader label="Context" id="context" sort={sort} onSort={onSort} />
            <SortHeader label="Alternative" id="evidence" sort={sort} onSort={onSort} />
          </div>

          <ul role="list">
            {rows.map((record, index) => (
              <Row
                key={record.artifact.id}
                record={record}
                active={record.artifact.id === selected}
                cursor={index === cursor}
                onSelect={() => {
                  setCursor(index)
                  onSelect(record.artifact.id)
                }}
              />
            ))}
          </ul>
        </section>
      )}

      {report.orphanLoadSites.length > 0 && (
        <section className={cx(SURFACE.panel, 'overflow-hidden')}>
          <header className="border-b border-line-1 px-5 py-4">
            <p className={cx(TYPE.eyebrow, 'text-unknown')}>Unresolved</p>
            <h2 className="mt-1.5 font-display text-lg font-medium text-ink-0">
              {report.orphanLoadSites.length} load site
              {report.orphanLoadSites.length === 1 ? '' : 's'} with no resolvable artifact
            </h2>
            <p className={cx(TYPE.note, 'mt-2 max-w-3xl')}>
              A loader is called here and DEADWEIGHT could not determine which file it reads. These
              are listed rather than dropped: the call will load something.
            </p>
          </header>
          <ul role="list">
            {report.orphanLoadSites.map((site) => (
              <li key={site.id} className={cx(SURFACE.row, 'px-5 py-3.5')}>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
                  <PathRef path={site.file} line={site.line} />
                  <span className="font-mono text-2xs text-ink-2">{site.loader}</span>
                  <ExecutionIndicator behaviour={site.behaviour.behaviour} size="sm" />
                </div>
                <p className={cx(TYPE.note, 'mt-1.5')}>{site.behaviour.mechanism}</p>
                <code className="mt-1.5 block truncate rounded bg-surface-inset px-2 py-1 font-mono text-2xs text-ink-2">
                  {site.snippet}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function SortHeader({
  label,
  id,
  sort,
  onSort,
}: {
  label: string
  id: SortKey
  sort: { key: SortKey; direction: SortDirection }
  onSort: (key: SortKey) => void
}) {
  const active = sort.key === id
  return (
    <button
      type="button"
      onClick={() => onSort(id)}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cx(
        TYPE.eyebrow,
        'flex items-center gap-1 text-left transition-colors duration-90 hover:text-ink-0',
        active && 'text-accent',
      )}
    >
      {label}
      <span aria-hidden className={cx('text-[8px]', active ? 'opacity-100' : 'opacity-0')}>
        {sort.direction === 'asc' ? '▲' : '▼'}
      </span>
    </button>
  )
}

function Row({
  record,
  active,
  cursor,
  onSelect,
}: {
  record: ArtifactRecord
  active: boolean
  cursor: boolean
  onSelect: () => void
}) {
  const node = useRef<HTMLLIElement>(null)
  const { artifact, behaviour } = record
  const spec = formatSpec(artifact.format.format)
  const privileged = record.contexts.some((c) => c.privileged)
  const migration = migrationStateOf(record)
  // One badge per environment, not per context: two production files are two
  // contexts and one column entry.
  const environments = distinctEnvironments(record.contexts)

  useEffect(() => {
    if (cursor) node.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  return (
    <li
      ref={node}
      className={cx(
        SURFACE.row,
        'relative transition-colors duration-90',
        active ? 'bg-surface-3' : cursor ? 'bg-surface-2' : 'hover:bg-surface-2',
      )}
    >
      {/* A left rule in the behaviour colour: the row's state is readable
          from the edge of the screen, before any text is. */}
      <span
        aria-hidden
        className={cx(
          'absolute inset-y-0 left-0 w-0.5 transition-opacity duration-140',
          BEHAVIOUR_STYLE[behaviour.behaviour].rule,
          active || cursor ? 'opacity-100' : 'opacity-0',
        )}
      />
      <button
        type="button"
        onClick={onSelect}
        aria-label={`${artifact.locator}. ${BEHAVIOUR_LABEL[behaviour.behaviour]}. ${stripeSummary(record.stripe)}`}
        className="block w-full px-4 py-3 text-left lg:grid lg:grid-cols-[76px_minmax(0,1fr)_168px_150px_136px_120px] lg:items-center lg:gap-4"
      >
        <span className="mb-2 flex items-center gap-3 lg:mb-0">
          <LoadStripe
            stripe={record.stripe}
            behaviour={behaviour.behaviour}
            size="sm"
            interactive={false}
          />
        </span>

        <span className="block min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate-flex font-mono text-xs text-ink-0">{artifact.locator}</span>
            {artifact.version !== null && (
              <span className="shrink-0 font-mono text-2xs text-ink-3">{artifact.version}</span>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {record.loadSites.length === 0 ? (
              <span className="font-mono text-2xs text-unknown">no load site found</span>
            ) : (
              <span className="font-mono text-2xs text-ink-3">
                {record.loadSites[0]?.file}:{record.loadSites[0]?.line}
                {record.loadSites.length > 1 && ` +${record.loadSites.length - 1}`}
              </span>
            )}
            {record.findings.some((f) => f.disposition === 'act') && (
              <span className="font-mono text-2xs uppercase tracking-[0.08em] text-code">act</span>
            )}
          </span>
        </span>

        {/* On a phone these four facts read as one wrapping line; on a wide
            screen `contents` dissolves this wrapper so they become four grid
            cells again. */}
        <span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 lg:mt-0 lg:contents">
          {/* `justify-self-start` because a grid item stretches by default,
              and a badge stretched across its column stops reading as a label
              and starts reading as a filled bar. */}
          <ExecutionIndicator
            behaviour={behaviour.behaviour}
            size="sm"
            guard={behaviour.guard === null ? null : undefined}
            className="lg:justify-self-start"
          />

          <span className="truncate-flex text-xs text-ink-2">{spec.label}</span>

          {/* Two badges and a count. Three wrapped to a second line and made
              one row taller than the rest, which breaks the scan down the
              column. */}
          <span className="flex flex-wrap items-center gap-1">
            {environments.length === 0 ? (
              <span className="font-mono text-2xs text-ink-3">&mdash;</span>
            ) : (
              <>
                {environments.slice(0, 2).map((context) => (
                  <ContextBadge
                    key={context.id}
                    environment={context.environment}
                    basis={context.basis}
                    privileged={privileged && context.privileged}
                  />
                ))}
                {environments.length > 2 && (
                  <span
                    className="font-mono text-2xs text-ink-3"
                    title={environments
                      .slice(2)
                      .map((c) => c.environment)
                      .join(', ')}
                  >
                    +{environments.length - 2}
                  </span>
                )}
              </>
            )}
          </span>

          <span className="block text-2xs">
            {migration === 'available' ? (
              <span className="font-mono uppercase tracking-[0.08em] text-accent">available</span>
            ) : (
              <span className="font-mono uppercase tracking-[0.08em] text-ink-3">&mdash;</span>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}
