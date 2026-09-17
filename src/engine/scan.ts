/**
 * Source scanners.
 *
 * These find the calls that turn an artifact into a live object, and the
 * signals that say what the surrounding code can reach. They are not
 * compilers. Where a scanner cannot resolve something -- a path built at
 * runtime, a loader reached through a variable -- it records the expression as
 * written and marks the target unresolved, which is a first-class outcome in
 * this product rather than a gap to paper over.
 *
 * Everything runs on the masked source from mask.ts, so a path inside a
 * string never becomes a bracket and a commented-out loader never becomes a
 * load site.
 */

import {
  MAX_ARG_CHARS,
  MAX_LINES,
  MAX_LINE_LENGTH,
  MAX_SNIPPET_CHARS,
  clip,
  sanitise,
} from './limits.ts'
import { BARE_NAMES, LOADER_RULES, matchLoader } from './loaders.ts'
import { lineAt, literalIn, maskJs, maskPython, matchBracket, splitArguments } from './mask.ts'
import type { Masked } from './mask.ts'
import type { CallArgument, LoaderEcosystem, PrivilegeKind, PrivilegeSignal } from './types.ts'

export interface RawCall {
  readonly file: string
  readonly line: number
  readonly enclosing: string | null
  readonly loaderId: string
  readonly canonical: string
  readonly snippet: string
  readonly args: readonly CallArgument[]
  /** The target argument exactly as written. */
  readonly targetExpression: string
  /** Resolved string value of the target, when static analysis could reach one. */
  readonly targetLiteral: string | null
}

export interface ScanResult {
  readonly calls: readonly RawCall[]
  readonly privileges: readonly PrivilegeSignal[]
  readonly imports: readonly string[]
  readonly frameworks: readonly string[]
}

const EMPTY: ScanResult = { calls: [], privileges: [], imports: [], frameworks: [] }

/**
 * Target argument positions per loader, indexed once from the registry so the
 * scanners do not re-walk the rule list for every call they find.
 */
const LOADER_TARGETS: ReadonlyMap<
  string,
  { positions: readonly number[]; keywords: readonly string[] }
> = new Map(
  LOADER_RULES.map((r) => [r.spec.id, { positions: r.positions, keywords: r.keywords }]),
)

/* -------------------------------------------------------------------------- */
/* Privilege signals                                                          */
/* -------------------------------------------------------------------------- */

interface PrivilegeRule {
  readonly kind: PrivilegeKind
  readonly label: string
  readonly pattern: RegExp
}

/**
 * What the loading code can reach.
 *
 * These are read as *capability in the same file as the load*, which is a
 * deliberately conservative join: it says the process performing the load has
 * this reach, not that the artifact will use it. The product never claims
 * more than that, and the UI says so where the signals are shown.
 */
const PRIVILEGE_RULES: readonly PrivilegeRule[] = [
  {
    kind: 'cloud-credentials',
    label: 'Cloud SDK client constructed',
    pattern: /\b(boto3\.(client|resource|Session)|google\.cloud\.\w+|azure\.identity\.\w+|botocore\.session)\b/,
  },
  {
    kind: 'secret-material',
    label: 'Secret read from the environment',
    pattern:
      /\b(os\.environ(?:\.get)?|os\.getenv|process\.env)\s*[[(]?\s*['"`][A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)[A-Z0-9_]*['"`]/,
  },
  {
    kind: 'secret-material',
    label: 'Secret manager accessed',
    pattern: /\b(get_secret_value|SecretClient|secretmanager|vault_client|hvac\.Client)\b/,
  },
  {
    kind: 'orchestration-api',
    label: 'Cluster or orchestration API client',
    pattern: /\b(kubernetes\.(client|config)|docker\.from_env|KubernetesClient|CoreV1Api)\b/,
  },
  {
    kind: 'datastore-write',
    label: 'Datastore write',
    pattern:
      /\b(cursor\.execute\s*\(\s*['"`]\s*(INSERT|UPDATE|DELETE|DROP)|session\.(add|commit|delete)\s*\(|\.put_item\s*\(|\.insert_one\s*\(|\.bulk_write\s*\()/i,
  },
  {
    kind: 'process-execution',
    label: 'Subprocess or shell execution',
    pattern:
      /\b(subprocess\.(run|Popen|call|check_output|check_call)|os\.(system|popen|execv?p?e?|spawn\w+)|child_process\.(exec|spawn|execSync|spawnSync))\b/,
  },
  {
    kind: 'network-egress',
    label: 'Outbound HTTP client',
    pattern: /\b(requests\.(get|post|put|patch|delete)|httpx\.(get|post|Client|AsyncClient)|urllib\.request\.urlopen|aiohttp\.ClientSession|fetch)\s*\(/,
  },
  {
    kind: 'filesystem-write',
    label: 'Filesystem write outside a temporary directory',
    pattern: /\b(open\s*\([^,)]*,\s*['"`][wax]|shutil\.(copy\w*|move|rmtree)|os\.(remove|unlink|rmdir)|fs\.(writeFile|writeFileSync))\b/,
  },
]

/** Framework markers, used later to infer whether a file is a service entry point. */
const FRAMEWORK_MARKERS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'fastapi', pattern: /\bfrom\s+fastapi\b|\bFastAPI\s*\(/ },
  { id: 'flask', pattern: /\bfrom\s+flask\b|\bFlask\s*\(/ },
  { id: 'django', pattern: /\bdjango\.(conf|urls|http)\b/ },
  { id: 'uvicorn', pattern: /\buvicorn\.(run|Server)\b/ },
  { id: 'gunicorn', pattern: /\bgunicorn\b/ },
  { id: 'celery', pattern: /\bCelery\s*\(|\bshared_task\b/ },
  { id: 'streamlit', pattern: /\bimport\s+streamlit\b/ },
  { id: 'gradio', pattern: /\bimport\s+gradio\b|\bgr\.(Interface|Blocks)\b/ },
  { id: 'ray-serve', pattern: /\bray\.serve\b|\bserve\.deployment\b/ },
  { id: 'bentoml', pattern: /\bimport\s+bentoml\b/ },
  { id: 'torchserve', pattern: /\bBaseHandler\b|\bts\.torch_handler\b/ },
  { id: 'lambda', pattern: /\bdef\s+lambda_handler\s*\(/ },
  { id: 'airflow', pattern: /\bairflow\.(decorators|operators|models)\b/ },
  { id: 'mlflow', pattern: /\bimport\s+mlflow\b/ },
  { id: 'express', pattern: /\bexpress\s*\(\s*\)/ },
  { id: 'next', pattern: /\bnext\/(server|headers)\b/ },
]

function collectSignals(file: string, masked: Masked): PrivilegeSignal[] {
  const signals: PrivilegeSignal[] = []
  const seen = new Set<string>()
  // Run on the original text so that a secret name inside a string literal is
  // still visible; the mask exists for bracket safety, not for this.
  const lines = masked.text.split(/\r?\n/)
  for (let i = 0; i < Math.min(lines.length, MAX_LINES); i += 1) {
    const raw = lines[i] as string
    if (raw.length > MAX_LINE_LENGTH) continue
    for (const r of PRIVILEGE_RULES) {
      if (!r.pattern.test(raw)) continue
      const key = `${r.kind}:${r.label}`
      if (seen.has(key)) continue
      seen.add(key)
      signals.push({
        kind: r.kind,
        label: r.label,
        file,
        line: i + 1,
        evidence: clip(sanitise(raw), 140),
      })
    }
  }
  return signals
}

function collectFrameworks(text: string): string[] {
  const found: string[] = []
  for (const marker of FRAMEWORK_MARKERS) {
    if (marker.pattern.test(text)) found.push(marker.id)
  }
  return found
}

/* -------------------------------------------------------------------------- */
/* Python                                                                     */
/* -------------------------------------------------------------------------- */

const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#]+)$/gm
const PY_FROM = /^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import[ \t]+([^\n#]+)$/gm
const PY_DEF = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm
const PY_CLASS = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)/gm
/* -------------------------------------------------------------------------- */
/* Finding calls                                                              */
/* -------------------------------------------------------------------------- */

/** `[A-Za-z0-9_.]`, by code point. Called once per character of every file. */
function isNameChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 46
  )
}

/** `[A-Za-z_]`. A name may not begin with a digit or a dot. */
function isNameStart(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95
}

export interface CallSite {
  /** Index of the first character of the name. */
  readonly index: number
  /** The dotted expression being called, exactly as written. */
  readonly name: string
  /** Index of the opening bracket. */
  readonly open: number
}

/**
 * Every `name(` in masked source, left to right.
 *
 * This was one regular expression -- `/([A-Za-z_][\w.]*)[ \t]*\(/g` -- and it
 * was quadratic in the length of a line. At each starting position the engine
 * consumed the whole run of name characters, failed to find a bracket, and
 * handed the characters back one at a time; then it advanced one position and
 * did it again. Measured: 69 ms for a 10,000-character line, 17 s at 160,000,
 * and about three quarters of an hour for the 2 MB line that `MAX_SOURCE_BYTES`
 * permits. A minified bundle committed to a repository was therefore enough to
 * hang the analyser on that repository -- a denial of service delivered by the
 * thing being analysed, which is the one class of bug this product cannot have.
 *
 * Finding the bracket first and walking backwards over the name is linear in
 * the file. It accepts exactly what the expression accepted, including that
 * spaces and tabs may sit between a name and its bracket, and that `1foo(`
 * and `.foo(` are both calls to `foo`.
 */
export function* callSites(source: string): Generator<CallSite> {
  for (let open = source.indexOf('('); open !== -1; open = source.indexOf('(', open + 1)) {
    let at = open
    while (at > 0) {
      const code = source.charCodeAt(at - 1)
      if (code !== 32 && code !== 9) break
      at -= 1
    }
    let start = at
    while (start > 0 && isNameChar(source.charCodeAt(start - 1))) start -= 1
    while (start < at && !isNameStart(source.charCodeAt(start))) start += 1
    if (start === at) continue
    yield { index: start, name: source.slice(start, at), open }
  }
}
const PY_ASSIGN = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*([^\n#][^\n]*)$/gm
const PY_WITH =
  /\bwith[ \t]+((?:open|io\.open|gzip\.open|bz2\.open|lzma\.open)[ \t]*\([^\n]*?\))[ \t]+as[ \t]+([A-Za-z_]\w*)/gm

function pythonAliases(masked: Masked): Map<string, string> {
  const aliases = new Map<string, string>()
  const src = masked.masked

  PY_IMPORT.lastIndex = 0
  for (const match of src.matchAll(PY_IMPORT)) {
    for (const item of (match[1] as string).split(',')) {
      const parts = item.trim().split(/\s+as\s+/)
      const module = (parts[0] ?? '').trim()
      if (!/^[A-Za-z_][\w.]*$/.test(module)) continue
      const alias = (parts[1] ?? '').trim()
      if (alias !== '' && /^[A-Za-z_]\w*$/.test(alias)) aliases.set(alias, module)
      else {
        aliases.set(module, module)
        // `import a.b.c` also binds `a`.
        const head = module.split('.')[0] as string
        if (!aliases.has(head)) aliases.set(head, head)
      }
    }
  }

  PY_FROM.lastIndex = 0
  for (const match of src.matchAll(PY_FROM)) {
    const module = match[1] as string
    const names = (match[2] as string).replace(/[()]/g, '')
    for (const item of names.split(',')) {
      const parts = item.trim().split(/\s+as\s+/)
      const name = (parts[0] ?? '').trim()
      if (name === '' || name === '*') continue
      if (!/^[A-Za-z_]\w*$/.test(name)) continue
      const alias = (parts[1] ?? '').trim() || name
      aliases.set(alias, `${module}.${name}`)
    }
  }

  return aliases
}

/** Rewrite a call expression through the import aliases. */
function canonicalise(expression: string, aliases: Map<string, string>): string {
  const segments = expression.split('.')
  // Longest alias prefix wins, so `import torch.nn as nn` and `import torch`
  // both resolve correctly in the same file.
  for (let take = Math.min(segments.length, 4); take >= 1; take -= 1) {
    const prefix = segments.slice(0, take).join('.')
    const target = aliases.get(prefix)
    if (target !== undefined) {
      return [target, ...segments.slice(take)].join('.')
    }
  }
  return expression
}

interface Scope {
  readonly indent: number
  readonly name: string
  readonly index: number
}

function pythonScopes(masked: Masked): Scope[] {
  const scopes: Scope[] = []
  const src = masked.masked
  for (const re of [PY_DEF, PY_CLASS]) {
    re.lastIndex = 0
    for (const match of src.matchAll(re)) {
      scopes.push({
        indent: (match[1] as string).replace(/\t/g, '    ').length,
        name: match[2] as string,
        index: match.index ?? 0,
      })
    }
  }
  return scopes.sort((a, b) => a.index - b.index)
}

function enclosingOf(scopes: readonly Scope[], index: number, columnIndent: number): string | null {
  let best: Scope | null = null
  for (const scope of scopes) {
    if (scope.index > index) break
    if (scope.indent < columnIndent) {
      if (best === null || scope.indent >= best.indent) best = scope
    }
  }
  return best?.name ?? null
}

function indentOf(masked: Masked, index: number): number {
  const line = lineAt(masked, index)
  const start = masked.lineStarts[line - 1] as number
  let n = 0
  for (let i = start; i < index; i += 1) {
    const ch = masked.text[i]
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

/**
 * Every binding of a name, with the line it happened on.
 *
 * Line-scoped rather than first-wins, because the pattern this exists for is
 *
 *     with open(CLASSIFIER, "rb") as handle: pickle.load(handle)
 *     with open(THRESHOLDS, "rb") as handle: pickle.load(handle)
 *
 * where both calls bind the same name and a first-wins map would confidently
 * report two loads of the same file. Resolution takes the nearest binding at
 * or above the call, which is what a reader of the file does.
 */
export interface Bindings {
  nearest(name: string, atLine: number): string | null
}

function bindingsOf(masked: Masked): Bindings {
  const map = new Map<string, Array<{ line: number; expression: string }>>()

  const record = (name: string, index: number, raw: string): void => {
    const list = map.get(name) ?? []
    list.push({ line: lineAt(masked, index), expression: raw.trim() })
    map.set(name, list)
  }

  PY_ASSIGN.lastIndex = 0
  for (const match of masked.masked.matchAll(PY_ASSIGN)) {
    const start = (match.index ?? 0) + (match[0] as string).indexOf(match[2] as string)
    record(match[1] as string, start, masked.text.slice(start, start + (match[2] as string).length))
  }

  // `with open(path, "rb") as handle:` binds the handle to the path, so
  // `pickle.load(handle)` below it resolves to the file.
  PY_WITH.lastIndex = 0
  for (const match of masked.masked.matchAll(PY_WITH)) {
    const start = (match.index ?? 0) + (match[0] as string).indexOf(match[1] as string)
    record(match[2] as string, start, masked.text.slice(start, start + (match[1] as string).length))
  }

  for (const list of map.values()) list.sort((a, b) => a.line - b.line)

  return {
    nearest(name, atLine) {
      const list = map.get(name)
      if (list === undefined) return null
      let best: string | null = null
      for (const entry of list) {
        if (entry.line > atLine) break
        best = entry.expression
      }
      // A name bound only below the call is still the only candidate; module
      // constants defined after a function that uses them are ordinary Python.
      return best ?? (list[0]?.expression ?? null)
    },
  }
}



/**
 * Resolve a path expression to a string, or null.
 *
 * Supports the handful of shapes real loading code uses: a literal, a
 * variable holding a literal, `os.path.join`, `Path(...)`, `/` composition,
 * `+` concatenation and an f-string whose placeholders are themselves
 * resolvable. Everything else is unresolved, on purpose.
 */
export function resolvePathExpression(
  expression: string,
  bindings: Bindings,
  atLine: number,
  depth = 0,
): string | null {
  if (depth > 6) return null
  const text = expression.trim()
  if (text === '') return null

  const quoted = /^(?:([rRbBuU]{0,2})?)(['"])((?:[^\\]|\\.)*?)\2$/.exec(text)
  if (quoted) return quoted[3] as string

  const fstring = /^[fF]([rR]?)(['"])((?:[^\\]|\\.)*?)\2$/.exec(text)
  if (fstring) {
    let out = ''
    const body = fstring[3] as string
    let i = 0
    while (i < body.length) {
      const open = body.indexOf('{', i)
      if (open === -1) {
        out += body.slice(i)
        break
      }
      out += body.slice(i, open)
      const close = body.indexOf('}', open)
      if (close === -1) return null
      const inner = body.slice(open + 1, close).split(':')[0] as string
      const resolved = resolvePathExpression(inner, bindings, atLine, depth + 1)
      if (resolved === null) return null
      out += resolved
      i = close + 1
    }
    return out
  }

  const bare = /^[A-Za-z_]\w*$/.exec(text)
  if (bare) {
    const next = bindings.nearest(text, atLine)
    return next === null ? null : resolvePathExpression(next, bindings, atLine, depth + 1)
  }

  const wrapper = /^(?:os\.path\.join|Path|pathlib\.Path|str|os\.fspath)\s*\((.*)\)$/s.exec(text)
  if (wrapper) {
    const parts = splitTopLevel(wrapper[1] as string)
    const resolved = parts.map((p) => resolvePathExpression(p, bindings, atLine, depth + 1))
    if (resolved.some((r) => r === null)) return null
    return (resolved as string[]).join('/').replace(/\/{2,}/g, '/')
  }

  // `pickle.load(open(path, "rb"))` is the most common way this is written, so
  // a file handle resolves to the path it was opened on. Only the first
  // argument matters; the mode is not part of the path.
  const opened = /^(?:open|io\.open|gzip\.open|bz2\.open|lzma\.open)\s*\((.*)\)$/s.exec(text)
  if (opened) {
    const first = splitTopLevel(opened[1] as string)[0]
    return first === undefined ? null : resolvePathExpression(first, bindings, atLine, depth + 1)
  }

  // `Path("weights/x.pt").open("rb")` and `.read_bytes()` do the same.
  const method = /^(.*?)\.(?:open|read_bytes|read_text|resolve|absolute)\s*\([^)]*\)$/s.exec(text)
  if (method) return resolvePathExpression(method[1] as string, bindings, atLine, depth + 1)

  if (text.includes('/') || text.includes('+')) {
    const operator = text.includes('+') && !text.includes('/') ? '+' : '/'
    const parts = splitOperator(text, operator)
    if (parts.length > 1) {
      const resolved = parts.map((p) => resolvePathExpression(p, bindings, atLine, depth + 1))
      if (resolved.some((r) => r === null)) return null
      const joined = (resolved as string[]).join(operator === '+' ? '' : '/')
      return joined.replace(/\/{2,}/g, '/')
    }
  }

  return null
}

/** Split on top-level commas, respecting brackets and quotes crudely. */
function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote !== '') {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/** Split on a top-level binary operator. */
function splitOperator(text: string, operator: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote !== '') {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === operator && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  const parts = out.map((s) => s.trim()).filter((s) => s !== '')
  return parts
}

function readArguments(masked: Masked, open: number, close: number): CallArgument[] {
  const args: CallArgument[] = []
  for (const range of splitArguments(masked.masked, open, close)) {
    const raw = masked.text.slice(range.start, range.end)
    const keywordMatch = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(masked.masked.slice(range.start, range.end))
    let keyword: string | null = null
    let valueStart = range.start
    if (keywordMatch) {
      keyword = keywordMatch[1] as string
      valueStart = range.start + (keywordMatch[0] as string).length
    }
    const valueText = masked.text.slice(valueStart, range.end).trim()
    const literal = literalIn(masked, valueStart, range.end)
    // An f-string's decoded body still contains its placeholders, so it is not
    // a value. Leave it for resolvePathExpression, which can substitute them
    // or decline to.
    let value: string | null =
      literal !== null && !literal.prefix.includes('f') ? literal.value : null
    if (value === null) {
      if (/^(True|true)$/.test(valueText)) value = 'true'
      else if (/^(False|false)$/.test(valueText)) value = 'false'
      else if (/^(None|null|undefined)$/.test(valueText)) value = 'none'
      else if (/^-?\d+(\.\d+)?$/.test(valueText)) value = valueText
    }
    args.push({
      keyword,
      literal: value === null ? null : clip(sanitise(value), MAX_ARG_CHARS),
      text: clip(sanitise(raw), MAX_ARG_CHARS),
    })
  }
  return args
}

function pickTarget(
  args: readonly CallArgument[],
  positions: readonly number[],
  keywords: readonly string[],
): CallArgument | null {
  for (const keyword of keywords) {
    const found = args.find((a) => a.keyword === keyword)
    if (found) return found
  }
  const positional = args.filter((a) => a.keyword === null)
  for (const index of positions) {
    const found = positional[index]
    if (found) return found
  }
  return null
}

export function scanPython(file: string, text: string): ScanResult {
  if (text.length === 0) return EMPTY
  const masked = maskPython(text)
  const aliases = pythonAliases(masked)
  const scopes = pythonScopes(masked)
  const bindings = bindingsOf(masked)
  const calls: RawCall[] = []

  for (const site of callSites(masked.masked)) {
    const expression = site.name
    const segments = expression.split('.')
    const last = segments[segments.length - 1] as string
    // Cheap reject first. A bare name is only worth resolving when it is one a
    // rule could match, or when this file bound it to something by an alias:
    // `from torch import load as tload` gives a call named nothing like `load`.
    if (!BARE_NAMES.has(last) && !(segments.length === 1 && aliases.has(expression))) continue

    const canonical = canonicalise(expression, aliases)
    const loaderId = matchLoader(canonical, 'python')
    if (loaderId === null) continue

    const open = site.open
    const close = matchBracket(masked.masked, open)
    if (close === -1) continue

    const rule = LOADER_TARGETS.get(loaderId)
    const args = readArguments(masked, open, close)
    const target = rule ? pickTarget(args, rule.positions, rule.keywords) : null
    const index = site.index

    calls.push({
      file,
      line: lineAt(masked, index),
      enclosing: enclosingOf(scopes, index, indentOf(masked, index)),
      loaderId,
      canonical,
      snippet: clip(sanitise(masked.text.slice(index, close + 1)), MAX_SNIPPET_CHARS),
      args,
      targetExpression: target ? target.text : '',
      targetLiteral:
        target === null
          ? null
          : (target.literal ??
            resolvePathExpression(stripKeyword(target.text), bindings, lineAt(masked, index))),
    })
  }

  return {
    calls,
    privileges: collectSignals(file, masked),
    imports: [...new Set(aliases.values())].sort(),
    frameworks: collectFrameworks(text),
  }
}

function stripKeyword(text: string): string {
  const match = /^\s*[A-Za-z_]\w*\s*=(?!=)\s*(.*)$/s.exec(text)
  return match ? (match[1] as string) : text
}

/* -------------------------------------------------------------------------- */
/* JavaScript and TypeScript                                                  */
/* -------------------------------------------------------------------------- */

const JS_IMPORT = /import\s+(?:([\w*\s{},$]+)\s+from\s+)?['"]([^'"]+)['"]/g
const JS_REQUIRE = /(?:const|let|var)\s+([\w{},:\s$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const JS_FN = /(?:function\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\()/g
const JS_ASSIGN = /(?:const|let|var)\s+([\w$]+)\s*(?::\s*[\w<>[\]|]+\s*)?=\s*([^\n;]+)/g

function jsBindings(masked: Masked): Bindings {
  const map = new Map<string, Array<{ line: number; expression: string }>>()
  JS_ASSIGN.lastIndex = 0
  for (const match of masked.masked.matchAll(JS_ASSIGN)) {
    const start = (match.index ?? 0) + (match[0] as string).indexOf(match[2] as string)
    const name = match[1] as string
    const list = map.get(name) ?? []
    list.push({
      line: lineAt(masked, start),
      expression: masked.text.slice(start, start + (match[2] as string).length).trim(),
    })
    map.set(name, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.line - b.line)
  return {
    nearest(name, atLine) {
      const list = map.get(name)
      if (list === undefined) return null
      let best: string | null = null
      for (const entry of list) {
        if (entry.line > atLine) break
        best = entry.expression
      }
      return best ?? (list[0]?.expression ?? null)
    },
  }
}

function jsAliases(masked: Masked): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const re of [JS_IMPORT, JS_REQUIRE]) {
    re.lastIndex = 0
    for (const match of masked.masked.matchAll(re)) {
      const clause = (match[1] ?? '').trim()
      const module = (match[2] as string).replace(/^@[^/]+\//, '')
      if (clause === '') continue
      const named = /\{([^}]*)\}/.exec(clause)
      if (named) {
        for (const item of (named[1] as string).split(',')) {
          const parts = item.trim().split(/\s+as\s+|\s*:\s*/)
          const name = (parts[0] ?? '').trim()
          const alias = (parts[1] ?? '').trim() || name
          if (/^[\w$]+$/.test(alias)) aliases.set(alias, name)
        }
      }
      const def = clause.replace(/\{[^}]*\}/g, '').replace(/,/g, '').trim()
      if (/^[\w$]+$/.test(def)) aliases.set(def, module)
      const star = /\*\s+as\s+([\w$]+)/.exec(clause)
      if (star) aliases.set(star[1] as string, module)
    }
  }
  return aliases
}

export function scanJs(file: string, text: string): ScanResult {
  if (text.length === 0) return EMPTY
  const masked = maskJs(text)
  const aliases = jsAliases(masked)
  const bindings = jsBindings(masked)
  const calls: RawCall[] = []

  const functions: Scope[] = []
  JS_FN.lastIndex = 0
  for (const match of masked.masked.matchAll(JS_FN)) {
    const name = match[1] ?? match[2]
    if (name) functions.push({ indent: 0, name, index: match.index ?? 0 })
  }

  for (const site of callSites(masked.masked)) {
    const expression = site.name
    const segments = expression.split('.')
    const last = segments[segments.length - 1] as string
    if (!BARE_NAMES.has(last)) continue

    const canonical = canonicalise(expression, aliases)
    const loaderId = matchLoader(canonical, 'javascript')
    if (loaderId === null) continue

    const open = site.open
    const close = matchBracket(masked.masked, open)
    if (close === -1) continue

    const rule = LOADER_TARGETS.get(loaderId)
    const args = readArguments(masked, open, close)
    const target = rule ? pickTarget(args, rule.positions, rule.keywords) : null
    const index = site.index

    let enclosing: string | null = null
    for (const fn of functions) {
      if (fn.index < index) enclosing = fn.name
      else break
    }

    calls.push({
      file,
      line: lineAt(masked, index),
      enclosing,
      loaderId,
      canonical,
      snippet: clip(sanitise(masked.text.slice(index, close + 1)), MAX_SNIPPET_CHARS),
      args,
      targetExpression: target ? target.text : '',
      targetLiteral:
        target === null
          ? null
          : (target.literal ??
            resolvePathExpression(stripKeyword(target.text), bindings, lineAt(masked, index))),
    })
  }

  return {
    calls,
    privileges: collectSignals(file, masked),
    imports: [...new Set(aliases.values())].sort(),
    frameworks: collectFrameworks(text),
  }
}

/* -------------------------------------------------------------------------- */

export function scanSource(
  file: string,
  text: string,
  ecosystem: LoaderEcosystem,
): ScanResult {
  return ecosystem === 'python' ? scanPython(file, text) : scanJs(file, text)
}
