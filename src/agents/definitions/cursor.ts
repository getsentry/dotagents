import type { AgentDefinition } from "../types.js";
import claude from "./claude.js";

const cursor: AgentDefinition = {
  ...claude,
  id: "cursor",
  displayName: "Cursor",
  configDir: ".cursor",
  skillsParentDir: ".cursor",
  mcp: {
    filePath: ".cursor/mcp.json",
    rootKey: "mcpServers",
    format: "json",
    shared: false,
  },
};

export default cursor;
