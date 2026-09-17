/**
 * One load site, drawn as the chain it is.
 *
 *   source file  ->  function  ->  loader  ->  artifact  ->  behaviour
 *
 * A list of file paths does not say that `torch.load` is what turns
 * `weights/ranker.bin` into an object, or that the flag deciding it is on
 * this line and not another. The chain does, and it is the same reading
 * order as the stripe, so the two reinforce each other.
 *
 * Each site carries its own verdict, because one checkpoint is routinely
 * loaded with a guard in one place and without it in another.
 */

import { loaderSpec } from '../engine/loaders.ts'
import type { LoadSite } from '../engine/types.ts'
import { ExecutionIndicator, PathRef, cx } from './primitives.tsx'
import { BEHAVIOUR_STYLE, SURFACE, TYPE } from './tokens.ts'
import { Tooltip } from './Tooltip.tsx'

export function LoadPathFlow({
  site,
  artifactName,
  compact,
}: {
  site: LoadSite
  artifactName: string
  compact?: boolean
}) {
  const loader = loaderSpec(site.loader)
  const declared = site.loader.startsWith('declared:')
  const style = BEHAVIOUR_STYLE[site.behaviour.behaviour]

  return (
    <div className={cx(SURFACE.well, 'overflow-hidden')}>
      <div className="flex flex-wrap items-stretch">
        <Node label="Source" first>
          <PathRef path={site.file} line={site.line} />
        </Node>

        <Arrow />

        <Node label={declared ? 'Declared in' : 'Function'}>
          <span className="font-mono text-xs text-ink-1">
            {site.enclosing ?? (declared ? 'manifest entry' : 'module scope')}
          </span>
        </Node>

        <Arrow />

        <Node label="Loader">
          {declared ? (
            <span className="font-mono text-xs text-ink-1">
              {site.loader.replace('declared:', '')}
            </span>
          ) : (
            <Tooltip width={300} content={loader?.summary ?? ''}>
              <span className="font-mono text-xs text-accent">{loader?.label ?? site.loader}</span>
            </Tooltip>
          )}
        </Node>

        <Arrow />

        <Node label="Artifact">
          <span className="truncate-flex font-mono text-xs text-ink-1">{artifactName}</span>
        </Node>

        <Arrow />

        <Node label="Behaviour" last>
          <ExecutionIndicator behaviour={site.behaviour.behaviour} size="sm" />
        </Node>
      </div>

      {compact !== true && (
        <div className={cx('border-t px-3 py-3', style.border)}>
          <p className="text-xs leading-relaxed text-ink-1">{site.behaviour.mechanism}</p>
          {site.snippet !== '' && (
            <code className="mt-2.5 block overflow-x-auto whitespace-pre rounded bg-surface-0/60 px-2.5 py-2 font-mono text-2xs text-ink-2 scroll-thin">
              {site.snippet}
            </code>
          )}
          {site.args.length > 0 && (
            <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
              {site.args
                .filter((argument) => argument.keyword !== null)
                .map((argument) => (
                  <div key={argument.keyword} className="flex items-baseline gap-1.5">
                    <dt className="font-mono text-2xs text-ink-3">{argument.keyword}</dt>
                    <dd className="font-mono text-2xs text-ink-1">
                      {argument.literal ?? argument.text}
                    </dd>
                  </div>
                ))}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}

function Node({
  label,
  children,
  first,
  last,
}: {
  label: string
  children: React.ReactNode
  first?: boolean
  last?: boolean
}) {
  return (
    <div
      className={cx(
        'min-w-0 flex-1 basis-[150px] px-3 py-2.5',
        !first && 'border-l border-line-1',
        last && 'bg-surface-2/40',
      )}
    >
      <p className={cx(TYPE.eyebrow, 'mb-1')}>{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Arrow() {
  return (
    <div aria-hidden className="hidden shrink-0 items-center px-0 text-ink-3 sm:flex">
      <span className="-mx-1.5 text-[10px]">&#9656;</span>
    </div>
  )
}
