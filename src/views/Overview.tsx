/**
 * Overview.
 *
 * Not a wall of KPI cards. It opens with the signature diagram, because the
 * fastest way to understand the product is to watch nine artifacts traced
 * through the six stages that decide what loading them does. The indicators
 * come second, as inventory state rather than as scores, and the matrix third
 * because it is the shape of the actual question.
 */

import { useMemo } from 'react'

import { ENVIRONMENT_META } from '../engine/context.ts'
import { BEHAVIOUR_LABEL } from '../engine/stripe.ts'
import { behaviourDistribution, indicators } from '../engine/summary.ts'
import type { EnvironmentId, LoadBehaviour, Report } from '../engine/types.ts'
import { LoadBoundary } from '../ui/LoadBoundary.tsx'
import { LoadStripe } from '../ui/LoadStripe.tsx'
import { Matrix } from '../ui/Matrix.tsx'
import { Button, DispositionDot, Panel, PathRef, cx, useCountUp } from '../ui/primitives.tsx'
import { BEHAVIOUR_STYLE, SURFACE, TYPE } from '../ui/tokens.ts'
import { Tooltip } from '../ui/Tooltip.tsx'

export function Overview({
  report,
  isDemo,
  notes,
  onSelectArtifact,
  onMatrixSelect,
  onGoToFindings,
}: {
  report: Report
  isDemo: boolean
  notes: readonly string[]
  onSelectArtifact: (id: string) => void
  onMatrixSelect: (behaviour: LoadBehaviour, environment: EnvironmentId) => void
  onGoToFindings: () => void
}) {
  const acts = report.findings.filter((f) => f.disposition === 'act')
  const reviews = report.findings.filter((f) => f.disposition === 'review')
  const distribution = behaviourDistribution(report.summary)
  const formats = Object.entries(report.summary.formats).sort((a, b) => b[1] - a[1])
  const records = useMemo(
    () => new Map(report.records.map((r) => [r.artifact.id, r])),
    [report.records],
  )

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8 md:px-10">
      {/* header ---------------------------------------------------------- */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className={TYPE.eyebrow}>AI model &amp; skill supply-chain analysis</p>
          <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-ink-0">
            {report.project}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-2">
            {report.counts.filesWalked} files in scope, {report.counts.filesRead} read.{' '}
            {report.summary.loadSites} load site{report.summary.loadSites === 1 ? '' : 's'} across{' '}
            {report.summary.artifacts} artifact{report.summary.artifacts === 1 ? '' : 's'}. No
            artifact was deserialised to produce any of it.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isDemo && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-2 font-mono text-2xs uppercase tracking-[0.12em] text-accent-strong">
              Demo &middot; synthetic
            </span>
          )}
          <Tooltip
            width={280}
            content="Digest of the canonical report body. Two analyses of the same tree produce the same value, which is what makes a BOM diff mean something."
          >
            <span className="font-mono text-2xs text-ink-3">
              report {report.digest.slice(0, 16)}
            </span>
          </Tooltip>
        </div>
      </header>

      {notes.length > 0 && (
        <div className={cx(SURFACE.panel, 'border-unknown/30 bg-unknown/[0.04] px-5 py-3')}>
          <ul className="space-y-1">
            {notes.map((note) => (
              <li key={note} className="text-xs text-unknown">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* the signature --------------------------------------------------- */}
      <Panel
        eyebrow="Signature"
        title="The load boundary"
        bleed
        actions={
          <span className="hidden font-mono text-2xs text-ink-3 sm:block">
            hover a trace &middot; click to investigate
          </span>
        }
      >
        <div className="grid-field border-b border-line-1 px-3 py-5 md:px-6">
          <LoadBoundary records={report.records} onSelect={onSelectArtifact} />
        </div>
        <p className={cx(TYPE.note, 'px-5 py-4')}>
          Each trace is one artifact, drawn in the colour of what loading it does. Everything to the
          right of the dashed line was derived without loading anything to the left of it:
          recognition read magic bytes, container member names and source text. The six nodes are
          the same six cells as the glyph in every artifact row.
        </p>
      </Panel>

      {/* indicators ------------------------------------------------------ */}
      <section>
        <h2 className="sr-only">Inventory indicators</h2>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-1 bg-line-1 sm:grid-cols-4 xl:grid-cols-8">
          {indicators(report.summary).map((indicator, index) => (
            <Indicator key={indicator.id} indicator={indicator} index={index} />
          ))}
        </div>
        <p className={cx(TYPE.note, 'mt-3')}>
          These are counts of state, not scores. Nothing here is combined with anything else here.
        </p>
      </section>

      {/* matrix + distribution ------------------------------------------- */}
      {/* `items-start` so the matrix panel is the height of the matrix rather
          than being stretched to match the taller column beside it. */}
      <div className="grid items-start gap-6 xl:grid-cols-[1.35fr_1fr]">
        <Panel eyebrow="Two axes" title="What loading does, by where it happens">
          <Matrix summary={report.summary} onSelect={onMatrixSelect} />
        </Panel>

        <div className="space-y-6">
          <Panel eyebrow="Distribution" title="Load behaviour">
            <div
              className="flex h-3 overflow-hidden rounded-full bg-surface-3"
              role="img"
              aria-label={distribution
                .map((d) => `${BEHAVIOUR_LABEL[d.behaviour]}: ${d.count}`)
                .join(', ')}
            >
              {/* A plain span, not a Tooltip: the Tooltip wrapper is an
                  inline-flex element, so a percentage width on its child has
                  nothing to resolve against and every segment collapses. */}
              {distribution.map((item) => (
                <span
                  key={item.behaviour}
                  title={`${BEHAVIOUR_LABEL[item.behaviour]}: ${item.count} of ${report.summary.artifacts}`}
                  className={cx(
                    'block h-3 transition-[width] duration-380 ease-out',
                    BEHAVIOUR_STYLE[item.behaviour].fill,
                  )}
                  style={{ width: `${Math.max(2, item.share * 100)}%` }}
                />
              ))}
            </div>
            <dl className="mt-4 space-y-2">
              {distribution.map((item) => (
                <div key={item.behaviour} className="flex items-baseline justify-between gap-3">
                  <dt className="flex items-center gap-2 text-xs text-ink-1">
                    <span
                      aria-hidden
                      className={cx('h-2 w-2 rounded-sm', BEHAVIOUR_STYLE[item.behaviour].fill)}
                    />
                    {BEHAVIOUR_LABEL[item.behaviour]}
                  </dt>
                  <dd className="font-mono text-xs text-ink-2 tnum">{item.count}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel eyebrow="Distribution" title="Format">
            <dl className="space-y-2">
              {formats.slice(0, 9).map(([label, count]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="truncate-flex text-xs text-ink-1">{label}</dt>
                  <dd className="shrink-0 font-mono text-xs text-ink-2 tnum">{count}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
      </div>

      {/* findings --------------------------------------------------------- */}
      <Panel
        eyebrow="Findings"
        title={`${acts.length} to act on, ${reviews.length} to review`}
        actions={
          <Button onClick={onGoToFindings}>
            All {report.findings.length} findings
          </Button>
        }
        bleed
      >
        {report.findings.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-2">
            Nothing to act on and nothing to review. Every artifact resolved to a data-only load.
          </p>
        ) : (
          <ul>
            {[...acts, ...reviews].slice(0, 8).map((finding) => {
              // The title is the *class* of finding, so several artifacts
              // legitimately share one. The subject has to be on the row or
              // three identical headlines read as a repeated bug.
              const subject =
                finding.artifactId === null
                  ? null
                  : (records.get(finding.artifactId) ?? null)
              return (
                <li key={finding.id} className={cx(SURFACE.row, 'px-5 py-4')}>
                  <button
                    type="button"
                    onClick={
                      finding.artifactId === null
                        ? undefined
                        : () => onSelectArtifact(finding.artifactId as string)
                    }
                    className="group block w-full text-left"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <DispositionDot disposition={finding.disposition} />
                      {subject !== null && (
                        <>
                          <LoadStripe
                            stripe={subject.stripe}
                            behaviour={subject.behaviour.behaviour}
                            size="xs"
                            interactive={false}
                          />
                          <span className="font-mono text-xs text-ink-0 group-hover:text-accent-strong">
                            {subject.artifact.locator}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="mt-2 text-sm font-medium text-ink-0">{finding.title}</p>
                    <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-2">
                      {finding.rationale}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {finding.locations.slice(0, 4).map((location) => {
                        const at = location.lastIndexOf(':')
                        const line = Number.parseInt(location.slice(at + 1), 10)
                        return (
                          <PathRef
                            key={location}
                            path={Number.isFinite(line) ? location.slice(0, at) : location}
                            line={Number.isFinite(line) ? line : null}
                          />
                        )
                      })}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {/* environments ----------------------------------------------------- */}
      <Panel eyebrow="Context" title="Where these loads happen">
        <div className="flex flex-wrap gap-2">
          {Object.entries(report.summary.environments)
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([id, count]) => {
              const environment = id as EnvironmentId
              return (
                <Tooltip key={id} width={280} content={ENVIRONMENT_META[environment].note}>
                  <span className={cx(SURFACE.well, 'flex items-baseline gap-2 px-3 py-2')}>
                    <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-2">
                      {ENVIRONMENT_META[environment].short}
                    </span>
                    <span className="font-mono text-sm text-ink-0 tnum">{count}</span>
                  </span>
                </Tooltip>
              )
            })}
        </div>
        {report.dependencies.length > 0 && (
          <p className={cx(TYPE.note, 'mt-4')}>
            {report.dependencies.length} dependencies declared,{' '}
            {report.dependencies.filter((d) => d.pin === 'exact').length} pinned exactly. A loader
            whose default changed at a known release cannot be resolved without an exact pin, which
            is why {report.summary.behaviour.unknown} artifact
            {report.summary.behaviour.unknown === 1 ? '' : 's'} came back unresolved.
          </p>
        )}
      </Panel>
    </div>
  )
}

function Indicator({
  indicator,
  index,
}: {
  indicator: ReturnType<typeof indicators>[number]
  index: number
}) {
  const shown = useCountUp(indicator.value, 600 + index * 40)
  const tone =
    indicator.tone === 'neutral'
      ? 'text-ink-0'
      : BEHAVIOUR_STYLE[indicator.tone as LoadBehaviour].text

  return (
    <Tooltip width={300} content={indicator.note} className="w-full">
      <div className="flex w-full flex-col justify-between bg-surface-1 px-4 py-4 text-left transition-colors duration-140 hover:bg-surface-2">
        <p className="font-mono text-2xs uppercase leading-tight tracking-[0.1em] text-ink-2">
          {indicator.label}
        </p>
        <p className="mt-3 flex items-baseline gap-1">
          <span className={cx('font-display text-2xl font-medium tracking-tight tnum', tone)}>
            {shown}
          </span>
          {indicator.of !== null && indicator.of > 0 && (
            <span className="font-mono text-2xs text-ink-3">/{indicator.of}</span>
          )}
        </p>
      </div>
    </Tooltip>
  )
}
