/**
 * Assert the claims the product makes, locally and in CI.
 *
 * These checks used to live only in the workflow file, which meant thirteen
 * of the fourteen could not be run before pushing: a change could pass lint,
 * typecheck, the suite and the build, and still fail on the runner. That
 * happened -- a grep for `JSON.parse` matched a *comment* about `JSON.parse`
 * -- and the first anyone knew about it was a failure email.
 *
 * So they live here, in Node rather than in shell, for two reasons. One, the
 * workflow now calls one step and `npm run verify` calls the same script, so
 * green locally means green on the runner. Two, shell greps cannot tell code
 * from prose, and this is a project whose comments discuss unpickling,
 * decompression and `document` constantly; reading the files properly and
 * skipping comment lines is both more accurate and easier to explain.
 *
 * Failures print a GitHub annotation and set a non-zero exit code. Every
 * check is run before exiting, because finding out about one problem per
 * push is how a green build takes five pushes.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
const CLI = join(ROOT, 'bin', 'deadweight.ts')
const DEMO = join(ROOT, 'fixtures', 'demo-project')

/** Run the CLI and return its exit code, stdout and stderr. Never throws. */
async function cli(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Source scanning                                                            */
/* -------------------------------------------------------------------------- */

interface SourceLine {
  readonly file: string
  readonly line: number
  readonly text: string
}

async function tsFiles(...directories: readonly string[]): Promise<string[]> {
  const out: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, item.name)
      if (item.isDirectory()) await walk(full)
      else if (/\.tsx?$/.test(item.name)) out.push(full)
    }
  }
  for (const directory of directories) {
    if (existsSync(directory)) await walk(directory)
  }
  return out
}

/**
 * Every line of code in the given directories, with comment lines dropped.
 *
 * The comment filter is the whole reason this is not a grep. `DecompressionStream`,
 * `unpickle` and `document` all appear in this project's prose because
 * explaining them is what the product does.
 */
async function codeLines(
  directories: readonly string[],
  options: { includeTests?: boolean } = {},
): Promise<SourceLine[]> {
  const out: SourceLine[] = []
  for (const file of await tsFiles(...directories)) {
    if (options.includeTests !== true && /\.test\.tsx?$/.test(file)) continue
    const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
    lines.forEach((text, index) => {
      const trimmed = text.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      out.push({ file: relative, line: index + 1, text })
    })
  }
  return out
}

function matching(lines: readonly SourceLine[], pattern: RegExp): SourceLine[] {
  return lines.filter((line) => pattern.test(line.text))
}

function describe(hits: readonly SourceLine[]): string {
  return hits.map((h) => `    ${h.file}:${h.line}: ${h.text.trim().slice(0, 110)}`).join('\n')
}

/* -------------------------------------------------------------------------- */
/* The checks                                                                 */
/* -------------------------------------------------------------------------- */

class Failed extends Error {}

function fail(message: string): never {
  throw new Failed(message)
}

const checks: ReadonlyArray<{ name: string; run: () => Promise<string> }> = [
  {
    name: 'The CLI runs with no build step and no dependencies',
    async run() {
      const commands: string[][] = [
        ['version'],
        ['artifacts', DEMO, '--quiet'],
        ['loadpaths', DEMO, '--quiet'],
        ['migrations', DEMO, '--quiet'],
        ['evidence', DEMO, '--quiet'],
        ['explain', DEMO, 'weights/ranker.bin', '--quiet'],
      ]
      for (const args of commands) {
        const result = await cli(args)
        if (result.code !== 0) {
          fail(`\`${args[0]}\` exited ${result.code}.\n${result.stderr.trim().slice(0, 400)}`)
        }
      }
      return 'The CLI ran from source.'
    },
  },

  {
    name: 'The exit codes are usable in a pipeline',
    async run() {
      // 0 clean, 2 findings at or above the threshold, 1 could not analyse.
      // A supply-chain check that cannot fail a build is one nobody runs.
      const findings = (await cli(['scan', DEMO, '--quiet'])).code
      const ignored = (await cli(['scan', DEMO, '--quiet', '--fail-on', 'none'])).code
      const missing = (await cli(['scan', join(ROOT, 'does-not-exist'), '--quiet'])).code
      if (findings !== 2) fail(`Expected exit 2 for a project with execution surfaces, got ${findings}.`)
      if (ignored !== 0) fail(`Expected exit 0 with --fail-on none, got ${ignored}.`)
      if (missing !== 1) fail(`Expected exit 1 for an unreadable path, got ${missing}.`)
      return 'Exit codes behave as documented.'
    },
  },

  {
    name: 'The analysis is reproducible, and a BOM diff of a project against itself is empty',
    async run() {
      // The BOM carries no timestamp precisely so that this holds, which is
      // what makes a diff between two BOMs a diff of the project.
      const scratch = await mkdtemp(join(tmpdir(), 'deadweight-'))
      const a = join(scratch, 'a.json')
      const b = join(scratch, 'b.json')
      await cli(['bom', DEMO, '--quiet', '--out', a])
      await cli(['bom', DEMO, '--quiet', '--out', b])

      const first = await readFile(a, 'utf8')
      const second = await readFile(b, 'utf8')
      if (first !== second) fail('A repeat run produced a different BOM; the analysis is not deterministic.')
      if (!first.includes('"schema":"deadweight.bom/1"')) fail('The BOM is missing its schema marker.')
      if (/[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(first)) {
        fail('The BOM contains a timestamp; a diff between two of them would report every entry as changed.')
      }

      const diff = await cli(['diff', a, b, '--quiet'])
      if (diff.code !== 0) {
        fail(`Diffing a BOM against an identical BOM reported a change (exit ${diff.code}).`)
      }
      return 'Two runs produced an identical BOM, with no timestamp, and diff to nothing.'
    },
  },

  {
    name: 'The engine never deserialises an artifact',
    async run() {
      // The product's central claim. Recognition reads bytes and matches
      // signatures; it never hands an artifact to a parser.
      const analysis = await codeLines([
        join(ROOT, 'src', 'engine'),
        join(ROOT, 'src', 'adapters'),
        join(ROOT, 'bin'),
      ])

      const libraries = matching(
        analysis,
        /from ['"](node:)?(zlib|v8)['"]|require\(['"](node:)?(zlib|v8)['"]\)|from ['"](pako|fflate|msgpackr|js-yaml|yaml|protobufjs|bson|cbor)['"]/,
      )
      if (libraries.length > 0) {
        fail(`A decompression or deserialisation library is reachable from the analysis.\n${describe(libraries)}`)
      }

      const evaluates = matching(
        analysis,
        /\b(DecompressionStream|CompressionStream)\b|\beval\s*\(|new Function\s*\(/,
      )
      if (evaluates.length > 0) {
        fail(`The analysis path decompresses or evaluates.\n${describe(evaluates)}`)
      }

      // `JSON.parse` is legitimate for the documents DEADWEIGHT reads on
      // purpose -- manifests, lockfiles, notebooks, evidence, its own
      // configuration -- and nowhere else, because an artifact is never parsed.
      const permitted = /(deps|manifests|config|notebook|containers)\.ts$/
      const engine = await codeLines([join(ROOT, 'src', 'engine')])
      const parses = matching(engine, /\bJSON\.parse\b/).filter((h) => !permitted.test(h.file))
      if (parses.length > 0) {
        fail(`A JSON.parse call appears outside the readers permitted to parse a document.\n${describe(parses)}`)
      }

      // The runtime dependency list is the other half of the same claim.
      const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      const allowed = /^(@fontsource|@fontsource-variable|react|react-dom)/
      const extra = Object.keys(manifest.dependencies ?? {}).filter((d) => !allowed.test(d))
      if (extra.length > 0) fail(`Unexpected runtime dependencies: ${extra.join(', ')}`)

      return 'No deserialising call, and runtime dependencies are React and fonts only.'
    },
  },

  {
    name: 'The engine reads no clock and no randomness',
    async run() {
      // Two analyses of the same tree must produce the same digest.
      const hits = matching(
        await codeLines([join(ROOT, 'src', 'engine'), join(ROOT, 'bin')]),
        /Date\.now\(|new Date\(|Math\.random\(|crypto\.randomUUID/,
      )
      if (hits.length > 0) {
        fail(`Engine or CLI reads the clock or a random source.\n${describe(hits)}`)
      }
      return 'No clock or randomness outside the tests.'
    },
  },

  {
    name: 'The engine does not reach into the browser',
    async run() {
      // The engine is shared with the CLI, where there is no document. The
      // trailing character class requires a real member access, because the
      // words "document" and "window" appear throughout the prose here.
      const hits = matching(
        await codeLines([join(ROOT, 'src', 'engine')]),
        /\b(document|window|localStorage|navigator|atob|btoa)\.[A-Za-z_]/,
      )
      if (hits.length > 0) {
        fail(`Engine source references a browser global; it has to run under Node too.\n${describe(hits)}`)
      }
      return 'Engine is free of browser globals.'
    },
  },

  {
    name: 'Nothing about an analysed project can leave the page',
    async run() {
      const assets = join(ROOT, 'dist', 'assets')
      if (!existsSync(assets)) fail('dist/ is missing. Run `npm run build` before this check.')

      // RTCPeerConnection is on this list for a reason worth stating: it is
      // the one channel `connect-src 'none'` does not govern, because no CSP
      // directive covers WebRTC.
      const network =
        /fetch\(|XMLHttpRequest|navigator\.sendBeacon|new WebSocket|EventSource|RTCPeerConnection|WebTransport|importScripts|new Worker|SharedWorker/
      for (const name of await readdir(assets)) {
        const body = await readFile(join(assets, name), 'utf8')
        if (name.endsWith('.js') && network.test(body)) {
          fail(`dist/assets/${name} references a network or worker API. Nothing may leave the tab.`)
        }
        if (name.endsWith('.css') && /https?:\/\/[^"')]*\.(woff2?|ttf|otf|css)/.test(body)) {
          fail(`dist/assets/${name} references a remote font, which is a request to a third party on every load.`)
        }
      }

      const page = await readFile(join(ROOT, 'dist', 'index.html'), 'utf8')
      if (!page.includes("connect-src 'none'")) fail("The built page is missing connect-src 'none'.")
      return 'No network APIs, no remote fonts, and the policy is in the page.'
    },
  },

  {
    name: 'The error pages stand on their own',
    async run() {
      // Each is served by the host without the bundle, so a reference to a
      // stylesheet, a script or a remote font would leave the page unstyled
      // or, worse, make a request from a page that exists to report a failure.
      for (const status of ['403', '404', '500']) {
        const source = await readFile(join(ROOT, 'public', `${status}.html`), 'utf8')
        const offending = source
          .split(/\r?\n/)
          .map((text, index) => ({ text, line: index + 1 }))
          .filter((l) => /<script|<link|https?:\/\/[^"')]*\.(css|js|woff2?|ttf)/.test(l.text))
        if (offending.length > 0) {
          fail(
            `public/${status}.html references an external resource; it has to render with no bundle and no network.\n` +
              offending.map((l) => `    line ${l.line}: ${l.text.trim().slice(0, 100)}`).join('\n'),
          )
        }
        if (!existsSync(join(ROOT, 'dist', `${status}.html`))) {
          fail(`public/${status}.html was not copied into dist/.`)
        }
      }
      return 'Error pages are self-contained and published.'
    },
  },

  {
    name: 'The demo project is a file list, not a results fixture',
    async run() {
      // The browser's demo mode must run the real engine over the real
      // fixtures. A fixture of *results* would make the demo a screenshot, so
      // the generated module is checked for shape rather than for words.
      const module_ = (await import(
        new URL('../src/demo-tree.generated.ts', import.meta.url).href
      )) as { DEMO_FILES: ReadonlyArray<Record<string, unknown>> }
      const exported = Object.keys(module_).sort().join(',')
      if (exported !== 'DEMO_FILES,DEMO_PROJECT_NAME') {
        fail(`The demo tree exports more than a file list: ${exported}`)
      }
      for (const file of module_.DEMO_FILES) {
        const keys = Object.keys(file).sort().join(',')
        if (keys !== 'path,text' && keys !== 'base64,path') {
          fail(`A demo entry has unexpected keys: ${keys}`)
        }
      }
      return `The demo tree is ${module_.DEMO_FILES.length} files and nothing else.`
    },
  },

  {
    name: 'Every loader rule points at a documented section',
    async run() {
      const { LOADER_RULES } = (await import(
        new URL('../src/engine/loaders.ts', import.meta.url).href
      )) as { LOADER_RULES: ReadonlyArray<{ spec: { id: string; reference: string } }> }
      const { allFormats } = (await import(
        new URL('../src/engine/formats.ts', import.meta.url).href
      )) as { allFormats: () => ReadonlyArray<{ id: string; mechanism: string; shape: string }> }

      const docs = await readFile(join(ROOT, 'docs', 'load-semantics.md'), 'utf8')
      const missing = [...new Set(LOADER_RULES.map((r) => r.spec.reference))]
        .sort()
        .filter((anchor) => !docs.includes(`{#${anchor}}`))
      if (missing.length > 0) {
        fail(`docs/load-semantics.md has no section for: ${missing.join(', ')}`)
      }

      // Every format's mechanism sentence is shown verbatim in the UI, so an
      // empty one would put a blank where an explanation goes.
      const thin = allFormats().filter((s) => s.mechanism.length < 40 || s.shape.length < 4)
      if (thin.length > 0) {
        fail(`Formats with no usable mechanism or shape: ${thin.map((s) => s.id).join(', ')}`)
      }
      return `${LOADER_RULES.length} loader rules and ${allFormats().length} formats documented.`
    },
  },

  {
    name: 'A hostile repository cannot hang the analyser',
    async run() {
      // A 2 MB single line used to take about three quarters of an hour,
      // because the expression that found calls backtracked quadratically.
      // The budget is roughly a hundred times the measured cost, so only a
      // return of superlinear behaviour fails here.
      const BUDGET_MS = 90_000
      const scratch = await mkdtemp(join(tmpdir(), 'deadweight-hostile-'))
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(scratch, 'src'), { recursive: true })
      await writeFile(join(scratch, 'src', 'bundle.js'), `x = ${'a'.repeat(2_000_000)}`)
      await writeFile(join(scratch, 'requirements.txt'), 'torch>=2.0\n')
      for (let i = 0; i < 4000; i += 1) {
        await writeFile(
          join(scratch, 'src', `m${i}.py`),
          'import torch\ntorch.load("nowhere.pt")\n',
        )
      }

      const started = Date.now()
      const result = await cli(['scan', scratch, '--quiet', '--fail-on', 'none'])
      const elapsed = Date.now() - started
      if (result.code !== 0) fail(`Analysing a hostile tree exited ${result.code}.`)
      if (elapsed > BUDGET_MS) {
        fail(`A hostile tree took ${(elapsed / 1000).toFixed(0)}s. Something is superlinear again.`)
      }
      return `Analysed a hostile tree in ${(elapsed / 1000).toFixed(1)}s.`
    },
  },

  {
    name: 'A malformed BOM gets guidance, not a stack trace',
    async run() {
      // `diff` reads a file named on a command line, which is still input.
      // The contract is the four-part error, not a TypeError message.
      const scratch = await mkdtemp(join(tmpdir(), 'deadweight-bom-'))
      const broken = join(scratch, 'broken.json')
      const good = join(scratch, 'good.json')
      await writeFile(broken, '{"entries":[null]}')
      await cli(['bom', DEMO, '--quiet', '--out', good])

      const result = await cli(['diff', broken, good])
      const output = `${result.stdout}${result.stderr}`
      if (result.code !== 1) fail(`A malformed BOM should exit 1, got ${result.code}.`)
      if (output.includes('stopped on an unexpected error')) {
        fail(`A malformed BOM produced an unhandled error instead of guidance.\n${output.trim().slice(0, 300)}`)
      }
      if (!output.includes('could not be read')) {
        fail(`Expected the bad-bom guidance, got:\n${output.trim().slice(0, 300)}`)
      }
      return 'A malformed BOM was refused with guidance.'
    },
  },
]

/* -------------------------------------------------------------------------- */

let failures = 0
for (const check of checks) {
  try {
    const detail = await check.run()
    console.log(`  ok    ${check.name}\n          ${detail}`)
  } catch (error) {
    failures += 1
    const message = error instanceof Failed ? error.message : `Unexpected: ${String(error)}`
    console.error(`::error::${check.name}: ${message.split('\n')[0] as string}`)
    console.error(`  FAIL  ${check.name}\n${message.replace(/^/gm, '          ')}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks.length} claims failed.`)
  process.exit(1)
}
console.log(`\nAll ${checks.length} claims hold.`)
