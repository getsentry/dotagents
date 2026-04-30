import type { McpDeclaration, HookDeclaration } from "../types.js";

export function envRecord(
  env: string[] | undefined,
  template: (key: string) => string,
): Record<string, string> | undefined {
  if (!env || env.length === 0) {return undefined;}
  const rec: Record<string, string> = {};
  for (const key of env) {rec[key] = template(key);}
  return rec;
}

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function interpolateEnvRefs(
  value: string,
  template: (varName: string) => string,
): string {
  return value.replace(ENV_REF_RE, (_match, varName: string) => template(varName));
}

export function interpolateHeaders(
  headers: Record<string, string> | undefined,
  template: (varName: string) => string,
): Record<string, string> | undefined {
  if (!headers) {return undefined;}
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = interpolateEnvRefs(value, template);
  }
  return result;
}

/**
 * Split headers for Codex's model: pure `${VAR}` refs go to `envHttpHeaders`
 * (mapping env var name → header name), everything else stays in `httpHeaders`.
 * Mixed values like `"Bearer ${TOKEN}"` can't be represented in Codex's
 * env_http_headers format and fall through as literal strings in httpHeaders.
 */
export function extractCodexHeaders(
  headers: Record<string, string> | undefined,
): { httpHeaders?: Record<string, string>; envHttpHeaders?: Record<string, string> } {
  if (!headers) {return {};}
  let httpHeaders: Record<string, string> | undefined;
  let envHttpHeaders: Record<string, string> | undefined;
  const pureRefRe = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
  for (const [key, value] of Object.entries(headers)) {
    const match = pureRefRe.exec(value);
    if (match) {
      (envHttpHeaders ??= {})[match[1]!] = key;
    } else {
      (httpHeaders ??= {})[key] = value;
    }
  }
  return { httpHeaders, envHttpHeaders };
}

export function httpServer(
  s: McpDeclaration,
  type?: string,
  template?: (varName: string) => string,
): [string, unknown] {
  const tpl = template ?? ((k: string) => `\${${k}}`);
  return [
    s.name,
    {
      ...(type && { type }),
      url: interpolateEnvRefs(s.url!, tpl),
      ...(s.headers && { headers: interpolateHeaders(s.headers, tpl) }),
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
