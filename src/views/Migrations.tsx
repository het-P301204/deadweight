/**
 * Migrations.
 *
 * The one screen in the product that is about doing something. Every entry is
 * an execution surface that can be removed rather than trusted, ordered by
 * how cheap the removal is:
 *
 *   the safe file is already in the repository and the code loads the other
 *   one  ->  a flag on the call closes the surface  ->  the payload has to be
 *   re-serialised
 *
 * The caveat travels with the recommendation every time. "Convert to
 * safetensors" is good advice that requires loading the pickle once, and
 * advice that hides its own cost is not advice.
 */

import { useMemo, useState } from 'react'

import { distinctEnvironments, ENVIRONMENT_META } from '../engine/context.ts'
import { formatSpec } from '../engine/formats.ts'
import { BEHAVIOUR_LABEL } from '../engine/stripe.ts'
import type { AlternativeKind, ArtifactRecord, Report } from '../engine/types.ts'
import { FormatComparison } from '../ui/FormatComparison.tsx'
import { LoadStripe } from '../ui/LoadStripe.tsx'
import {
  Button,
  ContextBadge,
  CopyButton,
  EmptyState,
  ExecutionIndicator,
  cx,
} from '../ui/primitives.tsx'
import { SURFACE, TYPE } from '../ui/tokens.ts'

const ORDER: readonly AlternativeKind[] = [
  'sibling-present',
  'loader-guard-available',
  'conversion-available',
]

const GROUP_META: Record<
  AlternativeKind,
  { title: string; lead: string }
> = {
  'sibling-present': {
    title: 'The safe file is already here',
    lead: 'A data-only export of these weights is committed beside the one the code loads. One line, nothing to convert, nothing to rebuild.',
  },
  'loader-guard-available': {
    title: 'A flag on the call closes the surface',
    lead: 'The loader accepts an argument that removes arbitrary-callable invocation. It costs nothing, and it is a guard rather than a format change: one keyword away from reopening.',
  },
  'conversion-available': {
    title: 'The payload can be re-serialised',
    lead: 'A data-oriented format carries what these artifacts carry. Real work, and it removes the surface rather than suppressing it.',
  },
  'none-identified': { title: '', lead: '' },
}

export function Migrations({
  report,
  onSelectArtifact,
}: {
  report: Report
  onSelectArtifact: (id: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)

  const groups = useMemo(() => {
    return ORDER.map((kind) => ({
      kind,
      records: report.records
        .filter((r) => r.alternative.kind === kind && r.behaviour.behaviour !== 'data')
        .sort((a, b) => (a.artifact.locator < b.artifact.locator ? -1 : 1)),
    })).filter((group) => group.records.length > 0)
  }, [report.records])

  const total = groups.reduce((sum, group) => sum + group.records.length, 0)

  const plan = useMemo(() => {
    const lines = [`# Format migration plan for ${report.project}`, '']
    for (const group of groups) {
      lines.push(`## ${GROUP_META[group.kind].title}`, '')
      for (const record of group.records) {
        lines.push(`### ${record.artifact.locator}`)
        lines.push(`- now: ${BEHAVIOUR_LABEL[record.behaviour.behaviour]} — ${record.behaviour.mechanism}`)
        lines.push(`- after: ${BEHAVIOUR_LABEL[record.alternative.resultingBehaviour]}`)
        if (record.alternative.change !== null) {
          lines.push('', '```', record.alternative.change, '```')
        }
        if (record.alternative.caveat !== null) {
          lines.push('', `> Caveat: ${record.alternative.caveat}`)
        }
        lines.push('')
      }
    }
    return lines.join('\n')
  }, [groups, report.project])

  if (total === 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-8 md:px-10">
        <div className={SURFACE.panel}>
          <EmptyState
            headline="No migration opportunity identified"
            body="Every execution surface in this project either has no data-oriented equivalent, or there is no execution surface to remove. That is not the same as everything being safe: check the unresolved artifacts, which have no alternative to offer because their behaviour is not known."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8 md:px-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={TYPE.eyebrow}>Migration opportunities</p>
          <h1 className="mt-2 font-display text-2xl font-medium tracking-tight text-ink-0">
            {total} execution surface{total === 1 ? '' : 's'} that can be removed
          </h1>
          <p className={cx(TYPE.note, 'mt-2 max-w-3xl')}>
            Ordered by cost. Removing a surface is not the same as trusting the file: after each of
            these changes, nothing in the artifact names a callable, so there is nothing left to
            trust.
          </p>
        </div>
        <CopyButton value={plan} label="Copy migration plan" variant="primary" />
      </header>

      {groups.map((group) => (
        <section key={group.kind} className="space-y-4">
          <header className="border-t border-line-1 pt-5">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="font-display text-lg font-medium text-ink-0">
                {GROUP_META[group.kind].title}
              </h2>
              <span className="font-mono text-2xs text-ink-3 tnum">
                {group.records.length} artifact{group.records.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className={cx(TYPE.note, 'mt-2 max-w-3xl')}>{GROUP_META[group.kind].lead}</p>
          </header>

          <div className="space-y-3">
            {group.records.map((record) => (
              <MigrationCard
                key={record.artifact.id}
                record={record}
                open={open === record.artifact.id}
                onToggle={() => setOpen(open === record.artifact.id ? null : record.artifact.id)}
                onInvestigate={() => onSelectArtifact(record.artifact.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function MigrationCard({
  record,
  open,
  onToggle,
  onInvestigate,
}: {
  record: ArtifactRecord
  open: boolean
  onToggle: () => void
  onInvestigate: () => void
}) {
  const { artifact, behaviour, alternative } = record

  return (
    <article className={cx(SURFACE.panel, 'overflow-hidden')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="block w-full px-5 py-4 text-left transition-colors duration-90 hover:bg-surface-2"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <LoadStripe
            stripe={record.stripe}
            behaviour={behaviour.behaviour}
            size="sm"
            interactive={false}
          />
          <span className="min-w-0 flex-1 truncate-flex font-mono text-xs text-ink-0">
            {artifact.locator}
          </span>
          <ExecutionIndicator behaviour={behaviour.behaviour} size="sm" />
          <span aria-hidden className="font-mono text-xs text-ink-3">
            &#8594;
          </span>
          <ExecutionIndicator behaviour={alternative.resultingBehaviour} size="sm" />
          {distinctEnvironments(record.contexts)
            .slice(0, 2)
            .map((context) => (
              <ContextBadge
                key={context.id}
                environment={context.environment}
                basis={context.basis}
                privileged={context.privileged}
              />
            ))}
          <span
            aria-hidden
            className={cx(
              'shrink-0 text-ink-3 transition-transform duration-140 ease-out',
              open && 'rotate-90',
            )}
          >
            &#9656;
          </span>
        </div>
        <p className="mt-2 text-sm text-ink-1">{alternative.summary}</p>
      </button>

      {open && (
        <div className="motion-fade animate-stage-in border-t border-line-1 p-5">
          <FormatComparison
            artifact={artifact}
            behaviour={behaviour.behaviour}
            alternative={alternative}
          />
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line-1 pt-4">
            <Button onClick={onInvestigate}>Investigate artifact</Button>
            <p className="font-mono text-2xs text-ink-3">
              {formatSpec(artifact.format.format).label}
              {record.contexts.length > 0 &&
                ` · loaded in ${[
                  ...new Set(record.contexts.map((c) => ENVIRONMENT_META[c.environment].label)),
                ].join(', ')}`}
            </p>
          </div>
        </div>
      )}
    </article>
  )
}
