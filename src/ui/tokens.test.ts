/**
 * The design tokens, under test.
 *
 * Contrast is arithmetic on the token values, so it does not need a browser
 * and it does not need to be re-checked by hand. This reads the triplets out
 * of `src/index.css` and asserts every text tier and every state colour
 * against the *worst* surface it can land on -- the hovered row -- in both
 * themes.
 *
 * The first pass of this palette had a text tier at 2.54:1 and a light-theme
 * green at 4.26:1. Both were found by measuring rather than by looking, which
 * is the argument for having this file at all.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BEHAVIOUR_STYLE, ENVIRONMENT_STYLE, STRIPE_CELL } from './tokens.ts'
import { ENVIRONMENTS } from '../engine/config.ts'
import { LOAD_BEHAVIOURS } from '../engine/types.ts'

const CSS = await readFile(resolve(import.meta.dirname, '..', 'index.css'), 'utf8')

type Rgb = readonly [number, number, number]

/** Read the token triplets for one theme block out of the stylesheet. */
function tokens(theme: 'dark' | 'light'): ReadonlyMap<string, Rgb> {
  const marker = theme === 'dark' ? "[data-theme='dark'] {" : "[data-theme='light'] {"
  const start = CSS.indexOf(marker)
  expect(start, `no ${theme} theme block in index.css`).toBeGreaterThan(-1)
  const end = CSS.indexOf('\n}', start)
  const block = CSS.slice(start, end)

  const found = new Map<string, Rgb>()
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    found.set(match[1] as string, [
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
    ] as const)
  }
  return found
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const THEMES = ['dark', 'light'] as const

describe('contrast', () => {
  for (const theme of THEMES) {
    describe(theme, () => {
      const palette = tokens(theme)

      /**
       * The surface with the least contrast against this theme's text: the
       * hovered row. Text that fails here fails while it is being read.
       */
      const worst = (): Rgb => palette.get('surface-3') as Rgb

      it('defines every token the components reference', () => {
        for (const name of [
          'surface-0',
          'surface-1',
          'surface-2',
          'surface-3',
          'surface-inset',
          'line-1',
          'line-2',
          'line-3',
          'ink-0',
          'ink-1',
          'ink-2',
          'ink-3',
          'accent',
          'accent-strong',
          'accent-dim',
          'state-code',
          'state-directive',
          'state-guarded',
          'state-data',
          'state-unknown',
        ]) {
          expect(palette.get(name), `${theme}: --${name} is missing`).toBeDefined()
        }
      })

      it('meets AA for all four text tiers on the hovered row', () => {
        for (const tier of ['ink-0', 'ink-1', 'ink-2', 'ink-3']) {
          const ratio = contrast(palette.get(tier) as Rgb, worst())
          expect(ratio, `${theme}: --${tier} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('keeps the text tiers monotonic, so the hierarchy is a hierarchy', () => {
        const ratios = ['ink-0', 'ink-1', 'ink-2', 'ink-3'].map((tier) =>
          contrast(palette.get(tier) as Rgb, worst()),
        )
        for (let i = 1; i < ratios.length; i += 1) {
          expect(
            ratios[i - 1] as number,
            `${theme}: tier ${i} is not lower contrast than tier ${i - 1}`,
          ).toBeGreaterThan(ratios[i] as number)
        }
      })

      it('meets AA for every state colour used as text', () => {
        for (const state of [
          'state-code',
          'state-directive',
          'state-guarded',
          'state-data',
          'state-unknown',
          'accent',
          'accent-strong',
        ]) {
          const ratio = contrast(palette.get(state) as Rgb, worst())
          expect(ratio, `${theme}: --${state} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('separates the two greens in luminance, not only in hue', () => {
        // `guarded` and `data` share a hue family on purpose: the outline
        // versus fill treatment is what carries the distinction. But they
        // must also differ in *lightness*, or a reader who cannot separate
        // green from green sees one colour and the treatment is doing all of
        // the work. Not a readability threshold -- a greyscale separability
        // one.
        const ratio = contrast(palette.get('state-guarded') as Rgb, palette.get('state-data') as Rgb)
        expect(ratio, `${theme}: the two greens are ${ratio.toFixed(2)}:1 apart`).toBeGreaterThan(1.15)
      })

      it('keeps every state colour distinguishable from every other', () => {
        const states = ['state-code', 'state-directive', 'state-unknown', 'state-data'] as const
        for (let i = 0; i < states.length; i += 1) {
          for (let j = i + 1; j < states.length; j += 1) {
            const a = palette.get(states[i] as string) as Rgb
            const b = palette.get(states[j] as string) as Rgb
            const same = a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
            expect(same, `${theme}: ${states[i]} and ${states[j]} are the same colour`).toBe(false)
          }
        }
      })

      it('gives the surface stack a perceptible step at every level', () => {
        const stack = ['surface-0', 'surface-1', 'surface-2', 'surface-3'].map(
          (name) => palette.get(name) as Rgb,
        )
        for (let i = 1; i < stack.length; i += 1) {
          const delta = Math.abs(
            luminance(stack[i] as Rgb) - luminance(stack[i - 1] as Rgb),
          )
          expect(delta, `${theme}: surface-${i - 1} and surface-${i} are the same`).toBeGreaterThan(
            0.0008,
          )
        }
      })

      it('makes the focus ring visible against every surface', () => {
        // The focus outline is --accent. A ring nobody can see is a keyboard
        // user with no cursor.
        for (const surface of ['surface-0', 'surface-1', 'surface-2', 'surface-3']) {
          const ratio = contrast(palette.get('accent') as Rgb, palette.get(surface) as Rgb)
          expect(ratio, `${theme}: focus ring on --${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
        }
      })
    })
  }
})

describe('token completeness', () => {
  it('styles every load behaviour', () => {
    for (const behaviour of LOAD_BEHAVIOURS) {
      const style = BEHAVIOUR_STYLE[behaviour]
      expect(style, behaviour).toBeDefined()
      expect(style.text.length, behaviour).toBeGreaterThan(0)
      expect(style.fill.length, behaviour).toBeGreaterThan(0)
      expect(style.short.length, behaviour).toBeGreaterThan(0)
    }
  })

  it('styles every environment, including unresolved', () => {
    for (const environment of ENVIRONMENTS) {
      expect(ENVIRONMENT_STYLE[environment], environment).toBeDefined()
    }
  })

  it('distinguishes the stripe states by treatment, not only by colour', () => {
    // `unresolved` carries the hatch class, so the glyph survives greyscale
    // and a reader who cannot separate red from green.
    expect(STRIPE_CELL.unresolved).toContain('hatch')
    expect(STRIPE_CELL.resolved).not.toContain('hatch')
  })

  it('gives every behaviour a distinct short code', () => {
    const codes = LOAD_BEHAVIOURS.map((b) => BEHAVIOUR_STYLE[b].short)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
