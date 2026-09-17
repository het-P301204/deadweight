/**
 * The analysis.
 *
 * Eight stages, in order, each one reporting a real count when it finishes:
 *
 *   walk          which files are in scope
 *   dependencies  what versions the project declares
 *   load-sites    where code loads an AI artifact
 *   artifacts     what those artifacts are, from their bytes
 *   behaviour     what loading each one does
 *   context       where that happens, and with what reach
 *   evidence      what has been checked, bound to a digest
 *   bom           the assembled inventory
 *
 * The progress callback exists so the UI can show the pipeline filling in
 * rather than a bar creeping to a number nobody chose. There are no
 * artificial delays anywhere in this file.
 *
 * Nothing here loads an artifact. The only reads are text for source files
 * and manifests, bounded head and tail slices for recognition, and a chunked
 * stream for hashing.
 */

import { resolveAlternative } from './alternatives.ts'
import { mostExposed, resolveBehaviour, unresolvedArtifactBehaviour } from './behaviour.ts'
import { classifyArtifact } from './classify.ts'
import { EMPTY_CONFIG, readConfig } from './config.ts'
import type { ProjectConfig } from './config.ts'
import { classifyContext, contextIdFor } from './context.ts'
import { readProjectName, resolveDependencies } from './deps.ts'
import { AnalysisError } from './errors.ts'
import { bindEvidence, collectEvidence } from './evidence.ts'
import { deriveFindings, rankFindings } from './findings.ts'
import { MODEL_EXTENSIONS, formatSpec } from './formats.ts'
import { canonicalJson, sha256Text, Sha256 } from './hash.ts'
import {
  MAX_FULL_DIGEST_BYTES,
  MAX_NOTEBOOK_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TREE_ENTRIES,
  ARTIFACT_HEAD_BYTES,
  ARTIFACT_TAIL_BYTES,
  clip,
  sanitise,
} from './limits.ts'
import { readDeclarations } from './manifests.ts'
import type { DeclaredLoad } from './manifests.ts'
import { cellForLine, readNotebook } from './notebook.ts'
import { basename, dirname, extname, matchesGlob, stem } from './source.ts'
import type { SourceTree, TreeEntry } from './source.ts'
import { scanPython, scanJs } from './scan.ts'
import type { RawCall } from './scan.ts'
import { buildStripe } from './stripe.ts'
import { buildSummary } from './summary.ts'
import type {
  AnalysisNotice,
  Artifact,
  ArtifactDigest,
  ArtifactRecord,
  BehaviourVerdict,
  CallArgument,
  FormatId,
  LoadContext,
  LoadSite,
  PrivilegeSignal,
  ProgressFn,
  Report,
} from './types.ts'

export interface AnalyzeOptions {
  readonly onProgress?: ProgressFn
  /** Override the project display name. */
  readonly name?: string
}

const PYTHON_EXTENSIONS = new Set(['.py', '.pyi'])
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts'])

export async function analyze(tree: SourceTree, options: AnalyzeOptions = {}): Promise<Report> {
  const notices: AnalysisNotice[] = []
  const report = options.onProgress ?? ((): void => {})
  const counts = { filesWalked: 0, filesRead: 0, bytesRead: 0 }

  /* ---- 1. walk --------------------------------------------------------- */
  report({ stage: 'walk', status: 'running', detail: 'Reading the project tree' })
  if (tree.entries.length === 0) throw new AnalysisError('tree-empty')
  if (tree.entries.length > MAX_TREE_ENTRIES) {
    throw new AnalysisError(
      'tree-too-large',
      `${tree.entries.length} entries; the limit is ${MAX_TREE_ENTRIES}.`,
    )
  }

  let config: ProjectConfig
  try {
    config = await readConfig(tree, tree.entries)
  } catch (error) {
    if (error instanceof AnalysisError) throw error
    config = EMPTY_CONFIG
  }

  const entries = tree.entries.filter((entry) => {
    if (config.ignore.some((glob) => matchesGlob(entry.path, glob))) return false
    if (entry.link === true) {
      notices.push({
        code: 'symlink-skipped',
        severity: 'info',
        message: 'Symbolic link was listed but not followed.',
        path: entry.path,
      })
      return false
    }
    return true
  })
  counts.filesWalked = entries.length
  report({
    stage: 'walk',
    status: 'done',
    detail: `${entries.length} file${entries.length === 1 ? '' : 's'} in scope`,
  })

  /* ---- 2. dependencies ------------------------------------------------- */
  report({ stage: 'dependencies', status: 'running', detail: 'Reading declared versions' })
  const dependencies = await resolveDependencies(tree, entries)
  const declaredName = await readProjectName(tree, entries)
  const pinned = dependencies.filter((d) => d.pin === 'exact').length
  report({
    stage: 'dependencies',
    status: 'done',
    detail: `${dependencies.length} declared, ${pinned} pinned exactly`,
  })

  /* ---- 3. load sites --------------------------------------------------- */
  report({ stage: 'load-sites', status: 'running', detail: 'Scanning source for loader calls' })
  const calls: RawCall[] = []
  const privilegesByFile = new Map<string, PrivilegeSignal[]>()
  const frameworksByFile = new Map<string, string[]>()

  for (const entry of entries) {
    const ext = extname(entry.path)
    const isPython = PYTHON_EXTENSIONS.has(ext)
    const isJs = JS_EXTENSIONS.has(ext)
    const isNotebook = ext === '.ipynb'
    if (!isPython && !isJs && !isNotebook) continue

    const cap = isNotebook ? MAX_NOTEBOOK_BYTES : MAX_SOURCE_BYTES
    if (entry.size > cap) {
      notices.push({
        code: 'source-too-large',
        severity: 'warning',
        message: `Skipped: ${(entry.size / 1_048_576).toFixed(1)} MB exceeds the ${(cap / 1_048_576).toFixed(0)} MB limit for this file type.`,
        path: entry.path,
      })
      continue
    }

    const text = await tree.readText(entry.path, cap)
    if (text === null) {
      notices.push({
        code: 'source-unreadable',
        severity: 'warning',
        message: 'The file is listed in the tree but could not be read.',
        path: entry.path,
      })
      continue
    }
    counts.filesRead += 1
    counts.bytesRead += text.length

    if (isNotebook) {
      const notebook = readNotebook(text)
      if (notebook === null) {
        notices.push({
          code: 'notebook-unparsed',
          severity: 'warning',
          message: 'Not valid notebook JSON, or it contains no code cells.',
          path: entry.path,
        })
        continue
      }
      const result = scanPython(entry.path, notebook.source)
      for (const call of result.calls) {
        const cell = cellForLine(notebook, call.line)
        calls.push({ ...call, enclosing: cell === null ? call.enclosing : `cell ${cell}` })
      }
      privilegesByFile.set(entry.path, [...result.privileges])
      frameworksByFile.set(entry.path, [...result.frameworks])
      continue
    }

    const result = isPython ? scanPython(entry.path, text) : scanJs(entry.path, text)
    calls.push(...result.calls)
    if (result.privileges.length > 0) privilegesByFile.set(entry.path, [...result.privileges])
    if (result.frameworks.length > 0) frameworksByFile.set(entry.path, [...result.frameworks])
  }

  const declarations = await readDeclarations(tree, entries)
  report({
    stage: 'load-sites',
    status: 'done',
    detail: `${calls.length} loader call${calls.length === 1 ? '' : 's'}, ${declarations.length} declaration${declarations.length === 1 ? '' : 's'}`,
  })

  /* ---- 4. artifacts ---------------------------------------------------- */
  report({ stage: 'artifacts', status: 'running', detail: 'Recognising artifacts from their bytes' })
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const referenced = new Map<string, { entry: TreeEntry | null; reference: string }>()

  for (const call of calls) {
    if (call.targetLiteral === null) continue
    const resolved = resolveReference(call, byPath)
    if (resolved !== null) referenced.set(resolved.key, resolved.value)
  }

  // Artifact files that sit in the tree with nothing loading them are still
  // artifacts: they shipped with the repository and something loads them
  // somewhere. Reported with an unresolved load stage rather than omitted.
  for (const entry of entries) {
    if (!MODEL_EXTENSIONS.has(extname(entry.path))) continue
    if (referenced.has(entry.path)) continue
    referenced.set(entry.path, { entry, reference: entry.path })
  }

  const artifacts = new Map<string, Artifact>()
  for (const [key, { entry, reference }] of referenced) {
    if (entry === null) {
      artifacts.set(key, remoteArtifact(key, reference))
      continue
    }
    const classified = await classifyArtifact(tree, entry.path, entry.size)
    counts.bytesRead += Math.min(entry.size, ARTIFACT_HEAD_BYTES + ARTIFACT_TAIL_BYTES)
    const digest = await digestOf(tree, entry)
    if (digest !== null) counts.bytesRead += digest.coverage === 'full' ? entry.size : 0
    artifacts.set(key, {
      id: entry.path,
      name: basename(entry.path),
      locator: entry.path,
      origin: 'in-tree',
      format: classified.verdict,
      sizeBytes: entry.size,
      digest,
      version: null,
      pickle: classified.pickle,
      tensorHeader: classified.tensorHeader,
      siblings: siblingsOf(entry.path, entries),
    })
  }

  for (const declaration of declarations) {
    artifacts.set(declaration.artifactId, {
      id: declaration.artifactId,
      name: declaration.name,
      locator: declaration.locator,
      origin: declaration.origin,
      format: { format: declaration.format, basis: 'declared', note: declaration.formatNote },
      sizeBytes: byPath.get(declaration.file)?.size ?? null,
      digest: null,
      version: declaration.version,
      pickle: null,
      tensorHeader: null,
      siblings: [],
    })
  }
  report({
    stage: 'artifacts',
    status: 'done',
    detail: `${artifacts.size} artifact${artifacts.size === 1 ? '' : 's'} recognised without loading any of them`,
  })

  /* ---- 5. load sites, bound to artifacts, each with its own verdict ---- */
  report({ stage: 'behaviour', status: 'running', detail: 'Resolving what loading does' })
  const sitesByArtifact = new Map<string, LoadSite[]>()
  const orphanLoadSites: LoadSite[] = []
  let siteCounter = 0

  for (const call of calls) {
    siteCounter += 1
    const resolved = call.targetLiteral === null ? null : resolveReference(call, byPath)
    const artifactId = resolved?.key ?? null
    const artifact = artifactId === null ? null : (artifacts.get(artifactId) ?? null)
    const site: LoadSite = {
      id: `ls-${siteCounter}`,
      file: call.file,
      line: call.line,
      enclosing: call.enclosing,
      loader: call.loaderId,
      snippet: call.snippet,
      args: call.args,
      artifactId,
      targetExpression:
        call.targetExpression === '' ? '(no artifact argument)' : call.targetExpression,
      contextId: contextIdFor(call.file),
      behaviour:
        artifactId === null
          ? unresolvedArtifactBehaviour(call)
          : resolveBehaviour({ call, artifact, deps: dependencies }),
    }
    if (artifactId === null) orphanLoadSites.push(site)
    else {
      const list = sitesByArtifact.get(artifactId) ?? []
      list.push(site)
      sitesByArtifact.set(artifactId, list)
    }
  }

  for (const declaration of declarations) {
    siteCounter += 1
    const list = sitesByArtifact.get(declaration.artifactId) ?? []
    list.push({
      id: `ls-${siteCounter}`,
      file: declaration.file,
      line: declaration.line,
      enclosing: null,
      loader: `declared:${declaration.loaderLabel}`,
      snippet: declaration.snippet,
      args: [] as readonly CallArgument[],
      artifactId: declaration.artifactId,
      targetExpression: declaration.targetExpression,
      contextId: contextIdFor(declaration.file),
      behaviour: declaredBehaviour(declaration),
    })
    sitesByArtifact.set(declaration.artifactId, list)
  }

  /* ---- 6. behaviour: the most exposed of an artifact's load sites ------ */
  const behaviours = new Map<string, BehaviourVerdict>()
  for (const [id, artifact] of artifacts) {
    const sites = sitesByArtifact.get(id) ?? []
    const headline = mostExposed(sites.map((s) => s.behaviour))
    behaviours.set(id, headline ?? dormantBehaviour(artifact))
  }
  report({
    stage: 'behaviour',
    status: 'done',
    detail: `${[...behaviours.values()].filter((b) => b.behaviour === 'code').length} execute on load, ${[...behaviours.values()].filter((b) => b.behaviour === 'unknown').length} unresolved`,
  })

  /* ---- 7. context ------------------------------------------------------ */
  report({ stage: 'context', status: 'running', detail: 'Classifying load contexts' })
  const contexts = new Map<string, LoadContext>()
  const contextFiles = new Set<string>([
    ...calls.map((c) => c.file),
    ...declarations.map((d) => d.file),
  ])
  for (const file of contextFiles) {
    contexts.set(
      contextIdFor(file),
      classifyContext(
        {
          file,
          frameworks: frameworksByFile.get(file) ?? [],
          privileges: privilegesByFile.get(file) ?? [],
        },
        config,
      ),
    )
  }
  report({
    stage: 'context',
    status: 'done',
    detail: `${contexts.size} load context${contexts.size === 1 ? '' : 's'}, ${[...contexts.values()].filter((c) => c.privileged).length} privileged`,
  })

  /* ---- 8. evidence ----------------------------------------------------- */
  report({ stage: 'evidence', status: 'running', detail: 'Binding scanner results to digests' })
  const rawEvidence = await collectEvidence(tree, entries)
  const bound = bindEvidence(
    rawEvidence,
    [...artifacts.values()].map((a) => ({
      id: a.id,
      locator: a.locator,
      digest: a.digest === null ? null : { value: a.digest.value, coverage: a.digest.coverage },
    })),
  )
  const boundCount = [...bound.values()].reduce((sum, list) => sum + list.length, 0)
  report({
    stage: 'evidence',
    status: 'done',
    detail: `${boundCount} of ${rawEvidence.length} record${rawEvidence.length === 1 ? '' : 's'} bound to an artifact`,
  })

  /* ---- 9. assemble ----------------------------------------------------- */
  report({ stage: 'bom', status: 'running', detail: 'Assembling the model BOM' })
  const records: ArtifactRecord[] = []
  for (const [id, artifact] of artifacts) {
    const sites = (sitesByArtifact.get(id) ?? []).sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
    )
    const behaviour = behaviours.get(id) as BehaviourVerdict
    const recordContexts = dedupe(
      sites.map((s) => contexts.get(s.contextId)).filter((c): c is LoadContext => c !== undefined),
    )
    const evidence = bound.get(id) ?? []
    const alternative = resolveAlternative(artifact, behaviour, sites)
    const findings = deriveFindings({
      artifact,
      behaviour,
      sites,
      contexts: recordContexts,
      evidence,
      alternative,
    })
    records.push({
      artifact,
      loadSites: sites,
      behaviour,
      contexts: recordContexts,
      evidence,
      alternative,
      findings,
      stripe: buildStripe({ artifact, sites, behaviour, contexts: recordContexts, evidence, alternative }),
    })
  }

  records.sort((a, b) => order(a) - order(b) || (a.artifact.id < b.artifact.id ? -1 : 1))

  const summary = buildSummary(records, orphanLoadSites)
  const findings = rankFindings(records.flatMap((r) => r.findings))

  const body = {
    // What the project calls itself, then what the directory is called. A
    // directory name is whatever the person cloning chose.
    project: options.name ?? declaredName ?? tree.name,
    records,
    contexts: [...contexts.values()],
    orphanLoadSites,
    findings,
    summary,
    notices,
    dependencies,
  }

  report({
    stage: 'bom',
    status: 'done',
    detail: `${records.length} entr${records.length === 1 ? 'y' : 'ies'}, ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
  })

  return {
    schema: 'deadweight.report/1',
    ...body,
    digest: sha256Text(canonicalJson(body)),
    counts,
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Ordering for the explorer: act on the dangerous ones first. */
function order(record: ArtifactRecord): number {
  const weight: Record<string, number> = { code: 0, unknown: 1, directive: 2, guarded: 3, data: 4 }
  const base = (weight[record.behaviour.behaviour] ?? 5) * 10
  return base - (record.contexts.some((c) => c.privileged) ? 5 : 0)
}

function dedupe(contexts: readonly LoadContext[]): readonly LoadContext[] {
  const seen = new Map<string, LoadContext>()
  for (const context of contexts) seen.set(context.id, context)
  return [...seen.values()]
}

/**
 * Resolve a load site's target to an artifact key.
 *
 * A literal that names a file in the tree resolves to that file, tried as
 * written and then as a suffix, because loading code is usually relative to
 * somewhere other than the repository root. A literal that looks like a
 * `org/name` repository reference becomes a remote artifact. Anything else is
 * unresolved and stays that way.
 */
function resolveReference(
  call: RawCall,
  byPath: ReadonlyMap<string, TreeEntry>,
): { key: string; value: { entry: TreeEntry | null; reference: string } } | null {
  const literal = call.targetLiteral
  if (literal === null || literal === '') return null
  const cleaned = sanitise(literal).replace(/\\/g, '/').replace(/^\.\//, '')

  const direct = byPath.get(cleaned)
  if (direct !== undefined) return { key: cleaned, value: { entry: direct, reference: cleaned } }

  // `weights/model.pt` written from inside `src/` still names the same file.
  const suffix = [...byPath.keys()].filter(
    (path) => path === cleaned || path.endsWith(`/${cleaned}`),
  )
  if (suffix.length === 1) {
    const path = suffix[0] as string
    return { key: path, value: { entry: byPath.get(path) as TreeEntry, reference: cleaned } }
  }

  // A repository reference: `org/name`, optionally with a revision. It must
  // carry no file extension, or `config/index.yaml` would become a model.
  if (/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(cleaned) && extname(cleaned) === '') {
    return { key: `hf:${cleaned}`, value: { entry: null, reference: cleaned } }
  }

  // A local path that names a file not in the tree: the reference is real and
  // the file is not here, which is worth reporting as an unresolved artifact.
  if (/[/.]/.test(cleaned) && MODEL_EXTENSIONS.has(extname(cleaned))) {
    return { key: `missing:${cleaned}`, value: { entry: null, reference: cleaned } }
  }

  return null
}

function remoteArtifact(key: string, reference: string): Artifact {
  const missing = key.startsWith('missing:')
  const format: FormatId = missing ? inferFormat(reference) : 'remote-repository'
  return {
    id: key,
    name: missing ? basename(reference) : reference,
    locator: reference,
    origin: missing ? 'unresolved' : 'remote-reference',
    format: {
      format,
      basis: missing ? 'extension' : 'none',
      note: missing
        ? `The path is loaded but no such file is in the tree; the format is a guess from its extension (${extname(reference) || 'none'}).`
        : 'A remote repository reference. DEADWEIGHT does not contact the network, so what it serves is outside this analysis.',
    },
    sizeBytes: null,
    digest: null,
    version: revisionOf(reference),
    pickle: null,
    tensorHeader: null,
    siblings: [],
  }
}

function inferFormat(reference: string): FormatId {
  const ext = extname(reference)
  if (ext === '.safetensors') return 'safetensors'
  if (ext === '.onnx') return 'onnx'
  if (ext === '.gguf') return 'gguf'
  if (ext === '.pkl' || ext === '.pickle') return 'pickle'
  if (ext === '.pt' || ext === '.pth' || ext === '.bin' || ext === '.ckpt') return 'pytorch-zip'
  return 'unknown'
}

function revisionOf(reference: string): string | null {
  const at = /@([\w.-]+)$/.exec(reference)
  return at ? (at[1] as string) : null
}

function siblingsOf(
  path: string,
  entries: readonly TreeEntry[],
): readonly { locator: string; format: FormatId }[] {
  const dir = dirname(path)
  const base = stem(path)
  const out: { locator: string; format: FormatId }[] = []
  for (const entry of entries) {
    if (entry.path === path) continue
    if (dirname(entry.path) !== dir) continue
    if (stem(entry.path) !== base) continue
    const format = inferFormat(entry.path)
    if (format === 'unknown') continue
    out.push({ locator: entry.path, format })
  }
  return out.sort((a, b) => (a.locator < b.locator ? -1 : 1))
}

async function digestOf(tree: SourceTree, entry: TreeEntry): Promise<ArtifactDigest | null> {
  try {
    if (entry.size <= MAX_FULL_DIGEST_BYTES) {
      const hash = new Sha256()
      let seen = 0
      for await (const chunk of tree.stream(entry.path, 1 << 16)) {
        hash.update(chunk)
        seen += chunk.length
      }
      if (seen === 0 && entry.size > 0) return null
      return { algorithm: 'sha256', value: hash.digest(), coverage: 'full', bytes: seen }
    }
    // Above the cap the digest covers the head, the tail and the length. It is
    // stable and detects change; it is deliberately not comparable with a
    // scanner's whole-file hash, and evidence binding treats it as unbound.
    const head = await tree.readBytes(entry.path, 0, ARTIFACT_HEAD_BYTES)
    const tail = await tree.readBytes(entry.path, -ARTIFACT_TAIL_BYTES, ARTIFACT_TAIL_BYTES)
    if (head === null || tail === null) return null
    const hash = new Sha256()
    hash.update(head)
    hash.update(new TextEncoder().encode(`|${entry.size}|`))
    hash.update(tail)
    return {
      algorithm: 'sha256',
      value: hash.digest(),
      coverage: 'head-tail',
      bytes: head.length + tail.length,
    }
  } catch {
    return null
  }
}

function declaredBehaviour(declaration: DeclaredLoad): BehaviourVerdict {
  return {
    behaviour: declaration.behaviour,
    mechanism: declaration.mechanism,
    steps: declaration.steps,
    unknownReason: null,
    guard: null,
  }
}

/**
 * An artifact in the tree that nothing in the tree loads.
 *
 * The format still says what loading it *would* do, which is the useful fact,
 * and the load stage is marked unresolved so the row cannot be mistaken for
 * one with a known call site.
 */
function dormantBehaviour(artifact: Artifact): BehaviourVerdict {
  const spec = formatSpec(artifact.format.format)

  /*
   * A format identified only by its extension has not been confirmed by
   * anything. Inheriting a data-only verdict from it would mean that naming a
   * file `.safetensors` is enough to be reported as data only -- including
   * when the safetensors reader looked at the bytes and refused them.
   */
  if (artifact.format.basis === 'extension' || artifact.format.basis === 'none') {
    return {
      behaviour: 'unknown',
      mechanism: `${artifact.format.note}. Naming a file is not evidence about its contents, so DEADWEIGHT will not report what loading it does.`,
      steps: [
        { claim: 'The file is in the tree.', basis: artifact.locator },
        { claim: artifact.format.note, basis: 'byte inspection' },
        {
          claim: `The extension suggests ${spec.label}; nothing in the bytes confirmed it.`,
          basis: `format basis: ${artifact.format.basis}`,
        },
      ],
      unknownReason: 'format-undetermined',
      guard: null,
    }
  }

  if (artifact.format.format === 'unknown') {
    return {
      behaviour: 'unknown',
      mechanism: `${artifact.format.note}. With no load site and no recognised format there is nothing to reason from.`,
      steps: [
        { claim: 'The file is in the tree.', basis: artifact.locator },
        { claim: 'No code in this project loads it.', basis: 'no matching load site' },
        { claim: artifact.format.note, basis: 'byte inspection' },
      ],
      unknownReason: 'format-undetermined',
      guard: null,
    }
  }
  return {
    behaviour: spec.intrinsic === 'code' ? 'unknown' : spec.intrinsic,
    mechanism:
      spec.intrinsic === 'code'
        ? `${spec.mechanism} No code in this project loads it, so which loader reads it -- and with which flags -- is not visible here.`
        : spec.mechanism,
    steps: [
      { claim: `Recognised as ${spec.label} from its bytes.`, basis: `${artifact.locator} (${artifact.format.basis})` },
      { claim: 'No code in this project loads it.', basis: 'no matching load site' },
      {
        claim:
          spec.intrinsic === 'code'
            ? 'The format carries an execution surface, and whether a flag suppresses it is decided by a call site that is not in this repository.'
            : 'The format carries no execution surface, so no call site can add one.',
        basis: `format: ${spec.id}`,
      },
    ],
    unknownReason: spec.intrinsic === 'code' ? 'artifact-unresolved' : null,
    guard: null,
  }
}

export { unresolvedArtifactBehaviour }

/** Human-readable stage names, shared by the CLI and the UI. */
export const STAGE_META: Readonly<Record<string, { label: string; verb: string }>> = {
  walk: { label: 'Walk', verb: 'Reading the project tree' },
  dependencies: { label: 'Dependencies', verb: 'Reading declared versions' },
  'load-sites': { label: 'Load sites', verb: 'Finding where artifacts are loaded' },
  artifacts: { label: 'Artifacts', verb: 'Recognising artifacts from their bytes' },
  behaviour: { label: 'Behaviour', verb: 'Resolving what loading does' },
  context: { label: 'Context', verb: 'Classifying load contexts' },
  evidence: { label: 'Evidence', verb: 'Binding scanner results to digests' },
  bom: { label: 'Model BOM', verb: 'Assembling the inventory' },
}

export { clip }
