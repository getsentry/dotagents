export { loadConfig, ConfigError, agentsConfigSchema, isWildcardDep } from "./config/index.js";
export type {
  AgentsConfig,
  SkillDependency,
  WildcardSkillDependency,
  RegularSkillDependency,
  SkillSource,
  McpConfig,
  TrustConfig,
} from "./config/index.js";

export { resolveScope } from "./scope.js";
export type { Scope, ScopeRoot } from "./scope.js";

export { getAgent, allAgentIds, writeMcpConfigs, verifyMcpConfigs, projectMcpResolver, getUserMcpTarget, userMcpResolver } from "./agents/index.js";
export type { AgentDefinition, McpDeclaration, McpConfigSpec, McpTargetResolver } from "./agents/index.js";

export { writeAgentsGitignore, ensureRootGitignoreEntries } from "./gitignore/index.js";

export { ensureSkillsSymlink, verifySymlinks } from "./symlinks/index.js";

export { lockfileSchema, loadLockfile, LockfileError, writeLockfile } from "./lockfile/index.js";
export type { Lockfile, LockedSkill } from "./lockfile/index.js";

// ---------------------------------------------------------------------------
// Re-exports from @sentry/dotagents-lib.
// These are deprecated on the host's surface — import directly from the lib.
// ---------------------------------------------------------------------------

/** @deprecated Import from `@sentry/dotagents-lib` instead. */
export {
  validateTrustedSource,
  extractDomain,
  TrustError,
  exec,
  ExecError,
  copyDir,
  clone,
  fetchAndReset,
  fetchRef,
  headCommit,
  isGitRepo,
  GitError,
  ensureCached,
  resolveLocalSource,
  LocalSourceError,
  loadSkillMd,
  SkillLoadError,
  discoverSkill,
  discoverAllSkills,
  resolveSkill,
  parseSource,
  ResolveError,
} from "@sentry/dotagents-lib";

/** @deprecated Import from `@sentry/dotagents-lib` instead. */
export type {
  CacheResult,
  SkillMeta,
  DiscoveredSkill,
  ResolvedSkill,
  ResolvedGitSkill,
  ResolvedLocalSkill,
} from "@sentry/dotagents-lib";
