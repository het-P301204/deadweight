/**
 * BOM diff, exports, declarations and notebooks.
 */

import { describe, expect, it } from 'vitest'

import { analyze } from './analyze.ts'
import { bomToCsv, buildBom } from './bom.ts'
import { toCycloneDx } from './cyclonedx.ts'
import { diffBoms } from './diff.ts'
import { readDeclarations, readFrontmatter, safeJson } from './manifests.ts'
import { readNotebook } from './notebook.ts'
import { memoryTree } from './source.ts'
import type { MemoryFile } from './source.ts'

function pickle(): Uint8Array {
  return new Uint8Array([0x80, 4, 0x63, 0x6f, 0x73, 0x0a, 0x73, 0x79, 0x73, 0x0a, 0x2e])
}

async function bomOf(files: MemoryFile[]) {
  return buildBom(await analyze(memoryTree('p', files)))
}

const BEFORE: MemoryFile[] = [
  { path: 'requirements.txt', text: 'torch==2.8.0\n' },
  { path: 'weights/m.pt', bytes: pickle() },
  { path: 'src/a.py', text: 'import torch\ntorch.load("weights/m.pt", weights_only=True)\n' },
]

describe('diffBoms', () => {
  it('reports no change for the same project analysed twice', async () => {
    const diff = diffBoms(await bomOf(BEFORE), await bomOf(BEFORE))
    expect(diff.identical).toBe(true)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.changed).toHaveLength(0)
  })

  it('reports an added and a removed artifact', async () => {
    const after = await bomOf([
      ...BEFORE,
      { path: 'weights/n.pt', bytes: pickle() },
      { path: 'src/b.py', text: 'import torch\ntorch.load("weights/n.pt", weights_only=True)\n' },
    ])
    const diff = diffBoms(await bomOf(BEFORE), after)
    expect(diff.added.map((e) => e.locator)).toEqual(['weights/n.pt'])

    const back = diffBoms(after, await bomOf(BEFORE))
    expect(back.removed.map((e) => e.locator)).toEqual(['weights/n.pt'])
  })

  it('reports a removed guard as an opened change, with the reason', async () => {
    const after = await bomOf([
      ...BEFORE.filter((f) => f.path !== 'src/a.py'),
      { path: 'src/a.py', text: 'import torch\ntorch.load("weights/m.pt", weights_only=False)\n' },
    ])
    const diff = diffBoms(await bomOf(BEFORE), after)
    const change = diff.changed[0]
    expect(change?.after.locator).toBe('weights/m.pt')
    const behaviour = change?.changes.find((c) => c.field === 'behaviour')
    expect(behaviour?.before).toBe('guarded')
    expect(behaviour?.after).toBe('code')
    expect(behaviour?.direction).toBe('opened')
  })

  it('reports a version pin moving as the behaviour change it causes', async () => {
    const after = await bomOf([
      ...BEFORE.filter((f) => f.path !== 'requirements.txt' && f.path !== 'src/a.py'),
      { path: 'requirements.txt', text: 'torch==2.5.1\n' },
      { path: 'src/a.py', text: 'import torch\ntorch.load("weights/m.pt")\n' },
    ])
    const diff = diffBoms(await bomOf(BEFORE), after)
    expect(diff.changed[0]?.changes.some((c) => c.direction === 'opened')).toBe(true)
  })

  it('reports a digest change and says what it does to the evidence', async () => {
    const after = await bomOf([
      ...BEFORE.filter((f) => f.path !== 'weights/m.pt'),
      { path: 'weights/m.pt', bytes: new Uint8Array([...pickle(), 0x00]) },
    ])
    const diff = diffBoms(await bomOf(BEFORE), after)
    const change = diff.changed[0]?.changes.find((c) => c.field === 'digest')
    expect(change?.note).toContain('evidence')
  })

  it('sorts an opened change above a lateral one', async () => {
    const before = await bomOf([
      ...BEFORE,
      { path: 'weights/n.pt', bytes: pickle() },
      { path: 'src/b.py', text: 'import torch\ntorch.load("weights/n.pt", weights_only=True)\n' },
    ])
    const after = await bomOf([
      { path: 'requirements.txt', text: 'torch==2.8.0\n' },
      { path: 'weights/m.pt', bytes: new Uint8Array([...pickle(), 0x00]) },
      { path: 'src/a.py', text: 'import torch\ntorch.load("weights/m.pt", weights_only=True)\n' },
      { path: 'weights/n.pt', bytes: pickle() },
      { path: 'src/b.py', text: 'import torch\ntorch.load("weights/n.pt", weights_only=False)\n' },
    ])
    const diff = diffBoms(before, after)
    expect(diff.changed[0]?.after.locator).toBe('weights/n.pt')
  })
})

describe('exports', () => {
  it('neutralises a leading formula character in a CSV cell', async () => {
    const bom = await bomOf([
      { path: 'requirements.txt', text: 'torch==2.8.0\n' },
      { path: 'weights/=cmd.pt', bytes: pickle() },
    ])
    // The locator does not begin with `=`; the artifact-name column does, and
    // that is the cell a spreadsheet would evaluate.
    expect(bomToCsv(bom)).toContain('"\'=cmd.pt"')
  })

  it('quotes and doubles embedded quotes', async () => {
    const bom = await bomOf([
      { path: 'requirements.txt', text: 'torch==2.8.0\n' },
      { path: 'weights/a"b.pt', bytes: pickle() },
    ])
    expect(bomToCsv(bom)).toContain('a""b.pt')
  })

  it('emits a CycloneDX document with the coverage note inside it', async () => {
    const cyclone = toCycloneDx(await bomOf(BEFORE))
    expect(cyclone.bomFormat).toBe('CycloneDX')
    expect(cyclone.specVersion).toBe('1.6')
    expect(
      cyclone.metadata.properties.find((p) => p.name === 'deadweight:coverage')?.value,
    ).toContain('never loads a model')
  })

  it('types a model as machine-learning-model and a skill as data', async () => {
    const cyclone = toCycloneDx(
      await bomOf([
        ...BEFORE,
        { path: '.claude/skills/x/SKILL.md', text: '---\nname: x\ndescription: d\n---\n' },
      ]),
    )
    const byName = new Map(cyclone.components.map((c) => [c.name, c.type]))
    expect(byName.get('m.pt')).toBe('machine-learning-model')
    expect(byName.get('x')).toBe('data')
  })

  it('carries the load behaviour as a namespaced property', async () => {
    const cyclone = toCycloneDx(await bomOf(BEFORE))
    const component = cyclone.components.find((c) => c.name === 'm.pt')
    expect(
      component?.properties.find((p) => p.name === 'deadweight:load.behaviour')?.value,
    ).toBe('guarded')
  })

  it('says evidence is absent rather than omitting the property', async () => {
    const cyclone = toCycloneDx(await bomOf(BEFORE))
    const component = cyclone.components.find((c) => c.name === 'm.pt')
    expect(component?.properties.find((p) => p.name === 'deadweight:evidence')?.value).toContain(
      'not a clean scan',
    )
  })

  it('emits no modelParameters it cannot fill', async () => {
    const cyclone = toCycloneDx(await bomOf(BEFORE))
    // The coverage note names the omitted structures in prose, so the check
    // is for the key rather than the word.
    expect(JSON.stringify(cyclone)).not.toContain('"quantitativeAnalysis"')
    expect(JSON.stringify(cyclone)).not.toContain('"modelParameters"')
  })
})

describe('readFrontmatter', () => {
  it('reads flat fields, inline lists and block lists', () => {
    const front = readFrontmatter(
      ['---', 'name: x', 'tools: [Bash, Read]', 'tags:', '  - a', '  - b', '---', 'Body.'].join(
        '\n',
      ),
    )
    expect(front?.fields['name']).toBe('x')
    expect(front?.lists['tools']).toEqual(['Bash', 'Read'])
    expect(front?.lists['tags']).toEqual(['a', 'b'])
    expect(front?.body.trim()).toBe('Body.')
  })

  it('returns null for a document with no frontmatter', () => {
    expect(readFrontmatter('# Just a heading\n')).toBeNull()
  })

  it('returns null for an unterminated block rather than reading the whole file', () => {
    expect(readFrontmatter('---\nname: x\nno closing fence\n')).toBeNull()
  })

  it('drops prototype-polluting keys', () => {
    const front = readFrontmatter('---\n__proto__: x\nname: y\n---\n')
    expect(front?.fields['name']).toBe('y')
    expect(Object.keys(front?.fields ?? {})).not.toContain('__proto__')
  })
})

describe('safeJson', () => {
  it('strips prototype-polluting keys at every level', () => {
    const parsed = safeJson('{"a":{"__proto__":{"x":1},"b":2}}') as Record<string, unknown>
    expect(JSON.stringify(parsed)).toBe('{"a":{"b":2}}')
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })

  it('returns null rather than throwing on invalid JSON', () => {
    expect(safeJson('{oops')).toBeNull()
  })
})

describe('readDeclarations', () => {
  it('notes the executables a skill body points at', async () => {
    const tree = memoryTree('p', [
      {
        path: '.claude/skills/x/SKILL.md',
        text: [
          '---',
          'name: x',
          'description: d',
          'allowed-tools: [Bash]',
          '---',
          '',
          'Run `scripts/collect.py` then ./tools/fix.sh.',
        ].join('\n'),
      },
    ])
    const declarations = await readDeclarations(tree, tree.entries)
    expect(declarations[0]?.behaviour).toBe('directive')
    expect(declarations[0]?.grants).toEqual(['Bash'])
    expect(
      declarations[0]?.facts.find((f) => f.label === 'Referenced executables')?.value,
    ).toContain('scripts/collect.py')
  })

  it('calls out a wildcard tool grant on an agent definition', async () => {
    const tree = memoryTree('p', [
      { path: 'agents/x.md', text: "---\nname: x\ndescription: d\ntools: ['*']\n---\n" },
    ])
    const declarations = await readDeclarations(tree, tree.entries)
    expect(declarations[0]?.steps.some((s) => s.claim.includes('every tool'))).toBe(true)
  })

  it('records the command an MCP entry spawns and the line it is on', async () => {
    const text = JSON.stringify(
      { mcpServers: { store: { command: 'npx', args: ['-y', 'pkg'] } } },
      null,
      2,
    )
    const tree = memoryTree('p', [{ path: '.mcp.json', text }])
    const declarations = await readDeclarations(tree, tree.entries)
    expect(declarations[0]?.behaviour).toBe('code')
    expect(declarations[0]?.facts.find((f) => f.label === 'Spawned command')?.value).toBe(
      'npx -y pkg',
    )
    expect(declarations[0]?.line).toBeGreaterThan(1)
  })

  it('records the environment an MCP entry passes through', async () => {
    const tree = memoryTree('p', [
      {
        path: '.mcp.json',
        text: JSON.stringify({ mcpServers: { s: { command: 'x', env: { TOKEN: 'v' } } } }),
      },
    ])
    const declarations = await readDeclarations(tree, tree.entries)
    expect(
      declarations[0]?.facts.find((f) => f.label === 'Environment passed through')?.value,
    ).toBe('TOKEN')
  })

  it('ignores a JSON file that declares no servers', async () => {
    const tree = memoryTree('p', [{ path: '.mcp.json', text: '{"other":1}' }])
    expect(await readDeclarations(tree, tree.entries)).toHaveLength(0)
  })
})

describe('readNotebook', () => {
  const notebook = (cells: unknown[]): string => JSON.stringify({ cells })

  it('concatenates code cells and maps lines back to their cell', () => {
    const parsed = readNotebook(
      notebook([
        { cell_type: 'markdown', source: ['# title'] },
        { cell_type: 'code', source: ['import torch\n'] },
        { cell_type: 'code', source: ['torch.load("m.pt")\n'] },
      ]),
    )
    expect(parsed?.cellCount).toBe(2)
    expect(parsed?.source).toContain('torch.load("m.pt")')
    expect(parsed?.cellOfLine[0]).toBe(1)
  })

  it('blanks magics and shell escapes so they cannot break bracket matching', () => {
    const parsed = readNotebook(
      notebook([{ cell_type: 'code', source: ['!pip install torch\n', 'x = 1\n'] }]),
    )
    expect(parsed?.source).not.toContain('pip install')
    expect(parsed?.source).toContain('x = 1')
  })

  it('returns null for JSON that is not a notebook', () => {
    expect(readNotebook('{"hello":1}')).toBeNull()
    expect(readNotebook('not json')).toBeNull()
  })

  it('returns null for a notebook with no code cells', () => {
    expect(readNotebook(notebook([{ cell_type: 'markdown', source: ['x'] }]))).toBeNull()
  })

  it('never reads cell outputs', () => {
    const parsed = readNotebook(
      notebook([
        {
          cell_type: 'code',
          source: ['x = 1\n'],
          outputs: [{ data: { 'image/png': 'BASE64PAYLOAD' } }],
        },
      ]),
    )
    expect(parsed?.source).not.toContain('BASE64PAYLOAD')
  })
})
