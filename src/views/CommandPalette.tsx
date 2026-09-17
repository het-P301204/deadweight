/**
 * Command palette.
 *
 * Ctrl/Cmd+K. Navigation, the filters someone actually reaches for, the
 * exports, and every artifact by path -- so the fastest route to one file in
 * a hundred is to type part of its name.
 *
 * Arrow keys move, Enter runs, Escape closes. The list is a real listbox with
 * `aria-activedescendant`, so it reads correctly rather than looking correct.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { formatSpec } from '../engine/formats.ts'
import { BEHAVIOUR_LABEL } from '../engine/stripe.ts'
import type { Report } from '../engine/types.ts'
import { LoadStripe } from '../ui/LoadStripe.tsx'
import { cx } from '../ui/primitives.tsx'
import { BEHAVIOUR_STYLE, CONTROL, SURFACE, TYPE } from '../ui/tokens.ts'
import type { ViewId } from '../state.ts'
import { VIEWS } from '../state.ts'

export interface Command {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly hint?: string
  readonly run: () => void
  readonly render?: () => React.ReactNode
}

export function CommandPalette({
  onClose,
  report,
  onView,
  onFilter,
  onSelectArtifact,
  onReset,
  onTheme,
}: {
  onClose: () => void
  report: Report | null
  onView: (view: ViewId) => void
  onFilter: (preset: 'executes' | 'production' | 'unknown' | 'privileged' | 'migrations' | 'clear') => void
  onSelectArtifact: (id: string) => void
  onReset: () => void
  onTheme: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const listbox = useRef<HTMLUListElement>(null)

  const commands = useMemo<readonly Command[]>(() => {
    const list: Command[] = []

    for (const view of VIEWS) {
      list.push({
        id: `view:${view.id}`,
        group: 'Go to',
        label: view.label,
        hint: view.hint,
        run: () => onView(view.id),
      })
    }

    if (report !== null) {
      list.push(
        {
          id: 'filter:executes',
          group: 'Filter',
          label: 'Executes on load',
          hint: `${report.summary.behaviour.code} artifacts`,
          run: () => onFilter('executes'),
        },
        {
          id: 'filter:production',
          group: 'Filter',
          label: 'Loaded in production',
          hint: `${report.summary.environments.production} artifacts`,
          run: () => onFilter('production'),
        },
        {
          id: 'filter:unknown',
          group: 'Filter',
          label: 'Unresolved behaviour',
          hint: `${report.summary.behaviour.unknown} artifacts`,
          run: () => onFilter('unknown'),
        },
        {
          id: 'filter:privileged',
          group: 'Filter',
          label: 'Privileged loads',
          hint: `${report.summary.privilegedLoads} artifacts`,
          run: () => onFilter('privileged'),
        },
        {
          id: 'filter:migrations',
          group: 'Filter',
          label: 'Safe format available',
          hint: `${report.summary.migrationsAvailable} artifacts`,
          run: () => onFilter('migrations'),
        },
        {
          id: 'filter:clear',
          group: 'Filter',
          label: 'Clear all filters',
          run: () => onFilter('clear'),
        },
        {
          id: 'export:bom',
          group: 'Export',
          label: 'Open the Model BOM and its exports',
          run: () => onView('bom'),
        },
      )

      for (const record of report.records) {
        list.push({
          id: `artifact:${record.artifact.id}`,
          group: 'Artifact',
          label: record.artifact.locator,
          hint: `${BEHAVIOUR_LABEL[record.behaviour.behaviour]} · ${formatSpec(record.artifact.format.format).label}`,
          run: () => onSelectArtifact(record.artifact.id),
          render: () => (
            <span className="flex min-w-0 items-center gap-3">
              <LoadStripe
                stripe={record.stripe}
                behaviour={record.behaviour.behaviour}
                size="xs"
                interactive={false}
              />
              <span className="truncate-flex font-mono text-xs text-ink-0">
                {record.artifact.locator}
              </span>
              <span
                className={cx(
                  'shrink-0 font-mono text-2xs',
                  BEHAVIOUR_STYLE[record.behaviour.behaviour].text,
                )}
              >
                {BEHAVIOUR_STYLE[record.behaviour.behaviour].short}
              </span>
            </span>
          ),
        })
      }
    }

    list.push(
      { id: 'app:theme', group: 'Application', label: 'Switch theme', run: onTheme },
      {
        id: 'app:reset',
        group: 'Application',
        label: 'Start over with a different project',
        run: onReset,
      },
    )

    return list
  }, [report, onView, onFilter, onSelectArtifact, onReset, onTheme])

  const results = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (text === '') return commands.slice(0, 40)
    const terms = text.split(/\s+/)
    return commands
      .filter((command) => {
        const haystack = `${command.group} ${command.label} ${command.hint ?? ''}`.toLowerCase()
        return terms.every((term) => haystack.includes(term))
      })
      .slice(0, 60)
  }, [commands, query])

  // The palette is mounted only while open, so query and cursor start at
  // their initial values without an effect resetting them. Focus is a DOM
  // side effect, which is what an effect is for.
  useEffect(() => {
    requestAnimationFrame(() => field.current?.focus())
  }, [])

  // The cursor indexes into the results list; when the query replaces that
  // list, adjust during render rather than paint a stale index.
  const [lastResults, setLastResults] = useState(results)
  if (lastResults !== results) {
    setLastResults(results)
    setCursor(0)
  }

  /*
   * The cursor is mirrored into a ref because two key events can arrive in
   * one tick -- key repeat outruns a render -- and an Enter handler reading
   * `cursor` from the render closure would then run the item the arrow key
   * just moved off. The ref is the authority for the handler; the state is
   * the authority for the paint.
   */
  const cursorRef = useRef(cursor)

  // Synced after paint, for the case where something other than a key press
  // moved the cursor -- a new query resetting it to the top. The key handler
  // writes the ref itself, so it is never behind.
  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    const move = (delta: number): void => {
      const next = Math.min(results.length - 1, Math.max(0, cursorRef.current + delta))
      cursorRef.current = next
      setCursor(next)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        move(-1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const command = results[cursorRef.current]
        if (command !== undefined) {
          command.run()
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [results, onClose])

  useEffect(() => {
    const node = listbox.current?.querySelector(`[data-index="${cursor}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  let lastGroup = ''

  return (
    <>
      <div
        className="motion-fade fixed inset-0 z-50 animate-fade-in bg-surface-0/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        /*
         * Centred with `inset-x-0` plus `mx-auto` rather than a translate,
         * because the entrance keyframes animate `transform` and end at
         * `none` -- which would drop a centring translate on the floor.
         */
        className={cx(
          SURFACE.float,
          'motion-fade fixed inset-x-0 top-[12vh] z-[60] mx-auto w-[min(640px,92vw)] animate-pop-in overflow-hidden',
        )}
      >
        <div className="border-b border-line-1 p-3">
          <input
            ref={field}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls="dw-palette-list"
            aria-activedescendant={results[cursor] === undefined ? undefined : `dw-cmd-${cursor}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands, filters and artifacts"
            className={cx(CONTROL.input, 'h-9 border-0 bg-transparent px-1 text-sm')}
          />
        </div>

        <ul
          ref={listbox}
          id="dw-palette-list"
          role="listbox"
          className="max-h-[52vh] overflow-y-auto py-1 scroll-thin"
        >
          {results.length === 0 && (
            <li className="px-4 py-8 text-center text-xs text-ink-2">
              Nothing matches &ldquo;{query}&rdquo;.
            </li>
          )}
          {results.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : null
            lastGroup = command.group
            return (
              <li key={command.id}>
                {heading !== null && (
                  <p className={cx(TYPE.eyebrow, 'px-4 pb-1 pt-3')}>{heading}</p>
                )}
                <button
                  type="button"
                  id={`dw-cmd-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === cursor}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => {
                    command.run()
                    onClose()
                  }}
                  className={cx(
                    'flex w-full items-center justify-between gap-4 px-4 py-2 text-left transition-colors duration-90',
                    index === cursor ? 'bg-accent/12' : 'hover:bg-surface-2',
                  )}
                >
                  {command.render === undefined ? (
                    <span className="min-w-0 truncate-flex text-xs text-ink-0">
                      {command.label}
                    </span>
                  ) : (
                    command.render()
                  )}
                  {command.hint !== undefined && (
                    <span className="hidden shrink-0 font-mono text-2xs text-ink-3 sm:block">
                      {command.hint}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>

        <footer className="flex items-center gap-4 border-t border-line-1 px-4 py-2.5">
          {[
            ['↑↓', 'move'],
            ['↵', 'run'],
            ['esc', 'close'],
          ].map(([key, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              <kbd className="rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
                {key}
              </kbd>
              <span className="text-2xs text-ink-3">{label}</span>
            </span>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-2xs text-ink-3">{results.length} results</span>
        </footer>
      </div>
    </>
  )
}
