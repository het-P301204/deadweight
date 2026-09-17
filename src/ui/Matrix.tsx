/**
 * Behaviour x context.
 *
 * The one aggregate in the product, and the reason there is no severity
 * score. `code` in a sandbox and `code` in production are the same execution
 * surface reached from two very different places; a single number would have
 * to average them, and averaging them is how a real finding gets buried under
 * nine harmless ones.
 *
 * So it stays a coordinate. Rows are what loading does, columns are where,
 * and a cell is clickable: it sets both filters and takes you to the rows.
 */

import { ENVIRONMENT_META, ENVIRONMENT_ORDER } from '../engine/context.ts'
import { BEHAVIOUR_LABEL, BEHAVIOUR_NOTE } from '../engine/stripe.ts'
import { matrixKey } from '../engine/summary.ts'
import { LOAD_BEHAVIOURS } from '../engine/types.ts'
import type { EnvironmentId, LoadBehaviour, Summary } from '../engine/types.ts'
import { cx } from './primitives.tsx'
import { BEHAVIOUR_STYLE, TYPE } from './tokens.ts'
import { Tooltip } from './Tooltip.tsx'

export function Matrix({
  summary,
  onSelect,
}: {
  summary: Summary
  onSelect?: (behaviour: LoadBehaviour, environment: EnvironmentId) => void
}) {
  // Columns in reach order, most consequential first.
  const columns = ENVIRONMENT_ORDER.filter((id) => (summary.environments[id] ?? 0) > 0)
  const rows = LOAD_BEHAVIOURS.filter((behaviour) => summary.behaviour[behaviour] > 0)

  if (columns.length === 0 || rows.length === 0) return null

  const peak = Math.max(1, ...Object.values(summary.matrix))

  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full border-separate border-spacing-0 text-left">
        <caption className="sr-only">
          Load behaviour by load context. Rows are what loading does; columns are where it happens.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-surface-1 pb-3 pr-4" />
            {columns.map((id) => (
              <th key={id} scope="col" className="px-1 pb-3 text-center">
                <Tooltip content={ENVIRONMENT_META[id].note} width={260}>
                  <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-2">
                    {ENVIRONMENT_META[id].short}
                  </span>
                </Tooltip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((behaviour) => {
            const style = BEHAVIOUR_STYLE[behaviour]
            return (
              <tr key={behaviour}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 whitespace-nowrap bg-surface-1 py-1 pr-4 text-right"
                >
                  <Tooltip content={BEHAVIOUR_NOTE[behaviour]} width={280}>
                    <span className={cx('text-xs font-medium', style.text)}>
                      {BEHAVIOUR_LABEL[behaviour]}
                    </span>
                  </Tooltip>
                </th>
                {columns.map((environment) => {
                  const count = summary.matrix[matrixKey(behaviour, environment)] ?? 0
                  const share = count / peak
                  const interactive = count > 0 && onSelect !== undefined
                  return (
                    <td key={environment} className="p-1">
                      <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? () => onSelect(behaviour, environment) : undefined}
                        aria-label={`${count} ${BEHAVIOUR_LABEL[behaviour]} in ${ENVIRONMENT_META[environment].label}`}
                        className={cx(
                          'relative grid h-11 w-full min-w-[46px] place-items-center rounded border transition-all duration-140 ease-out tnum',
                          count === 0
                            ? 'border-line-1 bg-transparent text-ink-3'
                            : cx(style.border, style.text, 'hover:-translate-y-px'),
                          interactive ? 'cursor-pointer' : 'cursor-default',
                        )}
                        style={
                          count === 0
                            ? undefined
                            : {
                                // Opacity encodes the count, so the eye finds
                                // the dense cells before it reads a number.
                                backgroundColor: `color-mix(in srgb, currentColor ${Math.round(
                                  8 + share * 26,
                                )}%, transparent)`,
                              }
                        }
                      >
                        <span className="text-sm font-medium">{count === 0 ? '·' : count}</span>
                      </button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className={cx(TYPE.note, 'mt-3')}>
        An artifact loaded in more than one environment is counted in each column, so the rows do
        not sum to the artifact total. The two axes are reported separately and never combined into
        a score.
      </p>
    </div>
  )
}
