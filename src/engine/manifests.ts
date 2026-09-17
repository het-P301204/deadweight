/**
 * Declared AI artifacts: skills, agents, MCP servers, prompt templates.
 *
 * The other half of the supply chain. A model file is loaded by a line of
 * code; these are loaded by a *declaration*, and the declaration is both the
 * artifact reference and the load site. Reading the manifest is therefore the
 * whole of discovery for them.
 *
 * Two behaviours show up here and they are not the same thing:
 *
 *   An MCP stdio server entry names a command the client spawns when the
 *   session starts. That is `code`: a process runs because the manifest was
 *   read, before any tool is called and before the model decides anything.
 *
 *   A skill, an agent definition or a prompt template executes nothing. It
 *   places instructions where a model will act on them, together with a list
 *   of tools those instructions may reach. That is `directive`, and reporting
 *   it as "data, no execution" would be true and useless.
 *
 * Parsing is deliberately shallow: flat frontmatter, and JSON via the built-in
 * parser with prototype-polluting keys dropped on the way out. There is no
 * YAML engine here, because a YAML engine is a deserialiser and this codebase
 * is not going to ship one to read a file it does not trust.
 */

import { MAX_MANIFEST_BYTES, clip, sanitise } from './limits.ts'
import { basename, dirname, stem } from './source.ts'
import type { SourceTree, TreeEntry } from './source.ts'
import type { ArtifactOrigin, BehaviourStep, FormatId, LoadBehaviour } from './types.ts'

export interface DeclaredFact {
  readonly label: string
  readonly value: string
}

export interface DeclaredLoad {
  readonly artifactId: string
  readonly name: string
  readonly locator: string
  readonly format: FormatId
  readonly version: string | null
  readonly origin: ArtifactOrigin
  readonly formatNote: string
  readonly loaderLabel: string
  readonly loaderSummary: string
  readonly file: string
  readonly line: number
  readonly snippet: string
  readonly targetExpression: string
  readonly behaviour: LoadBehaviour
  readonly mechanism: string
  readonly steps: readonly BehaviourStep[]
  readonly facts: readonly DeclaredFact[]
  /** Tools or permissions the declaration grants, verbatim. */
  readonly grants: readonly string[]
}

/* -------------------------------------------------------------------------- */
/* Frontmatter                                                                */
/* -------------------------------------------------------------------------- */

export interface Frontmatter {
  readonly fields: Readonly<Record<string, string>>
  readonly lists: Readonly<Record<string, readonly string[]>>
  readonly body: string
  readonly lineOffset: number
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Read a `---` delimited frontmatter block as flat key/value pairs.
 *
 * Supports `key: value`, `key: [a, b]` and a block list of `- item` lines.
 * Nested mappings are not supported and are reported as a raw value, which is
 * enough for every schema this reads and avoids implementing YAML.
 */
export function readFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith('---')) return null
  const lines = text.split(/\r?\n/)
  if ((lines[0] as string).trim() !== '---') return null

  let end = -1
  for (let i = 1; i < Math.min(lines.length, 400); i += 1) {
    if ((lines[i] as string).trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return null

  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  const lists: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  let currentList: string | null = null

  for (let i = 1; i < end; i += 1) {
    const raw = lines[i] as string
    const item = /^\s*-\s+(.*)$/.exec(raw)
    if (item && currentList !== null) {
      const list = lists[currentList]
      if (list) list.push(unquote(item[1] as string))
      continue
    }
    const pair = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(raw)
    if (!pair) continue
    const key = (pair[1] as string).toLowerCase()
    if (UNSAFE_KEYS.has(key)) continue
    const value = (pair[2] as string).trim()
    if (value === '') {
      currentList = key
      lists[key] = []
      continue
    }
    currentList = null
    const inline = /^\[(.*)\]$/.exec(value)
    if (inline) {
      lists[key] = (inline[1] as string)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== '')
      continue
    }
    fields[key] = clip(sanitise(unquote(value)), 400)
  }

  return {
    fields,
    lists,
    body: lines.slice(end + 1).join('\n'),
    lineOffset: end + 1,
  }
}

function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value.trim())
  return match ? (match[2] as string) : value.trim()
}

/* -------------------------------------------------------------------------- */
/* JSON reading                                                               */
/* -------------------------------------------------------------------------- */

/** Parse JSON and strip prototype-polluting keys at every level. */
export function safeJson(text: string): unknown {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  return scrub(doc, 0)
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > 32) return null
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue
    out[key] = scrub(inner, depth + 1)
  }
  return out
}

/** 1-indexed line of the first occurrence of a quoted key, or 1. */
function lineOfKey(text: string, key: string): number {
  const at = text.indexOf(`"${key}"`)
  if (at === -1) return 1
  let line = 1
  for (let i = 0; i < at; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? clip(sanitise(value), 400) : null
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string').map((v) => clip(sanitise(v), 120))
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => clip(sanitise(s.trim()), 120))
      .filter((s) => s !== '')
  }
  return []
}

/* -------------------------------------------------------------------------- */
/* Recognisers                                                                */
/* -------------------------------------------------------------------------- */

const SKILL_PATH = /(^|\/)SKILL\.md$/
const AGENT_PATH = /(^|\/)(agents|subagents)\/[^/]+\.(md|ya?ml|json)$/
const MCP_PATH =
  /(^|\/)(\.mcp\.json|mcp\.json|claude_desktop_config\.json|mcp_servers\.json|\.cursor\/mcp\.json)$/
const SETTINGS_PATH = /(^|\/)\.claude\/settings(\.local)?\.json$/
const PROMPT_PATH = /(^|\/)(prompts?|templates?)\/[^/]+\.(md|txt|jinja|j2|prompt)$/

export function isDeclarationFile(path: string): boolean {
  return (
    SKILL_PATH.test(path) ||
    AGENT_PATH.test(path) ||
    MCP_PATH.test(path) ||
    SETTINGS_PATH.test(path) ||
    PROMPT_PATH.test(path)
  )
}

/** Scripts a skill body points at, which is where its directive surface becomes code. */
function referencedScripts(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(
    /(?:^|[\s`'"(])((?:\.\/|scripts\/|bin\/|tools\/)[\w./-]+\.(?:py|sh|ps1|js|ts|rb))/g,
  )) {
    found.add(match[1] as string)
  }
  return [...found].sort().slice(0, 12)
}

function skillLoad(path: string, text: string): DeclaredLoad | null {
  const front = readFrontmatter(text)
  if (front === null) return null
  const name = front.fields['name'] ?? stem(basename(dirname(path))) ?? basename(path)
  const description = front.fields['description'] ?? ''
  const grants = [...(front.lists['allowed-tools'] ?? []), ...asStringList(front.fields['allowed-tools'])]
  const scripts = referencedScripts(front.body)

  const steps: BehaviourStep[] = [
    {
      claim: 'The file is an agent skill: Markdown instructions with structured frontmatter.',
      basis: `${path}:1`,
    },
    {
      claim: 'Loading places its text into a model context as instructions, and executes nothing itself.',
      basis: 'format: agent-skill',
    },
  ]
  if (grants.length > 0) {
    steps.push({
      claim: `The declaration grants ${grants.join(', ')}, so those instructions can reach those tools.`,
      basis: `${path}:1 allowed-tools`,
    })
  }
  if (scripts.length > 0) {
    steps.push({
      claim: `The body points at ${scripts.length} executable file${scripts.length === 1 ? '' : 's'}; an agent following the instructions would run them.`,
      basis: `${path} body`,
    })
  }

  const facts: DeclaredFact[] = []
  if (description !== '') facts.push({ label: 'Declared purpose', value: description })
  if (scripts.length > 0) facts.push({ label: 'Referenced executables', value: scripts.join(', ') })
  const license = front.fields['license']
  if (license) facts.push({ label: 'License', value: license })

  return {
    artifactId: `skill:${name}`,
    name,
    locator: path,
    format: 'agent-skill',
    version: front.fields['version'] ?? null,
    origin: 'in-tree',
    formatNote: 'Markdown with `---` frontmatter declaring a name and description',
    loaderLabel: 'agent runtime (skill discovery)',
    loaderSummary:
      'The runtime enumerates skill files and injects the matching one into the model context.',
    file: path,
    line: 1,
    snippet: clip(sanitise(description || name), 200),
    targetExpression: path,
    behaviour: 'directive',
    mechanism:
      scripts.length > 0
        ? 'Loading injects instructions that direct an agent to run the executables the skill ships with.'
        : 'Loading injects instructions into a model context. Nothing runs at load; what runs afterwards is whatever the instructions direct.',
    steps,
    facts,
    grants,
  }
}

function agentLoad(path: string, text: string): DeclaredLoad | null {
  const front = readFrontmatter(text)
  const name = front?.fields['name'] ?? stem(path)
  const tools = [
    ...(front?.lists['tools'] ?? []),
    ...asStringList(front?.fields['tools'] ?? ''),
    ...(front?.lists['allowed-tools'] ?? []),
  ]
  const facts: DeclaredFact[] = []
  const description = front?.fields['description']
  if (description) facts.push({ label: 'Declared purpose', value: description })
  const model = front?.fields['model']
  if (model) facts.push({ label: 'Model', value: model })

  const grantsEverything = tools.includes('*')
  const steps: BehaviourStep[] = [
    { claim: 'The file declares an agent: a system prompt plus a tool grant.', basis: `${path}:1` },
    {
      claim: grantsEverything
        ? 'The tool grant is `*`, so the instructions in this file can reach every tool the host exposes.'
        : tools.length > 0
          ? `The tool grant is ${tools.join(', ')}.`
          : 'No explicit tool grant; the agent inherits whatever the host allows.',
      basis: `${path}:1 tools`,
    },
  ]

  return {
    artifactId: `agent:${name}`,
    name,
    locator: path,
    format: 'agent-definition',
    version: front?.fields['version'] ?? null,
    origin: 'in-tree',
    formatNote: front ? 'structured frontmatter declaring an agent' : 'agent definition by path convention',
    loaderLabel: 'agent runtime (agent registry)',
    loaderSummary: 'The runtime registers the definition and uses its prompt and tool list when dispatched.',
    file: path,
    line: 1,
    snippet: clip(sanitise(description ?? name), 200),
    targetExpression: path,
    behaviour: 'directive',
    mechanism:
      'Loading registers a system prompt and a tool grant. The prompt becomes instructions a model follows; the grant becomes what those instructions can reach.',
    steps,
    facts,
    grants: tools,
  }
}

function promptLoad(path: string, text: string): DeclaredLoad {
  const front = readFrontmatter(text)
  const placeholders = new Set<string>()
  for (const match of text.matchAll(/\{\{?\s*([A-Za-z_][\w.]*)\s*\}?\}/g)) {
    placeholders.add(match[1] as string)
    if (placeholders.size >= 12) break
  }
  const facts: DeclaredFact[] = []
  if (placeholders.size > 0) {
    facts.push({ label: 'Interpolated values', value: [...placeholders].join(', ') })
  }
  return {
    artifactId: `prompt:${path}`,
    name: stem(path),
    locator: path,
    format: 'prompt-template',
    version: front?.fields['version'] ?? null,
    origin: 'in-tree',
    formatNote: 'instruction text under a prompts or templates directory',
    loaderLabel: 'application (template interpolation)',
    loaderSummary: 'The application reads the template, substitutes values and sends the result as instructions.',
    file: path,
    line: 1,
    snippet: clip(sanitise(text.slice(0, 200)), 200),
    targetExpression: path,
    behaviour: 'directive',
    mechanism:
      placeholders.size > 0
        ? `Loading produces instructions with ${placeholders.size} interpolated value${placeholders.size === 1 ? '' : 's'}; whatever reaches those placeholders reaches the model as instruction text.`
        : 'Loading produces instruction text for a model context. Nothing executes at load.',
    steps: [
      { claim: 'The file is a prompt template.', basis: `${path}:1` },
      {
        claim: 'Interpolation happens before the text becomes instructions, so an untrusted value becomes untrusted instruction.',
        basis: 'format: prompt-template',
      },
    ],
    facts,
    grants: [],
  }
}

/** MCP server entries, from any of the client configuration shapes. */
function mcpLoads(path: string, text: string): DeclaredLoad[] {
  const doc = safeJson(text)
  if (doc === null || typeof doc !== 'object') return []
  const root = doc as Record<string, unknown>
  const block =
    (root['mcpServers'] as Record<string, unknown> | undefined) ??
    (root['servers'] as Record<string, unknown> | undefined) ??
    null
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return []

  const loads: DeclaredLoad[] = []
  for (const [name, value] of Object.entries(block)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const command = asString(entry['command'])
    const args = asStringList(entry['args'])
    const url = asString(entry['url']) ?? asString(entry['endpoint'])
    const transport = asString(entry['type']) ?? asString(entry['transport'])
    const line = lineOfKey(text, name)
    const facts: DeclaredFact[] = []
    if (command !== null) {
      facts.push({ label: 'Spawned command', value: [command, ...args].join(' ') })
    }
    if (url !== null) facts.push({ label: 'Endpoint', value: url })
    if (transport !== null) facts.push({ label: 'Transport', value: transport })
    const env = entry['env']
    if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
      const keys = Object.keys(env as Record<string, unknown>)
      if (keys.length > 0) {
        facts.push({ label: 'Environment passed through', value: keys.join(', ') })
      }
    }

    const stdio = command !== null
    loads.push({
      artifactId: `mcp:${name}`,
      name,
      locator: `${path}#${name}`,
      format: 'mcp-server-manifest',
      version: null,
      origin: stdio ? 'in-tree' : 'remote-reference',
      formatNote: stdio
        ? `stdio server entry naming the command \`${clip([command, ...args].join(' '), 80)}\``
        : 'remote server entry naming an endpoint',
      loaderLabel: stdio ? 'MCP client (stdio transport)' : 'MCP client (remote transport)',
      loaderSummary: stdio
        ? 'The client spawns the declared command as a child process when the session starts.'
        : 'The client connects to the endpoint and reads its tool list at session start.',
      file: path,
      line,
      snippet: clip(sanitise(stdio ? [command, ...args].join(' ') : (url ?? name)), 200),
      targetExpression: `${path}#${name}`,
      behaviour: stdio ? 'code' : 'directive',
      mechanism: stdio
        ? 'Reading the manifest spawns this command as a child process. The process runs before any tool is called and before the model has decided anything.'
        : 'Reading the manifest connects to a server whose tool names and descriptions enter the model context as instructions.',
      steps: stdio
        ? [
            {
              claim: 'The entry declares a stdio transport with a command.',
              basis: `${path}:${line}`,
            },
            {
              claim: `The client executes \`${clip([command as string, ...args].join(' '), 90)}\` at session start.`,
              basis: 'MCP stdio transport',
            },
            {
              claim: 'What that command does is determined by the package it resolves to at run time, not by this file.',
              basis: 'format: mcp-server-manifest',
            },
          ]
        : [
            { claim: 'The entry declares a remote transport.', basis: `${path}:${line}` },
            {
              claim: 'Nothing is spawned locally; the tool descriptions the server returns become instructions in the model context.',
              basis: 'MCP remote transport',
            },
            {
              claim: 'DEADWEIGHT does not contact the endpoint, so what it would return is unknown to this analysis.',
              basis: 'offline by design',
            },
          ],
      facts,
      grants: [],
    })
  }
  return loads
}

/** Hook commands declared in a settings file, which run on a host event. */
function hookLoads(path: string, text: string): DeclaredLoad[] {
  const doc = safeJson(text)
  if (doc === null || typeof doc !== 'object') return []
  const hooks = (doc as Record<string, unknown>)['hooks']
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return []

  const loads: DeclaredLoad[] = []
  for (const [event, value] of Object.entries(hooks as Record<string, unknown>)) {
    const commands = collectHookCommands(value)
    for (const command of commands) {
      const line = lineOfKey(text, event)
      loads.push({
        artifactId: `hook:${event}:${command.slice(0, 40)}`,
        name: `${event} hook`,
        locator: `${path}#hooks.${event}`,
        format: 'agent-definition',
        version: null,
        origin: 'in-tree',
        formatNote: `hook entry for the ${event} event`,
        loaderLabel: 'agent runtime (hook registry)',
        loaderSummary: 'The runtime registers the command and executes it when the event fires.',
        file: path,
        line,
        snippet: clip(sanitise(command), 200),
        targetExpression: `${path}#hooks.${event}`,
        behaviour: 'code',
        mechanism: `Reading this settings file registers a shell command that the host runs on every ${event} event.`,
        steps: [
          { claim: `A hook is declared for the ${event} event.`, basis: `${path}:${line}` },
          { claim: `The command is \`${clip(command, 90)}\`.`, basis: `${path}:${line}` },
          {
            claim: 'The command runs with the privileges of the process that loaded the settings file.',
            basis: 'host hook execution',
          },
        ],
        facts: [{ label: 'Command', value: clip(command, 200) }],
        grants: [],
      })
    }
  }
  return loads
}

function collectHookCommands(value: unknown, depth = 0): string[] {
  if (depth > 6) return []
  if (Array.isArray(value)) return value.flatMap((v) => collectHookCommands(v, depth + 1))
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const command = asString(record['command'])
  const nested = Object.entries(record)
    .filter(([key]) => key !== 'command')
    .flatMap(([, v]) => collectHookCommands(v, depth + 1))
  return command === null ? nested : [command, ...nested]
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function readDeclarations(
  tree: SourceTree,
  entries: readonly TreeEntry[],
): Promise<readonly DeclaredLoad[]> {
  const loads: DeclaredLoad[] = []

  for (const entry of entries) {
    if (!isDeclarationFile(entry.path)) continue
    if (entry.size > MAX_MANIFEST_BYTES) continue
    const text = await tree.readText(entry.path, MAX_MANIFEST_BYTES)
    if (text === null) continue

    if (MCP_PATH.test(entry.path)) {
      loads.push(...mcpLoads(entry.path, text))
      continue
    }
    if (SETTINGS_PATH.test(entry.path)) {
      loads.push(...mcpLoads(entry.path, text))
      loads.push(...hookLoads(entry.path, text))
      continue
    }
    if (SKILL_PATH.test(entry.path)) {
      const load = skillLoad(entry.path, text)
      if (load) loads.push(load)
      continue
    }
    if (AGENT_PATH.test(entry.path)) {
      const load = agentLoad(entry.path, text)
      if (load) loads.push(load)
      continue
    }
    if (PROMPT_PATH.test(entry.path)) {
      loads.push(promptLoad(entry.path, text))
    }
  }

  return loads.sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0))
}
