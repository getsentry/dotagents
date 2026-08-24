import type { HookDeclaration, McpDeclaration } from "../types.js";
import type { SerializedObject, SerializedValue } from "@sentry/dotagents-lib";

type CommandHook = { type: "command"; command: string };
type ClaudeHookEntry = { matcher?: string; hooks: CommandHook[] };

export interface CodexHeaders {
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
}

/** Build an agent-specific environment map from declared variable names. */
export function envRecord(
  env: string[] | undefined,
  template: (key: string) => string,
  values?: Record<string, string>,
): Record<string, string> | undefined {
  if ((!env || env.length === 0) && !values) {return undefined;}
  const rec = { ...values };
  for (const key of env ?? []) {rec[key] = template(key);}
  return rec;
}

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Rewrite `${VAR}` references into the target agent's environment syntax. */
export function interpolateEnvRefs(
  value: string,
  template: (varName: string) => string,
): string {
  return value.replace(ENV_REF_RE, (_match, varName: string) => template(varName));
}

/** Rewrite all header values with the target agent's environment syntax. */
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
 * (mapping env var name to header name), everything else stays in `httpHeaders`.
 * Mixed values like `"Bearer ${TOKEN}"` can't be represented in Codex's
 * env_http_headers format and fall through as literal strings in httpHeaders.
 */
export function extractCodexHeaders(
  headers: Record<string, string> | undefined,
): CodexHeaders {
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

/** Serialize an HTTP MCP server into the target's JSON-compatible shape. */
export function httpServer(
  s: McpDeclaration,
  type?: string,
  template?: (varName: string) => string,
): [string, SerializedValue] {
  const tpl = template ?? ((k: string) => `\${${k}}`);
  const url = s.interpolateEnvRefs === false
    ? s.url!
    : interpolateEnvRefs(s.url!, tpl);
  const headers = s.interpolateEnvRefs === false
    ? s.headers
    : interpolateHeaders(s.headers, tpl);
  return [
    s.name,
    {
      ...(type && { type }),
      url,
      ...(headers && { headers }),
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
export function serializeClaudeHooks(hooks: HookDeclaration[]): SerializedObject {
  const result: Partial<Record<HookDeclaration["event"], ClaudeHookEntry[]>> = {};
  for (const h of hooks) {
    const entry: ClaudeHookEntry = {
      ...(h.matcher && { matcher: h.matcher }),
      hooks: [{ type: "command", command: h.command }],
    };
    (result[h.event] ??= []).push(entry);
  }
  return result;
}
