/**
 * Typed failures.
 *
 * Two kinds of thing go wrong. A *notice* is something DEADWEIGHT decided not
 * to look at -- a file over a limit, a path it refused, a document it could
 * not parse -- and the analysis continues with that fact recorded. An
 * `AnalysisError` means the analysis itself cannot produce a report, and the
 * CLI exits 1.
 *
 * Nothing here ever carries a stack trace into the UI. The message is written
 * for the person holding the repository: what happened, why it matters, what
 * to do.
 */

export type AnalysisErrorCode =
  | 'no-source-tree'
  | 'tree-empty'
  | 'tree-too-large'
  | 'unreadable-root'
  | 'bad-config'
  | 'bad-report'
  | 'bad-bom'

export interface ErrorGuidance {
  readonly what: string
  readonly why: string
  readonly fix: string
}

const GUIDANCE: Record<AnalysisErrorCode, ErrorGuidance> = {
  'no-source-tree': {
    what: 'No directory was provided to analyse.',
    why: 'DEADWEIGHT reads a project from disk; there is nothing to walk without one.',
    fix: 'Pass a path, or load the bundled demo project.',
  },
  'tree-empty': {
    what: 'The directory contained no files DEADWEIGHT can read.',
    why: 'Every file was filtered out by the skip list, a size limit, or a path rule, so no load site could be discovered.',
    fix: 'Check that you selected the project root and not an empty or build-only folder.',
  },
  'tree-too-large': {
    what: 'The directory exceeded the entry limit.',
    why: 'An unbounded walk on an unfamiliar tree is how an analyser becomes the incident.',
    fix: 'Point DEADWEIGHT at a subdirectory, or raise the limit deliberately in the CLI configuration.',
  },
  'unreadable-root': {
    what: 'The path could not be opened as a directory.',
    why: 'The analysis needs a readable project root to walk.',
    fix: 'Check the path exists and that you can list it.',
  },
  'bad-config': {
    what: 'The DEADWEIGHT configuration file could not be understood.',
    why: 'The configuration declares which paths run in which environment; a misread would silently mislabel every load context.',
    fix: 'Correct the reported line, or remove the file to fall back to inferred contexts.',
  },
  'bad-report': {
    what: 'The report document could not be read.',
    why: 'Diff and export operate on a report produced by this tool; a partially-read report would produce a wrong diff.',
    fix: 'Regenerate the report with `deadweight scan <dir> --out report.json`.',
  },
  'bad-bom': {
    what: 'The model BOM document could not be read.',
    why: 'A BOM is compared against another BOM; reading half of one produces a diff that looks like deletions.',
    fix: 'Regenerate the BOM with `deadweight bom <dir> --out bom.json`.',
  },
}

export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode
  readonly guidance: ErrorGuidance
  readonly detail: string | null

  constructor(code: AnalysisErrorCode, detail?: string) {
    const guidance = GUIDANCE[code]
    // The message carries the specific problem as well as the general one.
    // `deadweight.yaml:2: tab indentation is not accepted` is actionable;
    // "the configuration could not be understood" on its own is not. The UI
    // reads `guidance` for its headline and `detail` for the expandable part.
    super(detail === undefined ? guidance.what : `${guidance.what} ${detail}`)
    this.name = 'AnalysisError'
    this.code = code
    this.guidance = guidance
    this.detail = detail ?? null
  }
}

export function isAnalysisError(value: unknown): value is AnalysisError {
  return value instanceof AnalysisError
}

/** Guidance for an error that did not come from the engine. */
export function unexpectedGuidance(error: unknown): ErrorGuidance {
  return {
    what: 'The analysis stopped on an unexpected error.',
    why: 'DEADWEIGHT could not finish reading the project, so the report you would see would be incomplete rather than empty.',
    fix: error instanceof Error ? error.message : String(error),
  }
}
