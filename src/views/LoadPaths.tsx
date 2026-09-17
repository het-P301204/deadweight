/**
 * Load paths.
 *
 * Where the loading actually happens. The graph at the top is the shape of
 * it; the list below is the detail, grouped by source file, because that is
 * the unit a person opens in an editor.
 *
 * On a narrow screen the graph is replaced by the list rather than shrunk --
 * a four-column graph at 380px wide is decoration.
 */

import { useMemo } from 'react'

import { ENVIRONMENT_META } from '../engine/context.ts'
import type { ArtifactRecord, LoadContext, Report } from '../engine/types.ts'
import { ContextGraph } from '../ui/ContextGraph.tsx'
import { LoadPathFlow } from '../ui/LoadPathFlow.tsx'
import {
  ContextBadge,
  EmptyState,
  Panel,
  PrivilegeList,
  cx,
} from '../ui/primitives.tsx'
import { SURFACE, TYPE } from '../ui/tokens.ts'
import { applyFilters } from './filter.ts'
import type { Filters } from './filter.ts'

interface FileGroup {
  readonly file: string
  readonly context: LoadContext | null
  readonly sites: ReadonlyArray<{ record: ArtifactRecord; siteIndex: number }>
}

export function LoadPaths({
  report,
  filters,
  searchIndex,
  onSelectArtifact,
}: {
  report: Report
  filters: Filters
  searchIndex: ReadonlyMap<string, string>
  onSelectArtifact: (id: string) => void
}) {
  const records = useMemo(
    () => applyFilters(report.records, filters, searchIndex),
    [report.records, filters, searchIndex],
  )

  const groups = useMemo<readonly FileGroup[]>(() => {
    const byFile = new Map<string, Array<{ record: ArtifactRecord; siteIndex: number }>>()
    for (const record of records) {
      record.loadSites.forEach((site, siteIndex) => {
        const list = byFile.get(site.file) ?? []
        list.push({ record, siteIndex })
        byFile.set(site.file, list)
      })
    }
    const contexts = new Map(report.contexts.map((c) => [c.file, c]))
    return [...byFile.entries()]
      .map(([file, sites]) => ({ file, context: contexts.get(file) ?? null, sites }))
      .sort((a, b) => {
        // Privileged files first, then by reach, then alphabetically.
        const privilege = Number(b.context?.privileged ?? false) - Number(a.context?.privileged ?? false)
        if (privilege !== 0) return privilege
        return a.file < b.file ? -1 : 1
      })
  }, [records, report.contexts])

  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-8 md:px-10">
        <div className={SURFACE.panel}>
          <EmptyState
            headline="No load sites to show"
            body="Either the filters exclude everything, or DEADWEIGHT found no code in this project that loads an AI artifact."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8 md:px-10">
      <header>
        <p className={TYPE.eyebrow}>Load-site discovery</p>
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight text-ink-0">
          Where these artifacts are loaded
        </h1>
        <p className={cx(TYPE.note, 'mt-2 max-w-3xl')}>
          Each chain is source file, enclosing function, loader, artifact, and what that particular
          call does. Two calls on the same artifact can disagree, and when they do the artifact
          takes the more exposed verdict.
        </p>
      </header>

      <Panel eyebrow="Context graph" title="Environment to file to loader to artifact" bleed>
        <div className="hidden overflow-x-auto px-4 py-4 lg:block scroll-thin">
          <ContextGraph records={records} onSelectArtifact={onSelectArtifact} />
        </div>
        <p className={cx(TYPE.note, 'px-5 py-4 lg:hidden')}>
          The graph needs a wider screen. The chains below carry the same information.
        </p>
      </Panel>

      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.file} className={cx(SURFACE.panel, 'overflow-hidden')}>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line-1 px-5 py-4">
              <div className="min-w-0">
                <h2 className="break-all font-mono text-sm text-ink-0">{group.file}</h2>
                <p className={cx(TYPE.note, 'mt-1.5')}>
                  {group.context === null
                    ? 'No context resolved for this file.'
                    : group.context.rule}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {group.context !== null && (
                  <ContextBadge
                    environment={group.context.environment}
                    basis={group.context.basis}
                    privileged={group.context.privileged}
                  />
                )}
                <span className="font-mono text-2xs text-ink-3">
                  {group.sites.length} load{group.sites.length === 1 ? '' : 's'}
                </span>
              </div>
            </header>

            <div className="space-y-3 p-5">
              {group.sites.map(({ record, siteIndex }) => {
                const site = record.loadSites[siteIndex]
                if (site === undefined) return null
                return (
                  <button
                    key={site.id}
                    type="button"
                    onClick={() => onSelectArtifact(record.artifact.id)}
                    className="block w-full text-left transition-opacity duration-90 hover:opacity-90"
                  >
                    <LoadPathFlow site={site} artifactName={record.artifact.locator} />
                  </button>
                )
              })}
            </div>

            {group.context !== null && group.context.privileges.length > 0 && (
              <div className="border-t border-line-1 bg-code/[0.03] px-5 py-4">
                <p className={cx(TYPE.eyebrow, 'mb-2.5 text-code')}>
                  What this file can reach &mdash; {ENVIRONMENT_META[group.context.environment].label}
                </p>
                <PrivilegeList privileges={group.context.privileges} />
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
