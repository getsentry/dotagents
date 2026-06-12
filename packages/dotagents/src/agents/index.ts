export { getAgent, allAgentIds } from "./registry.js";
export { writeMcpConfigs, verifyMcpConfigs, toMcpDeclarations, projectMcpResolver } from "./mcp-writer.js";
export type { McpTargetResolver, McpResolvedTarget } from "./mcp-writer.js";
export { writeHookConfigs, verifyHookConfigs, toHookDeclarations, projectHookResolver } from "./hook-writer.js";
export type { HookTargetResolver, HookResolvedTarget } from "./hook-writer.js";
export {
  writeSubagentConfigs,
  pruneSubagentConfigs,
  verifySubagentConfigs,
  projectSubagentResolver,
  userSubagentResolver,
} from "./subagent-writer.js";
export {
  resolveSubagent,
  writeInstalledSubagents,
  loadInstalledSubagents,
  pruneInstalledSubagents,
  lockEntryForSubagent,
} from "./subagent-store.js";
export type {
  SubagentTargetResolver,
  SubagentResolvedTarget,
  SubagentWriteWarning,
  SubagentWriteResult,
  SubagentVerifyIssue,
} from "./subagent-writer.js";
export type {
  SubagentResolveOptions,
  ResolvedSubagent,
  ResolvedSubagentType,
  InstalledSubagentLoadIssue,
} from "./subagent-store.js";
export type { LockedSubagent } from "../lockfile/schema.js";
export { UnsupportedFeature } from "./errors.js";
export { getUserMcpTarget, userMcpResolver } from "./paths.js";
export type { UserMcpTarget } from "./paths.js";
export type {
  AgentDefinition,
  McpDeclaration,
  McpConfigSpec,
  McpSerializer,
  HookDeclaration,
  HookConfigSpec,
  HookSerializer,
  SubagentDeclaration,
  NativeSubagentConfig,
  NativeSubagentContent,
  NativeSubagentTarget,
  SubagentConfigSpec,
  SubagentIdentityStrategy,
  SubagentSerializer,
} from "./types.js";
