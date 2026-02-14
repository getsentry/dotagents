import type { McpDeclaration } from "../types.js";

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
