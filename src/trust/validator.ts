import type { TrustConfig } from "../config/schema.js";
import { parseSource } from "../skills/resolver.js";

export class TrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustError";
  }
}

/**
 * Extract domain from a git URL.
 *
 * Supports:
 *   https://host.com/...  → host.com
 *   ssh://host.com/...    → host.com
 *   git://host.com/...    → host.com
 *   git@host.com:...      → host.com
 *   file:///...           → (no domain)
 */
export function extractDomain(url: string): string | undefined {
  // git@host.com:owner/repo.git
  const scpMatch = url.match(/^[a-z]+@([^:]+):/);
  if (scpMatch) return scpMatch[1];

  // https://host.com/..., ssh://host.com/..., git://host.com/...
  try {
    const parsed = new URL(url);
    if (parsed.hostname) return parsed.hostname;
  } catch {
    // Not a valid URL — no domain
  }

  return undefined;
}

function formatAllowed(trust: TrustConfig): string {
  const parts: string[] = [];
  if (trust.github_orgs.length > 0) {
    parts.push(`orgs: ${trust.github_orgs.join(", ")}`);
  }
  if (trust.github_repos.length > 0) {
    parts.push(`repos: ${trust.github_repos.join(", ")}`);
  }
  if (trust.git_domains.length > 0) {
    parts.push(`domains: ${trust.git_domains.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

/**
 * Validate that a source specifier is allowed by the trust configuration.
 *
 * - No trust config → allow all (backward compat)
 * - allow_all = true → allow all
 * - Local path: sources → always allowed
 * - Otherwise → must match at least one rule (org, repo, or domain)
 */
export function validateTrustedSource(
  source: string,
  trust?: TrustConfig,
): void {
  // No trust config → allow everything
  if (!trust) return;

  // Explicit opt-out
  if (trust.allow_all) return;

  const parsed = parseSource(source);

  // Local sources are always allowed
  if (parsed.type === "local") return;

  if (parsed.type === "github") {
    const owner = parsed.owner!.toLowerCase();
    const repo = `${owner}/${parsed.repo!.toLowerCase()}`;

    if (trust.github_orgs.some((o) => o.toLowerCase() === owner)) return;
    if (trust.github_repos.some((r) => r.toLowerCase() === repo)) return;

    throw new TrustError(
      `Source "${source}" is not trusted. ` +
        `Allowed sources: ${formatAllowed(trust)}. ` +
        `Add the org or repo to [trust] in agents.toml to allow it.`,
    );
  }

  if (parsed.type === "git") {
    const domain = extractDomain(parsed.url!)?.toLowerCase();
    if (domain && trust.git_domains.some((d) => d.toLowerCase() === domain)) return;

    throw new TrustError(
      `Source "${source}" is not trusted. ` +
        `Allowed sources: ${formatAllowed(trust)}. ` +
        `Add the domain to [trust] in agents.toml to allow it.`,
    );
  }
}
