import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import claude from "./claude.js";

const copilotHome = process.env["COPILOT_HOME"] || join(homedir(), ".copilot");

const copilot: AgentDefinition = {
  id: "copilot",
  displayName: "GitHub Copilot",
  configDir: ".copilot",
  // Reads project .agents/skills/ natively. Global discovery follows COPILOT_HOME.
  skillsParentDir: undefined,
  userSkillsParentDirs: [copilotHome],
  mcp: {
    filePath: ".mcp.json",
    fallbackFilePaths: [".github/mcp.json"],
    acceptsBareServerMap: true,
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
