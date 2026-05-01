export { loadConfig, ConfigError } from "./loader.js";
export {
  addSkillToConfig,
  addWildcardToConfig,
  addExcludeToWildcard,
  removeSkillFromConfig,
  generateDefaultConfig,
} from "./writer.js";
export { agentsConfigSchema, isWildcardDep } from "./schema.js";
export type {
  AgentsConfig,
  SkillDependency,
  WildcardSkillDependency,
  RegularSkillDependency,
  SymlinksConfig,
  ProjectConfig,
  SkillSource,
  McpConfig,
  TrustConfig,
} from "./schema.js";
