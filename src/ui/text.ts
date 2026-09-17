/**
 * Text fitting for the diagrams.
 *
 * SVG has no text-overflow, so labels are shortened in JavaScript. The
 * interesting part is *how*: a bare leading ellipsis in IBM Plex Mono at 10px
 * sits low on the baseline and reads as an underscore, so
 * `…las-internal/intent-router-v3` looks like a filename beginning with `_`.
 *
 * Eliding on a path separator instead gives `…/intent-router-v3`, where the
 * slash makes the elision unmistakable. Only when that still does not fit
 * does it fall back to a trailing ellipsis, which is unambiguous because it
 * is at the end.
 */

/** Shorten a repository path, preferring to drop whole leading segments. */
export function elidePath(text: string, max: number): string {
  if (text.length <= max) return text

  const segments = text.split('/')
  for (let drop = 1; drop < segments.length; drop += 1) {
    const candidate = `…/${segments.slice(drop).join('/')}`
    if (candidate.length <= max) return candidate
  }

  // A single very long segment, or a path whose last segment alone is too
  // long. Trailing ellipsis: at the end it cannot be mistaken for a character
  // of the name.
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/** Shorten a name whose first words identify it: a loader, an environment. */
export function elideName(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}
