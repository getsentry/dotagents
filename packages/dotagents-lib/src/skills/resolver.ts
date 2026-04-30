import { join } from "node:path";
import {
  GITHUB_HTTPS_URL,
  GITHUB_SSH_URL,
  GITLAB_HTTPS_URL,
  GITLAB_SSH_URL,
  type RepositorySource,
} from "../sources/repository-source.js";
import { ensureCached } from "../sources/cache.js";
import { ensureWellKnownCached } from "../sources/wellknown.js";
import { resolveLocalSource } from "../sources/local.js";
import { discoverSkill, discoverAllSkills, type DiscoveredSkill } from "./discovery.js";
import { loadSkillMd } from "./loader.js";
import { stripTrailingSlashes } from "../utils/fs.js";
import { validateTrustedSource } from "../trust/validator.js";
import type { TrustPolicy } from "../trust/policy.js";

/** Structural shape of the wildcard-subset of a skill dependency, used by the lib resolver. */
export interface WildcardDependencyInput {
  source: string;
  ref?: string;
  exclude?: readonly string[];
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

export interface ResolvedGitSkill {
  type: "git";
  /** Original source string */
  source: string;
  /** Resolved git clone URL */
  resolvedUrl: string;
  /** Path within the repo to the skill directory */
  resolvedPath: string;
  /** Ref that was resolved */
  resolvedRef?: string;
  /** Full 40-char commit SHA */
  commit: string;
  /** Absolute path to the cached skill directory */
  skillDir: string;
}

export interface ResolvedLocalSkill {
  type: "local";
  source: string;
  /** Absolute path to the skill directory */
  skillDir: string;
}

export interface ResolvedWellKnownSkill {
  type: "well-known";
  /** Original source string */
  source: string;
  /** Resolved HTTP URL */
  resolvedUrl: string;
  /** Absolute path to the cached skill directory */
  skillDir: string;
}

export type ResolvedSkill = ResolvedGitSkill | ResolvedLocalSkill | ResolvedWellKnownSkill;

export function isExplicitSourceSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("path:") ||
    specifier.startsWith("git:") ||
    specifier.startsWith("http://") ||
    specifier.startsWith("https://") ||
    specifier.startsWith("git@")
  );
}

/** Strip a leading `@` from npm-style scoped specifiers (e.g. `@owner/repo` → `owner/repo`). */
export function stripLeadingAt(specifier: string): string {
  return specifier.startsWith("@") ? specifier.slice(1) : specifier;
}

export function parseOwnerRepoShorthand(
  specifier: string,
): { owner: string; repo: string; ref?: string } | undefined {
  if (isExplicitSourceSpecifier(specifier)) {return undefined;}

  const stripped = stripLeadingAt(specifier);
  const atIdx = stripped.indexOf("@");
  const base = atIdx >= 0 ? stripped.slice(0, atIdx) : stripped;
  const ref = atIdx >= 0 ? stripped.slice(atIdx + 1) : undefined;
  const parts = base.split("/");
  if (parts.length !== 2) {return undefined;}

  const [owner, repo] = parts;
  if (!owner || !repo || owner.startsWith("-") || repo.startsWith("-")) {
    return undefined;
  }

  return { owner, repo, ref };
}

/**
 * Expand owner/repo shorthand according to defaultRepositorySource.
 * Returns input unchanged for explicit sources or non-shorthand values.
 *
 * When defaultRepositorySource is "gitlab", also handles multi-slash paths
 * (e.g., `group/subgroup/repo`) since GitLab supports nested groups.
 */
export function applyDefaultRepositorySource(
  specifier: string,
  defaultRepositorySource: RepositorySource = "github",
): string {
  if (isExplicitSourceSpecifier(specifier)) {return specifier;}

  const shorthand = parseOwnerRepoShorthand(specifier);
  if (shorthand) {
    const host =
      defaultRepositorySource === "gitlab" ? "gitlab.com" : "github.com";
    const refSuffix = shorthand.ref ? `@${shorthand.ref}` : "";
    return `https://${host}/${shorthand.owner}/${shorthand.repo}${refSuffix}`;
  }

  // Multi-slash GitLab path: group/subgroup/repo[@ref]
  if (defaultRepositorySource === "gitlab") {
    const stripped = stripLeadingAt(specifier);
    const atIdx = stripped.indexOf("@");
    const base = atIdx >= 0 ? stripped.slice(0, atIdx) : stripped;
    const ref = atIdx >= 0 ? stripped.slice(atIdx + 1) : undefined;
    const parts = base.split("/");
    if (parts.length >= 3 && parts.every((p) => p && !p.startsWith("-"))) {
      const refSuffix = ref ? `@${ref}` : "";
      return `https://gitlab.com/${base}${refSuffix}`;
    }
  }

  return specifier;
}

/**
 * Parse a source string into its components.
 */
export function parseSource(source: string): {
  type: "github" | "git" | "local" | "well-known";
  url?: string;
  /** Original URL to use for cloning (preserves SSH/HTTPS protocol). Undefined for owner/repo shorthand. */
  cloneUrl?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  path?: string;
} {
  if (source.startsWith("path:")) {
    return { type: "local", path: source.slice(5) };
  }

  if (source.startsWith("git:")) {
    return { type: "git", url: source.slice(4) };
  }

  // GitHub HTTPS or SSH URL
  const githubUrlMatch =
    source.match(GITHUB_HTTPS_URL) || source.match(GITHUB_SSH_URL);
  if (githubUrlMatch) {
    const [, owner, repo, ref] = githubUrlMatch;
    // Strip @ref suffix using known ref length, upgrade http:// to https:// (no-op for SSH URLs)
    const withoutRef = ref ? source.slice(0, -(ref.length + 1)) : source;
    const cloneUrl = withoutRef.replace(/^http:\/\//i, "https://");
    return {
      type: "github",
      owner,
      repo,
      ref,
      url: `https://github.com/${owner}/${repo}.git`,
      cloneUrl,
    };
  }

  // GitLab HTTPS or SSH URL
  const gitlabUrlMatch =
    source.match(GITLAB_HTTPS_URL) || source.match(GITLAB_SSH_URL);
  if (gitlabUrlMatch) {
    const [, owner, repo, ref] = gitlabUrlMatch;
    // Strip @ref suffix using known ref length, upgrade http:// to https:// (no-op for SSH URLs)
    const withoutRef = ref ? source.slice(0, -(ref.length + 1)) : source;
    const cloneUrl = withoutRef.replace(/^http:\/\//i, "https://");
    return {
      type: "git",
      owner,
      repo,
      ref,
      url: `https://gitlab.com/${owner}/${repo}.git`,
      cloneUrl,
    };
  }

  // Bare HTTPS URL not matching GitHub/GitLab — candidate for well-known
  // Only HTTPS — http:// is rejected to prevent MITM attacks
  if (/^https:\/\//i.test(source)) {
    return { type: "well-known", url: stripTrailingSlashes(source) };
  }

  // owner/repo or owner/repo@ref — shorthand, no cloneUrl
  const stripped = stripLeadingAt(source);
  const atIdx = stripped.indexOf("@");
  const base = atIdx === -1 ? stripped : stripped.slice(0, atIdx);
  const ref = atIdx === -1 ? undefined : stripped.slice(atIdx + 1);
  const [owner, repo] = base.split("/");

  return {
    type: "github",
    owner,
    repo,
    ref,
    url: `https://github.com/${owner}/${repo}.git`,
  };
}

/** Normalize hosted sources to canonical owner/repo form for comparison/dedup. */
export function normalizeSource(source: string): string {
  const parsed = parseSource(source);
  if (parsed.type === "well-known" && parsed.url) {
    // Normalize: strip trailing slash, lowercase hostname
    try {
      const u = new URL(parsed.url);
      return `${u.protocol}//${u.host.toLowerCase()}${stripTrailingSlashes(u.pathname)}`;
    } catch {
      return source;
    }
  }
  if (parsed.owner && parsed.repo) {
    return `${parsed.owner}/${parsed.repo}`;
  }
  return source;
}

/** Build a cache key for a well-known URL (e.g. "wellknown/cli.sentry.dev/path"). */
function wellKnownCacheKey(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `wellknown/${u.host.toLowerCase()}${stripTrailingSlashes(u.pathname)}`;
}

/** Compare two source strings for equivalence (normalizes hosted URLs to owner/repo). */
export function sourcesMatch(a: string, b: string): boolean {
  return normalizeSource(a) === normalizeSource(b);
}

/**
 * Resolve a skill dependency to a concrete directory on disk.
 */
export async function resolveSkill(
  skillName: string,
  dep: { source: string; ref?: string; path?: string },
  opts?: {
    projectRoot?: string;
    defaultRepositorySource?: RepositorySource;
    /** Override cache TTL (pass 0 to force refresh) */
    ttlMs?: number;
    /** When set, resolve to the newest commit at least this many minutes old. */
    minimumReleaseAge?: number;
    /** Sources excluded from the age gate (org or org/repo patterns). */
    minimumReleaseAgeExclude?: string[];
    /** When provided, validate the source against the policy BEFORE any network access. */
    trust?: TrustPolicy;
  },
): Promise<ResolvedSkill> {
  if (opts?.trust) {validateTrustedSource(dep.source, opts.trust);}

  const sourceForResolve = applyDefaultRepositorySource(
    dep.source,
    opts?.defaultRepositorySource,
  );
  const parsed = parseSource(sourceForResolve);

  if (parsed.type === "local") {
    const projectRoot = opts?.projectRoot || process.cwd();
    const skillDir = await resolveLocalSource(projectRoot, parsed.path!);
    return { type: "local", source: dep.source, skillDir };
  }

  if (parsed.type === "well-known") {
    const baseUrl = parsed.url!;
    const cached = await ensureWellKnownCached({
      url: baseUrl,
      cacheKey: wellKnownCacheKey(baseUrl),
      ttlMs: opts?.ttlMs,
    });

    if (!cached) {
      throw new ResolveError(
        `No skills found at ${baseUrl}. If this is a git repository, use the git: prefix: git:${baseUrl}`,
      );
    }

    const discovered = await discoverSkill(cached.cacheDir, skillName);
    if (!discovered) {
      throw new ResolveError(
        `Skill "${skillName}" not found in ${dep.source}. ` +
          `Tried conventional directories. Use the 'path' field to specify the location explicitly.`,
      );
    }

    return {
      type: "well-known",
      source: dep.source,
      resolvedUrl: baseUrl,
      skillDir: join(cached.cacheDir, discovered.path),
    };
  }

  // Git source (GitHub or generic git)
  const url = parsed.url!;
  const cloneUrl = parsed.cloneUrl ?? url;
  const ref = dep.ref ?? parsed.ref;
  const cacheKey =
    parsed.type === "github"
      ? `${parsed.owner}/${parsed.repo}`
      : url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

  const excluded = isSourceExcluded(dep.source, opts?.minimumReleaseAgeExclude);
  const cached = await ensureCached({
    url: cloneUrl,
    cacheKey,
    ref,
    minimumReleaseAge: excluded ? undefined : opts?.minimumReleaseAge,
  });

  // Discover the skill within the repo
  let discovered: DiscoveredSkill | null;
  if (dep.path) {
    // Explicit path override — load directly
    const meta = await loadSkillMd(join(cached.repoDir, dep.path, "SKILL.md"));
    discovered = { path: dep.path, meta };
  } else {
    discovered = await discoverSkill(cached.repoDir, skillName);
  }

  if (!discovered) {
    throw new ResolveError(
      `Skill "${skillName}" not found in ${dep.source}. ` +
        `Tried conventional directories. Use the 'path' field to specify the location explicitly.`,
    );
  }

  return {
    type: "git",
    source: dep.source,
    resolvedUrl: cloneUrl,
    resolvedPath: discovered.path,
    resolvedRef: ref,
    commit: cached.commit,
    skillDir: join(cached.repoDir, discovered.path),
  };
}

export interface NamedResolvedSkill {
  name: string;
  resolved: ResolvedSkill;
}

/** Skill names must be safe for use in file paths. */
export const VALID_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Resolve a wildcard dependency: discover all skills from a source and return them.
 * Excludes are filtered out. Skill names are validated to prevent path traversal.
 */
export async function resolveWildcardSkills(
  dep: WildcardDependencyInput,
  opts?: {
    projectRoot?: string;
    defaultRepositorySource?: RepositorySource;
    /** Override cache TTL (pass 0 to force refresh) */
    ttlMs?: number;
    /** When set, resolve to the newest commit at least this many minutes old. */
    minimumReleaseAge?: number;
    /** Sources excluded from the age gate (org or org/repo patterns). */
    minimumReleaseAgeExclude?: string[];
    /** When provided, validate the source against the policy BEFORE any network access. */
    trust?: TrustPolicy;
  },
): Promise<NamedResolvedSkill[]> {
  if (opts?.trust) {validateTrustedSource(dep.source, opts.trust);}

  const sourceForResolve = applyDefaultRepositorySource(
    dep.source,
    opts?.defaultRepositorySource,
  );
  const parsed = parseSource(sourceForResolve);
  const excludeSet = new Set(dep.exclude);

  if (parsed.type === "local") {
    const projectRoot = opts?.projectRoot || process.cwd();
    const skillDir = await resolveLocalSource(projectRoot, parsed.path!);
    const discovered = await discoverAllSkills(skillDir);
    return discovered
      .filter(
        (d) =>
          !excludeSet.has(d.meta.name) && VALID_SKILL_NAME.test(d.meta.name),
      )
      .map((d) => ({
        name: d.meta.name,
        resolved: {
          type: "local" as const,
          source: dep.source,
          skillDir: join(skillDir, d.path),
        },
      }));
  }

  if (parsed.type === "well-known") {
    const baseUrl = parsed.url!;
    const cached = await ensureWellKnownCached({
      url: baseUrl,
      cacheKey: wellKnownCacheKey(baseUrl),
      ttlMs: opts?.ttlMs,
    });

    if (!cached) {
      return [];
    }

    const discovered = await discoverAllSkills(cached.cacheDir);
    return discovered
      .filter(
        (d) => !excludeSet.has(d.meta.name) && VALID_SKILL_NAME.test(d.meta.name),
      )
      .map((d) => ({
        name: d.meta.name,
        resolved: {
          type: "well-known" as const,
          source: dep.source,
          resolvedUrl: baseUrl,
          skillDir: join(cached.cacheDir, d.path),
        },
      }));
  }

  // Git source
  const url = parsed.url!;
  const cloneUrl = parsed.cloneUrl ?? url;
  const ref = dep.ref ?? parsed.ref;
  const cacheKey =
    parsed.type === "github"
      ? `${parsed.owner}/${parsed.repo}`
      : url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

  const excluded = isSourceExcluded(dep.source, opts?.minimumReleaseAgeExclude);
  const cached = await ensureCached({
    url: cloneUrl,
    cacheKey,
    ref,
    minimumReleaseAge: excluded ? undefined : opts?.minimumReleaseAge,
  });

  const discovered = await discoverAllSkills(cached.repoDir);

  return discovered
    .filter(
      (d) => !excludeSet.has(d.meta.name) && VALID_SKILL_NAME.test(d.meta.name),
    )
    .map((d) => ({
      name: d.meta.name,
      resolved: {
        type: "git" as const,
        source: dep.source,
        resolvedUrl: cloneUrl,
        resolvedPath: d.path,
        resolvedRef: ref,
        commit: cached.commit,
        skillDir: join(cached.repoDir, d.path),
      },
    }));
}

/**
 * Check if a source string matches any pattern in the exclude list.
 * Patterns: "org" matches "org/anything", "org/repo" is exact match,
 * "org/*" matches "org/anything" (explicit wildcard).
 */
export function isSourceExcluded(source: string, exclude?: string[]): boolean {
  if (!exclude?.length) {return false;}
  const normalized = source.replace(/^git:/, "");
  for (const raw of exclude) {
    const pattern = raw.replace(/^git:/, "");
    if (pattern.includes("/") && !pattern.endsWith("/*")) {
      // Exact org/repo match
      if (normalized === pattern) {return true;}
    } else {
      // Bare org ("myorg") or wildcard ("myorg/*") — both match as prefix
      const prefix = pattern.replace(/\/\*$/, "");
      if (normalized.startsWith(`${prefix}/`)) {return true;}
    }
  }
  return false;
}
