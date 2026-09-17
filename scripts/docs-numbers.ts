/**
 * Keep the figures in the documentation honest.
 *
 * Every number about the demo project that appears in README.md or the docs
 * is written here once, computed by running the analyser, and checked into
 * the prose as a `<!-- dw:key -->` marker. `--check` recomputes them and
 * fails if the prose has drifted, which CI runs.
 *
 * The reason is a lesson learned the hard way on an earlier project: a figure
 * typed into a README by hand goes stale the first time the analysis changes,
 * and one stale figure makes every other claim in the document suspect.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { walkDirectory } from '../src/adapters/node-tree.ts'
import { analyze } from '../src/engine/analyze.ts'
import { buildBom } from '../src/engine/bom.ts'
import { ENVIRONMENT_META, ENVIRONMENT_ORDER } from '../src/engine/context.ts'
import { allFormats } from '../src/engine/formats.ts'
import { LOADER_RULES } from '../src/engine/loaders.ts'
import { BEHAVIOUR_LABEL } from '../src/engine/stripe.ts'
import { matrixKey } from '../src/engine/summary.ts'
import { LOAD_BEHAVIOURS } from '../src/engine/types.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DEMO = join(ROOT, 'fixtures', 'demo-project')
const DOCUMENTS = ['README.md', 'CHANGELOG.md', 'docs/methodology.md', 'docs/schema-format.md']

// The project name now comes from the analysis itself, which reads it from
// the demo project's pyproject.toml.
const { tree } = await walkDirectory(DEMO)
const report = await analyze(tree)
const bom = buildBom(report)

const figures: Record<string, string> = {
  artifacts: String(report.summary.artifacts),
  code: String(report.summary.behaviour.code),
  directive: String(report.summary.behaviour.directive),
  guarded: String(report.summary.behaviour.guarded),
  data: String(report.summary.behaviour.data),
  unknown: String(report.summary.behaviour.unknown),
  privileged: String(report.summary.privilegedLoads),
  migrations: String(report.summary.migrationsAvailable),
  loadsites: String(report.summary.loadSites),
  orphans: String(report.summary.unresolvedLoadSites),
  evidence: String(report.summary.evidenceRecords),
  stale: String(report.summary.staleEvidence),
  findings: String(report.findings.length),
  act: String(report.findings.filter((f) => f.disposition === 'act').length),
  review: String(report.findings.filter((f) => f.disposition === 'review').length),
  files: String(report.counts.filesWalked),
  read: String(report.counts.filesRead),
  deps: String(report.dependencies.length),
  pinned: String(report.dependencies.filter((d) => d.pin === 'exact').length),
  formats: String(Object.keys(report.summary.formats).length),
  environments: String(Object.values(report.summary.environments).filter((n) => n > 0).length),
  bomentries: String(bom.entries.length),
  tests: await countTests(),
  loaders: String(LOADER_RULES.length),
  formatcount: String(allFormats().length),
  ...(await ciSteps()),

  // Two multi-line blocks. The marker regex allows newlines, so a whole code
  // block can be generated -- which matters more than the single figures: a
  // stale example of the tool's own output is the most embarrassing kind.
  matrix: renderMatrix(),
  stages: await renderStages(),
}

/**
 * How many CI steps there are, and how many of them assert a product claim.
 *
 * The README says CI checks the claims rather than only building. That is a
 * claim about CI, so it is counted from the workflow rather than typed: the
 * assertion steps are the ones whose name begins with "Assert", which is the
 * convention the file already follows.
 */
async function ciSteps(): Promise<{ cisteps: string; ciasserts: string }> {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const names = [...workflow.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => (m[1] as string).trim())
  const uses = [...workflow.matchAll(/^ {6}- uses: /gm)].length
  return {
    cisteps: String(names.length + uses),
    ciasserts: String(names.filter((name) => name.startsWith('Assert')).length),
  }
}

/** The behaviour x context table, exactly as the product computes it. */
function renderMatrix(): string {
  const environments = ENVIRONMENT_ORDER.filter((id) => (report.summary.environments[id] ?? 0) > 0)
  const behaviours = LOAD_BEHAVIOURS.filter((b) => report.summary.behaviour[b] > 0)
  const label = (b: (typeof behaviours)[number]): string => BEHAVIOUR_LABEL[b]
  const width = Math.max(...behaviours.map((b) => label(b).length))

  const header = `${' '.repeat(width)}  ${environments
    .map((id) => ENVIRONMENT_META[id].short.padStart(6))
    .join('')}`
  const rows = behaviours.map((behaviour) => {
    const cells = environments
      .map((environment) => {
        const count = report.summary.matrix[matrixKey(behaviour, environment)] ?? 0
        return (count === 0 ? '·' : String(count)).padStart(6)
      })
      .join('')
    return `${label(behaviour).padEnd(width)}  ${cells}`
  })
  return `\n${[header, ...rows].join('\n')}\n`
}

/** The eight stage lines the CLI prints, from a real run. */
async function renderStages(): Promise<string> {
  const lines: string[] = []
  await analyze(tree, {
    onProgress: (event) => {
      if (event.status === 'done') lines.push(`  ${event.stage.padEnd(13)} ${event.detail}`)
    },
  })
  return `\n$ node bin/deadweight.ts scan fixtures/demo-project\n\n${lines.join('\n')}\n`
}

/**
 * Size of the suite, taken from the runner rather than from the source.
 *
 * Counting `it(` in the source undercounts: the design-token tests are
 * generated in a loop over both themes, so eight declarations produce sixteen
 * cases. Asking vitest is slower and is the only way to get a number that
 * matches what the suite actually reports.
 */
async function countTests(): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const output = join(ROOT, 'node_modules', '.tmp', 'dw-test-count.json')

  try {
    // The vitest entry point directly rather than through `npx`: a `.cmd`
    // shim needs a shell on Windows, and spawning one to read a number is
    // both slower and a way to inherit surprises.
    await run(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--reporter=json',
        `--outputFile=${output}`,
      ],
      { cwd: ROOT, windowsHide: true },
    )
    const report = JSON.parse(await readFile(output, 'utf8')) as { numTotalTests?: number }
    if (typeof report.numTotalTests === 'number') return String(report.numTotalTests)
  } catch (error) {
    console.error(
      `::error::Could not read the suite size from vitest: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
  console.error('::error::vitest reported no test total.')
  process.exit(1)
}

const MARKER = /<!-- dw:([a-z]+) -->[^<]*<!-- \/dw -->/g

const check = process.argv.includes('--check')
let failures = 0
let replaced = 0

for (const relative of DOCUMENTS) {
  const path = join(ROOT, relative)
  let body: string
  try {
    body = await readFile(path, 'utf8')
  } catch {
    continue
  }

  const updated = body.replace(MARKER, (whole, key: string) => {
    const value = figures[key]
    if (value === undefined) {
      console.error(`::error::${relative}: unknown figure "${key}".`)
      failures += 1
      return whole
    }
    replaced += 1
    return `<!-- dw:${key} -->${value}<!-- /dw -->`
  })

  if (check) {
    if (updated !== body) {
      console.error(
        `::error::${relative} contains a figure that does not match the analysis. Run \`npm run docs-numbers\`.`,
      )
      failures += 1
    }
    continue
  }
  if (updated !== body) await writeFile(path, updated, 'utf8')
}

if (failures > 0) process.exit(1)
console.log(
  check
    ? `All ${replaced} documented figures match the analysis.`
    : `Refreshed ${replaced} documented figures.`,
)
