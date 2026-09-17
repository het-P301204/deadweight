/**
 * Tooltip.
 *
 * Fixed-positioned from the trigger's own rectangle rather than absolutely
 * positioned inside it, because the things that need tooltips here -- stripe
 * cells, matrix cells, graph nodes -- live inside scrolling containers that
 * would clip an absolutely positioned bubble.
 *
 * It opens on hover and on focus, closes on Escape, and is marked
 * `aria-hidden` because the same text is always on the trigger's accessible
 * name. A tooltip is the second way to read something, never the only way.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { cx } from './primitives.tsx'

interface Position {
  readonly left: number
  readonly top: number
  readonly placement: 'top' | 'bottom'
}

export function Tooltip({
  content,
  children,
  className,
  width = 300,
}: {
  content: ReactNode
  children: ReactNode
  className?: string
  width?: number
}) {
  const trigger = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<Position | null>(null)

  const open = useCallback(() => {
    const node = trigger.current
    if (node === null) return
    const rect = node.getBoundingClientRect()
    const margin = 10
    const above = rect.top > 180
    const half = width / 2
    const left = Math.min(
      Math.max(margin + half, rect.left + rect.width / 2),
      window.innerWidth - margin - half,
    )
    setPosition({
      left,
      top: above ? rect.top - margin : rect.bottom + margin,
      placement: above ? 'top' : 'bottom',
    })
  }, [width])

  const close = useCallback(() => setPosition(null), [])

  useEffect(() => {
    if (position === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [position, close])

  return (
    <span
      ref={trigger}
      className={cx('relative inline-flex', className)}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {position !== null && (
        /*
         * Two elements, and the reason matters: the outer one carries the
         * `translate(-50%, …)` that centres the bubble on its trigger, and
         * the inner one carries the entrance animation. Putting both on one
         * element loses the centring, because the keyframes animate
         * `transform` and end at `none`.
         */
        <span
          aria-hidden
          role="presentation"
          className="pointer-events-none fixed z-50"
          style={{
            left: position.left,
            top: position.top,
            width,
            transform: `translate(-50%, ${position.placement === 'top' ? '-100%' : '0'})`,
          }}
        >
          <span className="motion-fade block animate-pop-in rounded-md border border-line-2 bg-surface-1 px-3 py-2.5 text-left text-xs leading-relaxed text-ink-1 shadow-pop">
            {content}
          </span>
        </span>
      )}
    </span>
  )
}
