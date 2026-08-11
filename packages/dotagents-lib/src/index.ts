// SKILL.md loading
export {
  loadSkillMd,
  loadMarkdownFrontmatter,
  parseMarkdownFrontmatterContent,
  SkillLoadError,
} from "./skills/loader.js";
export type {
  SkillMeta,
  LoadSkillMdOptions,
  MarkdownFrontmatter,
  LoadMarkdownFrontmatterOptions,
} from "./skills/loader.js";

// Tool name vocabulary (allowed-tools frontmatter)
export { TOOL_NAMES, isToolName } from "./skills/tool-name.js";
export type { ToolName } from "./skills/tool-name.js";

// Skill discovery
export { discoverSkill, discoverAllSkills } from "./skills/discovery.js";
export type { DiscoveredSkill, DiscoveryOpts } from "./skills/discovery.js";

// Source-string grammar + resolution
export {
  resolveSkill,
  resolveWildcardSkills,
  parseSource,
  isExplicitSourceSpecifier,
  parseOwnerRepoShorthand,
  applyDefaultRepositorySource,
  normalizeSource,
  sourcesMatch,
  isSourceExcluded,
  stripLeadingAt,
  ResolveError,
  ParseSourceError,
  VALID_SKILL_NAME,
} from "./skills/resolver.js";
export type { ParseSourceErrorKind } from "./skills/resolver.js";
export type {
  ResolvedSkill,
  ResolvedGitSkill,
  ResolvedLocalSkill,
  ResolvedWellKnownSkill,
  NamedResolvedSkill,
  WildcardDependencyInput,
  ResolveOpts,
} from "./skills/resolver.js";

// Sources / cache
export {
  clone,
  fetchAndReset,
  fetchRef,
  headCommit,
  isGitRepo,
  GitError,
} from "./sources/git.js";
export type { GitErrorDetails } from "./sources/git.js";
export {
  ensureCached,
  CacheError,
  sanitizeCacheKey,
  validateCacheKey,
} from "./sources/cache.js";
export type { CacheResult, CacheReuse } from "./sources/cache.js";
export { ensureWellKnownCached } from "./sources/wellknown.js";
export { resolveLocalSource, LocalSourceError } from "./sources/local.js";

// Source-host primitives
export {
  GITHUB_HTTPS_URL,
  GITHUB_SSH_URL,
  GITLAB_HTTPS_URL,
  GITLAB_SSH_URL,
} from "./sources/repository-source.js";
export type { RepositorySource } from "./sources/repository-source.js";

// Trust
export {
  validateTrustedSource,
  extractDomain,
  TrustError,
} from "./trust/validator.js";
export type { TrustPolicy } from "./trust/policy.js";
export type { TrustErrorDetails } from "./trust/validator.js";

// Git name safety
export {
  validateGitNameSafety,
  GitNameSafetyError,
} from "./sources/name-safety.js";
export type {
  GitNameSafetyField,
  GitNameSafetyReason,
} from "./sources/name-safety.js";

// General-purpose utilities used by callers
export { exec, ExecError } from "./utils/exec.js";
export { copyDir, stripTrailingSlashes } from "./utils/fs.js";
