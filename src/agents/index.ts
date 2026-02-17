export { getAgent, allAgentIds } from "./registry.js";
export { writeMcpConfigs, verifyMcpConfigs, toMcpDeclarations, projectMcpResolver } from "./mcp-writer.js";
export type { McpTargetResolver, McpResolvedTarget } from "./mcp-writer.js";
export { writeHookConfigs, verifyHookConfigs, toHookDeclarations, projectHookResolver } from "./hook-writer.js";
export type { HookTargetResolver, HookResolvedTarget } from "./hook-writer.js";
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
} from "./types.js";
