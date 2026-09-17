/**
 * The load stripe: DEADWEIGHT's signature.
 *
 * Six cells, one per stage of the pipeline the product exists to answer:
 *
 *     FORMAT  LOAD  EXEC  CONTEXT  EVIDENCE  ALTERNATIVE
 *
 * Each cell is resolved, flagged or unresolved. The glyph replaces four
 * badge columns in the explorer, which is how a hundred rows stay dense
 * without becoming cluttered -- and it is the same six facts the full-size
 * diagram on the overview draws, so a reader learns it once.
 *
 * Three treatments, so it survives greyscale and colour blindness:
 *
 *   resolved    solid, neutral grey
 *   flagged     solid, in the artifact's behaviour colour
 *   unresolved  hatched, amber
 */

import { STAGE_META } from '../engine/stripe.ts'
import type { LoadBehaviour, LoadStripe as Stripe, StripeCell, StripeStage } from '../engine/types.ts'
import { cx } from './primitives.tsx'
import { BEHAVIOUR_STYLE } from './tokens.ts'
import { Tooltip } from './Tooltip.tsx'

const SIZES = {
  xs: { w: 'w-1.5', h: 'h-3.5', gap: 'gap-[2px]' },
  sm: { w: 'w-2', h: 'h-4', gap: 'gap-[2px]' },
  md: { w: 'w-3', h: 'h-6', gap: 'gap-[3px]' },
  lg: { w: 'w-8', h: 'h-10', gap: 'gap-1' },
} as const

function cellClass(cell: StripeCell, behaviour: LoadBehaviour): string {
  if (cell.state === 'flagged') return BEHAVIOUR_STYLE[behaviour].fill
  if (cell.state === 'unresolved') return 'bg-unknown/20 text-unknown hatch'
  return 'bg-ink-2/40'
}

/** One-line summary for screen readers and for the row's accessible name. */
export function stripeSummary(stripe: Stripe): string {
  return stripe
    .map((cell) => `${STAGE_META[cell.stage].label}: ${cell.label} (${cell.state})`)
    .join('. ')
}

export function LoadStripe({
  stripe,
  behaviour,
  size = 'sm',
  interactive = true,
  onStageClick,
}: {
  stripe: Stripe
  behaviour: LoadBehaviour
  size?: keyof typeof SIZES
  /** When false the glyph is decoration beside text that already says it. */
  interactive?: boolean
  onStageClick?: (stage: StripeStage) => void
}) {
  const dimensions = SIZES[size]

  if (!interactive) {
    return (
      <span
        className={cx('inline-flex shrink-0', dimensions.gap)}
        role="img"
        aria-label={stripeSummary(stripe)}
      >
        {stripe.map((cell) => (
          <span
            key={cell.stage}
            className={cx('rounded-[1px]', dimensions.w, dimensions.h, cellClass(cell, behaviour))}
          />
        ))}
      </span>
    )
  }

  return (
    <span className={cx('inline-flex shrink-0', dimensions.gap)}>
      {stripe.map((cell) => (
        <Tooltip
          key={cell.stage}
          width={300}
          content={
            <>
              <span className="mb-1 block font-mono text-2xs uppercase tracking-[0.12em] text-ink-2">
                {STAGE_META[cell.stage].label} &middot; {STAGE_META[cell.stage].question}
              </span>
              <span className="mb-1 block text-xs font-medium text-ink-0">{cell.label}</span>
              <span className="block text-xs text-ink-2">{cell.detail}</span>
            </>
          }
        >
          <span
            role={onStageClick === undefined ? 'img' : 'button'}
            tabIndex={onStageClick === undefined ? -1 : 0}
            aria-label={`${STAGE_META[cell.stage].label}: ${cell.label}. ${cell.detail}`}
            onClick={onStageClick === undefined ? undefined : () => onStageClick(cell.stage)}
            onKeyDown={
              onStageClick === undefined
                ? undefined
                : (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onStageClick(cell.stage)
                    }
                  }
            }
            className={cx(
              'block rounded-[1px] transition-transform duration-140 ease-out',
              dimensions.w,
              dimensions.h,
              cellClass(cell, behaviour),
              onStageClick !== undefined && 'cursor-pointer hover:scale-y-110',
            )}
          />
        </Tooltip>
      ))}
    </span>
  )
}

/**
 * The stripe with its stage names underneath. Used once per view, at the top
 * of the explorer, so the glyph in every row below it is already explained.
 */
export function StripeLegend({ className }: { className?: string }) {
  return (
    <div className={cx('flex items-end gap-4', className)}>
      <div className="flex items-end gap-[3px]">
        {(['format', 'load', 'exec', 'context', 'evidence', 'alternative'] as StripeStage[]).map(
          (stage, index) => (
            <div key={stage} className="flex flex-col items-center gap-1.5">
              <span
                aria-hidden
                className={cx(
                  'h-4 w-2 rounded-[1px]',
                  index === 2 ? 'bg-ink-1/70' : 'bg-ink-2/40',
                )}
              />
              <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3">
                {STAGE_META[stage].short}
              </span>
            </div>
          ),
        )}
      </div>
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-4 text-2xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-1.5 rounded-[1px] bg-ink-2/40" />
          resolved
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-1.5 rounded-[1px] bg-code" />
          flagged
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="hatch h-3 w-1.5 rounded-[1px] bg-unknown/20 text-unknown" />
          unresolved
        </span>
      </dl>
    </div>
  )
}
