/**
 * CycloneDX 1.6 ML-BOM export.
 *
 * A subset, and labelled as one. CycloneDX 1.6 has a
 * `machine-learning-model` component type and a `modelCard` structure, and
 * DEADWEIGHT populates the parts it can fill from a static analysis of a
 * repository: identity, hashes, component type, and the properties that carry
 * this tool's own findings.
 *
 * What it does not populate is as important. There is no `modelParameters`
 * describing architecture or datasets, no `quantitativeAnalysis`, and no
 * `considerations`, because those are facts about how a model was trained and
 * this analyser never opens one. Emitting empty structures for them would
 * make a document that looks complete and is not.
 *
 * The DEADWEIGHT-specific facts travel as namespaced `properties`, which is
 * what the specification provides for exactly this case. `deadweight:` keys
 * are the load behaviour, its mechanism, the guard, the context and the
 * evidence binding -- the things no standard field has a home for.
 */

import { formatSpec } from './formats.ts'
import type { ModelBom } from './bom.ts'
import type { BomEntry } from './bom.ts'

export const CYCLONEDX_SPEC_VERSION = '1.6'

interface Property {
  readonly name: string
  readonly value: string
}

interface Component {
  readonly type: string
  readonly 'bom-ref': string
  readonly name: string
  readonly version?: string
  readonly description: string
  readonly hashes?: ReadonlyArray<{ readonly alg: string; readonly content: string }>
  readonly properties: readonly Property[]
}

export interface CycloneDxBom {
  readonly bomFormat: 'CycloneDX'
  readonly specVersion: typeof CYCLONEDX_SPEC_VERSION
  readonly version: 1
  readonly metadata: {
    readonly component: { readonly type: 'application'; readonly name: string; readonly 'bom-ref': string }
    readonly tools: {
      readonly components: ReadonlyArray<{
        readonly type: 'application'
        readonly name: string
        readonly description: string
      }>
    }
    readonly properties: readonly Property[]
  }
  readonly components: readonly Component[]
}

/**
 * The coverage note that travels inside the document. A consumer reading the
 * JSON without the README still learns what is missing and why.
 */
export const COVERAGE_NOTE =
  'Subset export. DEADWEIGHT populates component identity, hashes and its own load-behaviour analysis as namespaced properties. modelParameters, quantitativeAnalysis and considerations are omitted rather than emitted empty: this tool analyses a repository statically and never loads a model, so it has no basis for them.'

export function toCycloneDx(bom: ModelBom): CycloneDxBom {
  return {
    bomFormat: 'CycloneDX',
    specVersion: CYCLONEDX_SPEC_VERSION,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: bom.project,
        'bom-ref': `project:${bom.project}`,
      },
      tools: {
        components: [
          {
            type: 'application',
            name: 'deadweight',
            description: 'AI model and skill supply-chain analyzer',
          },
        ],
      },
      properties: [
        { name: 'deadweight:schema', value: bom.schema },
        { name: 'deadweight:digest', value: bom.digest },
        { name: 'deadweight:coverage', value: COVERAGE_NOTE },
        {
          name: 'deadweight:determinism',
          value: 'No timestamp is emitted. Two analyses of the same tree produce an identical document.',
        },
      ],
    },
    components: bom.entries.map(toComponent),
  }
}

function toComponent(entry: BomEntry): Component {
  const spec = formatSpec(entry.format.id)
  const properties: Property[] = [
    { name: 'deadweight:format', value: entry.format.id },
    { name: 'deadweight:format.basis', value: entry.format.basis },
    { name: 'deadweight:format.note', value: entry.format.note },
    { name: 'deadweight:load.behaviour', value: entry.load.behaviour },
    { name: 'deadweight:load.mechanism', value: entry.load.mechanism },
  ]

  if (entry.load.guard !== null) {
    properties.push({ name: 'deadweight:load.guard', value: entry.load.guard })
    properties.push({
      name: 'deadweight:load.guardRemovedBecomes',
      value: entry.load.guardRemovedBecomes ?? 'unknown',
    })
  }
  if (entry.load.unresolvedReason !== null) {
    properties.push({
      name: 'deadweight:load.unresolvedReason',
      value: entry.load.unresolvedReason,
    })
  }
  for (const site of entry.loadSites) {
    properties.push({
      name: 'deadweight:loadSite',
      value: `${site.file}:${site.line} via ${site.loader}`,
    })
  }
  for (const context of entry.contexts) {
    properties.push({
      name: 'deadweight:context',
      value: `${context.environment} (${context.basis})${context.privileged ? ` privileged: ${context.privileges.join(',')}` : ''}`,
    })
  }
  for (const record of entry.evidence) {
    properties.push({
      name: 'deadweight:evidence',
      value: `${record.scanner}${record.version === null ? '' : ` ${record.version}`} → ${record.result}, binding ${record.binding}`,
    })
  }
  if (entry.evidence.length === 0) {
    properties.push({
      name: 'deadweight:evidence',
      value: 'none recorded; an absent scan is not a clean scan',
    })
  }
  properties.push({ name: 'deadweight:alternative', value: entry.alternative.kind })
  if (entry.alternative.targetFormat !== null) {
    properties.push({
      name: 'deadweight:alternative.target',
      value: entry.alternative.targetFormat,
    })
  }
  for (const finding of entry.findings) {
    properties.push({ name: 'deadweight:finding', value: finding })
  }

  const base: Component = {
    // Skills, agents and prompts are not models. Typing them as `data`
    // components is closer to true than calling a Markdown file a model.
    type: isModel(entry) ? 'machine-learning-model' : 'data',
    'bom-ref': entry.id,
    name: entry.name,
    description: `${spec.shape}. ${entry.load.mechanism}`,
    properties,
    ...(entry.version === null ? {} : { version: entry.version }),
    ...(entry.digest === null
      ? {}
      : {
          hashes: [
            {
              alg: 'SHA-256',
              content: entry.digest.value,
            },
          ],
        }),
  }
  return base
}

function isModel(entry: BomEntry): boolean {
  return !(
    entry.format.id === 'agent-skill' ||
    entry.format.id === 'agent-definition' ||
    entry.format.id === 'prompt-template' ||
    entry.format.id === 'mcp-server-manifest'
  )
}
