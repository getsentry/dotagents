export { loadConfig, ConfigError, agentsConfigSchema, isWildcardDep } from "./config/index.js";
export type {
  AgentsConfig,
  SkillDependency,
  WildcardSkillDependency,
  RegularSkillDependency,
  SkillSource,
  McpConfig,
  SubagentConfig,
  TrustConfig,
} from "./config/index.js";

export { resolveScope } from "./scope.js";
export type { Scope, ScopeRoot } from "./scope.js";

export {
  getAgent,
  allAgentIds,
  writeMcpConfigs,
  verifyMcpConfigs,
  projectMcpResolver,
  writeSubagentConfigs,
  verifySubagentConfigs,
  projectSubagentResolver,
  getUserMcpTarget,
  userMcpResolver,
  userSubagentResolver,
  resolveSubagent,
  writeInstalledSubagents,
  loadInstalledSubagents,
  pruneInstalledSubagents,
} from "./agents/index.js";
export type {
  AgentDefinition,
  McpDeclaration,
  McpConfigSpec,
  McpTargetResolver,
  SubagentDeclaration,
  NativeSubagentConfig,
  NativeSubagentContent,
  NativeSubagentTarget,
  SubagentConfigSpec,
  SubagentSerializer,
  SubagentTargetResolver,
  SubagentWriteResult,
  ResolvedSubagent,
} from "./agents/index.js";

export { writeAgentsGitignore, ensureRootGitignoreEntries } from "./gitignore/index.js";

export { ensureSkillsSymlink, verifySymlinks } from "./symlinks/index.js";

export { lockfileSchema, loadLockfile, LockfileError, writeLockfile } from "./lockfile/index.js";
export type { Lockfile, LockedSkill, LockedSubagent } from "./lockfile/index.js";

// ---------------------------------------------------------------------------
// Re-exports from @sentry/dotagents-lib.
// These are deprecated on the host's surface — import directly from the lib.
// ---------------------------------------------------------------------------

import {
  discoverSkill as libDiscoverSkill,
  discoverAllSkills as libDiscoverAllSkills,
  type DiscoveredSkill,
  type DiscoveryOpts,
} from "@sentry/dotagents-lib";
import { HOST_SCAN_DIRS } from "./cli/cache.js";

/**
 * @deprecated Import from `@sentry/dotagents-lib` instead.
 *
 * Wraps the lib's `discoverSkill` to preserve dotagents' historical scan
 * behavior (which included `.agents/skills/` and `.claude/skills/`). Lib
 * consumers calling the lib directly get the canonical `["skills"]`
 * default instead.
 */
export function discoverSkill(
  repoDir: string,
  skillName: string,
  opts?: DiscoveryOpts,
): Promise<DiscoveredSkill | null> {
  return libDiscoverSkill(repoDir, skillName, { scanDirs: opts?.scanDirs ?? HOST_SCAN_DIRS });
}

/**
 * @deprecated Import from `@sentry/dotagents-lib` instead.
 *
 * Wraps the lib's `discoverAllSkills` to preserve dotagents' historical scan
 * behavior. See {@link discoverSkill} above.
 */
export function discoverAllSkills(
  repoDir: string,
  opts?: DiscoveryOpts,
): Promise<DiscoveredSkill[]> {
  return libDiscoverAllSkills(repoDir, { scanDirs: opts?.scanDirs ?? HOST_SCAN_DIRS });
}

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
