/**
 * The DEADWEIGHT engine.
 *
 * One analysis, three front ends: the CLI, the browser tab, and the test
 * suite. They differ only in where the `SourceTree` comes from, which is the
 * only reason the demo is worth trusting as a demonstration of the product.
 */

export { analyze, STAGE_META } from './analyze.ts'
export type { AnalyzeOptions } from './analyze.ts'

export { resolveAlternative } from './alternatives.ts'
export { resolveBehaviour } from './behaviour.ts'
export { BOM_SCHEMA, bomToCsv, bomToText, buildBom } from './bom.ts'
export type { BomEntry, ModelBom } from './bom.ts'
export { classifyArtifact, classifyBytes } from './classify.ts'
export { ENVIRONMENTS, EMPTY_CONFIG, readConfig } from './config.ts'
export type { ProjectConfig } from './config.ts'
export {
  byReach,
  classifyContext,
  distinctEnvironments,
  ENVIRONMENT_META,
  ENVIRONMENT_ORDER,
  PRIVILEGE_META,
} from './context.ts'
export { readSafetensorsHeader } from './containers.ts'
export { COVERAGE_NOTE, CYCLONEDX_SPEC_VERSION, toCycloneDx } from './cyclonedx.ts'
export type { CycloneDxBom } from './cyclonedx.ts'
export {
  compareVersions,
  findDependency,
  parseConstraint,
  parseVersion,
  readProjectName,
  resolveDependencies,
} from './deps.ts'
export { diffBoms, diffToText } from './diff.ts'
export type { BomDiff, FieldChange } from './diff.ts'
export { AnalysisError, isAnalysisError, unexpectedGuidance } from './errors.ts'
export type { ErrorGuidance } from './errors.ts'
export { allScannerProfiles, bindEvidence, collectEvidence, scannerProfile } from './evidence.ts'
export { deriveFindings, FINDING_META, rankFindings } from './findings.ts'
export { allFormats, DATA_FORMATS, formatSpec, MODEL_EXTENSIONS } from './formats.ts'
export { canonicalJson, Sha256, sha256Bytes, sha256Text, shortId } from './hash.ts'
export * as limits from './limits.ts'
export { LOADER_RULES, loaderRule, loaderSpec, matchLoader } from './loaders.ts'
export { readDeclarations, readFrontmatter, safeJson } from './manifests.ts'
export type { DeclaredLoad } from './manifests.ts'
export { readNotebook } from './notebook.ts'
export { looksLikePickle, notableGlobals, read as readPickle } from './pickle.ts'
export { scanJs, scanPython } from './scan.ts'
export type { RawCall, ScanResult } from './scan.ts'
export {
  basename,
  dirname,
  extname,
  joinPath,
  matchesGlob,
  memoryTree,
  normalisePath,
  stem,
} from './source.ts'
export type { MemoryFile, SourceTree, TreeEntry } from './source.ts'
export { BEHAVIOUR_LABEL, BEHAVIOUR_NOTE, buildStripe, STAGE_META as STRIPE_STAGE_META } from './stripe.ts'
export { behaviourDistribution, buildSummary, indicators, matrixKey } from './summary.ts'
export type { Indicator } from './summary.ts'
export { listZip } from './zip.ts'

export * from './types.ts'
