/**
 * The application shell.
 *
 * Six views, one drawer, one palette. The header carries the project and the
 * navigation; nothing else lives in it, because a toolbar that accumulates
 * controls is how a tool becomes a dashboard.
 */

import { useCallback, useEffect, useRef } from 'react'

import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import { Button, cx } from './ui/primitives.tsx'
import { CONTROL, TYPE } from './ui/tokens.ts'
import { VIEWS, useApp, useTheme } from './state.ts'
import type { ViewId } from './state.ts'
import { NO_FILTERS } from './views/filter.ts'
import { AnalysisProgress } from './views/AnalysisProgress.tsx'
import { ArtifactDrawer } from './views/ArtifactDrawer.tsx'
import { Artifacts } from './views/Artifacts.tsx'
import { Bom } from './views/Bom.tsx'
import { CommandPalette } from './views/CommandPalette.tsx'
import { Evidence } from './views/Evidence.tsx'
import { Hero } from './views/Hero.tsx'
import { LoadPaths } from './views/LoadPaths.tsx'
import { Migrations } from './views/Migrations.tsx'
import { Overview } from './views/Overview.tsx'
import { ErrorState } from './ui/primitives.tsx'

export function App() {
  const app = useApp()
  const theme = useTheme()
  const folder = useRef<HTMLInputElement>(null)

  const { analysis, paletteOpen, setPaletteOpen } = app

  // Cmd/Ctrl+K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPaletteOpen])

  const applyPreset = useCallback(
    (preset: 'executes' | 'production' | 'unknown' | 'privileged' | 'migrations' | 'clear') => {
      switch (preset) {
        case 'executes':
          app.setFilters({ ...NO_FILTERS, behaviour: ['code'] })
          app.setView('artifacts')
          break
        case 'production':
          app.setFilters({ ...NO_FILTERS, environment: ['production', 'staging', 'service'] })
          app.setView('artifacts')
          break
        case 'unknown':
          app.setFilters({ ...NO_FILTERS, behaviour: ['unknown'] })
          app.setView('artifacts')
          break
        case 'privileged':
          app.setFilters({ ...NO_FILTERS, privilegedOnly: true })
          app.setView('artifacts')
          break
        case 'migrations':
          app.setFilters({ ...NO_FILTERS, migration: ['available'] })
          app.setView('migrations')
          break
        case 'clear':
        default:
          app.clearFilters()
      }
    },
    [app],
  )

  const selectedRecord =
    analysis.status === 'ready' && app.selected !== null
      ? (analysis.report.records.find((r) => r.artifact.id === app.selected) ?? null)
      : null

  return (
    <div className="min-h-screen">
      <a
        href="#dw-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded focus:bg-surface-1 focus:px-3 focus:py-2 focus:text-xs focus:text-ink-0 focus:shadow-pop"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-20 border-b border-line-1 bg-surface-0/85 backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-[1400px] items-center gap-4 px-6 md:px-10">
          <button
            type="button"
            onClick={() => app.setView('overview')}
            className="flex shrink-0 items-center gap-2.5"
            title="DEADWEIGHT"
          >
            <Wordmark />
          </button>

          {analysis.status === 'ready' && (
            <nav aria-label="Views" className="hidden min-w-0 flex-1 items-center gap-0.5 lg:flex">
              {VIEWS.map((view) => (
                <NavItem
                  key={view.id}
                  view={view}
                  active={app.view === view.id}
                  onClick={() => app.setView(view.id)}
                />
              ))}
            </nav>
          )}

          <div className="flex-1 lg:hidden" />

          <div className="flex shrink-0 items-center gap-2">
            {analysis.status === 'ready' && (
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="hidden items-center gap-2 rounded border border-line-2 px-2.5 py-1 text-2xs text-ink-2 transition-colors duration-90 hover:border-line-3 hover:text-ink-0 sm:flex"
              >
                Search
                <kbd className="rounded border border-line-2 px-1 font-mono text-[10px]">
                  {navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'}K
                </kbd>
              </button>
            )}
            <button
              type="button"
              onClick={theme.cycle}
              aria-label={`Theme: ${theme.preference}. Switch.`}
              title={`Theme: ${theme.preference}`}
              className={CONTROL.icon}
            >
              <span aria-hidden className="font-mono text-[10px]">
                {theme.preference === 'system' ? 'A' : theme.preference === 'dark' ? 'D' : 'L'}
              </span>
            </button>
            {analysis.status !== 'idle' && (
              <Button onClick={app.reset} title="Analyse a different project">
                New
              </Button>
            )}
          </div>
        </div>

        {/* mobile navigation ------------------------------------------- */}
        {analysis.status === 'ready' && (
          <nav
            aria-label="Views"
            className="no-scrollbar flex gap-0.5 overflow-x-auto border-t border-line-1 px-4 py-1.5 lg:hidden"
          >
            {VIEWS.map((view) => (
              <NavItem
                key={view.id}
                view={view}
                active={app.view === view.id}
                onClick={() => app.setView(view.id)}
              />
            ))}
          </nav>
        )}
      </header>

      <main id="dw-main">
        <ErrorBoundary onReset={app.reset}>
          {analysis.status === 'idle' && (
            <Hero
              onDemo={app.runDemo}
              onFiles={app.runFiles}
              onDrop={app.runDrop}
            />
          )}

          {analysis.status === 'running' && (
            <AnalysisProgress stages={analysis.stages} source={analysis.source} />
          )}

          {analysis.status === 'failed' && (
            <div className="mx-auto max-w-3xl px-6 py-16">
              <ErrorState
                what={analysis.guidance.what}
                why={analysis.guidance.why}
                fix={analysis.guidance.fix}
                detail={analysis.detail}
                actions={
                  <>
                    <Button variant="primary" onClick={app.runDemo}>
                      Run the demo project
                    </Button>
                    <Button onClick={() => folder.current?.click()}>Pick another folder</Button>
                    <input
                      ref={folder}
                      type="file"
                      className="sr-only"
                      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                      multiple
                      onChange={(event) => {
                        if (event.target.files !== null && event.target.files.length > 0) {
                          app.runFiles(event.target.files)
                        }
                      }}
                    />
                  </>
                }
              />
            </div>
          )}

          {analysis.status === 'ready' && (
            <>
              {app.view === 'overview' && (
                <Overview
                  report={analysis.report}
                  isDemo={analysis.isDemo}
                  notes={analysis.notes}
                  onSelectArtifact={app.select}
                  onMatrixSelect={(behaviour, environment) => {
                    app.setFilters({ ...NO_FILTERS, behaviour: [behaviour], environment: [environment] })
                    app.setView('artifacts')
                  }}
                  onGoToFindings={() => {
                    app.clearFilters()
                    app.setView('artifacts')
                  }}
                />
              )}

              {app.view === 'artifacts' && (
                <Artifacts
                  report={analysis.report}
                  filters={app.filters}
                  searchIndex={app.searchIndex}
                  sort={app.sort}
                  selected={app.selected}
                  onToggle={app.toggleFilter}
                  onTogglePrivileged={() =>
                    app.setFilters({ ...app.filters, privilegedOnly: !app.filters.privilegedOnly })
                  }
                  onQuery={(query) => app.setFilters({ ...app.filters, query })}
                  onClear={app.clearFilters}
                  onSort={app.setSort}
                  onSelect={app.select}
                />
              )}

              {app.view === 'loadpaths' && (
                <LoadPaths
                  report={analysis.report}
                  filters={app.filters}
                  searchIndex={app.searchIndex}
                  onSelectArtifact={app.select}
                />
              )}

              {app.view === 'migrations' && (
                <Migrations report={analysis.report} onSelectArtifact={app.select} />
              )}

              {app.view === 'bom' && (
                <Bom
                  report={analysis.report}
                  bom={analysis.bom}
                  filters={app.filters}
                  searchIndex={app.searchIndex}
                  onSelectArtifact={app.select}
                />
              )}

              {app.view === 'evidence' && (
                <Evidence report={analysis.report} onSelectArtifact={app.select} />
              )}
            </>
          )}
        </ErrorBoundary>
      </main>

      {analysis.status === 'ready' && (
        <footer className="border-t border-line-1 px-6 py-8 md:px-10">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-baseline justify-between gap-4">
            <p className={TYPE.note}>
              DEADWEIGHT reads {analysis.report.counts.filesWalked} files and never deserialises an
              artifact to inspect one. Nothing about this project left this tab.
            </p>
            <p className="font-mono text-2xs text-ink-3">
              {analysis.report.schema} &middot; {analysis.report.digest.slice(0, 16)}
            </p>
          </div>
        </footer>
      )}

      {selectedRecord !== null && (
        <ArtifactDrawer
          key={selectedRecord.artifact.id}
          record={selectedRecord}
          onClose={() => app.select(null)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          report={analysis.status === 'ready' ? analysis.report : null}
          onView={app.setView}
          onFilter={applyPreset}
          onSelectArtifact={app.select}
          onReset={app.reset}
          onTheme={theme.cycle}
        />
      )}
    </div>
  )
}

function NavItem({
  view,
  active,
  onClick,
}: {
  view: { id: ViewId; label: string; hint: string }
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={view.hint}
      className={cx(
        'relative shrink-0 rounded px-3 py-1.5 text-xs transition-colors duration-90',
        active ? 'text-ink-0' : 'text-ink-2 hover:text-ink-1',
      )}
    >
      {view.label}
      {active && (
        <span aria-hidden className="absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full bg-accent" />
      )}
    </button>
  )
}

/**
 * The wordmark is the stripe: six cells, the third one -- execution -- in red.
 * The product's glyph is its logo, which is the point of having one.
 */
function Wordmark() {
  return (
    <>
      <span aria-hidden className="flex items-end gap-[2px]">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cx(
              'w-[3px] rounded-[1px]',
              i === 2 ? 'h-[14px] bg-code' : 'h-[10px] bg-ink-2/60',
            )}
          />
        ))}
      </span>
      <span className="font-display text-sm font-semibold tracking-[0.02em] text-ink-0">
        DEADWEIGHT
      </span>
    </>
  )
}
