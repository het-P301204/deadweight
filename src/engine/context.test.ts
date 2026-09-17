/**
 * Load context, and the configuration that declares it.
 *
 * The property under test is that inferred is never presented as declared,
 * and that a path nothing covers comes back unresolved rather than being
 * quietly called development.
 */

import { describe, expect, it } from 'vitest'

import { EMPTY_CONFIG, readConfig } from './config.ts'
import { classifyContext } from './context.ts'
import { AnalysisError } from './errors.ts'
import { matchesGlob, memoryTree, normalisePath } from './source.ts'
import type { PrivilegeSignal } from './types.ts'

const noSignals: PrivilegeSignal[] = []

function classify(file: string, frameworks: string[] = [], privileges = noSignals) {
  return classifyContext({ file, frameworks, privileges }, EMPTY_CONFIG)
}

describe('classifyContext: inference', () => {
  it('infers CI from a workflow path', () => {
    const context = classify('.github/workflows/eval.yml')
    expect(context.environment).toBe('ci')
    expect(context.basis).toBe('inferred')
  })

  it('infers build, notebook, test and sandbox from their conventions', () => {
    expect(classify('docker/Dockerfile').environment).toBe('build')
    expect(classify('notebooks/x.ipynb').environment).toBe('notebook')
    expect(classify('tests/test_api.py').environment).toBe('test')
    expect(classify('examples/demo.py').environment).toBe('sandbox')
  })

  it('infers a service from the framework the file builds', () => {
    const context = classify('app/main.py', ['fastapi'])
    expect(context.environment).toBe('service')
    expect(context.rule).toContain('fastapi')
  })

  it('infers development for an agent runtime configuration', () => {
    const context = classify('.mcp.json')
    expect(context.environment).toBe('development')
    expect(context.rule).toContain('agent runtime')
  })

  it('leaves an ordinary source path unresolved rather than calling it development', () => {
    const context = classify('src/pipeline/featurise.py')
    expect(context.environment).toBe('unresolved')
    expect(context.basis).toBe('unresolved')
  })

  it('records privilege signals and marks the context privileged', () => {
    const context = classify('app/main.py', ['fastapi'], [
      {
        kind: 'cloud-credentials',
        label: 'Cloud SDK client constructed',
        file: 'app/main.py',
        line: 4,
        evidence: 's3 = boto3.client("s3")',
      },
    ])
    expect(context.privileged).toBe(true)
    expect(context.privileges).toHaveLength(1)
  })

  it('carries the file it describes, so two production contexts stay distinguishable', () => {
    expect(classify('src/serving/api.py').file).toBe('src/serving/api.py')
  })
})

describe('readConfig', () => {
  async function config(text: string, path = 'deadweight.yaml') {
    const tree = memoryTree('p', [{ path, text }])
    return readConfig(tree, tree.entries)
  }

  it('reads declared environments from YAML', async () => {
    const parsed = await config('environments:\n  production:\n    - src/serving/**\n')
    expect(parsed.environments.get('production')).toEqual(['src/serving/**'])
  })

  it('reads declared environments from JSON', async () => {
    const parsed = await config(
      JSON.stringify({ environments: { ci: ['.github/**'] }, ignore: ['vendor/**'] }),
      'deadweight.json',
    )
    expect(parsed.environments.get('ci')).toEqual(['.github/**'])
    expect(parsed.ignore).toEqual(['vendor/**'])
  })

  it('makes a declared environment win over an inferred one, and says so', async () => {
    const parsed = await config('environments:\n  production:\n    - notebooks/**\n')
    const context = classifyContext(
      { file: 'notebooks/x.ipynb', frameworks: [], privileges: noSignals },
      parsed,
    )
    expect(context.environment).toBe('production')
    expect(context.basis).toBe('declared')
    expect(context.rule).toContain('deadweight.yaml')
  })

  it('returns an empty configuration when there is no file', async () => {
    const tree = memoryTree('p', [{ path: 'README.md', text: '# hi' }])
    expect((await readConfig(tree, tree.entries)).source).toBeNull()
  })

  /* ---- malformed configuration ---------------------------------------- */

  it('refuses an unknown environment name rather than ignoring it', async () => {
    await expect(config('environments:\n  prodution:\n    - src/**\n')).rejects.toThrow(
      AnalysisError,
    )
  })

  it('refuses tab indentation', async () => {
    await expect(config('environments:\n\tproduction:\n')).rejects.toThrow(/tab/)
  })

  it('refuses an unknown top-level section', async () => {
    await expect(config('environmnts:\n  production:\n')).rejects.toThrow(/unknown section/)
  })

  it('refuses a list item with no environment above it', async () => {
    await expect(config('environments:\n  - src/**\n')).rejects.toThrow(/environment/)
  })

  it('refuses an absolute or traversing glob', async () => {
    await expect(config('environments:\n  production:\n    - /etc/**\n')).rejects.toThrow(
      /repository-relative/,
    )
    await expect(config('environments:\n  production:\n    - ../other/**\n')).rejects.toThrow(
      /repository-relative/,
    )
  })

  it('refuses JSON where environments is not an object', async () => {
    await expect(config(JSON.stringify({ environments: [] }), 'deadweight.json')).rejects.toThrow(
      /must be an object/,
    )
  })

  it('refuses JSON that does not parse, and names the problem', async () => {
    await expect(config('{"environments":', 'deadweight.json')).rejects.toThrow(AnalysisError)
  })
})

describe('path handling', () => {
  it('refuses a traversing path rather than resolving it', () => {
    expect(normalisePath('a/../../b')).toBeNull()
    expect(normalisePath('../etc/passwd')).toBeNull()
  })

  it('refuses absolute, drive-letter and UNC paths', () => {
    expect(normalisePath('/etc/passwd')).toBeNull()
    expect(normalisePath('C:/Windows/System32')).toBeNull()
    expect(normalisePath('//server/share/x')).toBeNull()
  })

  it('refuses a path containing a NUL', () => {
    expect(normalisePath('a\u0000b')).toBeNull()
  })

  it('folds backslashes and redundant separators', () => {
    expect(normalisePath('src\\serving\\api.py')).toBe('src/serving/api.py')
    expect(normalisePath('src//serving/./api.py')).toBe('src/serving/api.py')
  })

  it('replaces control characters that could rewrite a terminal line', () => {
    const result = normalisePath('src/we\u001b[31mird.py') as string
    expect(result).not.toContain('\u001b')
    expect(result).toContain('\uFFFD')
  })

  it('refuses a path over the length limit', () => {
    expect(normalisePath(`${'a/'.repeat(600)}x.py`)).toBeNull()
  })
})

describe('globs', () => {
  it('matches within a segment with * and across segments with **', () => {
    expect(matchesGlob('src/serving/api.py', 'src/*/api.py')).toBe(true)
    expect(matchesGlob('src/a/b/api.py', 'src/*/api.py')).toBe(false)
    expect(matchesGlob('src/a/b/api.py', 'src/**/api.py')).toBe(true)
    expect(matchesGlob('src/api.py', 'src/**/api.py')).toBe(true)
  })

  it('matches a trailing ** as everything beneath', () => {
    expect(matchesGlob('src/serving/a/b.py', 'src/serving/**')).toBe(true)
    expect(matchesGlob('src/servingx/a.py', 'src/serving/**')).toBe(false)
  })

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(matchesGlob('a+b.py', 'a+b.py')).toBe(true)
    expect(matchesGlob('aab.py', 'a+b.py')).toBe(false)
    expect(matchesGlob('x.py', 'x.py')).toBe(true)
    expect(matchesGlob('xapy', 'x.py')).toBe(false)
  })
})
