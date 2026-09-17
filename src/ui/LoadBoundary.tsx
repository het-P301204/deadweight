/**
 * The load boundary: the stripe, exploded.
 *
 * This is the product's signature visual and it is the same six facts the
 * inline glyph carries, drawn at full size with the stages named. A reader
 * meets it on the overview, learns to read six cells left to right, and then
 * recognises the two-millimetre version in every row of the explorer.
 *
 * What the drawing says:
 *
 *   - Artifacts sit on the left, outside the analysis boundary.
 *   - The dashed line is the boundary. Nothing to the right of it was loaded
 *     to produce what is to the right of it; recognition read magic bytes,
 *     container member names and source, and never called a deserialiser.
 *   - Each trace runs through the six stages, in the colour of what loading
 *     that artifact does, and terminates in how it should be acted on.
 *
 * The animation traces each line left to right on first paint. That is the
 * only thing it does, and it does it because "these facts were derived in
 * this order, from this side of the boundary" is the thing worth saying.
 */

import { useMemo, useState } from 'react'

import { STAGE_META } from '../engine/stripe.ts'
import type { ArtifactRecord, StripeStage } from '../engine/types.ts'
import { cx } from './primitives.tsx'
import { elidePath } from './text.ts'
import { BEHAVIOUR_RGB } from './tokens.ts'

const STAGES: readonly StripeStage[] = [
  'format',
  'load',
  'exec',
  'context',
  'evidence',
  'alternative',
]

const LABEL_WIDTH = 232
// A 36px gutter between the longest label and the boundary, so the rotated
// boundary text has clear air either side of it.
const BOUNDARY_X = 268
const FIRST_STAGE_X = 348
const STAGE_GAP = 124
const TERMINAL_X = 1062
const ROW_HEIGHT = 34
const HEADER_HEIGHT = 74
const NODE_W = 13
const NODE_H = 18
const WIDTH = 1160

function stageX(index: number): number {
  return FIRST_STAGE_X + index * STAGE_GAP
}

type Terminal = 'act' | 'review' | 'record'

function terminalOf(record: ArtifactRecord): Terminal {
  if (record.findings.some((f) => f.disposition === 'act')) return 'act'
  if (record.findings.some((f) => f.disposition === 'review')) return 'review'
  return 'record'
}

const TERMINAL_META: Record<Terminal, { label: string; colour: string }> = {
  act: { label: 'ACT', colour: 'rgb(var(--state-code))' },
  review: { label: 'REVIEW', colour: 'rgb(var(--state-unknown))' },
  record: { label: 'RECORD', colour: 'rgb(var(--ink-2))' },
}

export function LoadBoundary({
  records,
  limit = 9,
  onSelect,
  animate = true,
}: {
  records: readonly ArtifactRecord[]
  limit?: number
  onSelect?: (id: string) => void
  animate?: boolean
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [stage, setStage] = useState<StripeStage | null>(null)

  const shown = useMemo(() => records.slice(0, limit), [records, limit])
  const height = HEADER_HEIGHT + shown.length * ROW_HEIGHT + 22

  if (shown.length === 0) return null

  return (
    <figure className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Load boundary diagram: ${shown.length} artifacts traced through format, load site, execution behaviour, context, evidence and alternative.`}
      >
        <defs>
          <pattern id="dw-hatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill="rgb(var(--state-unknown) / 0.14)" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="rgb(var(--state-unknown) / 0.85)" strokeWidth="1.2" />
          </pattern>
        </defs>

        {/* stage columns ------------------------------------------------- */}
        {STAGES.map((id, index) => {
          const x = stageX(index)
          const active = stage === id
          return (
            <g
              key={id}
              onMouseEnter={() => setStage(id)}
              onMouseLeave={() => setStage(null)}
              className="cursor-default"
            >
              <rect
                x={x - STAGE_GAP / 2}
                y={30}
                width={STAGE_GAP}
                height={height - 46}
                fill={active ? 'rgb(var(--accent) / 0.05)' : 'transparent'}
                className="transition-[fill] duration-220 ease-out"
              />
              <text
                x={x}
                y={24}
                textAnchor="middle"
                className={cx(
                  'font-mono text-[10px] uppercase tracking-[0.16em] transition-[fill] duration-220',
                  active ? 'fill-[rgb(var(--accent-strong))]' : 'fill-[rgb(var(--ink-2))]',
                )}
              >
                {STAGE_META[id].label}
              </text>
              <line
                x1={x}
                y1={34}
                x2={x}
                y2={height - 20}
                stroke="rgb(var(--line-1))"
                strokeWidth="1"
              />
              <line
                x1={x - 5}
                y1={40}
                x2={x + 5}
                y2={40}
                stroke={active ? 'rgb(var(--accent))' : 'rgb(var(--line-2))'}
                strokeWidth="1.5"
              />
            </g>
          )
        })}

        {/* the boundary ---------------------------------------------------- */}
        <line
          x1={BOUNDARY_X}
          y1={14}
          x2={BOUNDARY_X}
          y2={height - 14}
          stroke="rgb(var(--accent) / 0.55)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <text
          x={BOUNDARY_X - 11}
          y={height / 2}
          textAnchor="middle"
          transform={`rotate(-90 ${BOUNDARY_X - 11} ${height / 2})`}
          className="fill-[rgb(var(--accent))] font-mono text-[9px] uppercase tracking-[0.22em]"
        >
          analysis boundary
        </text>

        {/* traces ---------------------------------------------------------- */}
        {shown.map((record, row) => {
          const y = HEADER_HEIGHT + row * ROW_HEIGHT
          const colour = BEHAVIOUR_RGB[record.behaviour.behaviour]
          const dim = hovered !== null && hovered !== record.artifact.id
          const terminal = TERMINAL_META[terminalOf(record)]
          const delay = animate ? row * 70 : 0

          return (
            <g
              key={record.artifact.id}
              onMouseEnter={() => setHovered(record.artifact.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={onSelect === undefined ? undefined : () => onSelect(record.artifact.id)}
              className={cx(
                'transition-opacity duration-220 ease-out',
                dim ? 'opacity-25' : 'opacity-100',
                onSelect !== undefined && 'cursor-pointer',
              )}
            >
              <title>
                {`${record.artifact.locator} — ${record.behaviour.mechanism}`}
              </title>

              {/* hover band */}
              <rect
                x={0}
                y={y - ROW_HEIGHT / 2 + 2}
                width={WIDTH}
                height={ROW_HEIGHT - 4}
                fill={hovered === record.artifact.id ? 'rgb(var(--surface-3) / 0.7)' : 'transparent'}
                rx="4"
                className="transition-[fill] duration-140"
              />

              {/* artifact label, outside the boundary */}
              <text
                x={LABEL_WIDTH}
                y={y + 4}
                textAnchor="end"
                className="fill-[rgb(var(--ink-1))] font-mono text-[11px]"
              >
                {elidePath(record.artifact.locator, 33)}
              </text>

              {/* the trace */}
              <path
                d={`M ${BOUNDARY_X + 10} ${y} L ${TERMINAL_X - 12} ${y}`}
                stroke={colour}
                strokeWidth="1.25"
                strokeOpacity="0.45"
                fill="none"
                pathLength={1}
                className={animate ? 'dw-trace' : undefined}
                style={animate ? { animationDelay: `${delay}ms` } : undefined}
              />

              {/* one node per stage */}
              {record.stripe.map((cell, index) => {
                const x = stageX(index)
                const fill =
                  cell.state === 'flagged'
                    ? colour
                    : cell.state === 'unresolved'
                      ? 'url(#dw-hatch)'
                      : 'rgb(var(--ink-2) / 0.4)'
                return (
                  <rect
                    key={cell.stage}
                    x={x - NODE_W / 2}
                    y={y - NODE_H / 2}
                    width={NODE_W}
                    height={NODE_H}
                    rx="2"
                    fill={fill}
                    stroke={cell.state === 'unresolved' ? 'rgb(var(--state-unknown) / 0.5)' : 'none'}
                    strokeWidth="1"
                    className={animate ? 'dw-node' : undefined}
                    style={
                      animate
                        ? { animationDelay: `${delay + 180 + index * 90}ms`, transformOrigin: `${x}px ${y}px` }
                        : undefined
                    }
                  >
                    <title>{`${STAGE_META[cell.stage].label}: ${cell.label}. ${cell.detail}`}</title>
                  </rect>
                )
              })}

              {/* terminal */}
              <text
                x={TERMINAL_X}
                y={y + 3.5}
                fill={terminal.colour}
                className={cx(
                  'font-mono text-[10px] uppercase tracking-[0.1em]',
                  animate && 'dw-node',
                )}
                style={animate ? { animationDelay: `${delay + 780}ms` } : undefined}
              >
                {terminal.label}
              </text>
            </g>
          )
        })}
      </svg>

      {records.length > shown.length && (
        <figcaption className="mt-3 text-center font-mono text-2xs text-ink-3">
          {shown.length} of {records.length} artifacts shown, most exposed first
        </figcaption>
      )}
    </figure>
  )
}
