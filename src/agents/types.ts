/**
 * Universal MCP server declaration from agents.toml [[mcp]] sections.
 * Represents either a stdio or HTTP server.
 */
export interface McpDeclaration {
  name: string;
  /** For stdio servers */
  command?: string;
  args?: string[];
  /** For HTTP servers */
  url?: string;
  headers?: Record<string, string>;
  /** Environment variable names (values come from the user's env) */
  env?: string[];
}

/**
 * Describes how an agent tool writes its MCP config file.
 */
export interface McpConfigSpec {
  /** Path to the config file, relative to project root */
  filePath: string;
  /** Top-level key in the config file under which servers live */
  rootKey: string;
  /** File format */
  format: "json" | "toml";
  /**
   * If true, the config file is shared with other content and must be
   * read-merge-written. If false, dotagents owns the entire file.
   */
  shared: boolean;
}

/**
 * Transforms a universal McpDeclaration into the agent-specific shape
 * for its config file. Returns [serverName, serverConfig] tuple.
 */
export type McpSerializer = (server: McpDeclaration) => [string, unknown];

/**
 * Definition of an agent tool that dotagents manages.
 */
export interface AgentDefinition {
  id: string;
  displayName: string;
  /** Directory that holds agent-specific config (e.g. ".claude") */
  configDir: string;
  /** Parent directory for the skills/ symlink */
  skillsParentDir: string;
  /** MCP config file specification */
  mcp: McpConfigSpec;
  /** Transforms universal MCP declaration to agent-specific format */
  serializeServer: McpSerializer;
}
