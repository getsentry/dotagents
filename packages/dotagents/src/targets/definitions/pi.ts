import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import claude from "./claude.js";

const pi: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  configDir: ".pi",
  // Pi reads .agents/skills/ natively in both scopes.
  mcp: {
    filePath: ".pi/mcp.json",
    rootKey: "mcpServers",
    format: "json",
    shared: true,
  },
  serializeServer(server) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) {
      throw new Error(`Invalid Pi MCP server name "${server.name}". Use only letters, digits, underscores, and hyphens.`);
    }
    if (server.url?.includes("${")) {
      throw new Error(`Pi MCP server "${server.name}" requires a literal URL. Environment references are supported in headers and env values only.`);
    }
    return claude.serializeServer(server);
  },
  serializeHooks() {
    throw new UnsupportedFeature("pi", "hooks");
  },
};

export default pi;
