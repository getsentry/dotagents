import { GitError, TrustError } from "@sentry/dotagents-lib";
import type { ScopeRoot } from "../scope.js";
import { commandPrefix } from "./context.js";

/**
 * Format a TrustError into a user-facing message that includes the
 * `npx @sentry/dotagents trust add ...` hint appropriate for the
 * offending source. The lib throws plain TrustError; this wrapper adds the
 * host-specific recovery copy.
 */
export function formatTrustError(err: TrustError, scope: ScopeRoot): string {
  const cmd = commandPrefix(scope);
  const { details } = err;
  if (details.kind === "github" && details.owner && details.repo) {
    return (
      `${err.message}\n` +
      `Run: ${cmd} trust add ${details.owner} ` +
      `(or \`${cmd} trust add ${details.owner}/${details.repo}\` for just this repo)`
    );
  }
  if ((details.kind === "git" || details.kind === "well-known") && details.domain) {
    return `${err.message}\nRun: ${cmd} trust add ${details.domain}`;
  }
  return err.message;
}

/**
 * Format a GitError into a user-facing message that includes the
 * `npx @sentry/dotagents add <ssh-url>` hint when the failure looks like
 * missing auth on a public hosting provider.
 */
export function formatGitError(err: GitError, scope: ScopeRoot): string {
  const cmd = commandPrefix(scope);
  if (err.details?.kind === "auth-required" && err.details.sshUrl) {
    return (
      `${err.message}\n` +
      `Hint: for private repos, use the SSH URL instead:\n` +
      `  ${cmd} add ${err.details.sshUrl}`
    );
  }
  return err.message;
}
