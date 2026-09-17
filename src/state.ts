/**
 * Application state.
 *
 * One hook owns the analysis lifecycle, the filters, the selection and the
 * theme. Views read it and render; they never hold a second copy of anything
 * derived from the report, which is what keeps the stripe in the explorer and
 * the stripe in the drawer showing the same six facts.
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'

import { demoTree, treeFromDataTransfer, treeFromFileList } from './adapters/browser-tree.ts'
import { analyze } from './engine/analyze.ts'
import { buildBom } from './engine/bom.ts'
import type { ModelBom } from './engine/bom.ts'
import { isAnalysisError, unexpectedGuidance } from './engine/errors.ts'
import type { ErrorGuidance } from './engine/errors.ts'
import { STAGE_ORDER } from './engine/types.ts'
import type { Report, StageEvent, StageId } from './engine/types.ts'
import { NO_FILTERS, buildSearchIndex } from './views/filter.ts'
import type { Filters, SortDirection, SortKey } from './views/filter.ts'

export type ViewId = 'overview' | 'artifacts' | 'loadpaths' | 'migrations' | 'bom' | 'evidence'

export const VIEWS: ReadonlyArray<{ id: ViewId; label: string; hint: string }> = [
  { id: 'overview', label: 'Overview', hint: 'What this project loads, and what happens when it does' },
  { id: 'artifacts', label: 'Artifacts', hint: 'Every artifact, filterable and searchable' },
  { id: 'loadpaths', label: 'Load paths', hint: 'Source file to loader to artifact to behaviour' },
  { id: 'migrations', label: 'Migrations', hint: 'Execution surfaces that can be removed' },
  { id: 'bom', label: 'Model BOM', hint: 'The inventory, and its exports' },
  { id: 'evidence', label: 'Evidence', hint: 'Scanner results, their bindings and their coverage' },
]

/* -------------------------------------------------------------------------- */
/* Analysis                                                                   */
/* -------------------------------------------------------------------------- */

export type StageStatus = 'pending' | 'running' | 'done'

export interface StageState {
  readonly stage: StageId
  readonly status: StageStatus
  readonly detail: string
}

export type Analysis =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly source: string; readonly stages: readonly StageState[] }
  | {
      readonly status: 'ready'
      readonly source: string
      readonly report: Report
      readonly bom: ModelBom
      readonly isDemo: boolean
      readonly notes: readonly string[]
    }
  | { readonly status: 'failed'; readonly source: string; readonly guidance: ErrorGuidance; readonly detail: string | null }

type Action =
  | { type: 'start'; source: string }
  | { type: 'stage'; event: StageEvent }
  | { type: 'ready'; source: string; report: Report; isDemo: boolean; notes: readonly string[] }
  | { type: 'failed'; source: string; guidance: ErrorGuidance; detail: string | null }
  | { type: 'reset' }

function initialStages(): StageState[] {
  return STAGE_ORDER.map((stage) => ({ stage, status: 'pending', detail: '' }))
}

function reducer(state: Analysis, action: Action): Analysis {
  switch (action.type) {
    case 'start':
      return { status: 'running', source: action.source, stages: initialStages() }
    case 'stage': {
      if (state.status !== 'running') return state
      return {
        ...state,
        stages: state.stages.map((item) =>
          item.stage === action.event.stage
            ? { stage: item.stage, status: action.event.status, detail: action.event.detail }
            : item,
        ),
      }
    }
    case 'ready':
      return {
        status: 'ready',
        source: action.source,
        report: action.report,
        bom: buildBom(action.report),
        isDemo: action.isDemo,
        notes: action.notes,
      }
    case 'failed':
      return {
        status: 'failed',
        source: action.source,
        guidance: action.guidance,
        detail: action.detail,
      }
    case 'reset':
      return { status: 'idle' }
    default:
      return state
  }
}

/* -------------------------------------------------------------------------- */
/* Theme                                                                      */
/* -------------------------------------------------------------------------- */

export type ThemePreference = 'system' | 'dark' | 'light'

const THEME_KEY = 'deadweight.theme'

function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return 'system'
}

export function useTheme(): {
  preference: ThemePreference
  resolved: 'dark' | 'light'
  setPreference: (next: ThemePreference) => void
  cycle: () => void
} {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference)
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const resolved: 'dark' | 'light' =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)
  }, [resolved])

  /**
   * Persist only a choice the reader actually made.
   *
   * Writing `system` back on mount would record a preference nobody
   * expressed, and would then survive a later change to the OS setting as
   * though it had been chosen.
   */
  const choose = useCallback((next: ThemePreference) => {
    setPreference(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Not being able to remember the choice is not worth an error.
    }
  }, [])

  const cycle = useCallback(() => {
    choose(preference === 'system' ? 'dark' : preference === 'dark' ? 'light' : 'system')
  }, [choose, preference])

  return { preference, resolved, setPreference: choose, cycle }
}

/* -------------------------------------------------------------------------- */
/* The app hook                                                               */
/* -------------------------------------------------------------------------- */

export interface AppState {
  readonly analysis: Analysis
  readonly view: ViewId
  readonly setView: (view: ViewId) => void
  readonly filters: Filters
  readonly setFilters: (next: Filters) => void
  readonly toggleFilter: <K extends 'behaviour' | 'environment' | 'format' | 'migration' | 'evidence'>(
    facet: K,
    value: Filters[K][number],
  ) => void
  readonly clearFilters: () => void
  readonly sort: { key: SortKey; direction: SortDirection }
  readonly setSort: (key: SortKey) => void
  readonly selected: string | null
  readonly select: (id: string | null) => void
  readonly searchIndex: ReadonlyMap<string, string>
  readonly runDemo: () => void
  readonly runFiles: (files: FileList | readonly File[]) => void
  readonly runDrop: (items: DataTransferItemList) => void
  readonly reset: () => void
  readonly paletteOpen: boolean
  readonly setPaletteOpen: (open: boolean) => void
}

export function useApp(): AppState {
  const [analysis, dispatch] = useReducer(reducer, { status: 'idle' } as Analysis)
  const [view, setView] = useState<ViewId>('overview')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [sort, setSortState] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'exposure',
    direction: 'asc',
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const searchIndex = useMemo(
    () => (analysis.status === 'ready' ? buildSearchIndex(analysis.report) : new Map<string, string>()),
    [analysis],
  )

  const run = useCallback(
    async (
      source: string,
      build: () => Promise<{ tree: Parameters<typeof analyze>[0]; notes: string[] }>,
      isDemo: boolean,
    ) => {
      dispatch({ type: 'start', source })
      // One frame, so the stage list paints before the analysis blocks the
      // thread. Not a delay for effect: without it the first stage's
      // "running" state is never visible even on a slow tree.
      await new Promise((done) => requestAnimationFrame(done))
      try {
        const { tree, notes } = await build()
        const report = await analyze(tree, {
          onProgress: (event) => dispatch({ type: 'stage', event }),
        })
        dispatch({ type: 'ready', source, report, isDemo, notes })
        setSelected(null)
        setFilters(NO_FILTERS)
      } catch (error) {
        dispatch({
          type: 'failed',
          source,
          guidance: isAnalysisError(error) ? error.guidance : unexpectedGuidance(error),
          detail: isAnalysisError(error) ? error.detail : null,
        })
      }
    },
    [],
  )

  const runDemo = useCallback(() => {
    void run('demo', async () => ({ tree: demoTree(), notes: [] }), true)
  }, [run])

  const runFiles = useCallback(
    (files: FileList | readonly File[]) => {
      void run(
        'directory',
        async () => {
          const picked = treeFromFileList(files)
          const notes: string[] = []
          if (picked.truncated) {
            notes.push('The directory exceeded the entry limit, so this analysis is partial.')
          }
          if (picked.skipped > 0) {
            notes.push(
              `${picked.skipped} file${picked.skipped === 1 ? '' : 's'} were skipped: build output, dependencies or a path DEADWEIGHT refused.`,
            )
          }
          return { tree: picked.tree, notes }
        },
        false,
      )
    },
    [run],
  )

  const runDrop = useCallback(
    (items: DataTransferItemList) => {
      void run(
        'directory',
        async () => {
          const picked = await treeFromDataTransfer(items)
          if (picked === null) {
            throw Object.assign(new Error('Nothing readable was dropped.'), { name: 'DropError' })
          }
          const notes: string[] = []
          if (picked.truncated) {
            notes.push('The directory exceeded the entry limit, so this analysis is partial.')
          }
          if (picked.skipped > 0) {
            notes.push(
              `${picked.skipped} file${picked.skipped === 1 ? '' : 's'} were skipped: build output, dependencies or a path DEADWEIGHT refused.`,
            )
          }
          return { tree: picked.tree, notes }
        },
        false,
      )
    },
    [run],
  )

  const toggleFilter = useCallback<AppState['toggleFilter']>((facet, value) => {
    setFilters((current) => {
      const list = current[facet] as readonly string[]
      const next = list.includes(value as string)
        ? list.filter((item) => item !== value)
        : [...list, value as string]
      return { ...current, [facet]: next } as Filters
    })
  }, [])

  const clearFilters = useCallback(() => setFilters(NO_FILTERS), [])

  const setSort = useCallback((key: SortKey) => {
    setSortState((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'exposure' ? 'asc' : 'asc' },
    )
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'reset' })
    setFilters(NO_FILTERS)
    setSelected(null)
    setView('overview')
  }, [])

  return {
    analysis,
    view,
    setView,
    filters,
    setFilters,
    toggleFilter,
    clearFilters,
    sort,
    setSort,
    selected,
    select: setSelected,
    searchIndex,
    runDemo,
    runFiles,
    runDrop,
    reset,
    paletteOpen,
    setPaletteOpen,
  }
}
