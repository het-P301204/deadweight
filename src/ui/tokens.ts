/**
 * Design tokens, as the class strings the components actually use.
 *
 * Centralised for one reason: state colour has to mean the same thing in the
 * stripe, the badge, the graph node, the matrix cell and the diff row. If a
 * component picks its own red, the interface stops being readable at a
 * glance, which is the only thing that makes a dense table useful.
 *
 * The palette is in src/index.css as CSS custom properties, so light and dark
 * are two specifications rather than one inverted.
 */

import type { EnvironmentId, LoadBehaviour, StripeCellState } from '../engine/types.ts'

/* -------------------------------------------------------------------------- */
/* Behaviour                                                                  */
/* -------------------------------------------------------------------------- */

export interface BehaviourStyle {
  /** Foreground text. */
  readonly text: string
  /** Solid fill, for the stripe and the matrix. */
  readonly fill: string
  /** Faint background wash. */
  readonly wash: string
  /** 1px border. */
  readonly border: string
  /** Left rule on a row or panel. */
  readonly rule: string
  /** Short uppercase label for compact spaces. */
  readonly short: string
}

export const BEHAVIOUR_STYLE: Readonly<Record<LoadBehaviour, BehaviourStyle>> = {
  code: {
    text: 'text-code',
    fill: 'bg-code',
    wash: 'bg-code/10',
    border: 'border-code/35',
    rule: 'bg-code',
    short: 'EXEC',
  },
  directive: {
    text: 'text-directive',
    fill: 'bg-directive',
    wash: 'bg-directive/10',
    border: 'border-directive/35',
    rule: 'bg-directive',
    short: 'DIRECT',
  },
  guarded: {
    text: 'text-guarded',
    fill: 'bg-guarded',
    wash: 'bg-guarded/10',
    border: 'border-guarded/35',
    rule: 'bg-guarded',
    short: 'GUARD',
  },
  data: {
    text: 'text-data',
    fill: 'bg-data',
    wash: 'bg-data/10',
    border: 'border-data/35',
    rule: 'bg-data',
    short: 'DATA',
  },
  unknown: {
    text: 'text-unknown',
    fill: 'bg-unknown',
    wash: 'bg-unknown/10',
    border: 'border-unknown/35',
    rule: 'bg-unknown',
    short: 'UNKN',
  },
}

/** SVG-friendly `rgb(var(--x))` strings, for the graph and the diagrams. */
export const BEHAVIOUR_RGB: Readonly<Record<LoadBehaviour, string>> = {
  code: 'rgb(var(--state-code))',
  directive: 'rgb(var(--state-directive))',
  guarded: 'rgb(var(--state-guarded))',
  data: 'rgb(var(--state-data))',
  unknown: 'rgb(var(--state-unknown))',
}

/* -------------------------------------------------------------------------- */
/* Stripe cells                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The stripe's three states are distinguished by *treatment* as well as
 * colour, so the glyph is still readable in greyscale and to a reader who
 * cannot separate red from green:
 *
 *   resolved    solid, neutral
 *   flagged     solid, in the behaviour's colour
 *   unresolved  hatched, amber
 */
export const STRIPE_CELL: Readonly<Record<StripeCellState, string>> = {
  resolved: 'bg-ink-2/45',
  flagged: '',
  unresolved: 'bg-unknown/25 text-unknown hatch',
}

/* -------------------------------------------------------------------------- */
/* Environments                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Environments are not coloured by severity, because they are not a severity.
 * They are coloured by *reach*: how far a compromise at that load site
 * travels. Blue is the accent for "a place that matters", neutral for the
 * rest, amber for unresolved.
 */
export const ENVIRONMENT_STYLE: Readonly<Record<EnvironmentId, string>> = {
  production: 'text-accent-strong border-accent/40 bg-accent/10',
  staging: 'text-accent-strong border-accent/30 bg-accent/[0.07]',
  service: 'text-accent border-accent/25 bg-accent/[0.05]',
  ci: 'text-ink-0 border-line-3 bg-surface-3',
  build: 'text-ink-0 border-line-3 bg-surface-3',
  notebook: 'text-ink-1 border-line-2 bg-surface-2',
  test: 'text-ink-1 border-line-2 bg-surface-2',
  development: 'text-ink-1 border-line-2 bg-surface-2',
  sandbox: 'text-ink-2 border-line-2 bg-transparent',
  unresolved: 'text-unknown border-unknown/30 bg-unknown/[0.07]',
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

export const SURFACE = {
  /** A major information surface: a panel with a hairline and no shadow. */
  panel: 'bg-surface-1 border border-line-1 rounded-lg',
  /** A nested well inside a panel: code, evidence, raw values. */
  well: 'bg-surface-inset border border-line-1 rounded-md',
  /** A row in a list. */
  row: 'border-b border-line-1 last:border-b-0',
  /** Anything that floats: drawer, palette, tooltip. */
  float: 'bg-surface-1 border border-line-2 rounded-lg shadow-pop',
} as const

export const TYPE = {
  /** Section eyebrow: small, tracked, monospace, muted. */
  eyebrow: 'font-mono text-2xs uppercase tracking-[0.14em] text-ink-2',
  /** Panel title. */
  title: 'font-display text-lg font-medium tracking-tight text-ink-0',
  /** View heading. */
  heading: 'font-display text-2xl font-medium tracking-tight text-ink-0',
  /** Body copy inside a panel. */
  body: 'text-base text-ink-1',
  /** Small print that still has to be read. */
  note: 'text-xs text-ink-2 leading-relaxed',
  /** Paths, hashes, identifiers, arguments. */
  mono: 'font-mono text-xs text-ink-1',
  /** A number in a metric. */
  metric: 'font-display text-3xl font-medium tracking-tight tnum',
} as const

export const CONTROL = {
  /** Default button. */
  button:
    'inline-flex items-center gap-2 h-8 px-3 rounded text-xs font-medium border border-line-2 bg-surface-2 text-ink-0 transition-colors duration-90 hover:bg-surface-3 hover:border-line-3 active:translate-y-px disabled:opacity-40 disabled:pointer-events-none',
  /** Primary action. */
  primary:
    'inline-flex items-center gap-2 h-8 px-3 rounded text-xs font-medium border border-accent/40 bg-accent/15 text-accent-strong transition-colors duration-90 hover:bg-accent/25 active:translate-y-px',
  /** Icon-only button. */
  icon: 'inline-flex items-center justify-center h-7 w-7 rounded border border-line-2 bg-surface-2 text-ink-1 transition-colors duration-90 hover:bg-surface-3 hover:text-ink-0',
  /** Filter chip, unselected. */
  chip: 'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-2xs font-mono uppercase tracking-[0.08em] border border-line-2 text-ink-2 transition-all duration-140 ease-out hover:border-line-3 hover:text-ink-1',
  /** Filter chip, selected. */
  chipOn:
    'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-2xs font-mono uppercase tracking-[0.08em] border border-accent/50 bg-accent/15 text-accent-strong transition-all duration-140 ease-out',
  /** Text input. */
  input:
    'h-8 w-full rounded border border-line-2 bg-surface-inset px-2.5 text-xs text-ink-0 placeholder:text-ink-3 transition-colors duration-90 focus:border-accent/60 focus:outline-none',
} as const

/** Disposition of a finding: how to act, not how bad. */
export const DISPOSITION_STYLE = {
  act: { text: 'text-code', label: 'Act', dot: 'bg-code' },
  review: { text: 'text-unknown', label: 'Review', dot: 'bg-unknown' },
  record: { text: 'text-ink-2', label: 'Record', dot: 'bg-ink-3' },
} as const

/** Evidence binding, which is not the same axis as the scanner's result. */
export const BINDING_STYLE = {
  current: { text: 'text-data', label: 'Bound' },
  stale: { text: 'text-code', label: 'Stale' },
  unbound: { text: 'text-unknown', label: 'Unbound' },
  absent: { text: 'text-ink-2', label: 'Absent' },
} as const
