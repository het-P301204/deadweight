/**
 * Format comparison.
 *
 * Current format on the left, alternative on the right, with the load
 * semantics of each stated rather than implied, and the behaviour the
 * artifact would have afterwards shown as the actual transition. The
 * remediation is copyable text and is never executed by DEADWEIGHT.
 *
 * The caveat has equal weight to the recommendation. Converting a pickle to
 * safetensors means loading the pickle once, which is the dangerous
 * operation; a migration card that left that out would be advice worth
 * ignoring.
 */

import { formatSpec } from '../engine/formats.ts'
import { BEHAVIOUR_LABEL } from '../engine/stripe.ts'
import type { Alternative, Artifact, LoadBehaviour } from '../engine/types.ts'
import { CopyButton, ExecutionIndicator, cx } from './primitives.tsx'
import { BEHAVIOUR_STYLE, SURFACE, TYPE } from './tokens.ts'

const KIND_LABEL: Record<Alternative['kind'], string> = {
  'sibling-present': 'Already in the repository',
  'loader-guard-available': 'Call-site guard',
  'conversion-available': 'Re-serialise',
  'none-identified': 'No alternative identified',
}

export function FormatComparison({
  artifact,
  behaviour,
  alternative,
}: {
  artifact: Artifact
  behaviour: LoadBehaviour
  alternative: Alternative
}) {
  const current = formatSpec(artifact.format.format)
  const target = alternative.targetFormat === null ? null : formatSpec(alternative.targetFormat)
  const none = alternative.kind === 'none-identified'

  return (
    <div className="space-y-4">
      <div className="grid gap-px overflow-hidden rounded-md border border-line-1 bg-line-1 md:grid-cols-[1fr_auto_1fr]">
        {/* current ------------------------------------------------------- */}
        <div className="bg-surface-1 p-4">
          <p className={TYPE.eyebrow}>Current</p>
          <p className="mt-2 font-display text-base font-medium text-ink-0">{current.label}</p>
          <p className="mt-1 font-mono text-2xs text-ink-3">{current.shape}</p>
          <div className="mt-3">
            <ExecutionIndicator behaviour={behaviour} size="sm" />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-ink-2">{current.mechanism}</p>
        </div>

        {/* the transition ------------------------------------------------ */}
        <div className="flex items-center justify-center bg-surface-1 px-4 py-3 md:px-3">
          <span
            aria-hidden
            className={cx(
              'font-mono text-lg',
              none ? 'text-ink-3' : BEHAVIOUR_STYLE[alternative.resultingBehaviour].text,
            )}
          >
            <span className="md:hidden">&#9660;</span>
            <span className="hidden md:inline">&#8594;</span>
          </span>
        </div>

        {/* alternative --------------------------------------------------- */}
        <div className={cx('p-4', none ? 'bg-surface-1' : 'bg-surface-1')}>
          <p className={cx(TYPE.eyebrow, none ? '' : 'text-accent')}>
            {KIND_LABEL[alternative.kind]}
          </p>
          <p className="mt-2 font-display text-base font-medium text-ink-0">
            {target?.label ?? alternative.summary}
          </p>
          {target !== null && <p className="mt-1 font-mono text-2xs text-ink-3">{target.shape}</p>}
          {!none && (
            <div className="mt-3">
              <ExecutionIndicator behaviour={alternative.resultingBehaviour} size="sm" />
            </div>
          )}
          <p className="mt-3 text-xs leading-relaxed text-ink-2">
            {target?.mechanism ?? alternative.difference}
          </p>
        </div>
      </div>

      {/* what the difference actually is -------------------------------- */}
      <div className={cx(SURFACE.well, 'p-4')}>
        <p className={TYPE.eyebrow}>Security difference</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-1">{alternative.difference}</p>
        {!none && (
          <p className="mt-3 text-xs text-ink-2">
            After the change, loading this artifact would be{' '}
            <span className={BEHAVIOUR_STYLE[alternative.resultingBehaviour].text}>
              {BEHAVIOUR_LABEL[alternative.resultingBehaviour].toLowerCase()}
            </span>
            .
          </p>
        )}
      </div>

      {alternative.change !== null && (
        <div className={cx(SURFACE.well, 'overflow-hidden')}>
          <div className="flex items-center justify-between gap-3 border-b border-line-1 px-4 py-2.5">
            <p className={TYPE.eyebrow}>The change</p>
            <CopyButton value={alternative.change} label="Copy" />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-2xs leading-relaxed text-ink-1 scroll-thin">
            {alternative.change}
          </pre>
        </div>
      )}

      {alternative.caveat !== null && (
        <div className="flex gap-3 rounded-md border border-unknown/30 bg-unknown/[0.05] p-4">
          <span aria-hidden className="mt-0.5 shrink-0 font-mono text-xs text-unknown">
            !
          </span>
          <div>
            <p className={cx(TYPE.eyebrow, 'text-unknown')}>Caveat</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-1">{alternative.caveat}</p>
          </div>
        </div>
      )}
    </div>
  )
}
