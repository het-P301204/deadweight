/**
 * Safe-format availability.
 *
 * The question this answers is narrow and practical: can the execution
 * surface be removed by changing the format or the call, rather than by
 * trusting the file?
 *
 * Four answers, strongest first.
 *
 *   sibling-present         the safe file is already sitting next to the
 *                           unsafe one and the code loads the wrong one.
 *                           A one-line change with nothing to convert.
 *   loader-guard-available  the call can take a flag that closes the surface.
 *                           Costs nothing, and is a guard rather than a
 *                           format change, so it is honest about being one
 *                           keyword from reopening.
 *   conversion-available    the payload can be re-serialised into a
 *                           data-oriented format. Real work, real result.
 *   none-identified         no data-oriented equivalent for what this
 *                           artifact carries.
 *
 * Every answer states the security difference in one sentence, and any
 * answer that is not a pure win carries its caveat.
 */

import { DATA_FORMATS, formatSpec } from './formats.ts'
import { dirname, stem } from './source.ts'
import type { Alternative, Artifact, BehaviourVerdict, LoadSite } from './types.ts'

const NONE: Alternative = {
  kind: 'none-identified',
  targetFormat: null,
  summary: 'No data-oriented equivalent identified',
  difference:
    'DEADWEIGHT knows of no format that carries what this artifact carries without an execution or instruction surface.',
  change: null,
  resultingBehaviour: 'unknown',
  caveat: null,
}

export function resolveAlternative(
  artifact: Artifact,
  behaviour: BehaviourVerdict,
  sites: readonly LoadSite[],
): Alternative {
  // Nothing to offer when there is no surface to remove.
  if (behaviour.behaviour === 'data') {
    return {
      kind: 'none-identified',
      targetFormat: null,
      summary: 'Already data-oriented',
      difference: 'Loading this artifact parses data. There is no execution surface to migrate away from.',
      change: null,
      resultingBehaviour: 'data',
      caveat: null,
    }
  }

  const spec = formatSpec(artifact.format.format)

  /* ---- the safe file is already here --------------------------------- */
  const sibling = artifact.siblings.find((s) => DATA_FORMATS.has(s.format))
  if (sibling !== undefined) {
    const site = sites[0]
    return {
      kind: 'sibling-present',
      targetFormat: sibling.format,
      summary: `${formatSpec(sibling.format).label} of the same weights is already in the repository`,
      difference: `${spec.label} carries an execution surface at load; ${formatSpec(sibling.format).label} does not. Both files are present, and the code loads the one that does.`,
      change:
        site === undefined
          ? `Load ${sibling.locator} instead of ${artifact.locator}.`
          : `${site.file}:${site.line} — load \`${sibling.locator}\` instead of \`${artifact.locator}\`.`,
      resultingBehaviour: 'data',
      caveat:
        sibling.format === 'safetensors'
          ? 'safetensors carries weights only. Confirm the architecture comes from your code and not from the checkpoint before deleting the original.'
          : null,
    }
  }

  /* ---- a flag on the call closes the surface -------------------------- */
  const guardable = guardFor(artifact, behaviour, sites)
  if (guardable !== null) return guardable

  /* ---- re-serialise --------------------------------------------------- */
  const target = spec.convertibleTo.find((f) => DATA_FORMATS.has(f))
  if (target !== undefined) {
    return {
      kind: 'conversion-available',
      targetFormat: target,
      summary: `Re-serialise to ${formatSpec(target).label}`,
      difference: `${spec.mechanism} ${formatSpec(target).label}: ${formatSpec(target).shape}, with nothing in the file that names a callable.`,
      change: conversionSnippet(artifact, target),
      resultingBehaviour: 'data',
      caveat:
        target === 'safetensors'
          ? 'Conversion loads the original once, which is the dangerous operation. Do it in an isolated environment, on the build that was scanned, and publish the result.'
          : 'Export runs the model once to trace its graph, so do it in an isolated environment.',
    }
  }

  if (behaviour.behaviour === 'directive') return directiveAlternative(artifact)

  return NONE
}

function guardFor(
  artifact: Artifact,
  behaviour: BehaviourVerdict,
  sites: readonly LoadSite[],
): Alternative | null {
  const site = sites.find((s) => GUARDABLE[s.loader] !== undefined)
  if (site === undefined) return null
  const guard = GUARDABLE[site.loader]
  if (guard === undefined) return null
  // Already guarded: the migration view should not offer the flag twice.
  if (behaviour.guard !== null && behaviour.behaviour !== 'code') return null

  return {
    kind: 'loader-guard-available',
    targetFormat: null,
    summary: guard.summary,
    difference: guard.difference,
    change: `${site.file}:${site.line} — ${guard.change}`,
    resultingBehaviour: 'guarded',
    caveat: guard.caveat,
  }
}

const GUARDABLE: Readonly<
  Record<string, { summary: string; difference: string; change: string; caveat: string }>
> = {
  'torch.load': {
    summary: 'Pass weights_only=True',
    difference:
      'The unrestricted unpickler calls whatever the archive names. The restricted one refuses globals outside its allowlist, so the archive can carry tensors and not instructions.',
    change: 'add `weights_only=True` to the torch.load call',
    caveat:
      'This is an allowlist, not a sandbox, and it is one keyword away from being gone. Converting the artifact to safetensors removes the surface instead of guarding it.',
  },
  'keras.load_model': {
    summary: 'Pass safe_mode=True',
    difference:
      'With safe_mode off, Keras deserialises Lambda-layer bytecode from the file. With it on, Keras refuses to.',
    change: 'add `safe_mode=True` to the load_model call',
    caveat: 'The surface remains in the file; the flag is what closes it.',
  },
  'numpy.load': {
    summary: 'Pass allow_pickle=False',
    difference:
      'With pickling enabled, an object array in the file is unpickled. With it disabled, numpy refuses the array rather than running it.',
    change: 'add `allow_pickle=False` to the numpy.load call',
    caveat: 'If the file genuinely holds object arrays, this turns a silent execution into a loud failure, which is the point.',
  },
  'transformers.from_pretrained': {
    summary: 'Pass use_safetensors=True',
    difference:
      'Without it the loader prefers safetensors and falls back to pickle-backed weights. With it, the loader refuses a repository that offers only the pickle format.',
    change: 'add `use_safetensors=True` to the from_pretrained call',
    caveat:
      'This makes the format a requirement rather than a preference; it says nothing about the repository’s contents otherwise.',
  },
  'datasets.load_dataset': {
    summary: 'Leave trust_remote_code unset',
    difference:
      'With trust_remote_code the dataset repository’s script runs in your process. Without it, only data files are read.',
    change: 'remove `trust_remote_code=True`',
    caveat: 'Datasets that only ship a loading script will need converting to plain data files.',
  },
}

function conversionSnippet(artifact: Artifact, target: string): string {
  const base = stem(artifact.locator)
  const dir = dirname(artifact.locator)
  const out = dir === '' ? `${base}.safetensors` : `${dir}/${base}.safetensors`
  if (target === 'safetensors') {
    return [
      '# In an isolated environment, on the build that was scanned:',
      'import torch',
      'from safetensors.torch import save_file',
      `state = torch.load("${artifact.locator}", weights_only=True)`,
      `save_file(state, "${out}")`,
    ].join('\n')
  }
  return [
    '# In an isolated environment, on the build that was scanned:',
    'import torch',
    `model = torch.load("${artifact.locator}", weights_only=True)`,
    `torch.onnx.export(model, example_input, "${dir === '' ? base : `${dir}/${base}`}.onnx")`,
  ].join('\n')
}

/**
 * Skills, agents and prompts have no safe serialisation format, because the
 * surface is not serialisation. What reduces it is narrowing the grant.
 */
function directiveAlternative(artifact: Artifact): Alternative {
  const isMcp = artifact.format.format === 'mcp-server-manifest'
  return {
    kind: 'none-identified',
    targetFormat: null,
    summary: 'No format change applies; the surface is the grant',
    difference: isMcp
      ? 'The instruction surface of a remote MCP server is its tool list, which the server supplies at connect time. Re-serialising nothing changes that; pinning the server and narrowing what it may reach does.'
      : 'A skill or agent definition executes nothing, so there is no serialisation to replace. What bounds it is the tool grant and the review the file receives before it lands.',
    change: null,
    resultingBehaviour: 'directive',
    caveat:
      'Reported so the artifact appears in the BOM with its reach stated, not because a migration exists.',
  }
}
