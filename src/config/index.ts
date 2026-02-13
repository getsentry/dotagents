export { loadConfig, ConfigError } from "./loader.js";
export {
  addSkillToConfig,
  removeSkillFromConfig,
  generateDefaultConfig,
} from "./writer.js";
export { agentsConfigSchema } from "./schema.js";
export type {
  AgentsConfig,
  SkillDependency,
  SymlinksConfig,
  ProjectConfig,
  SkillSource,
  McpConfig,
} from "./schema.js";
