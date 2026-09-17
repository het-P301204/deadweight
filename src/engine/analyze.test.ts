/**
 * End-to-end analysis.
 *
 * Everything here runs on in-memory trees through the same `analyze` the CLI
 * and the browser call. The two most important assertions in the file are
 * negative: evidence never changes a behaviour, and an unresolved stage stays
 * unresolved.
 */

import { describe, expect, it } from 'vitest'

import { analyze } from './analyze.ts'
import { buildBom } from './bom.ts'
import { AnalysisError } from './errors.ts'
import { memoryTree } from './source.ts'
import type { MemoryFile } from './source.ts'
import type { Report } from './types.ts'

const REQUIREMENTS = 'torch==2.5.1\ntransformers==4.44.2\nsafetensors==0.4.5\nnumpy==2.1.1\n'

function tree(files: MemoryFile[]) {
  return memoryTree('project', files)
}

async function run(files: MemoryFile[]): Promise<Report> {
  return analyze(tree(files))
}

function pickle(): Uint8Array {
  const encoder = new TextEncoder()
  const body = encoder.encode('os\nsystem\n')
  const out = new Uint8Array(4 + body.length)
  out.set([0x80, 4, 0x63], 0)
  out.set(body, 3)
  out[3 + body.length] = 0x2e
  return out
}

function safetensors(): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({ 'w.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] } }),
  )
  const out = new Uint8Array(8 + json.length + 16)
  let n = json.length
  for (let i = 0; i < 8; i += 1) {
    out[i] = n & 0xff
    n = Math.floor(n / 256)
  }
  out.set(json, 8)
  return out
}

const BASE: MemoryFile[] = [
  { path: 'requirements.txt', text: REQUIREMENTS },
  { path: 'weights/m.pkl', bytes: pickle() },
  {
    path: 'src/serving/api.py',
    text: [
      'import os',
      'import pickle',
      'import boto3',
      'from fastapi import FastAPI',
      '',
      'app = FastAPI()',
      's3 = boto3.client("s3")',
      'TOKEN = os.environ["APP_API_TOKEN"]',
      '',
      'def load():',
      '    with open("weights/m.pkl", "rb") as h:',
      '        return pickle.load(h)',
    ].join('\n'),
  },
]

/* -------------------------------------------------------------------------- */

describe('analyze', () => {
  it('discovers the artifact, its load site, its context and its privileges', async () => {
    const report = await run(BASE)
    const record = report.records.find((r) => r.artifact.locator === 'weights/m.pkl')
    expect(record).toBeDefined()
    expect(record?.behaviour.behaviour).toBe('code')
    expect(record?.loadSites[0]?.file).toBe('src/serving/api.py')
    expect(record?.loadSites[0]?.line).toBe(12)
    expect(record?.contexts[0]?.environment).toBe('service')
    expect(record?.contexts[0]?.privileged).toBe(true)
  })

  it('uses the name the project declares, not the directory name', async () => {
    const report = await run([
      ...BASE,
      { path: 'pyproject.toml', text: '[project]\nname = "atlas-triage"\nversion = "1.0"\n' },
    ])
    expect(report.project).toBe('atlas-triage')
  })

  it('takes a name from package.json when there is no pyproject', async () => {
    const report = await run([...BASE, { path: 'package.json', text: '{"name":"atlas-web"}' }])
    expect(report.project).toBe('atlas-web')
  })

  it('falls back to the directory name when nothing declares one', async () => {
    expect((await run(BASE)).project).toBe('project')
  })

  it('does not take a name from a tool table that happens to have one', async () => {
    // `[tool.ruff]` and `[tool.poetry]` both have `name` keys and neither is
    // the project's name.
    const report = await run([
      ...BASE,
      { path: 'pyproject.toml', text: '[tool.ruff]\nname = "not-the-project"\n' },
    ])
    expect(report.project).toBe('project')
  })

  it('computes a digest over the artifact', async () => {
    const report = await run(BASE)
    const digest = report.records[0]?.artifact.digest
    expect(digest?.coverage).toBe('full')
    expect(digest?.value).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports the same digest for two runs of the same tree', async () => {
    const a = await run(BASE)
    const b = await run(BASE)
    expect(a.digest).toBe(b.digest)
  })

  it('reports a different digest when a dependency pin moves', async () => {
    const a = await run(BASE)
    const b = await run([
      ...BASE.filter((f) => f.path !== 'requirements.txt'),
      { path: 'requirements.txt', text: REQUIREMENTS.replace('2.5.1', '2.7.0') },
    ])
    expect(a.digest).not.toBe(b.digest)
  })

  it('reports every stage in order, each with a real count', async () => {
    const seen: string[] = []
    await analyze(tree(BASE), {
      onProgress: (event) => {
        if (event.status === 'done') seen.push(event.stage)
        expect(event.detail.length).toBeGreaterThan(0)
      },
    })
    expect(seen).toEqual([
      'walk',
      'dependencies',
      'load-sites',
      'artifacts',
      'behaviour',
      'context',
      'evidence',
      'bom',
    ])
  })

  it('includes an artifact nothing loads, with the load stage unresolved', async () => {
    const report = await run([...BASE, { path: 'weights/orphan.safetensors', bytes: safetensors() }])
    const record = report.records.find((r) => r.artifact.locator === 'weights/orphan.safetensors')
    expect(record).toBeDefined()
    expect(record?.loadSites).toHaveLength(0)
    expect(record?.stripe.find((c) => c.stage === 'load')?.state).toBe('unresolved')
  })

  it('reports a load site whose target is not static as an orphan', async () => {
    const report = await run([
      { path: 'requirements.txt', text: REQUIREMENTS },
      {
        path: 'src/loader.py',
        text: 'import torch\n\ndef load(name):\n    return torch.load(f"models/{name}.pt")\n',
      },
    ])
    expect(report.orphanLoadSites).toHaveLength(1)
    expect(report.orphanLoadSites[0]?.behaviour.unknownReason).toBe('path-not-static')
  })

  it('takes the most exposed of several load sites as the headline', async () => {
    const report = await run([
      { path: 'requirements.txt', text: 'torch==2.8.0\n' },
      { path: 'weights/m.pt', bytes: pickle() },
      {
        path: 'src/a.py',
        text: 'import torch\ntorch.load("weights/m.pt", weights_only=True)\n',
      },
      {
        path: 'src/b.py',
        text: 'import torch\ntorch.load("weights/m.pt", weights_only=False)\n',
      },
    ])
    const record = report.records.find((r) => r.artifact.locator === 'weights/m.pt')
    expect(record?.behaviour.behaviour).toBe('code')
    expect(record?.loadSites.map((s) => s.behaviour.behaviour).sort()).toEqual(['code', 'guarded'])
    expect(record?.findings.some((f) => f.kind === 'inconsistent-guard')).toBe(true)
  })

  it('finds a safetensors sibling and calls loading the other one out', async () => {
    const report = await run([
      { path: 'requirements.txt', text: 'torch==2.5.1\n' },
      { path: 'weights/m.bin', bytes: pickle() },
      { path: 'weights/m.safetensors', bytes: safetensors() },
      { path: 'src/a.py', text: 'import torch\ntorch.load("weights/m.bin")\n' },
    ])
    const record = report.records.find((r) => r.artifact.locator === 'weights/m.bin')
    expect(record?.alternative.kind).toBe('sibling-present')
    expect(record?.findings.some((f) => f.kind === 'shadowed-safe-format')).toBe(true)
  })

  it('discovers declared artifacts: a spawning MCP server and a skill', async () => {
    const report = await run([
      ...BASE,
      {
        path: '.mcp.json',
        text: JSON.stringify({
          mcpServers: {
            local: { command: 'npx', args: ['-y', 'some-server'] },
            remote: { type: 'http', url: 'https://example.invalid/mcp' },
          },
        }),
      },
      {
        path: '.claude/skills/triage/SKILL.md',
        text: '---\nname: triage\ndescription: d\nallowed-tools: [Bash]\n---\n\nBody.\n',
      },
    ])
    const byId = new Map(report.records.map((r) => [r.artifact.id, r]))
    expect(byId.get('mcp:local')?.behaviour.behaviour).toBe('code')
    expect(byId.get('mcp:remote')?.behaviour.behaviour).toBe('directive')
    expect(byId.get('skill:triage')?.behaviour.behaviour).toBe('directive')
    expect(byId.get('skill:triage')?.artifact.version).toBeNull()
  })

  it('records a hook command as executing when the settings file is read', async () => {
    const report = await run([
      ...BASE,
      {
        path: '.claude/settings.json',
        text: JSON.stringify({
          hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: './fmt.sh' }] }] },
        }),
      },
    ])
    const hook = report.records.find((r) => r.artifact.id.startsWith('hook:'))
    expect(hook?.behaviour.behaviour).toBe('code')
  })

  /* ---- the discipline ------------------------------------------------- */

  it('does not let a clean scanner result change a load behaviour', async () => {
    const withoutEvidence = await run(BASE)
    const before = withoutEvidence.records.find((r) => r.artifact.locator === 'weights/m.pkl')
    const digest = before?.artifact.digest?.value as string

    const withEvidence = await run([
      ...BASE,
      {
        path: 'security/deadweight-evidence.json',
        text: JSON.stringify({
          schema: 'deadweight.evidence/1',
          records: [
            {
              scanner: 'modelscan',
              version: '0.8.4',
              subject: 'weights/m.pkl',
              sha256: digest,
              result: 'pass',
              detail: 'clean',
            },
          ],
        }),
      },
    ])
    const after = withEvidence.records.find((r) => r.artifact.locator === 'weights/m.pkl')
    expect(after?.evidence[0]?.binding).toBe('current')
    expect(after?.evidence[0]?.result).toBe('pass')
    expect(after?.behaviour.behaviour).toBe('code')
    expect(after?.behaviour.behaviour).toBe(before?.behaviour.behaviour)
  })

  it('records an absent scan as a gap in the inventory, not as a pass', async () => {
    const report = await run(BASE)
    const record = report.records.find((r) => r.artifact.locator === 'weights/m.pkl')
    expect(record?.findings.some((f) => f.kind === 'evidence-absent')).toBe(true)
    expect(record?.stripe.find((c) => c.stage === 'evidence')?.state).toBe('unresolved')
  })

  it('gives every finding a rationale', async () => {
    const report = await run(BASE)
    expect(report.findings.length).toBeGreaterThan(0)
    for (const finding of report.findings) {
      expect(finding.rationale.length).toBeGreaterThan(20)
      expect(finding.locations.length).toBeGreaterThan(0)
    }
  })

  it('gives every unknown behaviour a reason', async () => {
    const report = await run([
      { path: 'requirements.txt', text: 'torch>=2.0\n' },
      { path: 'weights/m.pt', bytes: pickle() },
      { path: 'src/a.py', text: 'import torch\ntorch.load("weights/m.pt")\n' },
    ])
    for (const record of report.records) {
      if (record.behaviour.behaviour === 'unknown') {
        expect(record.behaviour.unknownReason).not.toBeNull()
      }
    }
  })

  it('builds a six-cell stripe for every record', async () => {
    const report = await run(BASE)
    for (const record of report.records) {
      expect(record.stripe).toHaveLength(6)
      expect(record.stripe.map((c) => c.stage)).toEqual([
        'format',
        'load',
        'exec',
        'context',
        'evidence',
        'alternative',
      ])
      for (const cell of record.stripe) expect(cell.detail.length).toBeGreaterThan(0)
    }
  })

  it('counts behaviours into the summary and crosses them with environments', async () => {
    const report = await run(BASE)
    expect(report.summary.behaviour.code).toBeGreaterThan(0)
    expect(report.summary.matrix['code|service']).toBe(1)
    expect(report.summary.privilegedLoads).toBe(1)
  })

  /* ---- failure modes --------------------------------------------------- */

  it('refuses an empty tree with guidance rather than an empty report', async () => {
    await expect(analyze(memoryTree('p', []))).rejects.toThrow(AnalysisError)
  })

  it('propagates a bad configuration rather than silently ignoring it', async () => {
    await expect(
      run([...BASE, { path: 'deadweight.yaml', text: 'environments:\n  prod:\n    - src/**\n' }]),
    ).rejects.toThrow(/not an environment/)
  })

  it('records a notice for a source file over the size limit', async () => {
    const report = await analyze(
      memoryTree('p', [
        { path: 'requirements.txt', text: REQUIREMENTS },
        { path: 'src/huge.py', text: `x = 1\n${'# pad\n'.repeat(400_000)}` },
      ]),
    )
    expect(report.notices.some((n) => n.code === 'source-too-large')).toBe(true)
  })

  it('records a notice for a notebook that is not valid JSON', async () => {
    const report = await run([...BASE, { path: 'notebooks/x.ipynb', text: '{not json' }])
    expect(report.notices.some((n) => n.code === 'notebook-unparsed')).toBe(true)
  })

  it('skips and reports a symlink rather than following it', async () => {
    const base = memoryTree('p', BASE)
    const withLink = {
      ...base,
      entries: [...base.entries, { path: 'link-to-root', size: 0, link: true }],
    }
    const report = await analyze(withLink)
    expect(report.notices.some((n) => n.code === 'symlink-skipped')).toBe(true)
  })

  it('honours an ignore glob from the configuration', async () => {
    const report = await run([
      ...BASE,
      { path: 'deadweight.yaml', text: 'ignore:\n  - vendor/**\n' },
      { path: 'vendor/thing.py', text: 'import pickle\npickle.load(open("v.pkl","rb"))\n' },
    ])
    expect(report.records.some((r) => r.artifact.locator.startsWith('vendor/'))).toBe(false)
    expect(report.orphanLoadSites.some((s) => s.file.startsWith('vendor/'))).toBe(false)
  })
})

describe('malformed and hostile input', () => {
  const hostile: MemoryFile[] = [
    { path: 'requirements.txt', text: REQUIREMENTS },
    // Truncated pickle.
    { path: 'weights/truncated.pkl', bytes: new Uint8Array([0x80, 4, 0x63, 0x6f, 0x73]) },
    // Zip magic with no central directory.
    { path: 'weights/broken.pt', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) },
    // A safetensors header claiming an enormous length.
    {
      path: 'weights/liar.safetensors',
      bytes: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x7b]),
    },
    // Empty file with a model extension.
    { path: 'weights/empty.pt', bytes: new Uint8Array(0) },
    // Source with unbalanced brackets.
    { path: 'src/bad.py', text: 'import torch\ntorch.load("x.pt"\n' },
    // Source that is one enormous line.
    { path: 'src/minified.js', text: `const x=${'1+'.repeat(3000)}1` },
    // Evidence document with a prototype-polluting key.
    {
      path: 'security/x.evidence.json',
      text: '{"__proto__":{"polluted":true},"records":[{"subject":"weights/empty.pt","result":"pass"}]}',
    },
    // A filename with an ANSI escape in it.
    { path: 'weights/we[31mird.pkl', bytes: new Uint8Array([0x80, 4, 0x2e]) },
  ]

  it('analyses a tree of malformed artifacts without throwing', async () => {
    await expect(analyze(memoryTree('hostile', hostile))).resolves.toBeDefined()
  })

  it('does not let a prototype-polluting evidence document pollute anything', async () => {
    await analyze(memoryTree('hostile', hostile))
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('strips control characters out of a filename before it reaches a report', async () => {
    const report = await analyze(memoryTree('hostile', hostile))
    const serialised = JSON.stringify(report)
    expect(serialised).not.toContain('')
  })

  it('reports the empty and truncated artifacts rather than dropping them', async () => {
    const report = await analyze(memoryTree('hostile', hostile))
    const locators = report.records.map((r) => r.artifact.locator)
    expect(locators).toContain('weights/empty.pt')
    expect(locators).toContain('weights/truncated.pkl')
  })

  it('never emits a record with no stripe, no behaviour or no mechanism', async () => {
    const report = await analyze(memoryTree('hostile', hostile))
    for (const record of report.records) {
      expect(record.stripe).toHaveLength(6)
      expect(record.behaviour.mechanism.length).toBeGreaterThan(0)
      expect(record.alternative.summary.length).toBeGreaterThan(0)
    }
  })
})

describe('buildBom', () => {
  it('produces an identical document for two runs of the same tree', async () => {
    const a = buildBom(await run(BASE))
    const b = buildBom(await run(BASE))
    expect(a.digest).toBe(b.digest)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('emits no timestamp, so a diff shows project change and not run change', async () => {
    const bom = buildBom(await run(BASE))
    const serialised = JSON.stringify(bom)
    expect(serialised).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(serialised).not.toContain('timestamp')
  })

  it('carries the unresolved reason into the BOM rather than omitting it', async () => {
    const report = await run([
      { path: 'requirements.txt', text: 'torch>=2.0\n' },
      { path: 'weights/m.pt', bytes: pickle() },
      { path: 'src/a.py', text: 'import torch\ntorch.load("weights/m.pt")\n' },
    ])
    const entry = buildBom(report).entries.find((e) => e.locator === 'weights/m.pt')
    expect(entry?.load.behaviour).toBe('unknown')
    expect(entry?.load.unresolvedReason).toBe('loader-default-unpinned')
  })
})
