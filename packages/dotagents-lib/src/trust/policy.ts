/**
 * Structural shape that any trust policy must satisfy for the lib to enforce it.
 *
 * The host's `TrustConfig` (defined in `@sentry/dotagents`) structurally satisfies
 * this interface. Other lib consumers can construct a `TrustPolicy` directly without
 * adopting the host's `agents.toml` config layer.
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
