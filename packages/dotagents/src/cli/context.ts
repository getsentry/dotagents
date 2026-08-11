import type { ScopeRoot } from "../scope.js";

export interface CommandContext {
  scope: ScopeRoot;
}

export function commandPrefix(scope: ScopeRoot): string {
  return scope.scope === "project"
    ? "npx @sentry/dotagents --project"
    : "npx @sentry/dotagents";
}

