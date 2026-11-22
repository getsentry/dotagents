import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";

const antigravity: AgentDefinition = {
  id: "antigravity",
  displayName: "Google Antigravity",
  configDir: ".agents",
  // Reads project .agents/skills/ natively. Global discovery uses ~/.gemini/config/skills/.
  skillsParentDir: undefined,
  userSkillsParentDirs: [join(homedir(), ".gemini", "config")],
  // Rejects ${VAR} headers, so a fresh global setup must not select it implicitly.
  optIn: true,
  mcp: {
    filePath: ".agents/mcp_config.json",
    rootKey: "mcpServers",
    format: "json",
    shared: true,
  },
  serializeServer(s) {
    if (s.url) {
      if ([s.url, ...Object.values(s.headers ?? {})].some((value) => value.includes("${"))) {
        throw new Error(`Antigravity MCP server "${s.name}" requires a literal URL and header values. Antigravity does not expand \${VAR} references.`);
      }
      return [s.name, { serverUrl: s.url, ...(s.headers && { headers: s.headers }) }];
    }
    // Stdio servers inherit Antigravity's environment, so declared env names need no entry.
    return [s.name, {
      command: s.command,
      args: s.args ?? [],
      ...(s.cwd && { cwd: s.cwd }),
      ...(s.envValues && { env: s.envValues }),
    }];
  },
  serializeHooks() {
    throw new UnsupportedFeature("antigravity", "hooks");
  },
};

export default antigravity;
