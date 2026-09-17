/**
 * DEADWEIGHT domain model.
 *
 * The product answers one question about every AI artifact a codebase loads:
 *
 *     what happens when this is loaded?
 *
 * Everything here exists to answer that question in separable pieces, so that
 * a piece the analyser cannot resolve stays visibly unresolved instead of
 * being folded into a number. In particular there is no severity score: load
 * behaviour and load context are orthogonal dimensions and are reported as a
 * coordinate, never multiplied together.
 *
 * No `enum` anywhere: the CLI runs these sources under Node's type stripping,
 * which cannot emit the runtime object an enum needs.
 */

/* -------------------------------------------------------------------------- */
/* Load behaviour                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What loading the artifact does, in the process that loads it.
 *
 * `guarded` is not a weaker `data`. It means the artifact's format *does*
 * carry an execution surface and a documented restriction at the call site is
 * the only thing suppressing it -- an allowlist, a safe-mode flag, a safe
 * loader class. Remove the flag and the row turns red. That is a materially
 * different fact from a format that has no execution surface to suppress,
 * which is why it is not merged into `data`.
 *
 * `directive` is the AI-native surface. Loading a skill, an agent definition
 * or a tool description executes nothing, but it places
 * attacker-influenceable instructions where a model will act on them. It is
 * reported separately rather than as `data`, because "no code runs" is a
 * misleading summary of an artifact whose entire purpose is to make something
 * else run.
 */
export type LoadBehaviour = 'code' | 'directive' | 'guarded' | 'data' | 'unknown'

export const LOAD_BEHAVIOURS: readonly LoadBehaviour[] = [
  'code',
  'directive',
  'guarded',
  'data',
  'unknown',
]

/** Why a load behaviour could not be resolved. Never empty when behaviour is `unknown`. */
export type UnknownReasonCode =
  | 'loader-default-unpinned'
  | 'artifact-unresolved'
  | 'format-undetermined'
  | 'path-not-static'
  | 'remote-contents-unresolvable'
  | 'loader-unrecognised'
  | 'artifact-unreadable'

/* -------------------------------------------------------------------------- */
/* Formats                                                                    */
/* -------------------------------------------------------------------------- */

export type FormatId =
  | 'pickle'
  | 'pytorch-zip'
  | 'pytorch-legacy'
  | 'torchscript'
  | 'joblib'
  | 'numpy-npy'
  | 'numpy-npz'
  | 'safetensors'
  | 'onnx'
  | 'gguf'
  | 'tflite'
  | 'keras-h5'
  | 'keras-v3'
  | 'tf-savedmodel'
  | 'flax-msgpack'
  | 'agent-skill'
  | 'mcp-server-manifest'
  | 'agent-definition'
  | 'prompt-template'
  | 'remote-repository'
  | 'unknown'

/** Static description of a serialisation format's load semantics. */
export interface FormatSpec {
  readonly id: FormatId
  readonly label: string
  /** Short noun phrase: "zip archive containing a pickle stream". */
  readonly shape: string
  /**
   * What the format does when a loader reads it, independent of any flag the
   * call site passes. Call-site flags are applied later, in behaviour.ts.
   */
  readonly intrinsic: LoadBehaviour
  /** One sentence on the mechanism. Shown verbatim in the UI. */
  readonly mechanism: string
  /** Whether a data-oriented replacement exists for this kind of payload. */
  readonly convertibleTo: readonly FormatId[]
  /** Extensions that suggest this format, before any byte inspection. */
  readonly extensions: readonly string[]
}

/** How confident the classifier is, and on what basis. */
export type FormatBasis = 'magic' | 'container' | 'extension' | 'declared' | 'none'

export interface FormatVerdict {
  readonly format: FormatId
  readonly basis: FormatBasis
  /** Human-readable note on what was actually read, e.g. "PK\\x03\\x04 + data.pkl member". */
  readonly note: string
  /** Set when the extension and the bytes disagree. A real signal, not a nit. */
  readonly extensionMismatch?: string
}

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                  */
/* -------------------------------------------------------------------------- */

export type ArtifactOrigin = 'in-tree' | 'remote-reference' | 'unresolved'

export interface ArtifactDigest {
  readonly algorithm: 'sha256'
  readonly value: string
  /**
   * `full` when every byte was hashed. `head-tail` when the file exceeded the
   * digest cap and only its head, tail and length were hashed -- still stable
   * and still useful for change detection, but it is not the same number a
   * scanner would produce, so evidence binding treats the two as distinct.
   */
  readonly coverage: 'full' | 'head-tail'
  readonly bytes: number
}

/** A pickle opcode observation. Produced without importing or running pickle. */
export interface PickleObservation {
  /** Pickle protocol version from the PROTO opcode, when present. */
  readonly protocol: number | null
  /** `module.name` pairs named by GLOBAL / STACK_GLOBAL opcodes, deduplicated. */
  readonly globals: readonly string[]
  /** Whether any opcode that invokes a callable is present. */
  readonly invokesCallable: boolean
  /** Opcode names observed that invoke a callable, e.g. REDUCE, INST, NEWOBJ. */
  readonly invokingOpcodes: readonly string[]
  /** True when the scan stopped at the byte cap before reaching STOP. */
  readonly truncated: boolean
}

export interface Artifact {
  /** Stable identity: path for in-tree files, `scheme:ref` for remote references. */
  readonly id: string
  readonly name: string
  /** Repo-relative POSIX path, or the remote reference string. */
  readonly locator: string
  readonly origin: ArtifactOrigin
  readonly format: FormatVerdict
  readonly sizeBytes: number | null
  readonly digest: ArtifactDigest | null
  /** Version string when one is declared or parseable from the reference. */
  readonly version: string | null
  /** Opcode-level observation for pickle-bearing artifacts. */
  readonly pickle: PickleObservation | null
  /** Safetensors header keys, when the header parsed. Data-only proof. */
  readonly tensorHeader: { readonly entries: number; readonly metadata: Record<string, string> } | null
  /** Sibling files with the same stem in the same directory, by format. */
  readonly siblings: readonly { readonly locator: string; readonly format: FormatId }[]
}

/* -------------------------------------------------------------------------- */
/* Load sites                                                                 */
/* -------------------------------------------------------------------------- */

export type LoaderEcosystem = 'python' | 'javascript' | 'config'

/** Static rule describing one loader call and how its flags change behaviour. */
export interface LoaderSpec {
  readonly id: string
  readonly ecosystem: LoaderEcosystem
  /** Display name, e.g. `torch.load`. */
  readonly label: string
  /** Distribution that provides it, for version resolution. */
  readonly distribution: string | null
  /** One line on what the call does with the bytes it is given. */
  readonly summary: string
  /** Doc anchor id in docs/load-semantics.md. */
  readonly reference: string
}

export interface CallArgument {
  readonly keyword: string | null
  /** Literal value when the argument is a string/bool/number literal; else null. */
  readonly literal: string | null
  /** Raw source text of the argument, trimmed and length-capped. */
  readonly text: string
}

export interface LoadSite {
  readonly id: string
  /** Repo-relative POSIX path of the source file. */
  readonly file: string
  /** 1-indexed line of the call. */
  readonly line: number
  /** Enclosing function or notebook cell, when resolvable. */
  readonly enclosing: string | null
  readonly loader: string
  /** The call as written, length-capped and never re-emitted as code. */
  readonly snippet: string
  readonly args: readonly CallArgument[]
  /** Artifact id this call resolves to, or null when the path is not static. */
  readonly artifactId: string | null
  /** What the path expression looked like, for the unresolved case. */
  readonly targetExpression: string
  readonly contextId: string
  /**
   * What loading does *at this site*.
   *
   * Per-site rather than per-artifact, because one checkpoint is routinely
   * loaded with `weights_only=True` in a request handler and without it in a
   * CI script. The artifact's headline verdict is then the most exposed of
   * its sites, and the disagreement is itself a finding.
   */
  readonly behaviour: BehaviourVerdict
}

/* -------------------------------------------------------------------------- */
/* Behaviour resolution                                                       */
/* -------------------------------------------------------------------------- */

/** A single step of the reasoning that produced a behaviour, shown in the UI. */
export interface BehaviourStep {
  readonly claim: string
  /** Where the claim came from: a file:line, a pinned version, a format spec. */
  readonly basis: string
}

export interface BehaviourVerdict {
  readonly behaviour: LoadBehaviour
  /** One sentence naming the mechanism. Never a euphemism. */
  readonly mechanism: string
  readonly steps: readonly BehaviourStep[]
  readonly unknownReason: UnknownReasonCode | null
  /**
   * For `guarded`: the exact flag holding the surface shut, so the UI can say
   * what removing it would do.
   */
  readonly guard: { readonly expression: string; readonly ifRemoved: LoadBehaviour } | null
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

export type EnvironmentId =
  | 'production'
  | 'staging'
  | 'service'
  | 'ci'
  | 'build'
  | 'notebook'
  | 'test'
  | 'development'
  | 'sandbox'
  | 'unresolved'

/** Where the context classification came from. Inferred is not declared. */
export type ContextBasis = 'declared' | 'inferred' | 'unresolved'

export type PrivilegeKind =
  | 'cloud-credentials'
  | 'secret-material'
  | 'orchestration-api'
  | 'datastore-write'
  | 'process-execution'
  | 'network-egress'
  | 'filesystem-write'

export interface PrivilegeSignal {
  readonly kind: PrivilegeKind
  readonly label: string
  readonly file: string
  readonly line: number
  readonly evidence: string
}

export interface LoadContext {
  readonly id: string
  /** The source file this context describes. */
  readonly file: string
  readonly environment: EnvironmentId
  readonly basis: ContextBasis
  /** The glob or path rule that matched, quoted for the UI. */
  readonly rule: string
  readonly privileges: readonly PrivilegeSignal[]
  /** True when any privilege signal is present in the loading file. */
  readonly privileged: boolean
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

export type EvidenceBinding = 'current' | 'stale' | 'unbound' | 'absent'
export type EvidenceResult = 'pass' | 'flagged' | 'error' | 'skipped'

/** Static description of what a scanner can and cannot see. */
export interface ScannerProfile {
  readonly id: string
  readonly label: string
  readonly inspects: readonly string[]
  /**
   * Named limitation classes. These are the reason a scanner result is
   * evidence rather than assurance, and they are shown next to every result.
   */
  readonly limitations: readonly string[]
}

export interface EvidenceRecord {
  readonly id: string
  readonly scanner: string
  readonly scannerVersion: string | null
  /** Artifact this record claims to be about. */
  readonly subject: string
  /** Digest the scanner recorded for its subject, when it recorded one. */
  readonly subjectDigest: string | null
  readonly result: EvidenceResult
  readonly detail: string
  readonly binding: EvidenceBinding
  /** Present when `binding` is `stale`: what the artifact hashes to now. */
  readonly bindingNote: string | null
  /** Source file the record was read from. */
  readonly source: string
}

/* -------------------------------------------------------------------------- */
/* Alternatives                                                               */
/* -------------------------------------------------------------------------- */

export type AlternativeKind =
  | 'sibling-present'
  | 'loader-guard-available'
  | 'conversion-available'
  | 'none-identified'

export interface Alternative {
  readonly kind: AlternativeKind
  readonly targetFormat: FormatId | null
  readonly summary: string
  /** What the security difference actually is, in one sentence. */
  readonly difference: string
  /** Concrete change, shown as copyable text. Never executed by DEADWEIGHT. */
  readonly change: string | null
  /** Behaviour the artifact would have after the change. */
  readonly resultingBehaviour: LoadBehaviour
  /** Honest caveat, when the change is not a pure win. */
  readonly caveat: string | null
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export type FindingKind =
  | 'execution-surface'
  | 'privileged-execution-surface'
  | 'unpinned-loader-default'
  | 'remote-code-trust'
  | 'spawns-process-on-load'
  | 'directive-surface'
  | 'inconsistent-guard'
  | 'shadowed-safe-format'
  | 'format-migration-available'
  | 'evidence-stale'
  | 'evidence-absent'
  | 'unresolved-artifact'
  | 'unresolved-context'
  | 'extension-mismatch'

/** Not a severity. It is how the finding should be acted on. */
export type FindingDisposition = 'act' | 'review' | 'record'

export interface Finding {
  readonly id: string
  readonly kind: FindingKind
  readonly disposition: FindingDisposition
  readonly title: string
  /** Why it matters. Required: a finding without this is noise. */
  readonly rationale: string
  readonly artifactId: string | null
  readonly loadSiteId: string | null
  readonly locations: readonly string[]
}

/* -------------------------------------------------------------------------- */
/* Assembled records                                                          */
/* -------------------------------------------------------------------------- */

/** One artifact, fully resolved through the pipeline. The unit of the UI. */
export interface ArtifactRecord {
  readonly artifact: Artifact
  readonly loadSites: readonly LoadSite[]
  readonly behaviour: BehaviourVerdict
  readonly contexts: readonly LoadContext[]
  readonly evidence: readonly EvidenceRecord[]
  readonly alternative: Alternative
  readonly findings: readonly Finding[]
  /**
   * The six-cell signature. Each cell is resolved, unresolved or flagged; the
   * UI renders it identically everywhere it appears.
   */
  readonly stripe: LoadStripe
}

export type StripeCellState = 'resolved' | 'unresolved' | 'flagged'

export interface StripeCell {
  readonly stage: StripeStage
  readonly state: StripeCellState
  readonly label: string
  readonly detail: string
}

export type StripeStage = 'format' | 'load' | 'exec' | 'context' | 'evidence' | 'alternative'

export const STRIPE_STAGES: readonly StripeStage[] = [
  'format',
  'load',
  'exec',
  'context',
  'evidence',
  'alternative',
]

export type LoadStripe = readonly StripeCell[]

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

export interface Summary {
  readonly artifacts: number
  readonly behaviour: Readonly<Record<LoadBehaviour, number>>
  readonly privilegedLoads: number
  readonly migrationsAvailable: number
  readonly loadSites: number
  readonly unresolvedLoadSites: number
  readonly evidenceRecords: number
  readonly staleEvidence: number
  readonly environments: Readonly<Record<EnvironmentId, number>>
  readonly formats: Readonly<Record<string, number>>
  /** behaviour x environment, for the matrix. Keyed `behaviour|environment`. */
  readonly matrix: Readonly<Record<string, number>>
}

export interface AnalysisNotice {
  readonly code: string
  readonly severity: 'info' | 'warning'
  readonly message: string
  readonly path: string | null
}

export interface Report {
  readonly schema: 'deadweight.report/1'
  readonly project: string
  readonly records: readonly ArtifactRecord[]
  readonly contexts: readonly LoadContext[]
  readonly orphanLoadSites: readonly LoadSite[]
  readonly findings: readonly Finding[]
  readonly summary: Summary
  readonly notices: readonly AnalysisNotice[]
  readonly dependencies: readonly ResolvedDependency[]
  /** Deterministic digest of the canonical report body. */
  readonly digest: string
  readonly counts: { readonly filesWalked: number; readonly filesRead: number; readonly bytesRead: number }
}

export interface ResolvedDependency {
  readonly name: string
  readonly version: string | null
  /** Exactly pinned, bounded by a range, or merely present. */
  readonly pin: 'exact' | 'range' | 'unpinned'
  readonly source: string
  readonly constraint: string
}

/* -------------------------------------------------------------------------- */
/* Analysis progress                                                          */
/* -------------------------------------------------------------------------- */

export type StageId =
  | 'walk'
  | 'dependencies'
  | 'load-sites'
  | 'artifacts'
  | 'behaviour'
  | 'context'
  | 'evidence'
  | 'bom'

export const STAGE_ORDER: readonly StageId[] = [
  'walk',
  'dependencies',
  'load-sites',
  'artifacts',
  'behaviour',
  'context',
  'evidence',
  'bom',
]

export interface StageEvent {
  readonly stage: StageId
  readonly status: 'running' | 'done'
  /** Real count produced by the stage, never a synthetic percentage. */
  readonly detail: string
}

export type ProgressFn = (event: StageEvent) => void
