/**
 * Load context.
 *
 * Executability and context are separate questions and this product never
 * multiplies them into a score. A pickle loaded in a throwaway notebook and
 * the same pickle loaded by a request handler holding cloud credentials are
 * the same execution surface reached from two very different places, and the
 * useful output is the coordinate, not a number.
 *
 * Context comes from one of three places, and which one is always shown:
 *
 *   declared   a glob in the project's deadweight configuration said so
 *   inferred   a path rule below matched, or the file builds a server
 *   unresolved neither, and DEADWEIGHT will not assume
 *
 * The privilege signals are a deliberately conservative join. They say the
 * *process performing the load* has this reach, because the signal was found
 * in the same file. They do not say the artifact uses it.
 */

import type { ProjectConfig } from './config.ts'
import { matchesGlob } from './source.ts'
import type { ContextBasis, EnvironmentId, LoadContext, PrivilegeSignal } from './types.ts'

interface PathRule {
  readonly environment: EnvironmentId
  readonly patterns: readonly string[]
  readonly description: string
}

/** First match wins, so the order is the policy. */
const PATH_RULES: readonly PathRule[] = [
  {
    environment: 'ci',
    patterns: [
      '.github/workflows/**',
      '.github/actions/**',
      '.gitlab-ci.yml',
      '.circleci/**',
      '.buildkite/**',
      'azure-pipelines*.yml',
      'Jenkinsfile',
      '**/Jenkinsfile',
    ],
    description: 'continuous integration definition',
  },
  {
    environment: 'build',
    patterns: [
      '**/Dockerfile',
      '**/Dockerfile.*',
      '**/*.dockerfile',
      'setup.py',
      'Makefile',
      'scripts/build*',
      'build/**',
      'packaging/**',
      'docker/**',
    ],
    description: 'build or packaging definition',
  },
  { environment: 'notebook', patterns: ['**/*.ipynb'], description: 'Jupyter notebook' },
  {
    environment: 'development',
    patterns: [
      '.claude/**',
      '.mcp.json',
      'mcp.json',
      '.cursor/**',
      '.vscode/mcp.json',
      'claude_desktop_config.json',
    ],
    description:
      'agent runtime configuration, loaded on whichever machine runs the agent and with that machine’s reach',
  },
  {
    environment: 'test',
    patterns: [
      'tests/**',
      'test/**',
      '**/test_*.py',
      '**/*_test.py',
      '**/conftest.py',
      '**/*.test.ts',
      '**/*.spec.ts',
    ],
    description: 'test suite',
  },
  {
    environment: 'sandbox',
    patterns: [
      'examples/**',
      'example/**',
      'sandbox/**',
      'playground/**',
      'scratch/**',
      'demo/**',
      'demos/**',
      'notebooks/**',
      'research/**',
    ],
    description: 'example or scratch directory',
  },
]

/** Framework markers that make a file a long-running request handler. */
const SERVICE_FRAMEWORKS: ReadonlySet<string> = new Set([
  'fastapi',
  'flask',
  'django',
  'uvicorn',
  'gunicorn',
  'ray-serve',
  'bentoml',
  'torchserve',
  'lambda',
  'celery',
  'express',
  'next',
  'streamlit',
  'gradio',
])

export interface ContextInput {
  readonly file: string
  readonly frameworks: readonly string[]
  readonly privileges: readonly PrivilegeSignal[]
}

export function contextIdFor(file: string): string {
  return `ctx:${file}`
}

export function classifyContext(input: ContextInput, config: ProjectConfig): LoadContext {
  const declared = declaredEnvironment(input.file, config)
  if (declared !== null) {
    return build(input, declared.environment, 'declared', declared.rule)
  }

  for (const rule of PATH_RULES) {
    const pattern = rule.patterns.find((p) => matchesGlob(input.file, p))
    if (pattern !== undefined) {
      return build(input, rule.environment, 'inferred', `${rule.description} (\`${pattern}\`)`)
    }
  }

  const framework = input.frameworks.find((f) => SERVICE_FRAMEWORKS.has(f))
  if (framework !== undefined) {
    return build(
      input,
      'service',
      'inferred',
      `the file builds a ${framework} entry point, so the load happens inside a running service`,
    )
  }

  // Deliberately not "development". Whether this path is deployed is a fact
  // about the deployment, not about the repository, and guessing would put a
  // green label on a production load.
  return build(
    input,
    'unresolved',
    'unresolved',
    'no path rule matched and no environment is declared for this path',
  )
}

function declaredEnvironment(
  file: string,
  config: ProjectConfig,
): { environment: EnvironmentId; rule: string } | null {
  for (const [environment, globs] of config.environments) {
    for (const glob of globs) {
      if (matchesGlob(file, glob)) {
        return {
          environment,
          rule: `declared as ${environment} by \`${glob}\` in ${config.source ?? 'the project configuration'}`,
        }
      }
    }
  }
  return null
}

function build(
  input: ContextInput,
  environment: EnvironmentId,
  basis: ContextBasis,
  rule: string,
): LoadContext {
  const privileges = [...input.privileges].sort((a, b) =>
    a.kind === b.kind ? a.line - b.line : a.kind < b.kind ? -1 : 1,
  )
  return {
    id: contextIdFor(input.file),
    file: input.file,
    environment,
    basis,
    rule,
    privileges,
    privileged: privileges.length > 0,
  }
}

/**
 * Environments in reach order: how far a compromise at a load site in each
 * one travels. Every place that shows a subset of an artifact's environments
 * sorts by this first, so a truncated list never hides production behind a
 * notebook.
 */
export const ENVIRONMENT_ORDER: readonly EnvironmentId[] = [
  'production',
  'staging',
  'service',
  'ci',
  'build',
  'notebook',
  'development',
  'test',
  'sandbox',
  'unresolved',
]

export function byReach(a: EnvironmentId, b: EnvironmentId): number {
  return ENVIRONMENT_ORDER.indexOf(a) - ENVIRONMENT_ORDER.indexOf(b)
}

/** Deduplicate an artifact's contexts to one per environment, in reach order. */
export function distinctEnvironments(contexts: readonly LoadContext[]): readonly LoadContext[] {
  const byEnvironment = new Map<EnvironmentId, LoadContext>()
  for (const context of contexts) {
    const existing = byEnvironment.get(context.environment)
    // Keep the privileged one, so a collapsed badge still carries the marker.
    if (existing === undefined || (context.privileged && !existing.privileged)) {
      byEnvironment.set(context.environment, context)
    }
  }
  return [...byEnvironment.values()].sort((a, b) => byReach(a.environment, b.environment))
}

/** Display metadata for each environment, shared by the UI and the CLI. */
export const ENVIRONMENT_META: Readonly<
  Record<EnvironmentId, { label: string; short: string; note: string }>
> = {
  production: {
    label: 'Production',
    short: 'PROD',
    note: 'Declared as production. A load here happens with whatever the deployment holds.',
  },
  staging: {
    label: 'Staging',
    short: 'STG',
    note: 'Declared as staging. Often holds real credentials against non-real data.',
  },
  service: {
    label: 'Service',
    short: 'SVC',
    note: 'A long-running request handler. Inferred from the framework, not from a deployment.',
  },
  ci: {
    label: 'CI',
    short: 'CI',
    note: 'Runs on the build fleet, usually with tokens that can publish.',
  },
  build: {
    label: 'Build',
    short: 'BLD',
    note: 'Runs while an image or package is produced, and its output is shipped onward.',
  },
  notebook: {
    label: 'Notebook',
    short: 'NB',
    note: 'An interactive notebook. Whose machine it runs on is a question about people.',
  },
  test: { label: 'Test', short: 'TEST', note: 'The test suite. Usually the build fleet too.' },
  development: {
    label: 'Development',
    short: 'DEV',
    note: 'A developer workstation, or an agent runtime configuration loaded on one. Whatever that machine can reach, the load can reach.',
  },
  sandbox: {
    label: 'Sandbox',
    short: 'SBX',
    note: 'An example or scratch path, expected to be isolated.',
  },
  unresolved: {
    label: 'Unresolved',
    short: 'UNRES',
    note: 'No rule matched and nothing declares this path. DEADWEIGHT will not guess where it runs.',
  },
}

export const PRIVILEGE_META: Readonly<Record<string, { label: string; note: string }>> = {
  'cloud-credentials': {
    label: 'Cloud credentials',
    note: 'The loading file constructs a cloud SDK client, so the process holds whatever that client can use.',
  },
  'secret-material': {
    label: 'Secret material',
    note: 'The loading file reads named secrets, so they are resident in the process performing the load.',
  },
  'orchestration-api': {
    label: 'Orchestration API',
    note: 'The loading file talks to a cluster or container API.',
  },
  'datastore-write': {
    label: 'Datastore write',
    note: 'The loading file writes to a datastore.',
  },
  'process-execution': {
    label: 'Process execution',
    note: 'The loading file already spawns processes, so an execution surface here has somewhere to go.',
  },
  'network-egress': {
    label: 'Network egress',
    note: 'The loading file makes outbound requests.',
  },
  'filesystem-write': {
    label: 'Filesystem write',
    note: 'The loading file writes outside a temporary directory.',
  },
}
