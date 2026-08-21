import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import claude from "./claude.js";

const copilot: AgentDefinition = {
  id: "copilot",
  displayName: "GitHub Copilot",
  configDir: ".copilot",
  // reads .agents/skills/ natively at both project and user scope
  skillsParentDir: undefined,
  userSkillsParentDirs: undefined,
  mcp: {
    filePath: ".mcp.json",
    fallbackFilePaths: [".github/mcp.json"],
    rootKey: "mcpServers",
    format: "json",
    shared: false,
  },
  // Copilot accepts Claude's MCP shape, and both clients can share project .mcp.json.
  serializeServer: claude.serializeServer,
  hooks: undefined,
  serializeHooks() {
    throw new UnsupportedFeature("copilot", "hooks");
  },
};

export default copilot;
