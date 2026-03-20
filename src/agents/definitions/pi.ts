import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";

const pi: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  configDir: ".pi",
  // reads .agents/skills/ natively at both project and user scope
  skillsParentDir: undefined,
  userSkillsParentDirs: undefined,
  mcp: undefined,
  serializeServer() {
    throw new UnsupportedFeature("pi", "MCP");
  },
  hooks: undefined,
  serializeHooks() {
    throw new UnsupportedFeature("pi", "hooks");
  },
};

export default pi;
