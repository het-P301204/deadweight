/**
 * The load stripe.
 *
 * DEADWEIGHT's signature. Six cells, one per stage of the pipeline, each in
 * one of three states:
 *
 *   resolved    the stage answered
 *   unresolved  the stage could not answer, and says why
 *   flagged     the stage answered, and the answer needs a decision
 *
 *   FORMAT   what the artifact is
 *   LOAD     where it is loaded from
 *   EXEC     what loading does
 *   CONTEXT  where that happens
 *   EVIDENCE what has been checked, and by what
 *   ALT      whether the surface can be removed
 *
 * It is computed here, once, so that the full-size diagram on the overview,
 * the inline glyph on every row and the traced path in the detail drawer are
 * the same six facts rendered at three sizes -- and so that "the stripe is
 * wrong" is a test failure rather than a CSS argument.
 */

import { ENVIRONMENT_META } from './context.ts'
import { formatSpec } from './formats.ts'
import type {
  Alternative,
  Artifact,
  BehaviourVerdict,
  EvidenceRecord,
  LoadContext,
  LoadSite,
  LoadStripe,
  StripeCell,
} from './types.ts'

export const STAGE_META: Readonly<
  Record<StripeCell['stage'], { label: string; short: string; question: string }>
> = {
  format: { label: 'Format', short: 'FMT', question: 'What is it?' },
  load: { label: 'Load', short: 'LOAD', question: 'Where is it loaded?' },
  exec: { label: 'Execution', short: 'EXEC', question: 'What happens when it loads?' },
  context: { label: 'Context', short: 'CTX', question: 'Where does that happen?' },
  evidence: { label: 'Evidence', short: 'EVID', question: 'What has been checked?' },
  alternative: { label: 'Alternative', short: 'ALT', question: 'Can the surface be removed?' },
}

interface Input {
  readonly artifact: Artifact
  readonly sites: readonly LoadSite[]
  readonly behaviour: BehaviourVerdict
  readonly contexts: readonly LoadContext[]
  readonly evidence: readonly EvidenceRecord[]
  readonly alternative: Alternative
}

export function buildStripe(input: Input): LoadStripe {
  const { artifact, sites, behaviour, contexts, evidence, alternative } = input
  const cells: StripeCell[] = []

  /* format ---------------------------------------------------------------- */
  const spec = formatSpec(artifact.format.format)
  if (artifact.format.format === 'unknown') {
    cells.push({
      stage: 'format',
      state: 'unresolved',
      label: 'Unrecognised',
      detail: artifact.format.note,
    })
  } else if (artifact.format.extensionMismatch !== undefined) {
    cells.push({
      stage: 'format',
      state: 'flagged',
      label: spec.label,
      detail: artifact.format.extensionMismatch,
    })
  } else {
    cells.push({
      stage: 'format',
      state: artifact.format.basis === 'extension' ? 'unresolved' : 'resolved',
      label: spec.label,
      detail:
        artifact.format.basis === 'extension'
          ? `Identified from the extension only: ${artifact.format.note}`
          : artifact.format.note,
    })
  }

  /* load ------------------------------------------------------------------ */
  if (sites.length === 0) {
    cells.push({
      stage: 'load',
      state: 'unresolved',
      label: 'No load site found',
      detail:
        'The artifact is in the tree but DEADWEIGHT found no code that loads it. It may be loaded by something outside this repository, or not at all.',
    })
  } else {
    const first = sites[0] as LoadSite
    cells.push({
      stage: 'load',
      state: 'resolved',
      label: sites.length === 1 ? `${first.file}:${first.line}` : `${sites.length} load sites`,
      detail:
        sites.length === 1
          ? `Loaded by ${first.loader} at ${first.file}:${first.line}${first.enclosing === null ? '' : ` in ${first.enclosing}`}.`
          : // Bounded. This string becomes an `aria-label`, a tooltip body and
            // an SVG `<title>`; joining every site made it 94,000 characters
            // for an artifact loaded 5,000 times, which is a row a screen
            // reader cannot get past.
            `Loaded from ${sites.length} places, including ${sites
              .slice(0, 4)
              .map((s) => `${s.file}:${s.line}`)
              .join(', ')}${sites.length > 4 ? ', and others' : ''}.`,
    })
  }

  /* exec ------------------------------------------------------------------ */
  cells.push({
    stage: 'exec',
    state:
      behaviour.behaviour === 'unknown'
        ? 'unresolved'
        : behaviour.behaviour === 'code' || behaviour.behaviour === 'directive'
          ? 'flagged'
          : 'resolved',
    label: BEHAVIOUR_LABEL[behaviour.behaviour],
    detail: behaviour.mechanism,
  })

  /* context --------------------------------------------------------------- */
  if (contexts.length === 0) {
    cells.push({
      stage: 'context',
      state: 'unresolved',
      label: 'No context',
      detail: 'There is no load site, so there is no context to classify.',
    })
  } else {
    const unresolved = contexts.filter((c) => c.basis === 'unresolved')
    const privileged = contexts.filter((c) => c.privileged)
    const environments = [...new Set(contexts.map((c) => c.environment))]
    if (unresolved.length === contexts.length) {
      cells.push({
        stage: 'context',
        state: 'unresolved',
        label: 'Unresolved',
        detail: unresolved[0]?.rule ?? 'No environment could be resolved for this load.',
      })
    } else if (privileged.length > 0) {
      const kinds = [...new Set(privileged.flatMap((c) => c.privileges.map((p) => p.label)))]
      cells.push({
        stage: 'context',
        state: 'flagged',
        label: `${environments.map((e) => ENVIRONMENT_META[e].short).join(' · ')} · privileged`,
        detail: `The loading file shows ${kinds.join(', ').toLowerCase()}.`,
      })
    } else {
      cells.push({
        stage: 'context',
        state: 'resolved',
        label: environments.map((e) => ENVIRONMENT_META[e].short).join(' · '),
        detail: environments.map((e) => `${ENVIRONMENT_META[e].label}: ${ENVIRONMENT_META[e].note}`).join(' '),
      })
    }
  }

  /* evidence -------------------------------------------------------------- */
  const current = evidence.filter((e) => e.binding === 'current')
  const stale = evidence.filter((e) => e.binding === 'stale')
  const unbound = evidence.filter((e) => e.binding === 'unbound')
  if (evidence.length === 0) {
    cells.push({
      stage: 'evidence',
      state: 'unresolved',
      label: 'None recorded',
      detail: 'No scanner result is recorded for this artifact. An absent scan is not a clean scan.',
    })
  } else if (stale.length > 0) {
    cells.push({
      stage: 'evidence',
      state: 'flagged',
      label: `${stale.length} stale`,
      detail: stale[0]?.bindingNote ?? 'A record is bound to a digest that is not the file on disk.',
    })
  } else if (current.length > 0) {
    const flagged = current.filter((e) => e.result === 'flagged')
    cells.push({
      stage: 'evidence',
      state: flagged.length > 0 ? 'flagged' : 'resolved',
      label:
        flagged.length > 0
          ? `${flagged.length} flagged`
          : `${current.length} bound · ${[...new Set(current.map((e) => e.scanner))].join(', ')}`,
      detail:
        flagged.length > 0
          ? (flagged[0]?.detail ?? '')
          : `${current.length} record${current.length === 1 ? '' : 's'} bound to the digest on disk. Evidence, not assurance: each scanner’s coverage is stated alongside it.`,
    })
  } else {
    cells.push({
      stage: 'evidence',
      state: 'unresolved',
      label: `${unbound.length} unbound`,
      detail: unbound[0]?.bindingNote ?? 'Records exist but nothing ties them to the bytes on disk.',
    })
  }

  /* alternative ----------------------------------------------------------- */
  if (behaviour.behaviour === 'data') {
    cells.push({
      stage: 'alternative',
      state: 'resolved',
      label: 'Not needed',
      detail: 'Loading parses data. There is no execution surface to migrate away from.',
    })
  } else if (alternative.kind === 'none-identified') {
    cells.push({
      stage: 'alternative',
      state: 'unresolved',
      label: 'None identified',
      detail: alternative.difference,
    })
  } else {
    cells.push({
      stage: 'alternative',
      state: 'flagged',
      label: alternative.summary,
      detail: alternative.difference,
    })
  }

  return cells
}

export const BEHAVIOUR_LABEL: Readonly<Record<BehaviourVerdict['behaviour'], string>> = {
  code: 'Executes on load',
  directive: 'Directs on load',
  guarded: 'Guarded',
  data: 'Data only',
  unknown: 'Unknown',
}

export const BEHAVIOUR_NOTE: Readonly<Record<BehaviourVerdict['behaviour'], string>> = {
  code: 'Loading this artifact runs code in the loading process.',
  directive:
    'Loading injects instructions into a model context. Nothing runs at load; what runs afterwards is whatever the instructions direct.',
  guarded:
    'The format carries an execution surface and a flag at the call site is suppressing it. Safe only while that flag holds.',
  data: 'The format has no execution or instruction surface. Loading parses data.',
  unknown: 'DEADWEIGHT could not resolve what loading does, and states the reason rather than guessing.',
}
