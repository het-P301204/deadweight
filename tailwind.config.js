/**
 * DEADWEIGHT design system.
 *
 * Every colour is stored as a space-separated RGB triplet on a CSS custom
 * property so that Tailwind's `/opacity` modifier keeps working and so that
 * the light theme is a genuine re-specification rather than an inversion.
 * The triplets live in `src/index.css`; nothing here hardcodes a colour.
 *
 * The palette is deliberately small. Neutral carries structure, one blue
 * carries information, and four semantic hues carry state and nothing else:
 *
 *   code       red     loading this runs code in the loading process
 *   directive  purple  loading injects instructions into a model context
 *   guarded    green   safe only while a call-site flag holds
 *   data       green   no execution or instruction surface at load
 *   unknown    amber   could not be resolved, with a reason
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: 'rgb(var(--surface-0) / <alpha-value>)',
          1: 'rgb(var(--surface-1) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
          3: 'rgb(var(--surface-3) / <alpha-value>)',
          inset: 'rgb(var(--surface-inset) / <alpha-value>)',
        },
        line: {
          1: 'rgb(var(--line-1) / <alpha-value>)',
          2: 'rgb(var(--line-2) / <alpha-value>)',
          3: 'rgb(var(--line-3) / <alpha-value>)',
        },
        ink: {
          0: 'rgb(var(--ink-0) / <alpha-value>)',
          1: 'rgb(var(--ink-1) / <alpha-value>)',
          2: 'rgb(var(--ink-2) / <alpha-value>)',
          3: 'rgb(var(--ink-3) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          strong: 'rgb(var(--accent-strong) / <alpha-value>)',
          dim: 'rgb(var(--accent-dim) / <alpha-value>)',
        },
        code: 'rgb(var(--state-code) / <alpha-value>)',
        directive: 'rgb(var(--state-directive) / <alpha-value>)',
        guarded: 'rgb(var(--state-guarded) / <alpha-value>)',
        data: 'rgb(var(--state-data) / <alpha-value>)',
        unknown: 'rgb(var(--state-unknown) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['"Space Grotesk Variable"', '"Space Grotesk"', '"Inter Variable"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // A tight, deliberate scale. Line heights are set for dense technical
        // reading: generous under 14px where scanning happens, tighter above.
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        xs: ['0.75rem', { lineHeight: '1.125rem', letterSpacing: '0.01em' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.4375rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.6rem' }],
        xl: ['1.375rem', { lineHeight: '1.75rem', letterSpacing: '-0.014em' }],
        '2xl': ['1.75rem', { lineHeight: '2.125rem', letterSpacing: '-0.02em' }],
        '3xl': ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.025em' }],
        '4xl': ['3.25rem', { lineHeight: '3.375rem', letterSpacing: '-0.032em' }],
      },
      spacing: {
        // 8px rhythm, with the four half-steps that dense UI actually needs.
        1: '0.25rem',
        2: '0.5rem',
        3: '0.75rem',
        4: '1rem',
        5: '1.25rem',
        6: '1.5rem',
        8: '2rem',
        10: '2.5rem',
        12: '3rem',
        16: '4rem',
        20: '5rem',
        24: '6rem',
      },
      borderRadius: {
        sm: '3px',
        DEFAULT: '5px',
        md: '7px',
        lg: '10px',
        xl: '14px',
      },
      boxShadow: {
        hair: '0 1px 0 0 rgb(var(--line-1) / 1)',
        raise: '0 1px 2px rgb(0 0 0 / var(--shadow-alpha-1)), 0 0 0 1px rgb(var(--line-1) / 1)',
        pop: '0 16px 48px -16px rgb(0 0 0 / var(--shadow-alpha-2)), 0 0 0 1px rgb(var(--line-2) / 1)',
        drawer: '-24px 0 64px -24px rgb(0 0 0 / var(--shadow-alpha-2))',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        inout: 'cubic-bezier(0.65, 0, 0.35, 1)',
      },
      transitionDuration: {
        90: '90ms',
        140: '140ms',
        220: '220ms',
        380: '380ms',
      },
      keyframes: {
        'stage-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'stripe-in': {
          from: { opacity: '0', transform: 'scaleX(0.2)' },
          to: { opacity: '1', transform: 'none' },
        },
        'drawer-in': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'sheet-in': {
          from: { opacity: '0', transform: 'translateY(100%)' },
          to: { opacity: '1', transform: 'none' },
        },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.97) translateY(-4px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'pulse-once': {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--accent) / 0.45)' },
          '100%': { boxShadow: '0 0 0 10px rgb(var(--accent) / 0)' },
        },
        'flow-dash': { to: { strokeDashoffset: '-24' } },
        sweep: { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(300%)' } },
      },
      animation: {
        'stage-in': 'stage-in 380ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'stripe-in': 'stripe-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'drawer-in': 'drawer-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'sheet-in': 'sheet-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 140ms linear both',
        'pop-in': 'pop-in 140ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'pulse-once': 'pulse-once 900ms cubic-bezier(0.16, 1, 0.3, 1) 1',
        'flow-dash': 'flow-dash 1.1s linear infinite',
        sweep: 'sweep 1.5s cubic-bezier(0.65, 0, 0.35, 1) infinite',
      },
    },
  },
  plugins: [],
}
