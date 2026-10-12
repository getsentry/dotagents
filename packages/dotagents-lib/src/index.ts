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
  ParsedSource,
  ResolvedSkill,
  ResolvedGitSkill,
  ResolvedLocalSkill,
  ResolvedWellKnownSkill,
  NamedResolvedSkill,
  WildcardDependencyInput,
  ResolveOpts,
  ResolverServices,
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
export type { GitErrorDetails, GitExecutor } from "./sources/git.js";
export {
  ensureCached,
  CacheError,
  sanitizeCacheKey,
  validateCacheKey,
} from "./sources/cache.js";
export type { CacheResult, CacheReuse } from "./sources/cache.js";
export { ensureWellKnownCached } from "./sources/wellknown.js";
export { resolveLocalSource, LocalSourceError } from "./sources/local.js";

// Agent Plugins: manifest schemas, discovery, and resolution
export {
  AGENT_PLUGIN_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  isStandardPluginManifest,
  parsePluginManifest,
  parsePluginMcp,
  parsePluginMcpBestEffort,
  parsePluginMarketplace,
} from "./plugins/schema.js";
export type {
  StandardPluginManifest,
  LegacyPluginManifest,
  PluginManifest,
  PluginMcpConfig,
  PluginMcpParseResult,
  MarketplacePluginEntry,
  PluginMarketplace,
} from "./plugins/schema.js";
export {
  PLUGIN_NAME_PATTERN,
  HYBRID_LEGACY_ROOTS,
  resolvePlugin,
  discoverPlugins,
  loadInstalledPluginBundle,
  assertPluginBundleSymlinksContained,
} from "./plugins/resolver.js";
export type {
  PluginDependencyInput,
  PluginResolveOptions,
  PluginResolverServices,
  PluginCandidate,
  ResolvedPlugin,
  ResolvedLocalPlugin,
  ResolvedGitPlugin,
  InstalledPluginProvenance,
} from "./plugins/resolver.js";
export {
  NATIVE_PLUGIN_SOURCES,
  NATIVE_PLUGIN_MANIFEST_PATHS,
  nativePluginDisplayName,
  nativeInterfaceNeedsFallback,
  generatedNativeMcpPath,
  manifestString,
  legacyManifestString,
  codexPluginInterface,
} from "./plugins/native-interfaces.js";
export type {
  NativePluginSource,
  AuthoredNativePluginInterface,
  AuthoredNativePluginInterfaces,
  PluginBundle,
} from "./plugins/types.js";

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
export { isSerializedObject, isSerializedValue } from "./utils/serialized.js";
export type { SerializedObject, SerializedValue } from "./utils/serialized.js";
