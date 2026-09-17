/**
 * Analysis progress.
 *
 * Eight named stages, each showing the real count it produced. There is no
 * percentage, because there is no honest one: the work per stage depends on
 * what the tree turns out to contain, and a bar creeping toward a number
 * nobody chose is a lie told for comfort.
 *
 * The running stage gets a pulse and the finished ones get their counts. That
 * is the whole animation, and it is the same shape as the CLI's output.
 */

import { STAGE_META } from '../engine/analyze.ts'
import type { StageState } from '../state.ts'
import { Skeleton, cx } from '../ui/primitives.tsx'
import { SURFACE, TYPE } from '../ui/tokens.ts'

export function AnalysisProgress({
  stages,
  source,
}: {
  stages: readonly StageState[]
  source: string
}) {
  const done = stages.filter((s) => s.status === 'done').length

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-24">
      <p className={TYPE.eyebrow}>Analysing</p>
      <h1 className="mt-3 font-display text-2xl font-medium tracking-tight text-ink-0">
        {source === 'demo' ? 'Demo project' : 'Selected directory'}
      </h1>
      <p className={cx(TYPE.note, 'mt-2')}>
        {done} of {stages.length} stages complete. Nothing is being loaded; each stage reads what it
        needs and states what it found.
      </p>

      <ol className={cx(SURFACE.panel, 'mt-8 divide-y divide-line-1')} aria-live="polite">
        {stages.map((stage, index) => {
          const meta = STAGE_META[stage.stage] ?? { label: stage.stage, verb: '' }
          return (
            <li key={stage.stage} className="flex items-center gap-4 px-5 py-3.5">
              <span
                aria-hidden
                className={cx(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border font-mono text-[10px] transition-all duration-220 ease-out',
                  stage.status === 'done' && 'border-data/50 bg-data/15 text-data',
                  stage.status === 'running' &&
                    'animate-pulse-once border-accent/60 bg-accent/15 text-accent-strong',
                  stage.status === 'pending' && 'border-line-2 text-ink-3',
                )}
              >
                {stage.status === 'done' ? '✓' : String(index + 1).padStart(2, '0')}
              </span>

              <span
                className={cx(
                  'w-32 shrink-0 text-sm transition-colors duration-220',
                  stage.status === 'pending' ? 'text-ink-3' : 'text-ink-0',
                )}
              >
                {meta.label}
              </span>

              <span className="min-w-0 flex-1">
                {stage.status === 'done' ? (
                  <span className="motion-fade block animate-stage-in font-mono text-xs text-ink-1">
                    {stage.detail}
                  </span>
                ) : stage.status === 'running' ? (
                  <span className="block font-mono text-xs text-ink-2">{meta.verb}&hellip;</span>
                ) : (
                  <Skeleton className="h-3 w-40" />
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
