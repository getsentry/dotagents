import { parseSource } from "../skills/resolver.js";
import type { TrustPolicy } from "./policy.js";

/**
 * Structured details on why a source failed trust validation.
 *
 * The lib never adds CLI hints or vendor copy to the error message — hosts
 * read these fields and render whatever guidance is appropriate for their
 * surface (`npx <host-cli> trust add ...`, a UI prompt, a structured log).
 */
export interface TrustErrorDetails {
  /** The original source string that was rejected. */
  source: string;
  /** What kind of source it is, after parsing. */
  kind: "github" | "git" | "well-known";
  /** Owner segment when applicable (e.g. GitHub org). */
  owner?: string;
  /** Repo segment when applicable. */
  repo?: string;
  /** Hostname (or host+port) of the offending URL. */
  domain?: string;
  /** A snapshot of the policy that rejected the source. */
  allowed: TrustPolicy;
}

export class TrustError extends Error {
  constructor(message: string, public readonly details: TrustErrorDetails) {
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
  if (scpMatch) {return scpMatch[1];}

  // https://host.com/..., ssh://host.com/..., git://host.com/...
  try {
    const parsed = new URL(url);
    // Use host (includes port) instead of hostname (strips port)
    if (parsed.host) {return parsed.host;}
  } catch {
    // Not a valid URL — no domain
  }

  return undefined;
}

/**
 * Extract domain + path from a git URL, stripping .git suffix and trailing slashes.
 *
 * Used for prefix-matching against `git_domains` entries that may include path components
 * (e.g., `gitlab.com/owner/group`).
 *
 * Examples:
 *   https://gitlab.com/owner/group/repo.git → gitlab.com/owner/group/repo
 *   git@gitlab.com:owner/group/repo.git     → gitlab.com/owner/group/repo
 *   https://gitlab.com                      → gitlab.com
 */
/** Normalize path segments, resolving `.` and `..` to prevent traversal bypasses. */
function normalizePath(raw: string): string {
  const segments: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") {continue;}
    if (seg === "..") {
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return segments.join("/");
}

export function extractDomainPath(url: string): string | undefined {
  // SCP-style: git@host.com:path
  const scpMatch = url.match(/^[a-z]+@([^:]+):(.+)$/);
  if (scpMatch) {
    const host = scpMatch[1]!;
    const path = normalizePath(scpMatch[2]!.replace(/\.git$/i, ""));
    return path ? `${host}/${path}` : host;
  }

  try {
    const parsed = new URL(url);
    if (!parsed.host) {return undefined;}
    const path = normalizePath(parsed.pathname.replace(/\.git$/i, ""));
    return path ? `${parsed.host}/${path}` : parsed.host;
  } catch {
    return undefined;
  }
}

function formatAllowed(trust: TrustPolicy): string {
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
 * - Local path: and npm: sources → always allowed
 * - Otherwise → must match at least one rule (org, repo, or domain)
 */
export function validateTrustedSource(
  source: string,
  trust?: TrustPolicy,
): void {
  // No trust config → allow everything
  if (!trust) {return;}

  // Explicit opt-out
  if (trust.allow_all) {return;}

  const parsed = parseSource(source);

  // Local and npm sources are always allowed — both resolve to directories
  // already on disk (npm packages are vetted by the package manager's own
  // supply-chain controls at install time).
  if (parsed.type === "local" || parsed.type === "npm") {return;}

  if (parsed.type === "github") {
    const owner = parsed.owner!.toLowerCase();
    const repo = `${owner}/${parsed.repo!.toLowerCase()}`;

    if (trust.github_orgs.some((o) => o.toLowerCase() === owner)) {return;}
    if (trust.github_repos.some((r) => r.toLowerCase() === repo)) {return;}

    throw new TrustError(
      `Source "${source}" is not trusted. Allowed sources: ${formatAllowed(trust)}.`,
      {
        source,
        kind: "github",
        owner: parsed.owner!,
        repo: parsed.repo!,
        allowed: trust,
      },
    );
  }

  if (parsed.type === "git" || parsed.type === "well-known") {
    const domainPath = extractDomainPath(parsed.url!)?.toLowerCase();
    if (domainPath && trust.git_domains.some((d) => {
      const entry = d.toLowerCase();
      return domainPath === entry || domainPath.startsWith(`${entry}/`);
    })) {return;}

    const domain = extractDomain(parsed.url!)?.toLowerCase();
    throw new TrustError(
      `Source "${source}" is not trusted. Allowed sources: ${formatAllowed(trust)}.`,
      {
        source,
        kind: parsed.type,
        domain,
        allowed: trust,
      },
    );
  }
}
