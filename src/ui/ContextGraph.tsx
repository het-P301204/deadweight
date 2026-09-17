/**
 * The context graph.
 *
 *   environment  ->  source file  ->  loader  ->  artifact
 *
 * Four columns, because that is the chain that decides whether a load
 * matters. Clicking any node selects its connected component and dims
 * everything else: click `production` and the artifacts loaded there light
 * up; click an artifact and every path that reaches it does.
 *
 * Laid out arithmetically rather than by a force simulation. A force layout
 * would look livelier and would put the same graph in a different place every
 * time, which is exactly wrong for something two people need to discuss.
 */

import { useMemo, useState } from 'react'

import { ENVIRONMENT_META, ENVIRONMENT_ORDER } from '../engine/context.ts'
import { loaderSpec } from '../engine/loaders.ts'
import { BEHAVIOUR_LABEL } from '../engine/stripe.ts'
import type { ArtifactRecord, EnvironmentId, LoadBehaviour } from '../engine/types.ts'
import { cx } from './primitives.tsx'
import { elideName, elidePath } from './text.ts'
import { BEHAVIOUR_RGB } from './tokens.ts'

type NodeKind = 'environment' | 'file' | 'loader' | 'artifact'

interface GraphNode {
  readonly id: string
  readonly kind: NodeKind
  readonly label: string
  readonly detail: string
  readonly behaviour: LoadBehaviour | null
  readonly privileged: boolean
  readonly artifactId: string | null
}

interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly behaviour: LoadBehaviour
}

const COLUMNS: readonly NodeKind[] = ['environment', 'file', 'loader', 'artifact']
const COLUMN_LABEL: Record<NodeKind, string> = {
  environment: 'Environment',
  file: 'Source file',
  loader: 'Loader',
  artifact: 'Artifact',
}

const WIDTH = 1300
const COLUMN_X = [16, 336, 700, 1016]
const COLUMN_W = [232, 256, 228, 268]
const ROW = 32
const NODE_H = 24
const TOP = 52
const MAX_PER_COLUMN = 24

const EXPOSURE: Record<LoadBehaviour, number> = {
  code: 0,
  unknown: 1,
  directive: 2,
  guarded: 3,
  data: 4,
}

export function ContextGraph({
  records,
  onSelectArtifact,
}: {
  records: readonly ArtifactRecord[]
  onSelectArtifact?: (id: string) => void
}) {
  const [focus, setFocus] = useState<string | null>(null)

  const graph = useMemo(() => {
    const nodes = new Map<string, GraphNode>()
    const edges: GraphEdge[] = []

    const add = (node: GraphNode): void => {
      const existing = nodes.get(node.id)
      if (existing === undefined) {
        nodes.set(node.id, node)
        return
      }
      // A file loading two artifacts takes the more exposed colour.
      if (
        node.behaviour !== null &&
        (existing.behaviour === null ||
          EXPOSURE[node.behaviour] < EXPOSURE[existing.behaviour])
      ) {
        nodes.set(node.id, { ...existing, behaviour: node.behaviour })
      }
      if (node.privileged && !existing.privileged) {
        nodes.set(node.id, { ...(nodes.get(node.id) as GraphNode), privileged: true })
      }
    }

    for (const record of records) {
      const behaviour = record.behaviour.behaviour
      add({
        id: `art:${record.artifact.id}`,
        kind: 'artifact',
        label: elidePath(record.artifact.locator, 34),
        detail: `${record.artifact.locator} — ${BEHAVIOUR_LABEL[behaviour]}`,
        behaviour,
        privileged: record.contexts.some((c) => c.privileged),
        artifactId: record.artifact.id,
      })

      for (const site of record.loadSites) {
        const context = record.contexts.find((c) => c.id === site.contextId)
        const environment = context?.environment ?? 'unresolved'
        const loader = loaderSpec(site.loader)?.label ?? site.loader.replace('declared:', '')

        add({
          id: `env:${environment}`,
          kind: 'environment',
          label: elideName(ENVIRONMENT_META[environment].label, 28),
          detail: ENVIRONMENT_META[environment].note,
          behaviour: null,
          privileged: context?.privileged === true,
          artifactId: null,
        })
        add({
          id: `file:${site.file}`,
          kind: 'file',
          label: elidePath(site.file, 34),
          detail: site.file,
          behaviour: site.behaviour.behaviour,
          privileged: context?.privileged === true,
          artifactId: null,
        })
        add({
          id: `loader:${loader}`,
          kind: 'loader',
          label: elideName(loader, 30),
          detail: loaderSpec(site.loader)?.summary ?? loader,
          behaviour: site.behaviour.behaviour,
          privileged: false,
          artifactId: null,
        })

        edges.push({
          from: `env:${environment}`,
          to: `file:${site.file}`,
          behaviour: site.behaviour.behaviour,
        })
        edges.push({
          from: `file:${site.file}`,
          to: `loader:${loader}`,
          behaviour: site.behaviour.behaviour,
        })
        edges.push({
          from: `loader:${loader}`,
          to: `art:${record.artifact.id}`,
          behaviour: site.behaviour.behaviour,
        })
      }
    }

    const byColumn = COLUMNS.map((kind) => {
      const list = [...nodes.values()].filter((n) => n.kind === kind)
      list.sort((a, b) => {
        if (kind === 'environment') {
          return (
            ENVIRONMENT_ORDER.indexOf(a.id.slice(4) as EnvironmentId) -
            ENVIRONMENT_ORDER.indexOf(b.id.slice(4) as EnvironmentId)
          )
        }
        if (kind === 'artifact') {
          const exposure =
            EXPOSURE[a.behaviour ?? 'data'] - EXPOSURE[b.behaviour ?? 'data']
          if (exposure !== 0) return exposure
        }
        return a.label < b.label ? -1 : 1
      })
      return list.slice(0, MAX_PER_COLUMN)
    })

    const shown = new Set(byColumn.flat().map((n) => n.id))
    const position = new Map<string, { x: number; y: number; w: number }>()
    byColumn.forEach((list, column) => {
      list.forEach((node, row) => {
        position.set(node.id, {
          x: COLUMN_X[column] as number,
          y: TOP + row * ROW,
          w: COLUMN_W[column] as number,
        })
      })
    })

    const visibleEdges = edges.filter((e) => shown.has(e.from) && shown.has(e.to))

    // Adjacency in both directions, for the connected-component highlight.
    const neighbours = new Map<string, Set<string>>()
    for (const edge of visibleEdges) {
      if (!neighbours.has(edge.from)) neighbours.set(edge.from, new Set())
      if (!neighbours.has(edge.to)) neighbours.set(edge.to, new Set())
      ;(neighbours.get(edge.from) as Set<string>).add(edge.to)
      ;(neighbours.get(edge.to) as Set<string>).add(edge.from)
    }

    const rows = Math.max(...byColumn.map((l) => l.length), 1)
    return {
      byColumn,
      position,
      edges: visibleEdges,
      neighbours,
      height: TOP + rows * ROW + 24,
      truncated: [...nodes.values()].length - shown.size,
    }
  }, [records])

  const highlighted = useMemo(() => {
    if (focus === null) return null
    const seen = new Set<string>([focus])
    const queue = [focus]
    while (queue.length > 0) {
      const next = queue.shift() as string
      for (const neighbour of graph.neighbours.get(next) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        queue.push(neighbour)
      }
    }
    return seen
  }, [focus, graph])

  if (graph.byColumn.every((list) => list.length === 0)) return null

  const isLit = (id: string): boolean => highlighted === null || highlighted.has(id)

  return (
    <figure>
      <svg
        viewBox={`0 0 ${WIDTH} ${graph.height}`}
        className="w-full"
        role="img"
        aria-label="Context graph: environments to source files to loaders to artifacts."
        onMouseLeave={() => setFocus(null)}
      >
        {/* column headers ---------------------------------------------- */}
        {COLUMNS.map((kind, index) => (
          <text
            key={kind}
            x={COLUMN_X[index]}
            y={30}
            className="fill-[rgb(var(--ink-2))] font-mono text-[10px] uppercase tracking-[0.14em]"
          >
            {COLUMN_LABEL[kind]}
          </text>
        ))}

        {/* edges -------------------------------------------------------- */}
        <g>
          {graph.edges.map((edge, index) => {
            const from = graph.position.get(edge.from)
            const to = graph.position.get(edge.to)
            if (from === undefined || to === undefined) return null
            const x1 = from.x + from.w
            const y1 = from.y + NODE_H / 2
            const x2 = to.x
            const y2 = to.y + NODE_H / 2
            const mid = x1 + (x2 - x1) / 2
            const lit = isLit(edge.from) && isLit(edge.to)
            return (
              <path
                key={`${edge.from}->${edge.to}-${index}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={BEHAVIOUR_RGB[edge.behaviour]}
                strokeWidth={lit && highlighted !== null ? 1.8 : 1.1}
                strokeOpacity={lit ? (highlighted === null ? 0.4 : 0.85) : 0.05}
                className="transition-all duration-220 ease-out"
              />
            )
          })}
        </g>

        {/* nodes -------------------------------------------------------- */}
        {graph.byColumn.map((list, column) =>
          list.map((node) => {
            const at = graph.position.get(node.id)
            if (at === undefined) return null
            const lit = isLit(node.id)
            const colour = node.behaviour === null ? 'rgb(var(--accent))' : BEHAVIOUR_RGB[node.behaviour]
            const clickable = node.artifactId !== null && onSelectArtifact !== undefined
            return (
              <g
                key={node.id}
                onMouseEnter={() => setFocus(node.id)}
                onClick={
                  clickable ? () => onSelectArtifact(node.artifactId as string) : () => setFocus(node.id)
                }
                className={cx(
                  'transition-opacity duration-220 ease-out',
                  lit ? 'opacity-100' : 'opacity-25',
                  'cursor-pointer',
                )}
              >
                <title>{node.detail}</title>
                <rect
                  x={at.x}
                  y={at.y}
                  width={at.w}
                  height={NODE_H}
                  rx="3"
                  fill={
                    focus === node.id ? 'rgb(var(--surface-3))' : 'rgb(var(--surface-2) / 0.8)'
                  }
                  stroke={focus === node.id ? colour : 'rgb(var(--line-2))'}
                  strokeWidth="1"
                  className="transition-all duration-140"
                />
                {/* a rule in the behaviour colour, so the column reads at a glance */}
                <rect x={at.x} y={at.y} width="2.5" height={NODE_H} rx="1" fill={colour} />
                <text
                  x={at.x + 10}
                  y={at.y + 16}
                  className="fill-[rgb(var(--ink-1))] font-mono text-[10.5px]"
                >
                  {node.label}
                </text>
                {node.privileged && column < 2 && (
                  <text
                    x={at.x + at.w - 8}
                    y={at.y + 16}
                    textAnchor="end"
                    fill="rgb(var(--state-code))"
                    className="font-mono text-[9px]"
                  >
                    &#9650;
                  </text>
                )}
              </g>
            )
          }),
        )}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 font-mono text-2xs text-ink-3">
        <span>
          Hover to highlight a connected path. Click an artifact to investigate it.
          {graph.truncated > 0 && ` ${graph.truncated} nodes hidden; narrow the filters.`}
        </span>
        <span className="text-code">&#9650; privileged</span>
      </figcaption>
    </figure>
  )
}
