import type { AgentDefinition } from "../types.js";
import claude from "./claude.js";

const codex: AgentDefinition = {
  ...claude,
  id: "codex",
  displayName: "Codex",
  configDir: ".codex",
  skillsParentDir: ".codex",
  mcp: {
    filePath: ".codex/config.toml",
    rootKey: "mcp_servers",
    format: "toml",
    shared: true,
  },
};

export default codex;
