/**
 * Scanner evidence.
 *
 * A scanner result is evidence. It is not assurance, and DEADWEIGHT never
 * lets one change a load behaviour. `torch.load` on a pickle-backed
 * checkpoint executes whatever the archive names, and a clean ModelScan run
 * does not alter that sentence -- it adds a second sentence: on this build of
 * this file, a tool that looks for a known set of dangerous imports found
 * none.
 *
 * Two disciplines make that real rather than rhetorical.
 *
 * Binding. Every record is tied to the digest of the artifact it claims to be
 * about. If the artifact on disk hashes to something else, the record is
 * STALE -- it is about a file that is no longer here. A result that carried no
 * digest is UNBOUND, which is weaker again: nothing ties it to any particular
 * bytes.
 *
 * Coverage. Every scanner has a profile stating what it inspects and the
 * named classes of thing it cannot see. Those limitations are shown next to
 * the result, every time, not in a footnote.
 */

import { MAX_EVIDENCE_RECORDS, MAX_MANIFEST_BYTES, clip, sanitise } from './limits.ts'
import { safeJson } from './manifests.ts'
import { basename } from './source.ts'
import type { SourceTree, TreeEntry } from './source.ts'
import type { EvidenceRecord, EvidenceResult, ScannerProfile } from './types.ts'

/* -------------------------------------------------------------------------- */
/* Scanner profiles                                                           */
/* -------------------------------------------------------------------------- */

const PROFILES: readonly ScannerProfile[] = [
  {
    id: 'modelscan',
    label: 'ModelScan',
    inspects: [
      'pickle opcode streams inside PyTorch archives, joblib dumps and bare pickles',
      'TensorFlow SavedModel graph operations',
      'Keras architecture configuration, including Lambda layers',
    ],
    limitations: [
      'It matches imports against a list of modules and functions known to be dangerous. A chain reaching the same effect through modules that are not on that list is not flagged.',
      'It reads the file. It cannot see the flags the loading code passes, so a file it passes is still loaded by whatever call your code makes.',
      'A format it does not support is skipped, and a skipped file is not a passed file.',
      'The result is about one build of one file. It does not transfer to a rebuild, a fine-tune or a different revision of the same model.',
    ],
  },
  {
    id: 'picklescan',
    label: 'picklescan',
    inspects: [
      'GLOBAL and STACK_GLOBAL opcodes in a pickle stream',
      'members of zip-based archives that contain pickles',
    ],
    limitations: [
      'It is denylist based: an import that is not on the list passes.',
      'Static opcode readers and CPython’s unpickler have disagreed about the same bytes before. A stream written so the two read it differently is a known class of bypass for any scanner of this design, including the reader in DEADWEIGHT.',
      'It does not evaluate the loading application’s configuration.',
    ],
  },
  {
    id: 'fickling',
    label: 'Fickling',
    inspects: [
      'the pickle program, decompiled to an abstract syntax tree',
      'behaviours the program would exhibit, rather than only the names it mentions',
    ],
    limitations: [
      'It reasons about what the pickle would do. What that reaches depends on the environment the unpickling happens in, which is not in the file.',
      'Its severity judgement is about the stream, not about where the stream is loaded.',
    ],
  },
  {
    id: 'generic',
    label: 'Unrecognised scanner',
    inspects: ['unknown; the record did not name a scanner DEADWEIGHT has a profile for'],
    limitations: [
      'DEADWEIGHT has no coverage statement for this tool, so what the result does and does not cover is unknown.',
      'An unrecognised result is recorded and never treated as reassurance.',
    ],
  },
]

const PROFILE_BY_ID = new Map(PROFILES.map((p) => [p.id, p]))

export function scannerProfile(id: string): ScannerProfile {
  return PROFILE_BY_ID.get(id.toLowerCase()) ?? (PROFILE_BY_ID.get('generic') as ScannerProfile)
}

export function allScannerProfiles(): readonly ScannerProfile[] {
  return PROFILES
}

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                  */
/* -------------------------------------------------------------------------- */

/** A record as read from a document, before it is bound to an artifact. */
interface RawEvidence {
  readonly scanner: string
  readonly scannerVersion: string | null
  readonly subject: string
  readonly subjectDigest: string | null
  readonly result: EvidenceResult
  readonly detail: string
  readonly source: string
}

const EVIDENCE_PATH =
  /(^|\/)(deadweight-evidence\.json|modelscan[^/]*\.json|picklescan[^/]*\.json|fickling[^/]*\.json|[^/]+\.evidence\.json)$/

export function isEvidenceFile(path: string): boolean {
  return EVIDENCE_PATH.test(path)
}

function asResult(value: unknown): EvidenceResult {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (text === 'pass' || text === 'clean' || text === 'ok' || text === 'passed') return 'pass'
  if (text === 'fail' || text === 'flagged' || text === 'issues' || text === 'failed') return 'flagged'
  if (text === 'error' || text === 'errored') return 'error'
  if (text === 'skip' || text === 'skipped' || text === 'unsupported') return 'skipped'
  return 'error'
}

function text(value: unknown, max = 300): string | null {
  return typeof value === 'string' ? clip(sanitise(value), max) : null
}

/** The DEADWEIGHT evidence document: explicit digests, explicit results. */
function readNativeEvidence(doc: Record<string, unknown>, source: string): RawEvidence[] {
  const records = doc['records']
  if (!Array.isArray(records)) return []
  const out: RawEvidence[] = []
  for (const item of records.slice(0, MAX_EVIDENCE_RECORDS)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const subject = text(record['subject'], 400)
    if (subject === null) continue
    const digest = text(record['sha256'], 80)
    out.push({
      scanner: (text(record['scanner'], 60) ?? 'generic').toLowerCase(),
      scannerVersion: text(record['version'], 40),
      subject,
      subjectDigest: digest !== null && /^[0-9a-f]{16,64}$/i.test(digest) ? digest.toLowerCase() : null,
      result: asResult(record['result']),
      detail: text(record['detail'], 400) ?? 'No detail recorded.',
      source,
    })
  }
  return out
}

/**
 * ModelScan's own JSON report.
 *
 * Its shape has moved between releases, so the reader takes what it finds: a
 * list of scanned files, a list of skipped files, and a list of issues keyed
 * by source. Anything it cannot place is dropped rather than guessed at.
 */
function readModelScanReport(doc: Record<string, unknown>, source: string): RawEvidence[] {
  const version = text(doc['modelscan_version'], 40)
  const summary = (doc['summary'] as Record<string, unknown> | undefined) ?? doc
  const scannedBlock = summary['scanned'] as Record<string, unknown> | undefined
  const skippedBlock = summary['skipped'] as Record<string, unknown> | undefined

  const issues = Array.isArray(doc['issues']) ? (doc['issues'] as unknown[]) : []
  const issuesBySubject = new Map<string, string[]>()
  for (const issue of issues.slice(0, MAX_EVIDENCE_RECORDS)) {
    if (issue === null || typeof issue !== 'object') continue
    const record = issue as Record<string, unknown>
    const subject = text(record['source'], 400)
    if (subject === null) continue
    const description = text(record['description'], 200) ?? 'issue reported'
    const operator = text(record['operator'], 80)
    const list = issuesBySubject.get(subject) ?? []
    list.push(operator === null ? description : `${description} (${operator})`)
    issuesBySubject.set(subject, list)
  }

  const out: RawEvidence[] = []
  const scannedFiles = Array.isArray(scannedBlock?.['scanned_files'])
    ? (scannedBlock['scanned_files'] as unknown[])
    : []
  for (const file of scannedFiles.slice(0, MAX_EVIDENCE_RECORDS)) {
    const subject = text(file, 400)
    if (subject === null) continue
    const found = issuesBySubject.get(subject)
    out.push({
      scanner: 'modelscan',
      scannerVersion: version,
      subject,
      subjectDigest: null,
      result: found === undefined ? 'pass' : 'flagged',
      detail:
        found === undefined
          ? 'Scanned; no issue reported against the scanner’s known-dangerous import list.'
          : clip(found.join('; '), 400),
      source,
    })
  }

  const skippedFiles = Array.isArray(skippedBlock?.['skipped_files'])
    ? (skippedBlock['skipped_files'] as unknown[])
    : []
  for (const file of skippedFiles.slice(0, MAX_EVIDENCE_RECORDS)) {
    const entry =
      file !== null && typeof file === 'object'
        ? text((file as Record<string, unknown>)['source'], 400)
        : text(file, 400)
    if (entry === null) continue
    out.push({
      scanner: 'modelscan',
      scannerVersion: version,
      subject: entry,
      subjectDigest: null,
      result: 'skipped',
      detail: 'The scanner skipped this file. A skipped file is not a passed file.',
      source,
    })
  }

  // Issues against files that did not appear in the scanned list.
  for (const [subject, found] of issuesBySubject) {
    if (out.some((r) => r.subject === subject)) continue
    out.push({
      scanner: 'modelscan',
      scannerVersion: version,
      subject,
      subjectDigest: null,
      result: 'flagged',
      detail: clip(found.join('; '), 400),
      source,
    })
  }

  return out
}

/** picklescan --json: a list of results with a path and a set of globals. */
function readPickleScanReport(doc: Record<string, unknown>, source: string): RawEvidence[] {
  const version = text(doc['version'], 40)
  const results = Array.isArray(doc['results'])
    ? (doc['results'] as unknown[])
    : Array.isArray(doc['scans'])
      ? (doc['scans'] as unknown[])
      : []
  const out: RawEvidence[] = []
  for (const item of results.slice(0, MAX_EVIDENCE_RECORDS)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const subject = text(record['file'], 400) ?? text(record['path'], 400)
    if (subject === null) continue
    const globals = Array.isArray(record['globals']) ? (record['globals'] as unknown[]) : []
    const dangerous = globals
      .map((g) =>
        g !== null && typeof g === 'object'
          ? `${text((g as Record<string, unknown>)['module'], 60) ?? '?'}.${text((g as Record<string, unknown>)['name'], 60) ?? '?'}`
          : text(g, 120),
      )
      .filter((g): g is string => g !== null)
    const flagged = record['safety'] === 'dangerous' || record['dangerous'] === true || dangerous.length > 0
    out.push({
      scanner: 'picklescan',
      scannerVersion: version,
      subject,
      subjectDigest: text(record['sha256'], 80),
      result: flagged ? 'flagged' : 'pass',
      detail: flagged
        ? `Denylisted globals: ${clip(dangerous.join(', '), 300)}`
        : 'No denylisted global found in the opcode stream.',
      source,
    })
  }
  return out
}

async function readEvidenceDocument(
  tree: SourceTree,
  entry: TreeEntry,
): Promise<readonly RawEvidence[]> {
  if (entry.size > MAX_MANIFEST_BYTES) return []
  const body = await tree.readText(entry.path, MAX_MANIFEST_BYTES)
  if (body === null) return []
  const doc = safeJson(body)
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return []
  const root = doc as Record<string, unknown>

  if (root['schema'] === 'deadweight.evidence/1' || Array.isArray(root['records'])) {
    return readNativeEvidence(root, entry.path)
  }
  if (root['modelscan_version'] !== undefined || root['issues'] !== undefined) {
    return readModelScanReport(root, entry.path)
  }
  if (root['results'] !== undefined || root['scans'] !== undefined) {
    return readPickleScanReport(root, entry.path)
  }
  return []
}

/* -------------------------------------------------------------------------- */
/* Binding                                                                    */
/* -------------------------------------------------------------------------- */

export interface BindableArtifact {
  readonly id: string
  readonly locator: string
  readonly digest: { readonly value: string; readonly coverage: 'full' | 'head-tail' } | null
}

/**
 * Attach records to artifacts and decide how strongly each is bound.
 *
 * Subject matching is by path suffix, then by filename, because a scanner was
 * usually run from a different working directory than the analysis. A subject
 * that matches more than one artifact by filename alone is left unmatched: a
 * record bound to the wrong file is worse than a record bound to nothing.
 */
export function bindEvidence(
  raw: readonly RawEvidence[],
  artifacts: readonly BindableArtifact[],
): ReadonlyMap<string, readonly EvidenceRecord[]> {
  const byArtifact = new Map<string, EvidenceRecord[]>()
  const byName = new Map<string, BindableArtifact[]>()
  for (const artifact of artifacts) {
    const name = basename(artifact.locator)
    const list = byName.get(name) ?? []
    list.push(artifact)
    byName.set(name, list)
  }

  let counter = 0
  for (const record of raw) {
    counter += 1
    const subject = record.subject.replace(/\\/g, '/')
    const target = resolveSubject(subject, artifacts, byName)
    if (target === null) continue

    let binding: EvidenceRecord['binding']
    let bindingNote: string | null = null

    if (record.subjectDigest === null) {
      binding = 'unbound'
      bindingNote =
        'The record carries no digest, so nothing ties it to the bytes on disk now.'
    } else if (target.digest === null) {
      binding = 'unbound'
      bindingNote = 'DEADWEIGHT could not hash the artifact, so the record cannot be checked against it.'
    } else if (target.digest.coverage === 'head-tail') {
      binding = 'unbound'
      bindingNote =
        'The artifact exceeded the full-hash limit, so DEADWEIGHT holds a head-and-tail digest that is not comparable with a scanner’s whole-file hash.'
    } else if (target.digest.value.startsWith(record.subjectDigest.toLowerCase())) {
      binding = 'current'
    } else {
      binding = 'stale'
      bindingNote = `The record is about sha256:${record.subjectDigest.slice(0, 12)}; the file on disk is sha256:${target.digest.value.slice(0, 12)}.`
    }

    const list = byArtifact.get(target.id) ?? []
    list.push({
      id: `ev-${counter}-${target.id}`,
      scanner: record.scanner,
      scannerVersion: record.scannerVersion,
      subject: record.subject,
      subjectDigest: record.subjectDigest,
      result: record.result,
      detail: record.detail,
      binding,
      bindingNote,
      source: record.source,
    })
    byArtifact.set(target.id, list)
  }

  return byArtifact
}

function resolveSubject(
  subject: string,
  artifacts: readonly BindableArtifact[],
  byName: ReadonlyMap<string, readonly BindableArtifact[]>,
): BindableArtifact | null {
  const exact = artifacts.find((a) => a.locator === subject)
  if (exact) return exact
  const suffix = artifacts.filter((a) => subject.endsWith(`/${a.locator}`) || a.locator.endsWith(`/${subject}`))
  if (suffix.length === 1) return suffix[0] as BindableArtifact
  const named = byName.get(basename(subject))
  if (named !== undefined && named.length === 1) return named[0] as BindableArtifact
  return null
}

export async function collectEvidence(
  tree: SourceTree,
  entries: readonly TreeEntry[],
): Promise<readonly RawEvidence[]> {
  const out: RawEvidence[] = []
  for (const entry of entries) {
    if (!isEvidenceFile(entry.path)) continue
    out.push(...(await readEvidenceDocument(tree, entry)))
    if (out.length >= MAX_EVIDENCE_RECORDS) break
  }
  return out
}
