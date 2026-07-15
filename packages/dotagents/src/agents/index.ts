// Compatibility barrel for older imports. Runtime ownership now lives in
// targets/ for agent targets and subagents/ for subagent handling.
export { getAgent, allAgentIds } from "../targets/registry.js";
export { writeMcpConfigs, verifyMcpConfigs, toMcpDeclarations, projectMcpResolver } from "../targets/mcp-writer.js";
export type { McpTargetResolver, McpResolvedTarget } from "../targets/mcp-writer.js";
export { writeHookConfigs, verifyHookConfigs, toHookDeclarations, projectHookResolver } from "../targets/hook-writer.js";
export type { HookTargetResolver, HookResolvedTarget } from "../targets/hook-writer.js";
export {
  writeSubagentConfigs,
  pruneSubagentConfigs,
  verifySubagentConfigs,
  reconcileSubagentConfigs,
  projectSubagentResolver,
  userSubagentResolver,
} from "../subagents/writer.js";
export {
  resolveSubagent,
  writeInstalledSubagents,
  loadInstalledSubagents,
  pruneInstalledSubagents,
  lockEntryForSubagent,
} from "../subagents/store.js";
export type {
  SubagentTargetResolver,
  SubagentResolvedTarget,
  SubagentWriteWarning,
  SubagentWriteResult,
  SubagentVerifyIssue,
  SubagentReconcileOptions,
  SubagentReconcileResult,
} from "../subagents/writer.js";
export type {
  SubagentResolveOptions,
  ResolvedSubagent,
  ResolvedSubagentType,
  InstalledSubagentLoadIssue,
} from "../subagents/store.js";
export type { LockedSubagent } from "../lockfile/schema.js";
export { UnsupportedFeature } from "../targets/errors.js";
export { getUserMcpTarget, userMcpResolver } from "../targets/paths.js";
export type { UserMcpTarget } from "../targets/paths.js";
export type {
  AgentDefinition,
  McpDeclaration,
  McpConfigSpec,
  McpSerializer,
  HookDeclaration,
  HookConfigSpec,
  HookSerializer,
} from "../targets/types.js";
export type {
  SubagentDeclaration,
  NativeSubagentConfig,
  NativeSubagentContent,
  NativeSubagentTarget,
  SubagentConfigSpec,
  SubagentIdentityStrategy,
  SubagentSerializer,
} from "../subagents/types.js";
