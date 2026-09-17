/**
 * Evidence.
 *
 * The screen that argues the product's position. A scanner result is a fact
 * about specific bytes, produced by a tool with a specific reach. So every
 * record here shows three things together: what the scanner said, whether it
 * is still about the file on disk, and what that scanner cannot see.
 *
 * Artifacts with no evidence are listed as prominently as the ones with it,
 * because an absent scan is the most common state in a real repository and
 * the easiest one to mistake for a clean one.
 */

import { useMemo } from 'react'

import { allScannerProfiles, scannerProfile } from '../engine/evidence.ts'
import type { ArtifactRecord, EvidenceBinding, Report } from '../engine/types.ts'
import {
  BindingBadge,
  Disclosure,
  EmptyState,
  ExecutionIndicator,
  Panel,
  PathRef,
  cx,
} from '../ui/primitives.tsx'
import { SURFACE, TYPE } from '../ui/tokens.ts'

export function Evidence({
  report,
  onSelectArtifact,
}: {
  report: Report
  onSelectArtifact: (id: string) => void
}) {
  const withEvidence = useMemo(
    () => report.records.filter((r) => r.evidence.length > 0),
    [report.records],
  )

  /** Executing or unresolved artifacts with nothing recorded about them. */
  const gaps = useMemo(
    () =>
      report.records.filter(
        (r) =>
          r.evidence.length === 0 &&
          r.artifact.origin === 'in-tree' &&
          (r.behaviour.behaviour === 'code' || r.behaviour.behaviour === 'unknown'),
      ),
    [report.records],
  )

  const counts = useMemo(() => {
    const byBinding: Record<EvidenceBinding, number> = {
      current: 0,
      stale: 0,
      unbound: 0,
      absent: gaps.length,
    }
    for (const record of withEvidence) {
      for (const item of record.evidence) byBinding[item.binding] += 1
    }
    return byBinding
  }, [withEvidence, gaps])

  const scanners = useMemo(
    () => [...new Set(withEvidence.flatMap((r) => r.evidence.map((e) => e.scanner)))].sort(),
    [withEvidence],
  )

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8 md:px-10">
      <header>
        <p className={TYPE.eyebrow}>Scanner evidence</p>
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight text-ink-0">
          What has been checked, and by what
        </h1>
        <p className={cx(TYPE.note, 'mt-2 max-w-3xl')}>
          A scanner result is evidence, not assurance. DEADWEIGHT records each one against the
          digest of the artifact it claims to be about, states the scanner&rsquo;s coverage
          alongside it, and never lets a result change what loading the artifact does.
        </p>
      </header>

      {/* binding summary -------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-1 bg-line-1 sm:grid-cols-4">
        {(
          [
            ['current', 'Bound', 'The record names a digest and it is the file on disk.'],
            ['stale', 'Stale', 'The record names a digest that is not the file on disk. It is evidence about bytes that are no longer here.'],
            ['unbound', 'Unbound', 'The record names no digest, or the artifact could not be hashed comparably. Nothing ties it to specific bytes.'],
            ['absent', 'Absent', 'No record at all, for an artifact that executes or is unresolved. An absent scan is not a clean scan.'],
          ] as ReadonlyArray<[EvidenceBinding, string, string]>
        ).map(([binding, label, note]) => (
          <div key={binding} className="bg-surface-1 px-4 py-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className={TYPE.eyebrow}>{label}</p>
              <BindingBadge binding={binding} />
            </div>
            <p className="mt-2.5 font-display text-2xl font-medium tracking-tight text-ink-0 tnum">
              {counts[binding]}
            </p>
            <p className={cx(TYPE.note, 'mt-2')}>{note}</p>
          </div>
        ))}
      </div>

      {/* records ---------------------------------------------------------- */}
      {withEvidence.length === 0 ? (
        <div className={SURFACE.panel}>
          <EmptyState
            headline="No scanner evidence in this project"
            body="DEADWEIGHT reads ModelScan and picklescan reports, and its own evidence documents, from anywhere in the tree. Bind a result by recording the artifact digest alongside it, and the record stops being about a filename and starts being about bytes."
          />
        </div>
      ) : (
        <Panel eyebrow="Records" title={`${withEvidence.length} artifacts with recorded results`} bleed>
          <ul role="list">
            {withEvidence.map((record) => (
              <li key={record.artifact.id} className={cx(SURFACE.row, 'px-5 py-4')}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button
                    type="button"
                    onClick={() => onSelectArtifact(record.artifact.id)}
                    className="min-w-0 flex-1 truncate-flex text-left font-mono text-xs text-ink-0 transition-colors duration-90 hover:text-accent-strong"
                  >
                    {record.artifact.locator}
                  </button>
                  <ExecutionIndicator behaviour={record.behaviour.behaviour} size="sm" />
                </div>

                <ul className="mt-3 space-y-2.5">
                  {record.evidence.map((item) => (
                    <li
                      key={item.id}
                      className={cx(
                        SURFACE.well,
                        'px-3.5 py-3',
                        item.binding === 'stale' && 'border-code/30',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="text-xs font-medium text-ink-0">
                          {scannerProfile(item.scanner).label}
                        </span>
                        {item.scannerVersion !== null && (
                          <span className="font-mono text-2xs text-ink-3">
                            {item.scannerVersion}
                          </span>
                        )}
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
                        <span className="flex-1" />
                        <PathRef path={item.source} />
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-ink-1">{item.detail}</p>
                      {item.bindingNote !== null && (
                        <p className="mt-1.5 text-xs text-unknown">{item.bindingNote}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* gaps ------------------------------------------------------------- */}
      {gaps.length > 0 && (
        <Panel
          eyebrow="Gaps"
          title={`${gaps.length} executing or unresolved artifact${gaps.length === 1 ? '' : 's'} with no evidence`}
          bleed
        >
          <p className={cx(TYPE.note, 'border-b border-line-1 px-5 py-4')}>
            These are not findings about the files. They are the boundary of what this inventory can
            say: nothing has been recorded about these bytes by anything.
          </p>
          <ul role="list">
            {gaps.map((record) => (
              <li key={record.artifact.id} className={cx(SURFACE.row, 'px-5 py-3')}>
                <button
                  type="button"
                  onClick={() => onSelectArtifact(record.artifact.id)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-left"
                >
                  <span className="min-w-0 flex-1 truncate-flex font-mono text-xs text-ink-1">
                    {record.artifact.locator}
                  </span>
                  <ExecutionIndicator behaviour={record.behaviour.behaviour} size="sm" />
                  <BindingBadge binding="absent" />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* coverage --------------------------------------------------------- */}
      <Panel eyebrow="Coverage" title="What each scanner can and cannot see">
        <div className="space-y-4">
          {allScannerProfiles()
            .filter((profile) => profile.id !== 'generic' || scanners.includes('generic'))
            .map((profile) => (
              <div key={profile.id} className={cx(SURFACE.well, 'p-4')}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium text-ink-0">{profile.label}</h3>
                  {scanners.includes(profile.id) ? (
                    <span className="font-mono text-2xs uppercase tracking-[0.1em] text-accent">
                      in this project
                    </span>
                  ) : (
                    <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-3">
                      not present
                    </span>
                  )}
                </div>
                <Disclosure summary="Coverage statement" defaultOpen={scanners.includes(profile.id)}>
                  <dl className="space-y-3">
                    <div>
                      <dt className={TYPE.eyebrow}>Inspects</dt>
                      <dd className="mt-1.5">
                        <ul className="space-y-1">
                          {profile.inspects.map((line) => (
                            <li key={line} className="flex gap-2 text-xs text-ink-1">
                              <span aria-hidden className="shrink-0 text-data">
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
                            <li key={line} className="flex gap-2 text-xs leading-relaxed text-ink-2">
                              <span aria-hidden className="shrink-0 text-unknown">
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
            ))}
        </div>
      </Panel>
    </div>
  )
}

/** Exported so a record's own summary line can be rendered elsewhere. */
export function evidenceBindingOf(record: ArtifactRecord): EvidenceBinding {
  if (record.evidence.length === 0) return 'absent'
  if (record.evidence.some((e) => e.binding === 'stale')) return 'stale'
  if (record.evidence.some((e) => e.binding === 'current')) return 'current'
  return 'unbound'
}
