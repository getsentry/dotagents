export { loadConfig, ConfigError, agentsConfigSchema } from "./config/index.js";
export type {
  AgentsConfig,
  SkillDependency,
  SymlinksConfig,
  ProjectConfig,
  SkillSource,
  McpConfig,
  TrustConfig,
} from "./config/index.js";
export { validateTrustedSource, extractDomain, TrustError } from "./trust/index.js";
export { resolveScope } from "./scope.js";
export type { Scope, ScopeRoot } from "./scope.js";
export { getAgent, allAgentIds, writeMcpConfigs, verifyMcpConfigs, projectMcpResolver, getUserMcpTarget, userMcpResolver } from "./agents/index.js";
export type { AgentDefinition, McpDeclaration, McpConfigSpec, McpSerializer, McpTargetResolver } from "./agents/index.js";
export { writeAgentsGitignore, removeAgentsGitignore, updateAgentsGitignore } from "./gitignore/index.js";
export { ensureSkillsSymlink, verifySymlinks } from "./symlinks/index.js";
export { exec, ExecError, hashDirectory, sha256, copyDir } from "./utils/index.js";
export { clone, fetchAndReset, fetchRef, headCommit, isGitRepo, GitError, ensureCached, resolveLocalSource, LocalSourceError } from "./sources/index.js";
export type { CacheResult } from "./sources/index.js";
export { loadSkillMd, SkillLoadError, discoverSkill, discoverAllSkills, resolveSkill, parseSource, ResolveError } from "./skills/index.js";
export type { SkillMeta, DiscoveredSkill, ResolvedSkill, ResolvedGitSkill, ResolvedLocalSkill } from "./skills/index.js";
export { lockfileSchema, isGitLocked, loadLockfile, LockfileError, writeLockfile } from "./lockfile/index.js";
export type { Lockfile, LockedSkill } from "./lockfile/index.js";
