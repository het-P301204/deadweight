/**
 * Theme bootstrap.
 *
 * A separate file rather than an inline script, so that the page's Content
 * Security Policy can be `script-src 'self'` with no `unsafe-inline` and no
 * hash to keep in sync. It runs before first paint because the tag that loads
 * it is synchronous and in the head: without that, a reader who chose light
 * gets a dark flash on every load.
 *
 * It reads one string and sets one attribute. Nothing else belongs here.
 */
;(function () {
  try {
    var stored = localStorage.getItem('deadweight.theme')
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    var resolved = stored === 'light' || stored === 'dark' ? stored : dark ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', resolved)
  } catch (error) {
    /* No storage available. The dark default in the markup stands. */
  }
})()
