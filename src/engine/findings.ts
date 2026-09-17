/**
 * Findings.
 *
 * Not every artifact is a finding, and no finding is a vulnerability report.
 * A finding here names a *state* worth a decision, says why that state
 * matters, and points at the lines that establish it. The vocabulary is
 * deliberately not CVSS: there is no score, because the two dimensions that
 * matter -- what loading does, and where it is loaded -- are not commensurable
 * and multiplying them would invent precision this analysis does not have.
 *
 * `disposition` is how to act, not how bad it is:
 *
 *   act     there is a concrete change available now
 *   review  a human has to decide something the tool cannot
 *   record  true, worth having in the inventory, no action implied
 */

import { notableGlobals } from './pickle.ts'
import type {
  Alternative,
  Artifact,
  BehaviourVerdict,
  EvidenceRecord,
  Finding,
  FindingDisposition,
  FindingKind,
  LoadContext,
  LoadSite,
} from './types.ts'

interface Input {
  readonly artifact: Artifact
  readonly behaviour: BehaviourVerdict
  readonly sites: readonly LoadSite[]
  readonly contexts: readonly LoadContext[]
  readonly evidence: readonly EvidenceRecord[]
  readonly alternative: Alternative
}

const PRIVILEGED_ENVIRONMENTS = new Set(['production', 'staging', 'service', 'ci', 'build'])

export function deriveFindings(input: Input): readonly Finding[] {
  const { artifact, behaviour, sites, contexts, evidence, alternative } = input
  const findings: Finding[] = []
  const locations = sites.map((s) => `${s.file}:${s.line}`)
  const primary = sites[0] ?? null

  const add = (
    kind: FindingKind,
    disposition: FindingDisposition,
    title: string,
    rationale: string,
    where: readonly string[] = locations,
  ): void => {
    findings.push({
      id: `${kind}:${artifact.id}`,
      kind,
      disposition,
      title,
      rationale,
      artifactId: artifact.id,
      loadSiteId: primary?.id ?? null,
      locations: where.length > 0 ? where : [artifact.locator],
    })
  }

  const privilegedContexts = contexts.filter((c) => c.privileged)
  const exposedEnvironments = contexts.filter((c) => PRIVILEGED_ENVIRONMENTS.has(c.environment))

  /* ---- execution surfaces --------------------------------------------- */
  if (behaviour.behaviour === 'code') {
    if (privilegedContexts.length > 0) {
      const kinds = [...new Set(privilegedContexts.flatMap((c) => c.privileges.map((p) => p.label)))]
      add(
        'privileged-execution-surface',
        'act',
        'Executes on load, in a context holding credentials',
        `${behaviour.mechanism} The loading file also shows ${kinds.slice(0, 3).join(', ').toLowerCase()}, so the process performing the load has that reach. Executability and context are separate facts; this artifact has both.`,
      )
    } else if (exposedEnvironments.length > 0) {
      const where = [...new Set(exposedEnvironments.map((c) => c.environment))]
      add(
        'execution-surface',
        'act',
        `Executes on load, in ${where.join(' and ')}`,
        `${behaviour.mechanism} The load sits in ${where.join(' and ')}, where a compromise reaches further than a workstation.`,
      )
    } else {
      add(
        'execution-surface',
        'review',
        'Executes on load',
        behaviour.mechanism,
      )
    }

    if (artifact.pickle !== null) {
      const notable = notableGlobals(artifact.pickle.globals)
      if (notable.length > 0) {
        add(
          'execution-surface',
          'review',
          `Pickle stream names ${notable.length} notable callable${notable.length === 1 ? '' : 's'}`,
          `The opcode scan found ${notable.join(', ')} named in the stream, read without unpickling. This is worth looking at, and its absence would have meant nothing: the reachable set for a pickle is every importable callable in the environment.`,
          [artifact.locator],
        )
      }
    }
  }

  /* ---- the unpinned default ------------------------------------------- */
  if (behaviour.unknownReason === 'loader-default-unpinned') {
    add(
      'unpinned-loader-default',
      'act',
      'Load behaviour depends on an unpinned library version',
      `${behaviour.mechanism} Pinning the dependency turns this from an open question into a stated fact, and is cheaper than deciding it again every time someone reads this line.`,
    )
  }

  /* ---- remote code ---------------------------------------------------- */
  if (
    behaviour.behaviour === 'code' &&
    (primary?.loader === 'transformers.from_pretrained' ||
      primary?.loader === 'datasets.load_dataset' ||
      primary?.loader === 'torch.hub.load')
  ) {
    add(
      'remote-code-trust',
      'review',
      'Imports code from a remote repository at load',
      'The execution surface is not a serialisation format. It is a repository whose contents can change between the review and the run, and which nothing in this project pins.',
    )
  }

  if (artifact.format.format === 'mcp-server-manifest' && behaviour.behaviour === 'code') {
    add(
      'spawns-process-on-load',
      'review',
      'Spawns a process when the manifest is read',
      'The declared command runs at session start, before any tool is called and before the model has decided anything. What it does is decided by whatever the package resolves to at that moment.',
    )
  }

  /* ---- directive surfaces --------------------------------------------- */
  if (behaviour.behaviour === 'directive') {
    const grants = artifact.format.format === 'agent-definition' || artifact.format.format === 'agent-skill'
    add(
      'directive-surface',
      'record',
      grants ? 'Injects instructions with a tool grant' : 'Injects instructions into a model context',
      `${behaviour.mechanism} It belongs in the inventory for the same reason a model file does: it arrived from somewhere, it is loaded by something, and it changes what the system does.`,
      [artifact.locator],
    )
  }

  /* ---- the same artifact, loaded two different ways ------------------- */
  const perSite = [...new Set(sites.map((s) => s.behaviour.behaviour))]
  if (perSite.length > 1) {
    const worst = sites.find((s) => s.behaviour.behaviour === behaviour.behaviour)
    const others = sites.filter((s) => s.behaviour.behaviour !== behaviour.behaviour)
    add(
      'inconsistent-guard',
      'act',
      'Loaded with different guarantees in different places',
      `${worst === undefined ? '' : `${worst.file}:${worst.line} is ${worst.behaviour.behaviour}`}, while ${others
        .slice(0, 2)
        .map((s) => `${s.file}:${s.line} is ${s.behaviour.behaviour}`)
        .join(' and ')}. The headline verdict for this artifact is the most exposed of its load sites, because "loaded safely" is not true of a file that is also loaded unsafely.`,
    )
  }

  /* ---- migration ------------------------------------------------------ */
  if (alternative.kind === 'sibling-present') {
    add(
      'shadowed-safe-format',
      'act',
      'A data-only copy of this artifact is already in the repository',
      `${alternative.difference} This is a one-line change with nothing to convert and nothing to rebuild.`,
    )
  } else if (alternative.kind === 'loader-guard-available' && behaviour.behaviour === 'code') {
    add(
      'format-migration-available',
      'act',
      alternative.summary,
      `${alternative.difference}${alternative.caveat === null ? '' : ` ${alternative.caveat}`}`,
    )
  } else if (alternative.kind === 'conversion-available' && behaviour.behaviour === 'code') {
    add(
      'format-migration-available',
      'review',
      alternative.summary,
      `${alternative.difference}${alternative.caveat === null ? '' : ` ${alternative.caveat}`}`,
    )
  }

  /* ---- evidence ------------------------------------------------------- */
  const stale = evidence.filter((e) => e.binding === 'stale')
  if (stale.length > 0) {
    add(
      'evidence-stale',
      'review',
      'Scanner evidence is about a different build of this file',
      `${stale[0]?.bindingNote ?? ''} A result recorded against bytes that are no longer here is not evidence about what is here.`,
      [artifact.locator],
    )
  }
  if (
    evidence.length === 0 &&
    (behaviour.behaviour === 'code' || behaviour.unknownReason === 'loader-default-unpinned') &&
    artifact.origin === 'in-tree'
  ) {
    add(
      'evidence-absent',
      'record',
      'No scanner evidence recorded for an executing artifact',
      'An absent scan is not a clean scan. It is also not a finding about the file: it is a gap in what this inventory can say about it.',
      [artifact.locator],
    )
  }

  /* ---- unresolved states ---------------------------------------------- */
  if (
    behaviour.unknownReason === 'path-not-static' ||
    behaviour.unknownReason === 'artifact-unresolved'
  ) {
    add(
      'unresolved-artifact',
      'review',
      'Load target could not be resolved',
      `${behaviour.mechanism} An unresolved target is reported as unresolved rather than assumed safe, because the loader on this line will load something.`,
    )
  }
  if (behaviour.unknownReason === 'remote-contents-unresolvable') {
    add(
      'unresolved-artifact',
      'review',
      'Weights come from a repository this analysis cannot see',
      behaviour.mechanism,
    )
  }
  if (behaviour.unknownReason === 'format-undetermined') {
    add(
      'unresolved-artifact',
      'review',
      'Format could not be determined',
      `${artifact.format.note}. DEADWEIGHT will not guess what loading an unrecognised file does.`,
      [artifact.locator],
    )
  }

  const unresolvedContexts = contexts.filter((c) => c.basis === 'unresolved')
  if (unresolvedContexts.length > 0 && behaviour.behaviour !== 'data') {
    add(
      'unresolved-context',
      'review',
      'Load context is not declared',
      `No path rule matched ${unresolvedContexts.map((c) => c.id.slice(4)).slice(0, 2).join(', ')} and nothing declares which environment it runs in. Whether a load matters depends on where it happens, and this analysis cannot see a deployment.`,
      unresolvedContexts.map((c) => c.id.slice(4)),
    )
  }

  /* ---- format integrity ------------------------------------------------ */
  if (artifact.format.extensionMismatch !== undefined) {
    add(
      'extension-mismatch',
      'review',
      'File extension does not match its contents',
      `${artifact.format.extensionMismatch}. DEADWEIGHT classified by the bytes. Anything else in the pipeline that dispatches on the extension will disagree with that.`,
      [artifact.locator],
    )
  }

  return findings
}

export const FINDING_META: Readonly<
  Record<FindingKind, { label: string; family: 'execution' | 'migration' | 'evidence' | 'unresolved' | 'integrity' }>
> = {
  'execution-surface': { label: 'Execution surface', family: 'execution' },
  'privileged-execution-surface': { label: 'Privileged execution surface', family: 'execution' },
  'unpinned-loader-default': { label: 'Unpinned loader default', family: 'execution' },
  'remote-code-trust': { label: 'Remote code trust', family: 'execution' },
  'spawns-process-on-load': { label: 'Spawns process on load', family: 'execution' },
  'directive-surface': { label: 'Directive surface', family: 'execution' },
  'inconsistent-guard': { label: 'Inconsistent guard', family: 'execution' },
  'shadowed-safe-format': { label: 'Shadowed safe format', family: 'migration' },
  'format-migration-available': { label: 'Format migration available', family: 'migration' },
  'evidence-stale': { label: 'Evidence stale', family: 'evidence' },
  'evidence-absent': { label: 'Evidence absent', family: 'evidence' },
  'unresolved-artifact': { label: 'Unresolved artifact', family: 'unresolved' },
  'unresolved-context': { label: 'Unresolved context', family: 'unresolved' },
  'extension-mismatch': { label: 'Extension mismatch', family: 'integrity' },
}

/** Order findings for display: actionable first, then by family. */
export function rankFindings(findings: readonly Finding[]): readonly Finding[] {
  const disposition: Record<FindingDisposition, number> = { act: 0, review: 1, record: 2 }
  const family = { execution: 0, migration: 1, unresolved: 2, evidence: 3, integrity: 4 }
  return [...findings].sort((a, b) => {
    const byDisposition = disposition[a.disposition] - disposition[b.disposition]
    if (byDisposition !== 0) return byDisposition
    const byFamily = family[FINDING_META[a.kind].family] - family[FINDING_META[b.kind].family]
    if (byFamily !== 0) return byFamily
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
