import type { McpDeclaration, HookDeclaration } from "../types.js";

export function envRecord(
  env: string[] | undefined,
  template: (key: string) => string,
): Record<string, string> | undefined {
  if (!env || env.length === 0) return undefined;
  const rec: Record<string, string> = {};
  for (const key of env) rec[key] = template(key);
  return rec;
}

export function httpServer(s: McpDeclaration, type?: string): [string, unknown] {
  return [
    s.name,
    {
      ...(type && { type }),
      url: s.url,
      ...(s.headers && { headers: s.headers }),
    },
  ];
}

/**
 * Serialize hooks into Claude Code / VS Code settings.json format.
 *
 * Output shape:
 * {
 *   "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "..." }] }],
 *   "Stop": [{ "hooks": [{ "type": "command", "command": "..." }] }]
 * }
 */
export function serializeClaudeHooks(hooks: HookDeclaration[]): Record<string, unknown> {
  const result: Record<string, unknown[]> = {};
  for (const h of hooks) {
    const entry = {
      ...(h.matcher && { matcher: h.matcher }),
      hooks: [{ type: "command", command: h.command }],
    };
    (result[h.event] ??= []).push(entry);
  }
  return result;
}
