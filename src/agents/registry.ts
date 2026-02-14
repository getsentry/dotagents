import type { AgentDefinition, McpDeclaration, McpSerializer } from "./types.js";

// --- Serializers ---

function envRecord(env: string[] | undefined, template: (key: string) => string): Record<string, string> | undefined {
  if (!env || env.length === 0) return undefined;
  const rec: Record<string, string> = {};
  for (const key of env) rec[key] = template(key);
  return rec;
}

/**
 * Claude Code & Cursor share the same shape:
 *   { command, args, env: { KEY: "${KEY}" } }
 */
const serializeClaude: McpSerializer = (s: McpDeclaration) => {
  if (s.url) {
    return [s.name, { url: s.url, ...(s.headers && { headers: s.headers }) }];
  }
  const env = envRecord(s.env, (k) => `\${${k}}`);
  return [
    s.name,
    {
      command: s.command,
      args: s.args ?? [],
      ...(env && { env }),
    },
  ];
};

const serializeCursor: McpSerializer = serializeClaude;

/** Codex: same shape as Claude, only differs in config format (TOML) and root key. */
const serializeCodex: McpSerializer = serializeClaude;

/**
 * VS Code Copilot:
 *   { type: "stdio", command, args, env: { KEY: "${input:KEY}" } }
 */
const serializeVscode: McpSerializer = (s: McpDeclaration) => {
  if (s.url) {
    return [s.name, { type: "sse", url: s.url, ...(s.headers && { headers: s.headers }) }];
  }
  const env = envRecord(s.env, (k) => `\${input:${k}}`);
  return [
    s.name,
    {
      type: "stdio",
      command: s.command,
      args: s.args ?? [],
      ...(env && { env }),
    },
  ];
};

/**
 * OpenCode:
 *   stdio: { type: "local", command: [cmd, ...args], environment: {...} }
 *   http:  { type: "remote", url, headers }
 */
const serializeOpencode: McpSerializer = (s: McpDeclaration) => {
  if (s.url) {
    return [s.name, { type: "remote", url: s.url, ...(s.headers && { headers: s.headers }) }];
  }
  const env = envRecord(s.env, (k) => `\${${k}}`);
  return [
    s.name,
    {
      type: "local",
      command: [s.command!, ...(s.args ?? [])],
      ...(env && { environment: env }),
    },
  ];
};

// --- Registry ---

const AGENT_REGISTRY = new Map<string, AgentDefinition>([
  [
    "claude",
    {
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
      serializeServer: serializeClaude,
    },
  ],
  [
    "cursor",
    {
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
      serializeServer: serializeCursor,
    },
  ],
  [
    "codex",
    {
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
      serializeServer: serializeCodex,
    },
  ],
  [
    "vscode",
    {
      id: "vscode",
      displayName: "VS Code Copilot",
      configDir: ".vscode",
      skillsParentDir: ".vscode",
      mcp: {
        filePath: ".vscode/mcp.json",
        rootKey: "servers",
        format: "json",
        shared: false,
      },
      serializeServer: serializeVscode,
    },
  ],
  [
    "opencode",
    {
      id: "opencode",
      displayName: "OpenCode",
      configDir: ".claude",
      skillsParentDir: ".claude",
      mcp: {
        filePath: "opencode.json",
        rootKey: "mcp",
        format: "json",
        shared: true,
      },
      serializeServer: serializeOpencode,
    },
  ],
]);

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENT_REGISTRY.get(id);
}

export function allAgentIds(): string[] {
  return [...AGENT_REGISTRY.keys()];
}
