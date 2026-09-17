/**
 * Source masking.
 *
 * Every scanner in DEADWEIGHT works on a *masked* copy of the source: a
 * string of identical length in which the inside of every comment and every
 * string literal has been replaced by a filler character. Positions are
 * preserved, so a match found in the mask indexes straight back into the
 * original text.
 *
 * The point is that bracket matching and pattern matching then cannot be
 * fooled by punctuation inside a string. A file containing
 *
 *     name = "torch.load(model.pt)"
 *
 * must not produce a load site, and a file containing
 *
 *     torch.load(")")      # a right paren inside a string argument
 *
 * must still have its argument list bounded correctly. Both fall out of
 * masking for free, and neither is reliable with regular expressions alone.
 */

export const FILLER = ''

export interface Literal {
  /** Index of the opening quote in the original text. */
  readonly start: number
  /** Index one past the closing quote. */
  readonly end: number
  /** Decoded value. Escapes are resolved for non-raw strings. */
  readonly value: string
  /** Lowercased prefix letters: 'r', 'b', 'f', 'rb', and so on. */
  readonly prefix: string
}

export interface Masked {
  readonly text: string
  readonly masked: string
  readonly literals: readonly Literal[]
  /** Byte-independent line starts, for turning an index into a line number. */
  readonly lineStarts: readonly number[]
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 1-indexed line number for a character index. Binary search. */
export function lineAt(masked: Masked, index: number): number {
  const starts = masked.lineStarts
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] as number) <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

export function lineTextAt(masked: Masked, index: number): string {
  const line = lineAt(masked, index)
  const start = masked.lineStarts[line - 1] as number
  const end = masked.lineStarts[line] ?? masked.text.length
  return masked.text.slice(start, end).replace(/\r?\n$/, '')
}

function decode(raw: string, isRaw: boolean): string {
  if (isRaw) return raw
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    i += 1
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'r':
        out += '\r'
        break
      case '0':
        out += '\0'
        break
      case undefined:
        out += '\\'
        break
      default:
        out += next
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Python                                                                     */
/* -------------------------------------------------------------------------- */

const PY_PREFIX = /[A-Za-z]{0,3}$/

export function maskPython(text: string): Masked {
  const out = new Array<string>(text.length)
  const literals: Literal[] = []
  let i = 0

  while (i < text.length) {
    const ch = text[i] as string

    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      const prefixMatch = PY_PREFIX.exec(text.slice(Math.max(0, i - 3), i))
      const prefix = (prefixMatch ? prefixMatch[0] : '').toLowerCase()
      const triple = text.startsWith(ch.repeat(3), i)
      const quote = triple ? ch.repeat(3) : ch
      const isRaw = prefix.includes('r')
      const start = i
      i += quote.length
      const bodyStart = i
      while (i < text.length) {
        if (!isRaw && text[i] === '\\') {
          i += 2
          continue
        }
        if (text.startsWith(quote, i)) break
        // An unterminated single-quoted string ends at the newline; Python
        // would reject the file, and stopping here keeps the mask aligned.
        if (!triple && text[i] === '\n') break
        i += 1
      }
      const bodyEnd = Math.min(i, text.length)
      const closed = text.startsWith(quote, i)
      const end = closed ? i + quote.length : bodyEnd
      for (let j = start; j < end; j += 1) out[j] = FILLER
      // Keep the quote characters visible so argument splitting can see them.
      out[start] = ch
      if (closed) out[end - 1] = ch
      literals.push({
        start,
        end,
        value: decode(text.slice(bodyStart, bodyEnd), isRaw),
        prefix,
      })
      i = end
      continue
    }

    out[i] = ch
    i += 1
  }

  for (let j = 0; j < text.length; j += 1) if (out[j] === undefined) out[j] = text[j] as string
  return { text, masked: out.join(''), literals, lineStarts: lineStartsOf(text) }
}

/* -------------------------------------------------------------------------- */
/* JavaScript and TypeScript                                                  */
/* -------------------------------------------------------------------------- */

export function maskJs(text: string): Masked {
  const out = new Array<string>(text.length)
  const literals: Literal[] = []
  let i = 0

  while (i < text.length) {
    const ch = text[i] as string

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }

    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      for (let j = i; j < stop; j += 1) out[j] = text[j] === '\n' ? '\n' : ' '
      i = stop
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i
      i += 1
      const bodyStart = i
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === ch) break
        if (ch !== '`' && text[i] === '\n') break
        i += 1
      }
      const bodyEnd = Math.min(i, text.length)
      const closed = text[i] === ch
      const end = closed ? i + 1 : bodyEnd
      for (let j = start; j < end; j += 1) out[j] = text[j] === '\n' ? '\n' : FILLER
      out[start] = ch
      if (closed) out[end - 1] = ch
      literals.push({ start, end, value: text.slice(bodyStart, bodyEnd), prefix: '' })
      i = end
      continue
    }

    out[i] = ch
    i += 1
  }

  for (let j = 0; j < text.length; j += 1) if (out[j] === undefined) out[j] = text[j] as string
  return { text, masked: out.join(''), literals, lineStarts: lineStartsOf(text) }
}

/* -------------------------------------------------------------------------- */
/* Bracket walking                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Index of the bracket closing the one at `open`, or -1.
 *
 * Runs on the mask, so brackets inside strings and comments are already gone.
 * Bounded by `limit` characters so an unbalanced file cannot make the scan
 * quadratic across a large source tree.
 */
export function matchBracket(masked: string, open: number, limit = 20_000): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const opener = masked[open] as string
  const closer = pairs[opener]
  if (closer === undefined) return -1
  let depth = 0
  const stop = Math.min(masked.length, open + limit)
  for (let i = open; i < stop; i += 1) {
    const ch = masked[i] as string
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return ch === closer ? i : -1
    }
  }
  return -1
}

/** Split an argument list on top-level commas. Returns [start, end) ranges. */
export function splitArguments(
  masked: string,
  open: number,
  close: number,
): ReadonlyArray<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let depth = 0
  let start = open + 1
  for (let i = open + 1; i < close; i += 1) {
    const ch = masked[i] as string
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      ranges.push({ start, end: i })
      start = i + 1
    }
  }
  if (start < close) ranges.push({ start, end: close })
  return ranges.filter((r) => masked.slice(r.start, r.end).trim() !== '')
}

/** The literal whose span exactly covers `[start, end)` after trimming, if any. */
export function literalIn(
  masked: Masked,
  start: number,
  end: number,
): Literal | null {
  for (const literal of masked.literals) {
    if (literal.start >= start && literal.end <= end) {
      const before = masked.text.slice(start, literal.start).trim()
      const after = masked.text.slice(literal.end, end).trim()
      // Allow a string prefix before the quote (`r"..."`, `f"..."`).
      if (/^[A-Za-z]{0,3}$/.test(before) && after === '') return literal
    }
  }
  return null
}
