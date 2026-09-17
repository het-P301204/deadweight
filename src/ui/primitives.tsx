/**
 * Shared primitives.
 *
 * Everything visual in DEADWEIGHT is built from these, so that a status badge
 * in the explorer and the same status in the drawer are literally the same
 * component rather than two things that happen to look alike.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { ENVIRONMENT_META, PRIVILEGE_META } from '../engine/context.ts'
import { BEHAVIOUR_LABEL, BEHAVIOUR_NOTE } from '../engine/stripe.ts'
import type {
  EnvironmentId,
  EvidenceBinding,
  FindingDisposition,
  LoadBehaviour,
  PrivilegeSignal,
} from '../engine/types.ts'
import {
  BEHAVIOUR_STYLE,
  BINDING_STYLE,
  CONTROL,
  DISPOSITION_STYLE,
  ENVIRONMENT_STYLE,
  SURFACE,
  TYPE,
} from './tokens.ts'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className,
  bleed,
}: {
  title?: string
  eyebrow?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Remove the body padding, for tables and diagrams that own their edges. */
  bleed?: boolean
}) {
  return (
    <section className={cx(SURFACE.panel, 'overflow-hidden', className)}>
      {(title !== undefined || actions !== undefined) && (
        <header className="flex items-start justify-between gap-4 border-b border-line-1 px-5 py-4">
          <div className="min-w-0">
            {eyebrow !== undefined && <p className={cx(TYPE.eyebrow, 'mb-1.5')}>{eyebrow}</p>}
            {title !== undefined && <h2 className={TYPE.title}>{title}</h2>}
          </div>
          {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bleed === true ? '' : 'p-5'}>{children}</div>
    </section>
  )
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <div className="min-w-0">
      <dt className={cx(TYPE.eyebrow, 'mb-1.5')}>{label}</dt>
      <dd className="text-sm text-ink-0">{children}</dd>
      {hint !== undefined && <p className={cx(TYPE.note, 'mt-1.5')}>{hint}</p>}
    </div>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono text-xs', className)}>{children}</span>
}

/** A repo-relative path with a line number, rendered so the tail stays visible. */
export function PathRef({ path, line }: { path: string; line?: number | null }) {
  return (
    <span className="inline-flex min-w-0 items-baseline font-mono text-xs">
      <span className="truncate-flex text-ink-1" dir="rtl" style={{ textAlign: 'left' }}>
        <span dir="ltr">{path}</span>
      </span>
      {line !== undefined && line !== null && <span className="shrink-0 text-ink-3">:{line}</span>}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The load-behaviour badge.
 *
 * `guarded` is drawn as an outline rather than a fill, because it is not the
 * same fact as `data`: the execution surface is present and a flag is holding
 * it shut. The shape carries that, not only the words.
 */
export function ExecutionIndicator({
  behaviour,
  size = 'md',
  guard,
  className,
}: {
  behaviour: LoadBehaviour
  size?: 'sm' | 'md'
  guard?: string | null
  /** For grid placement: a badge must not stretch to fill its cell. */
  className?: string
}) {
  const style = BEHAVIOUR_STYLE[behaviour]
  const outline = behaviour === 'guarded'
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border font-medium',
        size === 'sm' ? 'h-5 px-1.5 text-2xs' : 'h-6 px-2 text-xs',
        style.text,
        style.border,
        outline ? 'bg-transparent' : style.wash,
        className,
      )}
      title={`${BEHAVIOUR_LABEL[behaviour]} — ${BEHAVIOUR_NOTE[behaviour]}`}
    >
      <span
        aria-hidden
        className={cx(
          'h-1.5 w-1.5 shrink-0',
          outline ? cx('rounded-full border', style.border) : cx('rounded-full', style.fill),
        )}
      />
      {BEHAVIOUR_LABEL[behaviour]}
      {guard !== undefined && guard !== null && (
        <span className="font-mono text-2xs opacity-70">{guard}</span>
      )}
    </span>
  )
}

export function ContextBadge({
  environment,
  basis,
  privileged,
}: {
  environment: EnvironmentId
  basis?: 'declared' | 'inferred' | 'unresolved'
  privileged?: boolean
}) {
  const meta = ENVIRONMENT_META[environment]
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.08em]',
        ENVIRONMENT_STYLE[environment],
      )}
      title={`${meta.label} — ${meta.note}${basis === undefined ? '' : ` (${basis})`}`}
    >
      {meta.short}
      {basis === 'inferred' && (
        <span aria-label="inferred" className="opacity-50">
          ~
        </span>
      )}
      {privileged === true && (
        <span aria-label="privileged" className="text-code">
          &#9650;
        </span>
      )}
    </span>
  )
}

export function DispositionDot({ disposition }: { disposition: FindingDisposition }) {
  const style = DISPOSITION_STYLE[disposition]
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.08em]', style.text)}>
      <span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  )
}

export function BindingBadge({ binding }: { binding: EvidenceBinding }) {
  const style = BINDING_STYLE[binding]
  return (
    <span
      className={cx(
        'inline-flex items-center rounded border border-current/25 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.08em]',
        style.text,
      )}
    >
      {style.label}
    </span>
  )
}

export function PrivilegeList({ privileges }: { privileges: readonly PrivilegeSignal[] }) {
  if (privileges.length === 0) {
    return <p className={TYPE.note}>No credential, secret or process-execution signal in the loading file.</p>
  }
  return (
    <ul className="space-y-2">
      {privileges.map((privilege) => (
        <li key={`${privilege.kind}-${privilege.line}`} className="flex gap-2.5">
          <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-code" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink-0">{privilege.label}</p>
            <p className={cx(TYPE.note, 'mt-0.5')}>
              {PRIVILEGE_META[privilege.kind]?.note ?? ''}
            </p>
            <div className="mt-1 flex items-baseline gap-2">
              <PathRef path={privilege.file} line={privilege.line} />
            </div>
            <code className="mt-1 block truncate rounded bg-surface-inset px-1.5 py-1 font-mono text-2xs text-ink-2">
              {privilege.evidence}
            </code>
          </div>
        </li>
      ))}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

export function Button({
  children,
  onClick,
  variant = 'default',
  title,
  disabled,
  className,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary'
  title?: string
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cx(variant === 'primary' ? CONTROL.primary : CONTROL.button, className)}
    >
      {children}
    </button>
  )
}

export function Chip({
  children,
  active,
  onClick,
  count,
  title,
}: {
  children: ReactNode
  active: boolean
  onClick: () => void
  count?: number
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={active ? CONTROL.chipOn : CONTROL.chip}
    >
      {children}
      {count !== undefined && (
        <span className={cx('tnum', active ? 'text-accent-strong/70' : 'text-ink-3')}>{count}</span>
      )}
    </button>
  )
}

/**
 * Copy to clipboard with feedback that says what happened.
 *
 * Falls back to a hidden textarea and `execCommand` because the app is served
 * from `file://` in some of its own screenshots, where the async clipboard API
 * is unavailable, and a copy button that silently does nothing is worse than
 * no copy button.
 */
export function CopyButton({
  value,
  label = 'Copy',
  variant = 'default',
}: {
  value: string
  label?: string
  variant?: 'default' | 'primary'
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1800)
    return () => clearTimeout(timer)
  }, [state])

  const copy = (): void => {
    const done = (): void => setState('done')
    const failed = (): void => setState('failed')
    if (navigator.clipboard !== undefined) {
      navigator.clipboard.writeText(value).then(done, failed)
      return
    }
    try {
      const field = document.createElement('textarea')
      field.value = value
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(field)
      if (ok) done()
      else failed()
    } catch {
      failed()
    }
  }

  return (
    <Button onClick={copy} variant={variant} title={`Copy ${label.toLowerCase()} to the clipboard`}>
      <span aria-live="polite">
        {state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </span>
    </Button>
  )
}

/* -------------------------------------------------------------------------- */
/* Disclosure                                                                 */
/* -------------------------------------------------------------------------- */

export function Disclosure({
  summary,
  children,
  defaultOpen,
}: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen === true)
  const id = useId()
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-1 text-left text-xs text-ink-2 transition-colors duration-90 hover:text-ink-0"
      >
        <span
          aria-hidden
          className={cx(
            'inline-block transition-transform duration-140 ease-out',
            open && 'rotate-90',
          )}
        >
          &#9656;
        </span>
        {summary}
      </button>
      {open && (
        <div id={id} className="motion-fade animate-stage-in pt-2">
          {children}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Empty, error and loading                                                   */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  headline,
  body,
  actions,
}: {
  headline: string
  body: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      {/* An empty stripe: the product's own glyph, with nothing resolved. */}
      <div aria-hidden className="mb-6 flex gap-[3px]">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className="h-5 w-2.5 rounded-sm border border-line-2 bg-surface-2" />
        ))}
      </div>
      <h3 className="font-display text-lg font-medium text-ink-0">{headline}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-2">{body}</p>
      {actions !== undefined && <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
}

export function ErrorState({
  what,
  why,
  fix,
  detail,
  actions,
}: {
  what: string
  why: string
  fix: string
  detail?: string | null
  actions?: ReactNode
}) {
  return (
    <div className={cx(SURFACE.panel, 'border-code/30 p-6')}>
      <div className="flex gap-4">
        <span aria-hidden className="mt-1 h-8 w-0.5 shrink-0 rounded-full bg-code" />
        <div className="min-w-0 flex-1">
          <p className={cx(TYPE.eyebrow, 'text-code')}>Could not continue</p>
          <h3 className="mt-2 font-display text-lg font-medium text-ink-0">{what}</h3>
          <dl className="mt-4 space-y-3">
            <div>
              <dt className={TYPE.eyebrow}>Why it matters</dt>
              <dd className="mt-1 text-sm text-ink-1">{why}</dd>
            </div>
            <div>
              <dt className={TYPE.eyebrow}>What to do</dt>
              <dd className="mt-1 text-sm text-ink-1">{fix}</dd>
            </div>
          </dl>
          {detail !== undefined && detail !== null && detail !== '' && (
            <div className="mt-4">
              <Disclosure summary="Technical detail">
                <pre className={cx(SURFACE.well, 'overflow-x-auto p-3 font-mono text-2xs text-ink-2')}>
                  {detail}
                </pre>
              </Disclosure>
            </div>
          )}
          {actions !== undefined && <div className="mt-5 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cx('relative overflow-hidden rounded bg-surface-2', className)}>
      <div
        aria-hidden
        className="absolute inset-y-0 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-ink-3/10 to-transparent"
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Count-up                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Animate a metric from zero to its value.
 *
 * The animation says "this number was just computed", which is the one thing
 * worth animating about a number. It respects `prefers-reduced-motion` by
 * rendering the final value immediately.
 */
export function useCountUp(value: number, duration = 700): number {
  const [shown, setShown] = useState(value)
  const previous = useRef(value)

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || value === previous.current) {
      previous.current = value
      setShown(value)
      return
    }
    const from = previous.current
    previous.current = value
    const start = performance.now()
    let frame = 0
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      // Same easing curve as the CSS `ease-out` token.
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(Math.round(from + (value - from) * eased))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value, duration])

  return shown
}
