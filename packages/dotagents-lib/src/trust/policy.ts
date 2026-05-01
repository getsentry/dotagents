/**
 * Structural shape that any trust policy must satisfy for the lib to enforce it.
 *
 * Callers construct a `TrustPolicy` directly, or pass through any object that
 * structurally matches (e.g. a host-defined zod-validated config type).
 */
export interface TrustPolicy {
  /** When true, all sources are allowed (bypass other rules). */
  allow_all: boolean;
  /** GitHub orgs whose repos are allowed (e.g. `"anthropics"`). */
  github_orgs: readonly string[];
  /** Specific GitHub repos that are allowed (e.g. `"anthropics/skills"`). */
  github_repos: readonly string[];
  /** Allowed git domains, optionally with path prefixes (e.g. `"gitlab.com/myorg"`). */
  git_domains: readonly string[];
}
