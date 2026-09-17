/**
 * Capture the documentation screenshots from the real interface.
 *
 * Every image in the README is produced by driving the built app through
 * Playwright rather than mocked up, so a screenshot cannot show a product
 * that does not exist. Run it after `npm run build`:
 *
 *   npx vite preview --port 4317 &
 *   node scripts/screenshots.ts
 *
 * Playwright is not a dependency of this project; it is expected to be
 * available in the environment that runs this script. Nothing in the test
 * suite, the build or CI depends on it.
 */

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'docs')
const BASE = process.env['DW_PREVIEW'] ?? 'http://localhost:4317/'

interface Shot {
  readonly name: string
  readonly width: number
  readonly height: number
  /** View to open, or null to stay on the landing screen. */
  readonly view: string | null
  /** Extra steps, as a function serialised into the page. */
  readonly prepare?: string
  readonly clip?: { x: number; y: number; width: number; height: number }
}

const SHOTS: readonly Shot[] = [
  { name: 'deadweight-landing', width: 1440, height: 1000, view: null },
  {
    name: 'deadweight-overview',
    width: 1440,
    height: 1100,
    view: 'Overview',
    clip: { x: 0, y: 48, width: 1440, height: 940 },
  },
  { name: 'deadweight-artifacts', width: 1440, height: 1180, view: 'Artifacts' },
  { name: 'deadweight-loadpaths', width: 1440, height: 1060, view: 'Load paths' },
  {
    name: 'deadweight-migrations',
    width: 1440,
    height: 1060,
    view: 'Migrations',
    prepare: `
      const card = document.querySelector('article button[aria-expanded="false"]')
      card?.click()
      await new Promise((r) => setTimeout(r, 400))
    `,
  },
  { name: 'deadweight-bom', width: 1440, height: 1060, view: 'Model BOM' },
  { name: 'deadweight-evidence', width: 1440, height: 1060, view: 'Evidence' },
  {
    name: 'deadweight-drawer',
    width: 1440,
    height: 1060,
    view: 'Artifacts',
    prepare: `
      const row = document.querySelector('button[aria-label^="weights/ranker.bin"]')
      row?.click()
      await new Promise((r) => setTimeout(r, 500))
    `,
  },
  {
    name: 'deadweight-light',
    width: 1440,
    height: 1000,
    view: 'Overview',
    prepare: `
      const toggle = document.querySelector('button[aria-label^="Theme"]')
      toggle?.click(); await new Promise((r) => setTimeout(r, 120))
      toggle?.click(); await new Promise((r) => setTimeout(r, 400))
    `,
  },
  {
    name: 'deadweight-palette',
    width: 1440,
    height: 800,
    view: 'Artifacts',
    prepare: `
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 400))
      const field = document.querySelector('div[role="dialog"][aria-label="Command palette"] input')
      if (field) {
        field.focus()
        field.value = 'pkl'
        field.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await new Promise((r) => setTimeout(r, 400))
    `,
  },
  { name: 'deadweight-mobile', width: 390, height: 900, view: 'Artifacts' },
  { name: 'deadweight-404', width: 1000, height: 640, view: null },
]

const playwright = (await import('playwright')) as unknown as {
  chromium: {
    launch(options?: unknown): Promise<{
      newPage(options?: unknown): Promise<PageLike>
      close(): Promise<void>
    }>
  }
}

interface PageLike {
  setViewportSize(size: { width: number; height: number }): Promise<void>
  goto(url: string, options?: unknown): Promise<unknown>
  evaluate(script: string): Promise<unknown>
  screenshot(options: unknown): Promise<unknown>
}

await mkdir(OUT, { recursive: true })

const browser = await playwright.chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })

for (const shot of SHOTS) {
  await page.setViewportSize({ width: shot.width, height: shot.height })

  if (shot.name === 'deadweight-404') {
    await page.goto(`${BASE}404.html`, { waitUntil: 'load' })
  } else {
    await page.goto(BASE, { waitUntil: 'load' })
    if (shot.view !== null) {
      await page.evaluate(`(async () => {
        const demo = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Run the demo project'))
        demo?.click()
        await new Promise((r) => setTimeout(r, 1400))
        const nav = [...document.querySelectorAll('nav[aria-label="Views"] button')].find((b) => b.textContent === ${JSON.stringify(shot.view)})
        nav?.click()
        await new Promise((r) => setTimeout(r, 500))
        window.scrollTo(0, 0)
        ${shot.prepare ?? ''}
      })()`)
    }
  }

  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
  await page.screenshot({
    path: join(OUT, `${shot.name}.png`),
    ...(shot.clip === undefined ? {} : { clip: shot.clip }),
  })
  console.log(`  ${shot.name}.png  ${shot.width}x${shot.height}`)
}

await browser.close()
console.log(`Wrote ${SHOTS.length} screenshots into docs/.`)
