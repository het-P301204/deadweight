/**
 * First run.
 *
 * The screen has one job: in five seconds, say what the product decides. So
 * it leads with the question, then shows the six stages that answer it, then
 * offers the two ways in. The note about what the analyser never does is on
 * this screen rather than in a document, because it is the reason to trust
 * the rest of the interface.
 */

import { useCallback, useRef, useState } from 'react'

import { STAGE_META } from '../engine/stripe.ts'
import type { StripeStage } from '../engine/types.ts'
import { Button, cx } from '../ui/primitives.tsx'
import { TYPE } from '../ui/tokens.ts'

const STAGES: readonly StripeStage[] = [
  'format',
  'load',
  'exec',
  'context',
  'evidence',
  'alternative',
]

export function Hero({
  onDemo,
  onFiles,
  onDrop,
}: {
  onDemo: () => void
  onFiles: (files: FileList) => void
  onDrop: (items: DataTransferItemList) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      if (event.dataTransfer.items.length > 0) onDrop(event.dataTransfer.items)
      else if (event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files)
    },
    [onDrop, onFiles],
  )

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={cx(
        'relative min-h-[calc(100vh-49px)] overflow-hidden transition-colors duration-220',
        dragging && 'bg-accent/[0.04]',
      )}
    >
      <div aria-hidden className="grid-field pointer-events-none absolute inset-0 opacity-70" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_28%_0%,rgb(var(--accent)/0.10),transparent_62%)]"
      />

      <div className="relative mx-auto max-w-6xl px-6 pb-24 pt-20 md:px-10 md:pt-28">
        <p className={cx(TYPE.eyebrow, 'motion-fade animate-stage-in')}>
          AI model &amp; skill supply-chain analysis
        </p>

        <h1
          className="motion-fade mt-5 animate-stage-in font-display text-4xl font-medium leading-[1.02] tracking-[-0.035em] text-ink-0 md:text-[4.25rem]"
          style={{ animationDelay: '60ms' }}
        >
          DEADWEIGHT
        </h1>

        <p
          className="motion-fade mt-6 max-w-2xl animate-stage-in text-lg leading-relaxed text-ink-1 md:text-xl"
          style={{ animationDelay: '120ms' }}
        >
          Know what your AI dependencies do when they load.
        </p>

        <p
          className="motion-fade mt-5 max-w-3xl animate-stage-in text-base leading-relaxed text-ink-2"
          style={{ animationDelay: '180ms' }}
        >
          Not &ldquo;is this file malicious&rdquo;. DEADWEIGHT asks whether loading an artifact
          executes code, where in your codebase that happens, whether the process doing it holds
          credentials, whether a data-only format is available instead, and what evidence exists
          about the bytes on disk. It answers each of those separately, and says so when it cannot.
        </p>

        {/* the six stages, at the size where their questions fit ---------- */}
        <div
          className="motion-fade mt-14 animate-stage-in"
          style={{ animationDelay: '240ms' }}
        >
          <div className="flex items-stretch gap-px overflow-x-auto rounded-lg border border-line-1 bg-surface-1/70 scroll-thin">
            {STAGES.map((stage, index) => (
              <div
                key={stage}
                className={cx(
                  'group relative min-w-[132px] flex-1 px-4 py-5 transition-colors duration-220',
                  'hover:bg-surface-2',
                  index > 0 && 'border-l border-line-1',
                )}
              >
                <div className="mb-3 flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cx(
                      'h-4 w-2 rounded-[1px] transition-colors duration-220',
                      index === 2 ? 'bg-code' : 'bg-ink-2/40',
                      'group-hover:bg-accent',
                    )}
                  />
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-2">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <p className="text-sm font-medium text-ink-0">{STAGE_META[stage].label}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
                  {STAGE_META[stage].question}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 font-mono text-2xs text-ink-3">
            Six facts per artifact, resolved independently. Any one of them can come back
            unresolved, and none of the others is adjusted to compensate.
          </p>
        </div>

        {/* the two ways in ------------------------------------------------ */}
        <div
          className="motion-fade mt-12 flex flex-wrap items-center gap-3 animate-stage-in"
          style={{ animationDelay: '300ms' }}
        >
          <Button variant="primary" onClick={onDemo}>
            Run the demo project
          </Button>
          <Button onClick={() => input.current?.click()}>Analyse a folder</Button>
          <input
            ref={input}
            type="file"
            className="sr-only"
            /* Directory selection is a non-standard attribute on every engine
               that supports it, which is all of them. */
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            multiple
            onChange={(event) => {
              if (event.target.files !== null && event.target.files.length > 0) {
                onFiles(event.target.files)
              }
            }}
          />
          <span className="font-mono text-2xs text-ink-3">or drop a directory anywhere here</span>
        </div>

        {/* the trust note ------------------------------------------------- */}
        <div
          className="motion-fade mt-16 grid max-w-4xl gap-6 animate-stage-in sm:grid-cols-3"
          style={{ animationDelay: '360ms' }}
        >
          {[
            {
              title: 'It never loads the artifact',
              body: 'Recognition reads magic bytes, container member names and length-prefixed headers. The pickle reader walks opcodes and constructs nothing. No deserialiser is called on anything it analyses.',
            },
            {
              title: 'It never leaves the tab',
              body: 'A folder you analyse here is read through the File API in this page. There is no fetch anywhere in the bundle, and CI fails the build if one appears.',
            },
            {
              title: 'A scan is evidence, not a verdict',
              body: 'Scanner results are bound to an artifact digest. If the bytes moved, the result is stale rather than passing, and no result changes what loading does.',
            },
          ].map((item) => (
            <div key={item.title} className="border-t border-line-1 pt-4">
              <h2 className="text-sm font-medium text-ink-0">{item.title}</h2>
              <p className="mt-2 text-xs leading-relaxed text-ink-2">{item.body}</p>
            </div>
          ))}
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-4 rounded-xl border border-dashed border-accent/60 bg-surface-0/70 backdrop-blur-sm">
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">
              Drop to analyse
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
