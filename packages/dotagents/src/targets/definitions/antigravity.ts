import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";

const antigravity: AgentDefinition = {
  id: "antigravity",
  displayName: "Google Antigravity",
  configDir: ".agents",
  // Rejects ${VAR} headers, so a fresh global setup must not select it implicitly.
  optIn: true,
  // Reads project .agents/skills/ natively. Global discovery uses ~/.gemini/config/skills/.
  skillsParentDir: undefined,
  userSkillsParentDirs: [join(homedir(), ".gemini", "config")],
  mcp: {
    filePath: ".agents/mcp_config.json",
    rootKey: "mcpServers",
    format: "jsonc",
    shared: true,
    // Settings users change in Antigravity itself, such as disabling a server.
    clientFields: ["disabled", "enabledTools", "disabledTools", "tools", "timeoutSeconds", "oauth", "authProviderType"],
  },
  serializeServer(server) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) {
      throw new Error(`Invalid Antigravity MCP server name "${server.name}". Use only letters, digits, underscores, and hyphens.`);
    }
    if (server.url) {
      const values = [server.url, ...Object.values(server.headers ?? {})];
      if (server.interpolateEnvRefs !== false && values.some((value) => value.includes("${"))) {
        throw new Error(`Antigravity MCP server "${server.name}" requires a literal URL and header values. Antigravity does not expand \${VAR} references.`);
      }
      return [server.name, { url: server.url, ...(server.headers && { headers: server.headers }) }];
    }
    // Stdio servers inherit Antigravity's environment, so declared env names need no entry.
    return [server.name, {
      command: server.command,
      args: server.args ?? [],
      ...(server.cwd && { cwd: server.cwd }),
      ...(server.envValues && { env: server.envValues }),
    }];
  },
  serializeHooks() {
    throw new UnsupportedFeature("antigravity", "hooks");
  },
};

export default antigravity;
