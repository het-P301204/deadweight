#!/usr/bin/env node
/**
 * DEADWEIGHT command line.
 *
 * Runs the engine's TypeScript sources directly through Node's native type
 * stripping: no build step, no dependencies, nothing installed. The analysis
 * it performs is the same code the browser build runs.
 *
 * Exit codes are designed to be used in a pipeline:
 *
 *   0  analysed, nothing at or above the failure threshold
 *   1  could not analyse
 *   2  analysed, findings at or above the threshold
 *
 * A supply-chain check that cannot fail a build is a check nobody runs.
 */

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { walkDirectory } from '../src/adapters/node-tree.ts'
import { analyze } from '../src/engine/analyze.ts'
import { bomToCsv, bomToText, buildBom } from '../src/engine/bom.ts'
import type { ModelBom } from '../src/engine/bom.ts'
import { ENVIRONMENT_META } from '../src/engine/context.ts'
import { toCycloneDx } from '../src/engine/cyclonedx.ts'
import { diffBoms, diffToText } from '../src/engine/diff.ts'
import { AnalysisError, isAnalysisError, unexpectedGuidance } from '../src/engine/errors.ts'

import { formatSpec } from '../src/engine/formats.ts'
import { canonicalJson } from '../src/engine/hash.ts'
import { scannerProfile } from '../src/engine/evidence.ts'
import { BEHAVIOUR_LABEL } from '../src/engine/stripe.ts'
import { indicators } from '../src/engine/summary.ts'
import { LOAD_BEHAVIOURS } from '../src/engine/types.ts'
import type { ArtifactRecord, LoadBehaviour, Report, StageEvent } from '../src/engine/types.ts'

/**
 * Largest BOM accepted by `diff`. Generous next to any real inventory, and
 * still a bound: every other read in this project has one.
 */
const MAX_BOM_CHARS = 32 * 1024 * 1024

/* -------------------------------------------------------------------------- */
/* Terminal styling                                                           */
/* -------------------------------------------------------------------------- */

const COLOUR =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  process.stdout.isTTY === true

/**
 * SGR escapes, built from the code point.
 *
 * A literal escape byte in a string literal is invisible in every editor and
 * diff: the line reads `\`[2m${s}[0m\`` and looks like a typo rather than
 * like terminal styling. Naming it costs one constant and makes the source
 * say what it does.
 */
const CSI = `${String.fromCharCode(27)}[`
const RESET = `${CSI}0m`

const style = {
  dim: (s: string) => (COLOUR ? `${CSI}2m${s}${RESET}` : s),
  bold: (s: string) => (COLOUR ? `${CSI}1m${s}${RESET}` : s),
  red: (s: string) => (COLOUR ? `${CSI}31m${s}${RESET}` : s),
  green: (s: string) => (COLOUR ? `${CSI}32m${s}${RESET}` : s),
  amber: (s: string) => (COLOUR ? `${CSI}33m${s}${RESET}` : s),
  blue: (s: string) => (COLOUR ? `${CSI}36m${s}${RESET}` : s),
  purple: (s: string) => (COLOUR ? `${CSI}35m${s}${RESET}` : s),
}

const BEHAVIOUR_COLOUR: Record<LoadBehaviour, (s: string) => string> = {
  code: style.red,
  directive: style.purple,
  guarded: style.green,
  data: style.green,
  unknown: style.amber,
}

/** Six-cell stripe, rendered for a terminal. */
function stripeGlyph(record: ArtifactRecord): string {
  return record.stripe
    .map((cell) => {
      const mark = cell.state === 'resolved' ? '█' : cell.state === 'flagged' ? '▓' : '░'
      if (cell.state === 'flagged') return BEHAVIOUR_COLOUR[record.behaviour.behaviour](mark)
      if (cell.state === 'unresolved') return style.amber(mark)
      return style.dim(mark)
    })
    .join('')
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

interface Args {
  readonly command: string
  readonly positional: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  let command = ''

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i] as string
    if (item.startsWith('--')) {
      const [name, inline] = item.slice(2).split('=', 2)
      if (inline !== undefined) flags.set(name as string, inline)
      else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(name as string, next)
          i += 1
        } else flags.set(name as string, true)
      }
      continue
    }
    if (command === '') command = item
    else positional.push(item)
  }

  return { command, positional, flags }
}

function flagString(args: Args, name: string, fallback: string): string {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : fallback
}

/* -------------------------------------------------------------------------- */
/* Help                                                                       */
/* -------------------------------------------------------------------------- */

const HELP = `
${style.bold('DEADWEIGHT')} — AI model and skill supply-chain analyzer

  What happens when this AI artifact is loaded?

${style.bold('USAGE')}
  deadweight <command> [path] [options]

${style.bold('COMMANDS')}
  scan <dir>              Full analysis, written for a terminal
  artifacts <dir>         One line per artifact
  loadpaths <dir>         Every load site, grouped by file
  migrations <dir>        Artifacts whose execution surface can be removed
  evidence <dir>          Scanner records and what each scanner can see
  bom <dir>               Model BOM
  explain <dir> <id>      Everything resolved about one artifact
  diff <a.json> <b.json>  Compare two BOMs
  version

${style.bold('OPTIONS')}
  --format <f>      For bom: canonical | cyclonedx | csv | text   (default canonical)
  --out <file>      Write the output to a file instead of stdout
  --json            Emit the full report as JSON
  --fail-on <what>  none | execution | privileged | unknown | any  (default execution)
  --quiet           Suppress the progress lines
  --no-color        Plain output

${style.bold('EXIT CODES')}
  0  analysed, nothing at or above the threshold
  1  could not analyse
  2  analysed, findings at or above the threshold

${style.bold('WHAT IT DOES NOT DO')}
  It never deserialises an artifact to inspect it. Recognition reads magic
  bytes, container member names and length-prefixed headers. It makes no
  network requests, so a remote model reference is reported as unresolvable
  rather than fetched.
`

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

async function loadReport(path: string, quiet: boolean): Promise<Report> {
  const onProgress = quiet
    ? undefined
    : (event: StageEvent): void => {
        if (event.status !== 'done') return
        process.stderr.write(`${style.dim(`  ${event.stage.padEnd(13)}`)} ${event.detail}\n`)
      }

  let walked
  try {
    walked = await walkDirectory(path)
  } catch {
    throw new AnalysisError('unreadable-root', path)
  }
  if (walked.truncated) {
    process.stderr.write(
      style.amber(`  note          walk stopped at the entry limit; results are partial\n`),
    )
  }
  if (!quiet) process.stderr.write(style.dim(`\n  Analysing ${path}\n`))
  const report = await analyze(walked.tree, { onProgress })
  if (!quiet) process.stderr.write('\n')
  return report
}

function printScan(report: Report): void {
  const out: string[] = []
  out.push(style.bold(`\n  ${report.project}`))
  out.push(style.dim(`  report ${report.digest.slice(0, 16)}\n`))

  for (const indicator of indicators(report.summary)) {
    const value = String(indicator.value).padStart(4)
    const tone =
      indicator.tone === 'code'
        ? style.red
        : indicator.tone === 'directive'
          ? style.purple
          : indicator.tone === 'unknown'
            ? style.amber
            : indicator.tone === 'data' || indicator.tone === 'guarded'
              ? style.green
              : style.blue
    out.push(`  ${tone(value)}  ${indicator.label}`)
  }

  const acts = report.findings.filter((f) => f.disposition === 'act')
  if (acts.length > 0) {
    out.push(style.bold('\n  ACT'))
    for (const finding of acts) {
      out.push(`  ${style.red('▪')} ${finding.title}`)
      out.push(style.dim(`      ${finding.locations.slice(0, 3).join('  ')}`))
    }
  }

  const reviews = report.findings.filter((f) => f.disposition === 'review')
  if (reviews.length > 0) {
    out.push(style.bold('\n  REVIEW'))
    for (const finding of reviews.slice(0, 12)) {
      out.push(`  ${style.amber('▪')} ${finding.title}`)
      out.push(style.dim(`      ${finding.locations.slice(0, 3).join('  ')}`))
    }
    if (reviews.length > 12) out.push(style.dim(`      … and ${reviews.length - 12} more`))
  }

  out.push(style.bold('\n  ARTIFACTS'))
  out.push(printArtifactLines(report))

  if (report.orphanLoadSites.length > 0) {
    out.push(style.bold('\n  LOAD SITES WITH NO RESOLVABLE ARTIFACT'))
    for (const site of report.orphanLoadSites) {
      out.push(
        `  ${style.amber('?')} ${site.file}:${site.line}  ${style.dim(site.loader)}  ${site.targetExpression}`,
      )
    }
  }

  if (report.notices.length > 0) {
    out.push(style.bold('\n  NOTICES'))
    for (const notice of report.notices) {
      out.push(`  ${style.dim(notice.path ?? '')}  ${notice.message}`)
    }
  }

  out.push('')
  process.stdout.write(`${out.join('\n')}\n`)
}

function printArtifactLines(report: Report): string {
  const width = Math.min(
    52,
    Math.max(...report.records.map((r) => r.artifact.locator.length), 10),
  )
  return report.records
    .map((record) => {
      const environments =
        record.contexts.length === 0
          ? style.dim('no-context')
          : [...new Set(record.contexts.map((c) => ENVIRONMENT_META[c.environment].short))].join(',')
      const privileged = record.contexts.some((c) => c.privileged) ? style.red(' ⚠') : ''
      const behaviour = BEHAVIOUR_COLOUR[record.behaviour.behaviour](
        BEHAVIOUR_LABEL[record.behaviour.behaviour].padEnd(17),
      )
      return `  ${stripeGlyph(record)}  ${truncate(record.artifact.locator, width).padEnd(width)}  ${behaviour}  ${style.dim(formatSpec(record.artifact.format.format).label.padEnd(20))}  ${environments}${privileged}`
    })
    .join('\n')
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `…${text.slice(text.length - width + 1)}`
}

function printLoadPaths(report: Report): void {
  const byFile = new Map<string, ArtifactRecord[]>()
  for (const record of report.records) {
    for (const site of record.loadSites) {
      const list = byFile.get(site.file) ?? []
      if (!list.includes(record)) list.push(record)
      byFile.set(site.file, list)
    }
  }
  const lines: string[] = ['']
  for (const [file, records] of [...byFile.entries()].sort()) {
    const context = report.contexts.find((c) => c.id === `ctx:${file}`)
    const label = context === undefined ? 'unresolved' : ENVIRONMENT_META[context.environment].label
    lines.push(
      `  ${style.bold(file)}  ${style.dim(`${label} (${context?.basis ?? 'unresolved'})`)}${context?.privileged === true ? style.red('  privileged') : ''}`,
    )
    for (const record of records) {
      for (const site of record.loadSites.filter((s) => s.file === file)) {
        lines.push(
          `    ${style.dim(`:${site.line}`)}  ${site.loader}  ${style.dim('→')}  ${record.artifact.locator}`,
        )
        lines.push(
          `        ${BEHAVIOUR_COLOUR[record.behaviour.behaviour](BEHAVIOUR_LABEL[record.behaviour.behaviour])}  ${style.dim(record.behaviour.mechanism)}`,
        )
      }
    }
    lines.push('')
  }
  process.stdout.write(lines.join('\n'))
}

function printMigrations(report: Report): void {
  const records = report.records.filter(
    (r) => r.alternative.kind !== 'none-identified' && r.behaviour.behaviour !== 'data',
  )
  if (records.length === 0) {
    process.stdout.write('\n  No migration opportunity identified.\n\n')
    return
  }
  const lines = ['']
  for (const record of records) {
    lines.push(`  ${style.bold(record.artifact.locator)}`)
    lines.push(
      `    ${BEHAVIOUR_COLOUR[record.behaviour.behaviour](BEHAVIOUR_LABEL[record.behaviour.behaviour])}  ${style.dim('→')}  ${style.green(BEHAVIOUR_LABEL[record.alternative.resultingBehaviour])}`,
    )
    lines.push(`    ${record.alternative.summary}`)
    lines.push(style.dim(`    ${record.alternative.difference}`))
    if (record.alternative.change !== null) {
      for (const line of record.alternative.change.split('\n')) {
        lines.push(style.blue(`      ${line}`))
      }
    }
    if (record.alternative.caveat !== null) {
      lines.push(style.amber(`    caveat: ${record.alternative.caveat}`))
    }
    lines.push('')
  }
  process.stdout.write(lines.join('\n'))
}

function printEvidence(report: Report): void {
  const lines = ['']
  const scanners = new Set<string>()
  let any = false
  for (const record of report.records) {
    if (record.evidence.length === 0) continue
    any = true
    lines.push(`  ${style.bold(record.artifact.locator)}`)
    for (const item of record.evidence) {
      scanners.add(item.scanner)
      const binding =
        item.binding === 'current'
          ? style.green('bound')
          : item.binding === 'stale'
            ? style.red('stale')
            : style.amber(item.binding)
      lines.push(
        `    ${item.scanner}${item.scannerVersion === null ? '' : ` ${item.scannerVersion}`}  ${item.result}  ${binding}`,
      )
      lines.push(style.dim(`      ${item.detail}`))
      if (item.bindingNote !== null) lines.push(style.amber(`      ${item.bindingNote}`))
    }
    lines.push('')
  }
  if (!any) lines.push('  No scanner evidence found in this project.\n')

  for (const id of [...scanners].sort()) {
    const profile = scannerProfile(id)
    lines.push(`  ${style.bold(profile.label)}  ${style.dim('coverage')}`)
    for (const item of profile.inspects) lines.push(`    ${style.green('+')} ${item}`)
    for (const item of profile.limitations) lines.push(`    ${style.amber('-')} ${item}`)
    lines.push('')
  }
  process.stdout.write(lines.join('\n'))
}

function printExplain(report: Report, id: string): number {
  const record =
    report.records.find((r) => r.artifact.id === id) ??
    report.records.find((r) => r.artifact.locator === id) ??
    report.records.find((r) => r.artifact.locator.endsWith(id)) ??
    report.records.find((r) => r.artifact.name === id)

  if (record === undefined) {
    process.stderr.write(`\n  No artifact matching "${id}".\n`)
    process.stderr.write(
      `  Known: ${report.records
        .slice(0, 8)
        .map((r) => r.artifact.locator)
        .join(', ')}${report.records.length > 8 ? ', …' : ''}\n\n`,
    )
    return 1
  }

  const lines = ['']
  lines.push(`  ${style.bold(record.artifact.locator)}  ${stripeGlyph(record)}`)
  lines.push(
    style.dim(
      `  ${formatSpec(record.artifact.format.format).label} · ${record.artifact.origin}${record.artifact.digest === null ? '' : ` · sha256:${record.artifact.digest.value.slice(0, 16)}${record.artifact.digest.coverage === 'head-tail' ? ' (head-tail)' : ''}`}`,
    ),
  )

  lines.push(style.bold('\n  WHAT HAPPENS WHEN IT LOADS'))
  lines.push(
    `  ${BEHAVIOUR_COLOUR[record.behaviour.behaviour](BEHAVIOUR_LABEL[record.behaviour.behaviour])}`,
  )
  lines.push(`  ${record.behaviour.mechanism}`)
  lines.push(style.bold('\n  HOW THAT WAS DECIDED'))
  for (const step of record.behaviour.steps) {
    lines.push(`  ${style.dim('•')} ${step.claim}`)
    lines.push(style.dim(`      ${step.basis}`))
  }

  if (record.loadSites.length > 0) {
    lines.push(style.bold('\n  LOAD SITES'))
    for (const site of record.loadSites) {
      lines.push(`  ${site.file}:${site.line}  ${style.dim(site.loader)}`)
      lines.push(style.dim(`      ${site.snippet}`))
    }
  }

  if (record.contexts.length > 0) {
    lines.push(style.bold('\n  CONTEXT'))
    for (const context of record.contexts) {
      lines.push(
        `  ${ENVIRONMENT_META[context.environment].label}  ${style.dim(`(${context.basis})`)}  ${style.dim(context.file)}`,
      )
      lines.push(style.dim(`      ${context.rule}`))
      for (const privilege of context.privileges) {
        lines.push(`      ${style.red('⚠')} ${privilege.label}  ${style.dim(`${privilege.file}:${privilege.line}`)}`)
      }
    }
  }

  lines.push(style.bold('\n  EVIDENCE'))
  if (record.evidence.length === 0) {
    lines.push(style.dim('  None recorded. An absent scan is not a clean scan.'))
  } else {
    for (const item of record.evidence) {
      lines.push(`  ${item.scanner} ${item.scannerVersion ?? ''}  ${item.result}  ${item.binding}`)
      lines.push(style.dim(`      ${item.detail}`))
      if (item.bindingNote !== null) lines.push(style.amber(`      ${item.bindingNote}`))
      const profile = scannerProfile(item.scanner)
      for (const limitation of profile.limitations) {
        lines.push(style.amber(`      - ${limitation}`))
      }
    }
  }

  lines.push(style.bold('\n  SAFE ALTERNATIVE'))
  lines.push(`  ${record.alternative.summary}`)
  lines.push(style.dim(`  ${record.alternative.difference}`))
  if (record.alternative.change !== null) {
    for (const line of record.alternative.change.split('\n')) lines.push(style.blue(`    ${line}`))
  }

  if (record.artifact.pickle !== null && record.artifact.pickle.globals.length > 0) {
    lines.push(style.bold('\n  PICKLE OPCODE SCAN'))
    lines.push(
      style.dim(
        `  protocol ${record.artifact.pickle.protocol ?? '0/1'} · ${record.artifact.pickle.invokingOpcodes.join(', ') || 'no invoking opcode'}`,
      ),
    )
    for (const name of record.artifact.pickle.globals) lines.push(`    ${name}`)
    lines.push(style.dim('  Read without unpickling: opcodes walked, no object constructed.'))
  }

  lines.push('')
  process.stdout.write(lines.join('\n'))
  return 0
}

function bomOutput(bom: ModelBom, format: string): string {
  switch (format) {
    case 'cyclonedx':
      return `${JSON.stringify(toCycloneDx(bom), null, 2)}\n`
    case 'csv':
      return `${bomToCsv(bom)}\n`
    case 'text':
      return `${bomToText(bom)}\n`
    case 'canonical':
      return `${canonicalJson(bom)}\n`
    default:
      return `${JSON.stringify(bom, null, 2)}\n`
  }
}

/* -------------------------------------------------------------------------- */
/* Failure threshold                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `scan` is the gate; everything else is a query.
 *
 * `deadweight bom <dir> --out bom.json && upload bom.json` has to work, and
 * it does not if generating a BOM exits 2 because the project contains an
 * execution surface. So the threshold applies to `scan` by default, and to
 * any command if the caller asks for it explicitly.
 */
const GATE_COMMANDS: ReadonlySet<string> = new Set(['scan'])

function shouldFail(report: Report, mode: string): boolean {
  switch (mode) {
    case 'none':
      return false
    case 'any':
      return report.findings.length > 0
    case 'unknown':
      return report.summary.behaviour.unknown > 0 || report.summary.behaviour.code > 0
    case 'privileged':
      return report.findings.some((f) => f.kind === 'privileged-execution-surface')
    case 'execution':
    default:
      return report.records.some(
        (r) =>
          r.behaviour.behaviour === 'code' &&
          r.artifact.format.format !== 'mcp-server-manifest' &&
          r.artifact.format.format !== 'agent-definition',
      )
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Exit code for a completed analysis: 0 unless the failure threshold is met
 * *and* this command is one the threshold applies to. `--fail-on` given
 * explicitly opts any command in.
 */
function gateExit(report: Report, args: Args): number {
  if (!args.flags.has('fail-on') && !GATE_COMMANDS.has(args.command)) return 0
  return shouldFail(report, flagString(args, 'fail-on', 'execution')) ? 2 : 0
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const quiet = args.flags.has('quiet') || args.flags.has('json')

  if (args.command === '' || args.command === 'help' || args.flags.has('help')) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (args.command === 'version') {
    process.stdout.write('deadweight 0.1.0  schema deadweight.report/1\n')
    return 0
  }

  if (args.command === 'diff') {
    const [a, b] = args.positional
    if (a === undefined || b === undefined) {
      process.stderr.write('  diff needs two BOM files.\n')
      return 1
    }
    const before = await readBom(a)
    const after = await readBom(b)
    const diff = diffBoms(before, after)
    const output = args.flags.has('json')
      ? `${JSON.stringify(diff, null, 2)}\n`
      : `\n${diffToText(diff)}\n\n`
    await emit(output, args)
    return diff.added.length + diff.removed.length + diff.changed.length > 0 ? 2 : 0
  }

  const path = args.positional[0] ?? (args.command === 'scan' ? '.' : undefined)
  if (path === undefined) {
    process.stderr.write(`  ${args.command} needs a directory.\n`)
    return 1
  }

  const report = await loadReport(path, quiet)

  if (args.flags.has('json')) {
    await emit(`${JSON.stringify(report, null, 2)}\n`, args)
    return gateExit(report, args)
  }

  switch (args.command) {
    case 'scan':
      printScan(report)
      break
    case 'artifacts':
      process.stdout.write(`\n${printArtifactLines(report)}\n\n`)
      break
    case 'loadpaths':
      printLoadPaths(report)
      break
    case 'migrations':
      printMigrations(report)
      break
    case 'evidence':
      printEvidence(report)
      break
    case 'bom': {
      const output = bomOutput(buildBom(report), flagString(args, 'format', 'canonical'))
      await emit(output, args)
      break
    }
    case 'explain': {
      const id = args.positional[1]
      if (id === undefined) {
        process.stderr.write('  explain needs an artifact path or name.\n')
        return 1
      }
      const code = printExplain(report, id)
      if (code !== 0) return code
      break
    }
    default:
      process.stderr.write(`  Unknown command "${args.command}".\n${HELP}\n`)
      return 1
  }

  return gateExit(report, args)
}

async function emit(output: string, args: Args): Promise<void> {
  const target = args.flags.get('out')
  if (typeof target === 'string') {
    await writeFile(target, output, 'utf8')
    process.stderr.write(style.dim(`  written to ${target}\n`))
    return
  }
  process.stdout.write(output)
}

/**
 * Read a BOM for `diff`, and check it far enough to trust the cast.
 *
 * A file named on a command line is still input. Checking only that
 * `entries` was an array let `{"entries":[null]}` through to the differ,
 * which reported `Cannot read properties of null (reading 'id')` -- a
 * JavaScript stack-trace message, from a tool whose whole argument is that
 * failures should say what happened and what to do about it. Every field the
 * differ reads is checked here, and anything missing is a `bad-bom` with the
 * usual guidance.
 */
async function readBom(path: string): Promise<ModelBom> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new AnalysisError('bad-bom', `${path} could not be read.`)
  }
  if (text.length > MAX_BOM_CHARS) {
    throw new AnalysisError(
      'bad-bom',
      `${path} is ${(text.length / 1_048_576).toFixed(1)} MB; the limit is ${MAX_BOM_CHARS / 1_048_576} MB.`,
    )
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (error) {
    throw new AnalysisError('bad-bom', `${path}: ${(error as Error).message}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AnalysisError('bad-bom', `${path}: expected an object at the top level.`)
  }
  const entries = (doc as Record<string, unknown>)['entries']
  if (!Array.isArray(entries)) {
    throw new AnalysisError('bad-bom', `${path}: no "entries" array.`)
  }
  entries.forEach((entry, at) => checkBomEntry(entry, `${path}: entries[${at}]`))
  return doc as ModelBom
}

/** The fields `diffBoms` reads, and nothing more. */
function checkBomEntry(entry: unknown, where: string): void {
  const need = (condition: boolean, what: string): void => {
    if (!condition) throw new AnalysisError('bad-bom', `${where} ${what}.`)
  }
  need(entry !== null && typeof entry === 'object' && !Array.isArray(entry), 'is not an object')
  const record = entry as Record<string, unknown>
  need(typeof record['id'] === 'string', 'has no string "id"')
  need(typeof record['locator'] === 'string', 'has no string "locator"')

  const format = record['format']
  need(format !== null && typeof format === 'object', 'has no "format" object')
  need(typeof (format as Record<string, unknown>)['id'] === 'string', 'has no "format.id"')

  const load = record['load']
  need(load !== null && typeof load === 'object', 'has no "load" object')
  const behaviour = (load as Record<string, unknown>)['behaviour']
  need(
    typeof behaviour === 'string' && (LOAD_BEHAVIOURS as readonly string[]).includes(behaviour),
    `has an unrecognised "load.behaviour" (expected one of ${LOAD_BEHAVIOURS.join(', ')})`,
  )

  const digest = record['digest']
  need(
    digest === null ||
      digest === undefined ||
      (typeof digest === 'object' && typeof (digest as Record<string, unknown>)['value'] === 'string'),
    'has a "digest" that is neither null nor a record with a string value',
  )
}

try {
  process.exitCode = await main()
} catch (error) {
  if (isAnalysisError(error)) {
    process.stderr.write(`\n  ${style.red(error.guidance.what)}\n`)
    process.stderr.write(`  ${style.dim(error.guidance.why)}\n`)
    process.stderr.write(`  ${error.guidance.fix}\n`)
    if (error.detail !== null) process.stderr.write(`  ${style.dim(error.detail)}\n`)
    process.stderr.write('\n')
  } else {
    // Through the same guidance contract as every other failure, which
    // sanitises the underlying message. Writing `error.message` straight to
    // the terminal put both host paths and analysed-repository bytes there.
    const guidance = unexpectedGuidance(error)
    process.stderr.write(`\n  ${style.red(guidance.what)}\n`)
    process.stderr.write(`  ${style.dim(guidance.why)}\n`)
    process.stderr.write(`  ${guidance.fix}\n`)
    if (guidance.detail !== undefined) process.stderr.write(`  ${style.dim(guidance.detail)}\n`)
    process.stderr.write('\n')
  }
  process.exitCode = 1
}
