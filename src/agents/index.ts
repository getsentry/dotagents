export { getAgent, allAgentIds } from "./registry.js";
export { writeMcpConfigs, verifyMcpConfigs, toMcpDeclarations } from "./mcp-writer.js";
export { writeHookConfigs, verifyHookConfigs, toHookDeclarations } from "./hook-writer.js";
export { UnsupportedFeature } from "./errors.js";
export type {
  AgentDefinition,
  McpDeclaration,
  McpConfigSpec,
  McpSerializer,
  HookDeclaration,
  HookConfigSpec,
  HookSerializer,
} from "./types.js";
