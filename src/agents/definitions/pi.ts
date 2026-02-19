import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";

const pi: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  configDir: ".pi",
  skillsParentDir: ".pi",
  userSkillsParentDirs: [join(homedir(), ".pi", "agent")],
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
