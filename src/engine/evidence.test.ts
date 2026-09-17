/**
 * Evidence binding.
 *
 * The discipline under test: a scanner result is about specific bytes. If the
 * bytes moved, the result is STALE, not PASS. If the result never named a
 * digest, it is UNBOUND. And no evidence state anywhere alters a load
 * behaviour, which is asserted in the report test.
 */

import { describe, expect, it } from 'vitest'

import { bindEvidence, collectEvidence, scannerProfile } from './evidence.ts'
import { memoryTree } from './source.ts'
import type { BindableArtifact } from './evidence.ts'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

function artifact(locator: string, digest: string | null, coverage: 'full' | 'head-tail' = 'full'): BindableArtifact {
  return { id: locator, locator, digest: digest === null ? null : { value: digest, coverage } }
}

async function read(document: unknown, path = 'security/evidence/deadweight-evidence.json') {
  const tree = memoryTree('p', [{ path, text: JSON.stringify(document) }])
  return collectEvidence(tree, tree.entries)
}

const nativeRecord = (overrides: Record<string, unknown> = {}) => ({
  schema: 'deadweight.evidence/1',
  records: [
    {
      scanner: 'modelscan',
      version: '0.8.4',
      subject: 'weights/m.pt',
      sha256: DIGEST_A,
      result: 'pass',
      detail: 'No issue reported.',
      ...overrides,
    },
  ],
})

describe('bindEvidence', () => {
  it('binds a record whose digest matches the file on disk', async () => {
    const raw = await read(nativeRecord())
    const bound = bindEvidence(raw, [artifact('weights/m.pt', DIGEST_A)])
    expect(bound.get('weights/m.pt')?.[0]?.binding).toBe('current')
  })

  it('marks a record STALE when the file has changed underneath it', async () => {
    const raw = await read(nativeRecord())
    const bound = bindEvidence(raw, [artifact('weights/m.pt', DIGEST_B)])
    const record = bound.get('weights/m.pt')?.[0]
    expect(record?.binding).toBe('stale')
    expect(record?.result).toBe('pass')
    expect(record?.bindingNote).toContain('aaaaaaaaaaaa')
  })

  it('does not downgrade a stale pass to a fail, only its binding', async () => {
    const raw = await read(nativeRecord())
    const bound = bindEvidence(raw, [artifact('weights/m.pt', DIGEST_B)])
    expect(bound.get('weights/m.pt')?.[0]?.result).toBe('pass')
  })

  it('marks a record UNBOUND when it carries no digest', async () => {
    const raw = await read(nativeRecord({ sha256: undefined }))
    const bound = bindEvidence(raw, [artifact('weights/m.pt', DIGEST_A)])
    expect(bound.get('weights/m.pt')?.[0]?.binding).toBe('unbound')
  })

  it('marks a record UNBOUND when the artifact could not be hashed', async () => {
    const raw = await read(nativeRecord())
    const bound = bindEvidence(raw, [artifact('weights/m.pt', null)])
    expect(bound.get('weights/m.pt')?.[0]?.binding).toBe('unbound')
  })

  it('refuses to compare a head-tail digest with a scanner whole-file hash', async () => {
    const raw = await read(nativeRecord())
    const bound = bindEvidence(raw, [artifact('weights/m.pt', DIGEST_A, 'head-tail')])
    const record = bound.get('weights/m.pt')?.[0]
    expect(record?.binding).toBe('unbound')
    expect(record?.bindingNote).toContain('not comparable')
  })

  it('matches a subject written from a different working directory', async () => {
    const raw = await read(nativeRecord({ subject: '/builds/atlas/weights/m.pt' }))
    const bound = bindEvidence(raw, [artifact('weights/m.pt', DIGEST_A)])
    expect(bound.get('weights/m.pt')).toHaveLength(1)
  })

  it('leaves an ambiguous filename unbound rather than binding it to the wrong file', async () => {
    const raw = await read(nativeRecord({ subject: 'model.pt' }))
    const bound = bindEvidence(raw, [
      artifact('a/model.pt', DIGEST_A),
      artifact('b/model.pt', DIGEST_A),
    ])
    expect(bound.size).toBe(0)
  })

  it('drops a record about an artifact this analysis never saw', async () => {
    const raw = await read(nativeRecord({ subject: 'weights/gone.pt' }))
    expect(bindEvidence(raw, [artifact('weights/m.pt', DIGEST_A)]).size).toBe(0)
  })
})

describe('report readers', () => {
  it('reads a ModelScan report, with issues attached to their subject', async () => {
    const raw = await read(
      {
        modelscan_version: '0.8.4',
        summary: {
          scanned: { scanned_files: ['weights/a.pkl', 'weights/b.pt'] },
          skipped: { skipped_files: [{ source: 'weights/c.joblib' }] },
        },
        issues: [
          { description: 'Use of unsafe operator', operator: 'system', source: 'weights/a.pkl' },
        ],
      },
      'security/modelscan-report.json',
    )
    const byResult = Object.fromEntries(raw.map((r) => [r.subject, r.result]))
    expect(byResult['weights/a.pkl']).toBe('flagged')
    expect(byResult['weights/b.pt']).toBe('pass')
    expect(byResult['weights/c.joblib']).toBe('skipped')
  })

  it('states that a skipped file is not a passed file', async () => {
    const raw = await read(
      {
        modelscan_version: '0.8.4',
        summary: { skipped: { skipped_files: [{ source: 'x.joblib' }] } },
      },
      'security/modelscan-report.json',
    )
    expect(raw[0]?.detail).toContain('not a passed file')
  })

  it('reads a picklescan report', async () => {
    const raw = await read(
      {
        version: '0.0.23',
        results: [
          { file: 'weights/a.pkl', globals: [{ module: 'os', name: 'system' }], safety: 'dangerous' },
          { file: 'weights/b.pkl', globals: [] },
        ],
      },
      'security/picklescan.json',
    )
    expect(raw.find((r) => r.subject === 'weights/a.pkl')?.result).toBe('flagged')
    expect(raw.find((r) => r.subject === 'weights/b.pkl')?.result).toBe('pass')
  })

  it('ignores a document it does not recognise instead of inventing records', async () => {
    expect(await read({ hello: 'world' }, 'security/x.evidence.json')).toHaveLength(0)
  })

  it('ignores a file that is not JSON', async () => {
    const tree = memoryTree('p', [
      { path: 'security/x.evidence.json', text: 'this is not json {' },
    ])
    expect(await collectEvidence(tree, tree.entries)).toHaveLength(0)
  })

  it('only reads files whose names say they are evidence', async () => {
    const tree = memoryTree('p', [
      { path: 'src/data.json', text: JSON.stringify(nativeRecord()) },
    ])
    expect(await collectEvidence(tree, tree.entries)).toHaveLength(0)
  })

  it('rejects a malformed digest rather than binding on it', async () => {
    const raw = await read(nativeRecord({ sha256: 'not-a-digest' }))
    expect(raw[0]?.subjectDigest).toBeNull()
  })
})

describe('scannerProfile', () => {
  it('states limitations for every profile, because that is the point', () => {
    for (const id of ['modelscan', 'picklescan', 'fickling']) {
      const profile = scannerProfile(id)
      expect(profile.limitations.length).toBeGreaterThan(0)
      expect(profile.inspects.length).toBeGreaterThan(0)
    }
  })

  it('falls back to a profile that says it knows nothing about the tool', () => {
    const profile = scannerProfile('some-internal-tool')
    expect(profile.id).toBe('generic')
    expect(profile.limitations.join(' ')).toContain('never treated as reassurance')
  })

  it('says of ModelScan that it cannot see the loading code’s flags', () => {
    expect(scannerProfile('modelscan').limitations.join(' ')).toContain('flags the loading code passes')
  })
})
