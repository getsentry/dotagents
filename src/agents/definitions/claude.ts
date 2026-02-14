import type { AgentDefinition } from "../types.js";
import { envRecord, httpServer, serializeClaudeHooks } from "./helpers.js";

const claude: AgentDefinition = {
  id: "claude",
  displayName: "Claude Code",
  configDir: ".claude",
  skillsParentDir: ".claude",
  mcp: {
    filePath: ".mcp.json",
    rootKey: "mcpServers",
    format: "json",
    shared: false,
  },
  serializeServer(s) {
    if (s.url) return httpServer(s);
    const env = envRecord(s.env, (k) => `\${${k}}`);
    return [s.name, { command: s.command, args: s.args ?? [], ...(env && { env }) }];
  },
  hooks: {
    filePath: ".claude/settings.json",
    rootKey: "hooks",
    format: "json",
    shared: true,
  },
  serializeHooks: serializeClaudeHooks,
};

export default claude;
