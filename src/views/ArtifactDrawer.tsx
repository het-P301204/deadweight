/**
 * The investigation drawer.
 *
 * A right-side drawer rather than a page, so the explorer stays behind it and
 * the reader keeps their place in a list they were working down. It answers,
 * in this order:
 *
 *   what is it, where did it come from, what format is it
 *   what happens when it loads, and how was that decided
 *   where is it loaded, and is that context privileged
 *   what evidence exists, and what can that evidence not see
 *   is a safer format available, and what would change
 *
 * The four-up header is always visible; the rest is behind tabs, because the
 * full text of five sections at once is a wall and the reader arrived with
 * one question.
 */

import { useEffect, useRef, useState } from 'react'

import { canonicalJson } from '../engine/hash.ts'
import { distinctEnvironments, ENVIRONMENT_META } from '../engine/context.ts'
import { scannerProfile } from '../engine/evidence.ts'
import { formatSpec } from '../engine/formats.ts'
import { notableGlobals } from '../engine/pickle.ts'
import { BEHAVIOUR_LABEL, BEHAVIOUR_NOTE } from '../engine/stripe.ts'
import type { ArtifactRecord } from '../engine/types.ts'
import { FormatComparison } from '../ui/FormatComparison.tsx'
import { LoadPathFlow } from '../ui/LoadPathFlow.tsx'
import { LoadStripe } from '../ui/LoadStripe.tsx'
import {
  BindingBadge,
  CopyButton,
  DispositionDot,
  Disclosure,
  ExecutionIndicator,
  Field,
  PathRef,
  PrivilegeList,
  cx,
} from '../ui/primitives.tsx'
import { BEHAVIOUR_STYLE, SURFACE, TYPE } from '../ui/tokens.ts'

/**
 * Display caps for the two lists whose length is chosen by the artifact.
 *
 * Every other list in the drawer is bounded by something the project did --
 * how many load sites, how many scanners. These two are bounded only by the
 * 64 KiB head slice: a crafted pickle produced 8,330 global names and a
 * crafted safetensors header 4,000 metadata rows. The count is always shown
 * alongside, so a cap never silently hides the size of the thing.
 */
const GLOBALS_SHOWN = 60
const METADATA_SHOWN = 24

type Tab = 'behaviour' | 'path' | 'evidence' | 'alternative'

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'behaviour', label: 'What happens' },
  { id: 'path', label: 'Load path' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'alternative', label: 'Alternative' },
]

export function ArtifactDrawer({
  record,
  onClose,
}: {
  record: ArtifactRecord
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('behaviour')
  const panel = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  // The drawer is keyed on the artifact id in App, so a different artifact
  // mounts a new drawer and the tab starts at the first one by construction.
  // This effect only moves focus, which is a DOM side effect and not state.
  useEffect(() => {
    closeButton.current?.focus()
  }, [])

  // Escape closes; Tab is trapped inside the drawer while it is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const container = panel.current
      if (container === null) return
      const focusable = container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const { artifact, behaviour } = record
  const spec = formatSpec(artifact.format.format)
  const privileged = record.contexts.filter((c) => c.privileged)
  const style = BEHAVIOUR_STYLE[behaviour.behaviour]

  return (
    <>
      <div
        className="motion-fade fixed inset-0 z-30 animate-fade-in bg-surface-0/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Investigation: ${artifact.locator}`}
        className="motion-fade fixed inset-y-0 right-0 z-40 flex w-full animate-drawer-in flex-col overflow-hidden border-l border-line-2 bg-surface-1 shadow-drawer sm:w-[min(760px,92vw)]"
      >
        {/* header ------------------------------------------------------- */}
        <header className="shrink-0 border-b border-line-1">
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <p className={TYPE.eyebrow}>{spec.label}</p>
              <h2 className="mt-1.5 break-all font-mono text-base text-ink-0">
                {artifact.locator}
              </h2>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <ExecutionIndicator
                  behaviour={behaviour.behaviour}
                  guard={behaviour.guard?.expression ?? null}
                />
                <LoadStripe stripe={record.stripe} behaviour={behaviour.behaviour} size="md" />
              </div>
            </div>
            <button
              ref={closeButton}
              type="button"
              onClick={onClose}
              aria-label="Close investigation"
              className="shrink-0 rounded border border-line-2 px-2 py-1 font-mono text-2xs text-ink-2 transition-colors duration-90 hover:bg-surface-3 hover:text-ink-0"
            >
              Esc
            </button>
          </div>

          {/* the four-up ------------------------------------------------ */}
          <dl className="mt-5 grid grid-cols-2 gap-px border-t border-line-1 bg-line-1 sm:grid-cols-4">
            <Cell label="Format">
              <span className="text-xs text-ink-0">{spec.label}</span>
              <span className="mt-0.5 block font-mono text-2xs text-ink-3">
                by {artifact.format.basis}
              </span>
            </Cell>
            <Cell label="Origin">
              <span className="text-xs text-ink-0">
                {artifact.origin === 'in-tree'
                  ? 'In the repository'
                  : artifact.origin === 'remote-reference'
                    ? 'Remote reference'
                    : 'Not found'}
              </span>
              <span className="mt-0.5 block font-mono text-2xs text-ink-3">
                {artifact.sizeBytes === null ? 'size unknown' : formatBytes(artifact.sizeBytes)}
              </span>
            </Cell>
            <Cell label="Context">
              {record.contexts.length === 0 ? (
                <span className="text-xs text-unknown">No load site</span>
              ) : (
                <>
                  <span className="text-xs text-ink-0">
                    {distinctEnvironments(record.contexts)
                      .slice(0, 2)
                      .map((c) => ENVIRONMENT_META[c.environment].label)
                      .join(', ')}
                    {distinctEnvironments(record.contexts).length > 2 &&
                      ` +${distinctEnvironments(record.contexts).length - 2}`}
                  </span>
                  <span className="mt-0.5 block font-mono text-2xs text-ink-3">
                    {privileged.length > 0 ? `${privileged.length} privileged` : 'no privilege signal'}
                  </span>
                </>
              )}
            </Cell>
            <Cell label="Digest">
              {artifact.digest === null ? (
                <span className="text-xs text-ink-2">Not hashed</span>
              ) : (
                <>
                  <span className="block truncate font-mono text-xs text-ink-0">
                    {artifact.digest.value.slice(0, 16)}
                  </span>
                  <span className="mt-0.5 block font-mono text-2xs text-ink-3">
                    sha256 &middot; {artifact.digest.coverage}
                  </span>
                </>
              )}
            </Cell>
          </dl>

          <nav className="flex gap-1 px-4 pt-3" aria-label="Investigation sections">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id}
                className={cx(
                  'relative px-3 py-2 text-xs transition-colors duration-90',
                  tab === item.id ? 'text-ink-0' : 'text-ink-2 hover:text-ink-1',
                )}
              >
                {item.label}
                {tab === item.id && (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
                  />
                )}
              </button>
            ))}
          </nav>
        </header>

        {/* body --------------------------------------------------------- */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scroll-thin">
          {tab === 'behaviour' && (
            <div className="motion-fade animate-stage-in space-y-6">
              <section className={cx('rounded-md border p-4', style.border, style.wash)}>
                <p className={cx(TYPE.eyebrow, style.text)}>
                  {BEHAVIOUR_LABEL[behaviour.behaviour]}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-ink-0">{behaviour.mechanism}</p>
                <p className={cx(TYPE.note, 'mt-3')}>{BEHAVIOUR_NOTE[behaviour.behaviour]}</p>
                {behaviour.guard !== null && (
                  <p className="mt-3 text-xs text-ink-1">
                    The guard is{' '}
                    <code className="rounded bg-surface-0/60 px-1.5 py-0.5 font-mono text-2xs">
                      {behaviour.guard.expression}
                    </code>
                    . Remove it and this becomes{' '}
                    <span className={BEHAVIOUR_STYLE[behaviour.guard.ifRemoved].text}>
                      {BEHAVIOUR_LABEL[behaviour.guard.ifRemoved].toLowerCase()}
                    </span>
                    .
                  </p>
                )}
              </section>

              <section>
                <h3 className={TYPE.eyebrow}>How that was decided</h3>
                <ol className="mt-3 space-y-3">
                  {behaviour.steps.map((step, index) => (
                    <li key={`${step.basis}-${index}`} className="flex gap-3">
                      <span className="mt-0.5 shrink-0 font-mono text-2xs text-ink-3 tnum">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs leading-relaxed text-ink-1">{step.claim}</p>
                        <p className="mt-1 font-mono text-2xs text-ink-3">{step.basis}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <h3 className={TYPE.eyebrow}>What the format does</h3>
                <p className="mt-2 text-xs leading-relaxed text-ink-1">{spec.mechanism}</p>
                <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Recognised by">
                    <span className="font-mono text-xs text-ink-1">{artifact.format.note}</span>
                  </Field>
                  {artifact.format.extensionMismatch !== undefined && (
                    <Field label="Extension mismatch">
                      <span className="font-mono text-xs text-code">
                        {artifact.format.extensionMismatch}
                      </span>
                    </Field>
                  )}
                </dl>
              </section>

              {artifact.pickle !== null && (
                <section className={cx(SURFACE.well, 'p-4')}>
                  <h3 className={TYPE.eyebrow}>Pickle opcode scan</h3>
                  <p className={cx(TYPE.note, 'mt-2')}>
                    Read by walking the opcode stream. No object was constructed and no module was
                    imported: protocol{' '}
                    {artifact.pickle.protocol ?? '0/1'},{' '}
                    {artifact.pickle.invokingOpcodes.length === 0
                      ? 'no callable-invoking opcode'
                      : `${artifact.pickle.invokingOpcodes.join(', ')} present`}
                    {artifact.pickle.truncated && ', scan truncated at the byte cap'}.
                  </p>
                  {artifact.pickle.globals.length > 0 ? (
                    <ul className="mt-3 flex flex-wrap gap-1.5">
                      {/* Capped. The global count is bounded only by the 64 KiB head
                          slice, so a crafted stream produced 8,330 list items in one
                          drawer. Notable names sort first so the cap never hides one. */}
                      {[...artifact.pickle.globals]
                        .sort((a, b) => Number(notableGlobals([b]).length) - Number(notableGlobals([a]).length))
                        .slice(0, GLOBALS_SHOWN)
                        .map((name) => {
                        const notable = notableGlobals([name]).length > 0
                        return (
                          <li
                            key={name}
                            className={cx(
                              'rounded border px-1.5 py-0.5 font-mono text-2xs break-all',
                              notable
                                ? 'border-code/40 bg-code/10 text-code'
                                : 'border-line-2 text-ink-2',
                            )}
                          >
                            {name}
                          </li>
                        )
                      })}
                      {artifact.pickle.globals.length > GLOBALS_SHOWN && (
                        <li className={cx(TYPE.note, "px-1.5 py-0.5")}>
                          and {artifact.pickle.globals.length - GLOBALS_SHOWN} more
                        </li>
                      )}
                    </ul>
                  ) : (
                    <p className="mt-3 text-xs text-ink-2">
                      The stream names no globals in the bytes read.
                    </p>
                  )}
                  <p className={cx(TYPE.note, 'mt-3')}>
                    A highlighted name is worth looking at. The absence of one means nothing: the
                    reachable set for a pickle is every importable callable in the environment, so
                    this list is never used to change the verdict above.
                  </p>
                </section>
              )}

              {artifact.tensorHeader !== null && (
                <section className={cx(SURFACE.well, 'p-4')}>
                  <h3 className={TYPE.eyebrow}>Tensor header</h3>
                  <p className={cx(TYPE.note, 'mt-2')}>
                    {artifact.tensorHeader.entries} tensor entries. Parsing this header is the whole
                    of loading the metadata, which is the property that makes the format a safe
                    alternative.
                  </p>
                  {Object.keys(artifact.tensorHeader.metadata).length > 0 && (
                    <dl className="mt-3 space-y-1">
                      {/* Capped for the same reason: both halves come from the header. */}
                      {Object.entries(artifact.tensorHeader.metadata)
                        .slice(0, METADATA_SHOWN)
                        .map(([key, value]) => (
                        <div key={key} className="flex gap-2 font-mono text-2xs">
                          <dt className="shrink-0 break-all text-ink-3">{key}</dt>
                          <dd className="break-all text-ink-1">{value}</dd>
                        </div>
                      ))}
                      {Object.keys(artifact.tensorHeader.metadata).length > METADATA_SHOWN && (
                        <p className={cx(TYPE.note, "pt-1")}>
                          and {Object.keys(artifact.tensorHeader.metadata).length - METADATA_SHOWN}{" "}
                          more metadata {Object.keys(artifact.tensorHeader.metadata).length - METADATA_SHOWN === 1 ? "key" : "keys"}
                        </p>
                      )}
                    </dl>
                  )}
                </section>
              )}

              {record.findings.length > 0 && (
                <section>
                  <h3 className={TYPE.eyebrow}>Findings</h3>
                  <ul className="mt-3 space-y-4">
                    {record.findings.map((finding) => (
                      <li key={finding.id}>
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <DispositionDot disposition={finding.disposition} />
                          <span className="text-sm font-medium text-ink-0">{finding.title}</span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
                          {finding.rationale}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          {tab === 'path' && (
            <div className="motion-fade animate-stage-in space-y-6">
              {record.loadSites.length === 0 ? (
                <section className="rounded-md border border-unknown/30 bg-unknown/[0.05] p-4">
                  <p className={cx(TYPE.eyebrow, 'text-unknown')}>No load site</p>
                  <p className="mt-2 text-sm text-ink-1">
                    This artifact is in the tree and nothing in the tree loads it. Something loads it
                    somewhere, or nothing does; either way the load stage is unresolved rather than
                    absent, and the format above still says what loading it would do.
                  </p>
                </section>
              ) : (
                <section className="space-y-4">
                  <h3 className={TYPE.eyebrow}>
                    {record.loadSites.length} load site
                    {record.loadSites.length === 1 ? '' : 's'}
                  </h3>
                  {record.loadSites.map((site) => (
                    <LoadPathFlow
                      key={site.id}
                      site={site}
                      artifactName={artifact.name}
                    />
                  ))}
                  {new Set(record.loadSites.map((s) => s.behaviour.behaviour)).size > 1 && (
                    <p className={cx(TYPE.note, 'rounded-md border border-line-1 p-3')}>
                      These sites do not agree. The verdict at the top of this drawer is the most
                      exposed of them, because &ldquo;loaded safely&rdquo; is not true of an
                      artifact that is also loaded unsafely.
                    </p>
                  )}
                </section>
              )}

              {record.contexts.length > 0 && (
                <section className="space-y-4">
                  <h3 className={TYPE.eyebrow}>Context</h3>
                  {record.contexts.map((context) => (
                    <div key={context.id} className={cx(SURFACE.well, 'p-4')}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm font-medium text-ink-0">
                          {ENVIRONMENT_META[context.environment].label}
                        </p>
                        <span
                          className={cx(
                            'font-mono text-2xs uppercase tracking-[0.08em]',
                            context.basis === 'declared'
                              ? 'text-accent'
                              : context.basis === 'inferred'
                                ? 'text-ink-2'
                                : 'text-unknown',
                          )}
                        >
                          {context.basis}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-2xs text-ink-3">{context.file}</p>
                      <p className={cx(TYPE.note, 'mt-2')}>{context.rule}</p>
                      <p className={cx(TYPE.note, 'mt-1.5')}>
                        {ENVIRONMENT_META[context.environment].note}
                      </p>
                      <div className="mt-3 border-t border-line-1 pt-3">
                        <p className={cx(TYPE.eyebrow, 'mb-2')}>What the loading file can reach</p>
                        <PrivilegeList privileges={context.privileges} />
                      </div>
                    </div>
                  ))}
                  <p className={cx(TYPE.note)}>
                    A privilege signal says the process performing the load has that reach, because
                    the signal is in the same file. It does not say the artifact uses it.
                  </p>
                </section>
              )}
            </div>
          )}

          {tab === 'evidence' && (
            <div className="motion-fade animate-stage-in space-y-6">
              {record.evidence.length === 0 ? (
                <section className="rounded-md border border-line-2 p-4">
                  <p className={TYPE.eyebrow}>No evidence recorded</p>
                  <p className="mt-2 text-sm text-ink-1">
                    No scanner result in this project is bound to this artifact. An absent scan is
                    not a clean scan, and it is not a finding about the file either: it is a gap in
                    what this inventory can say about it.
                  </p>
                  <p className={cx(TYPE.note, 'mt-3')}>
                    DEADWEIGHT reads ModelScan and picklescan reports, and its own evidence
                    documents, from anywhere in the tree. Bind a result by recording the artifact
                    digest alongside it.
                  </p>
                </section>
              ) : (
                record.evidence.map((item) => {
                  const profile = scannerProfile(item.scanner)
                  return (
                    <section key={item.id} className={cx(SURFACE.well, 'overflow-hidden')}>
                      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-1 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-ink-0">
                            {profile.label}
                            {item.scannerVersion !== null && (
                              <span className="ml-2 font-mono text-2xs text-ink-3">
                                {item.scannerVersion}
                              </span>
                            )}
                          </p>
                          <p className="mt-0.5 font-mono text-2xs text-ink-3">{item.source}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={cx(
                              'font-mono text-2xs uppercase tracking-[0.1em]',
                              item.result === 'flagged'
                                ? 'text-code'
                                : item.result === 'pass'
                                  ? 'text-data'
                                  : 'text-unknown',
                            )}
                          >
                            {item.result}
                          </span>
                          <BindingBadge binding={item.binding} />
                        </div>
                      </header>
                      <div className="px-4 py-3">
                        <p className="text-xs leading-relaxed text-ink-1">{item.detail}</p>
                        {item.bindingNote !== null && (
                          <p className="mt-2 text-xs text-unknown">{item.bindingNote}</p>
                        )}
                        {item.subjectDigest !== null && (
                          <p className="mt-2 font-mono text-2xs text-ink-3">
                            subject sha256:{item.subjectDigest.slice(0, 16)}
                          </p>
                        )}
                        <div className="mt-3 border-t border-line-1 pt-3">
                          <Disclosure summary={`What ${profile.label} can and cannot see`}>
                            <dl className="space-y-2.5">
                              <div>
                                <dt className={TYPE.eyebrow}>Inspects</dt>
                                <dd className="mt-1.5">
                                  <ul className="space-y-1">
                                    {profile.inspects.map((line) => (
                                      <li key={line} className="flex gap-2 text-xs text-ink-1">
                                        <span aria-hidden className="text-data">
                                          +
                                        </span>
                                        {line}
                                      </li>
                                    ))}
                                  </ul>
                                </dd>
                              </div>
                              <div>
                                <dt className={cx(TYPE.eyebrow, 'text-unknown')}>Limitations</dt>
                                <dd className="mt-1.5">
                                  <ul className="space-y-1.5">
                                    {profile.limitations.map((line) => (
                                      <li key={line} className="flex gap-2 text-xs text-ink-2">
                                        <span aria-hidden className="text-unknown">
                                          &minus;
                                        </span>
                                        {line}
                                      </li>
                                    ))}
                                  </ul>
                                </dd>
                              </div>
                            </dl>
                          </Disclosure>
                        </div>
                      </div>
                    </section>
                  )
                })
              )}

              <section className="rounded-md border border-line-1 p-4">
                <p className={TYPE.eyebrow}>What this tool can confirm</p>
                <ul className="mt-2.5 space-y-1.5 text-xs text-ink-1">
                  <li>
                    The format, from the bytes on disk &mdash; {artifact.format.note}.
                  </li>
                  {record.loadSites.length > 0 && (
                    <li>
                      That {record.loadSites.length === 1 ? 'this line' : 'these lines'} of source
                      call {record.loadSites[0]?.loader} on it.
                    </li>
                  )}
                  <li>What that call does with those bytes, given the versions declared here.</li>
                </ul>
                <p className={cx(TYPE.eyebrow, 'mt-4 text-unknown')}>What it cannot</p>
                <ul className="mt-2.5 space-y-1.5 text-xs text-ink-2">
                  <li>Whether the artifact is malicious. It reports surface, not intent.</li>
                  <li>
                    What a remote repository serves. DEADWEIGHT makes no network requests, so a
                    reference it cannot resolve stays unresolved.
                  </li>
                  <li>
                    Which version is actually installed. It reads what the repository declares; a
                    lockfile is a claim, not an environment.
                  </li>
                  <li>Whether a declared environment is the one it is deployed to.</li>
                </ul>
              </section>
            </div>
          )}

          {tab === 'alternative' && (
            <div className="motion-fade animate-stage-in space-y-6">
              <FormatComparison
                artifact={artifact}
                behaviour={behaviour.behaviour}
                alternative={record.alternative}
              />
              {artifact.siblings.length > 0 && (
                <section>
                  <h3 className={TYPE.eyebrow}>Files beside it with the same name</h3>
                  <ul className="mt-2.5 space-y-1.5">
                    {artifact.siblings.map((sibling) => (
                      <li key={sibling.locator} className="flex items-baseline gap-3">
                        <PathRef path={sibling.locator} />
                        <span className="shrink-0 font-mono text-2xs text-ink-3">
                          {formatSpec(sibling.format).label}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>

        {/* footer ------------------------------------------------------- */}
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line-1 px-5 py-3">
          <p className="min-w-0 truncate font-mono text-2xs text-ink-3">
            {artifact.id}
          </p>
          <CopyButton value={canonicalJson(record)} label="Copy record JSON" />
        </footer>
      </div>
    </>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-surface-1 px-4 py-3">
      <dt className={cx(TYPE.eyebrow, 'mb-1')}>{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}
