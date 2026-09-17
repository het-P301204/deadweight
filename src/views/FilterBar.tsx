/**
 * The filter bar.
 *
 * Facets are laid out in the order of the question the product asks, so the
 * bar reads as the pipeline: what it does, where, what it is, whether the
 * surface can be removed, what has been checked.
 *
 * Every chip carries its count, and the count is computed with that facet's
 * own selection removed -- so a chip never shows zero while being clickable,
 * and selecting one value does not make its siblings look empty.
 */

import { useEffect, useRef, useState } from 'react'

import { ENVIRONMENT_META, ENVIRONMENT_ORDER } from '../engine/context.ts'
import { formatSpec } from '../engine/formats.ts'
import { BEHAVIOUR_LABEL, BEHAVIOUR_NOTE } from '../engine/stripe.ts'
import { LOAD_BEHAVIOURS } from '../engine/types.ts'
import type { FormatId } from '../engine/types.ts'
import { Button, Chip, cx } from '../ui/primitives.tsx'
import { CONTROL, TYPE } from '../ui/tokens.ts'
import type { EvidenceFilter, FacetCounts, Filters, MigrationFilter } from './filter.ts'
import { activeFilterCount } from './filter.ts'

const MIGRATION_LABEL: Record<MigrationFilter, string> = {
  available: 'Safe format available',
  none: 'None identified',
}

const EVIDENCE_LABEL: Record<EvidenceFilter, string> = {
  bound: 'Bound',
  stale: 'Stale',
  unbound: 'Unbound',
  absent: 'Absent',
}

export function FilterBar({
  filters,
  counts,
  total,
  shown,
  onToggle,
  onQuery,
  onClear,
  onTogglePrivileged,
  searchRef,
}: {
  filters: Filters
  counts: FacetCounts
  total: number
  shown: number
  onToggle: <K extends 'behaviour' | 'environment' | 'format' | 'migration' | 'evidence'>(
    facet: K,
    value: Filters[K][number],
  ) => void
  onQuery: (value: string) => void
  onClear: () => void
  onTogglePrivileged: () => void
  searchRef?: React.RefObject<HTMLInputElement | null>
}) {
  const local = useRef<HTMLInputElement>(null)
  const [facetsOpen, setFacetsOpen] = useState(false)
  const field = searchRef ?? local
  const active = activeFilterCount(filters)

  // `/` focuses search, the way it does in every code host.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      field.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [field])

  const formats = [...counts.format.entries()].sort((a, b) => b[1] - a[1])

  /*
   * Each facet's chips are built first so a facet with none can be dropped
   * rather than rendered as a bare label. A zero-count value is left out
   * entirely, except when it is currently selected -- removing the only
   * control that could clear a filter is how a user gets stuck.
   */
  const facets: ReadonlyArray<{ label: string; chips: React.ReactNode[] }> = [
    {
      label: 'Execution',
      chips: LOAD_BEHAVIOURS.filter(
        (b) => (counts.behaviour.get(b) ?? 0) > 0 || filters.behaviour.includes(b),
      ).map((behaviour) => (
        <Chip
          key={behaviour}
          active={filters.behaviour.includes(behaviour)}
          onClick={() => onToggle('behaviour', behaviour)}
          count={counts.behaviour.get(behaviour) ?? 0}
          title={BEHAVIOUR_NOTE[behaviour]}
        >
          {BEHAVIOUR_LABEL[behaviour]}
        </Chip>
      )),
    },
    {
      label: 'Context',
      chips: [
        ...ENVIRONMENT_ORDER.filter(
          (id) => (counts.environment.get(id) ?? 0) > 0 || filters.environment.includes(id),
        ).map((id) => (
          <Chip
            key={id}
            active={filters.environment.includes(id)}
            onClick={() => onToggle('environment', id)}
            count={counts.environment.get(id) ?? 0}
            title={ENVIRONMENT_META[id].note}
          >
            {ENVIRONMENT_META[id].short}
          </Chip>
        )),
        ...(counts.privileged > 0 || filters.privilegedOnly
          ? [
              <Chip
                key="privileged"
                active={filters.privilegedOnly}
                onClick={onTogglePrivileged}
                count={counts.privileged}
                title="Only artifacts whose loading file shows credential, secret or process-execution capability"
              >
                Privileged
              </Chip>,
            ]
          : []),
      ],
    },
    {
      label: 'Format',
      chips: formats
        .filter(([id, count]) => count > 0 || filters.format.includes(id))
        .map(([id, count]) => (
          <Chip
            key={id}
            active={filters.format.includes(id)}
            onClick={() => onToggle('format', id as FormatId)}
            count={count}
            title={formatSpec(id as FormatId).mechanism}
          >
            {formatSpec(id as FormatId).label}
          </Chip>
        )),
    },
    {
      label: 'Migration',
      chips: (['available', 'none'] as MigrationFilter[])
        .filter((id) => (counts.migration.get(id) ?? 0) > 0 || filters.migration.includes(id))
        .map((id) => (
          <Chip
            key={id}
            active={filters.migration.includes(id)}
            onClick={() => onToggle('migration', id)}
            count={counts.migration.get(id) ?? 0}
          >
            {MIGRATION_LABEL[id]}
          </Chip>
        )),
    },
    {
      label: 'Evidence',
      chips: (['bound', 'stale', 'unbound', 'absent'] as EvidenceFilter[])
        .filter((id) => (counts.evidence.get(id) ?? 0) > 0 || filters.evidence.includes(id))
        .map((id) => (
          <Chip
            key={id}
            active={filters.evidence.includes(id)}
            onClick={() => onToggle('evidence', id)}
            count={counts.evidence.get(id) ?? 0}
            title={
              id === 'absent'
                ? 'No scanner result recorded. An absent scan is not a clean scan.'
                : id === 'stale'
                  ? 'A record exists but its digest is not the file on disk.'
                  : undefined
            }
          >
            {EVIDENCE_LABEL[id]}
          </Chip>
        )),
    },
  ].filter((facet) => facet.chips.length > 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <input
            ref={field}
            type="search"
            value={filters.query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onQuery('')
                event.currentTarget.blur()
              }
            }}
            placeholder="Search path, loader, format, context, finding"
            aria-label="Search artifacts"
            className={cx(CONTROL.input, 'pr-14')}
          />
          {filters.query === '' && (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
              /
            </kbd>
          )}
        </div>

        <p className="shrink-0 font-mono text-2xs text-ink-2 tnum">
          {shown === total ? `${total} artifacts` : `${shown} of ${total}`}
        </p>

        {active > 0 && (
          <Button onClick={onClear} title="Clear all filters">
            Clear {active} filter{active === 1 ? '' : 's'}
          </Button>
        )}

        {/* Twenty-four chips before the first row is not a filter bar on a
            phone, it is a wall. Search stays; the facets fold. */}
        <Button
          onClick={() => setFacetsOpen(!facetsOpen)}
          className="lg:hidden"
          title="Show or hide the filter facets"
        >
          {facetsOpen ? 'Hide facets' : `Facets${active > 0 ? ` (${active})` : ''}`}
        </Button>
      </div>

      <div className={cx('space-y-2.5', !facetsOpen && 'hidden lg:block')}>
        {facets.map((facet) => (
          <Facet key={facet.label} label={facet.label}>
            {facet.chips}
          </Facet>
        ))}
      </div>
    </div>
  )
}

/**
 * A facet row. Rendered only when it has chips: a search that matches nothing
 * zeroes every count, and five bare labels with no controls under them reads
 * as a broken filter bar rather than an empty one.
 */
function Facet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cx(TYPE.eyebrow, 'w-full shrink-0 sm:w-[72px]')}>{label}</span>
      {children}
    </div>
  )
}
