import { join } from "node:path";
import { homedir } from "node:os";
import type { McpTargetResolver } from "./mcp-writer.js";

export interface UserMcpTarget {
  filePath: string;
  shared: boolean;
}

/**
 * Returns the absolute path to the user-scope MCP config file for an agent,
 * plus whether that file is shared with other content.
 */
export function getUserMcpTarget(agentId: string): UserMcpTarget {
  const home = homedir();

  switch (agentId) {
    case "claude":
      return { filePath: join(home, ".claude.json"), shared: true };
    case "cursor":
      return { filePath: join(home, ".cursor", "mcp.json"), shared: false };
    case "codex":
      return { filePath: join(home, ".codex", "config.toml"), shared: true };
    case "vscode":
      return { filePath: vscodeMcpPath(), shared: false };
    case "opencode":
      return { filePath: join(home, ".config", "opencode", "opencode.json"), shared: true };
    case "pi":
      return { filePath: join(home, ".pi", "agent", "mcp.json"), shared: false };
    default:
      throw new Error(`Unknown agent for user-scope MCP: ${agentId}`);
  }
}

/**
 * MCP target resolver for user scope.
 * Ignores the agent definition's spec and uses user-scope absolute paths.
 */
export function userMcpResolver(): McpTargetResolver {
  return (agentId: string) => getUserMcpTarget(agentId);
}

function vscodeMcpPath(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
    case "win32":
      return join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
    default:
      return join(home, ".config", "Code", "User", "mcp.json");
  }
}
