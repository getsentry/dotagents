import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  GITHUB_HTTPS_URL,
  GITHUB_SSH_URL,
  GITLAB_HTTPS_URL,
  GITLAB_SSH_URL,
  type RepositorySource,
} from "../sources/repository-source.js";
import { ensureCached, sanitizeCacheKey } from "../sources/cache.js";
import { ensureWellKnownCached } from "../sources/wellknown.js";
import { resolveLocalSource } from "../sources/local.js";
import { resolveNpmSource } from "../sources/npm.js";
import { discoverSkill, discoverAllSkills, type DiscoveredSkill } from "./discovery.js";
import { loadSkillMd } from "./loader.js";
import { stripTrailingSlashes } from "../utils/fs.js";
import { validateTrustedSource } from "../trust/validator.js";
import type { TrustPolicy } from "../trust/policy.js";

/** Structural shape of the wildcard-subset of a skill dependency, used by the lib resolver. */
export interface WildcardDependencyInput {
  source: string;
  ref?: string;
  path?: string;
  exclude?: readonly string[];
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

/**
 * Thrown when `parseSource` is asked to parse a malformed shorthand specifier
 * that previously produced a silent partial parse.
 *
 *  - `empty-sha`: input ends with `@` and nothing after (`owner/repo@`).
 *  - `multi-segment-shorthand`: shorthand has more than two slash-separated
 *    segments (`owner/repo/nested`). GitLab nested groups are unaffected
 *    because they go through `applyDefaultRepositorySource` first.
 */
export type ParseSourceErrorKind = "empty-sha" | "multi-segment-shorthand";

export class ParseSourceError extends Error {
  readonly kind: ParseSourceErrorKind;

  constructor(message: string, kind: ParseSourceErrorKind) {
    super(message);
    this.name = "ParseSourceError";
    this.kind = kind;
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
  /** Path within the local source root, when discovered from a wildcard. */
  resolvedPath?: string;
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
    specifier.startsWith("npm:") ||
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

  // Empty SHA after `@` is malformed shorthand, not a valid no-pin parse.
  if (atIdx >= 0 && ref === "") {return undefined;}

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
  type: "github" | "git" | "local" | "npm" | "well-known";
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

  if (source.startsWith("npm:")) {
    return { type: "npm", path: source.slice(4) };
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

  // Empty SHA after `@` was previously returning `ref: ''` which downstream
  // code treats as no-pin. Throw instead so a typo doesn't silently fall back
  // to the tip of the default branch.
  if (atIdx >= 0 && ref === "") {
    throw new ParseSourceError(
      `Invalid source: ${source} (empty SHA after @)`,
      "empty-sha",
    );
  }

  const parts = base.split("/");
  // Multi-segment shorthand silently dropped trailing segments. Throw so
  // `owner/repo/nested` doesn't resolve as `owner/repo` against the user's
  // intent. (GitLab nested groups go through applyDefaultRepositorySource
  // first and arrive here as URL form, not shorthand.)
  if (parts.length > 2) {
    throw new ParseSourceError(
      `Invalid source: ${source} (multi-segment shorthand; use a full URL for nested groups)`,
      "multi-segment-shorthand",
    );
  }

  const [owner, repo] = parts;

  return {
    type: "github",
    owner,
    repo,
    ref,
    url: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Normalize hosted sources to canonical owner/repo form for comparison/dedup.
 *
 * Best-effort: malformed inputs that `parseSource` rejects are returned as-is
 * so dedup and comparison paths don't crash on stale or hand-edited config.
 * Real install/add paths still call `parseSource` directly and surface the
 * error to the user.
 */
export function normalizeSource(source: string): string {
  let parsed;
  try {
    parsed = parseSource(source);
  } catch (err) {
    if (err instanceof ParseSourceError) {return source;}
    throw err;
  }
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
export interface ResolveOpts {
  /** Cache root directory. Required — host owns this. */
  stateDir: string;
  projectRoot?: string;
  defaultRepositorySource?: RepositorySource;
  /** Extra recursive directories to scan when looking for SKILL.md inside a source. */
  scanDirs?: readonly string[];
  /** Override cache TTL for well-known sources (pass 0 to force refresh). */
  ttlMs?: number;
  /** When set, resolve to the newest commit at least this many minutes old. */
  minimumReleaseAge?: number;
  /** Sources excluded from the age gate (org or org/repo patterns). */
  minimumReleaseAgeExclude?: string[];
  /** When provided, validate the source against the policy BEFORE any network access. */
  trust?: TrustPolicy;
}

type AcquiredSkillSource =
  | { type: "local"; skillDir: string }
  | { type: "well-known"; cacheDir: string | null; resolvedUrl: string }
  | {
      type: "git";
      repoDir: string;
      resolvedUrl: string;
      resolvedRef?: string;
      commit: string;
    };

async function acquireSkillSource(
  dep: { source: string; ref?: string },
  opts: ResolveOpts,
): Promise<AcquiredSkillSource> {
  const sourceForResolve = applyDefaultRepositorySource(
    dep.source,
    opts.defaultRepositorySource,
  );
  // Trust the expanded source before any local or network acquisition.
  if (opts.trust) {validateTrustedSource(sourceForResolve, opts.trust);}

  const parsed = parseSource(sourceForResolve);
  if (parsed.type === "local") {
    const projectRoot = opts.projectRoot || process.cwd();
    const skillDir = await resolveLocalSource(projectRoot, parsed.path!);
    return { type: "local", skillDir };
  }

  // npm packages resolve to an installed directory on disk; from here on they
  // behave exactly like local sources.
  if (parsed.type === "npm") {
    const projectRoot = opts.projectRoot || process.cwd();
    const skillDir = await resolveNpmSource(projectRoot, parsed.path!);
    return { type: "local", skillDir };
  }

  if (parsed.type === "well-known") {
    const resolvedUrl = parsed.url!;
    const cached = await ensureWellKnownCached({
      stateDir: opts.stateDir,
      url: resolvedUrl,
      cacheKey: wellKnownCacheKey(resolvedUrl),
      ttlMs: opts.ttlMs,
    });
    return {
      type: "well-known",
      cacheDir: cached?.cacheDir ?? null,
      resolvedUrl,
    };
  }

  const url = parsed.url!;
  const resolvedUrl = parsed.cloneUrl ?? url;
  const resolvedRef = dep.ref ?? parsed.ref;
  const cacheKey = parsed.type === "github"
    ? `${parsed.owner}/${parsed.repo}`
    : sanitizeCacheKey(url);
  const excluded = isSourceExcluded(dep.source, opts.minimumReleaseAgeExclude);
  const cached = await ensureCached({
    stateDir: opts.stateDir,
    url: resolvedUrl,
    cacheKey,
    ref: resolvedRef,
    minimumReleaseAge: excluded ? undefined : opts.minimumReleaseAge,
  });

  return {
    type: "git",
    repoDir: cached.repoDir,
    resolvedUrl,
    resolvedRef,
    commit: cached.commit,
  };
}

export async function resolveSkill(
  skillName: string,
  dep: { source: string; ref?: string; path?: string },
  opts: ResolveOpts,
): Promise<ResolvedSkill> {
  const acquired = await acquireSkillSource(dep, opts);

  if (acquired.type === "local") {
    return { type: "local", source: dep.source, skillDir: acquired.skillDir };
  }

  if (acquired.type === "well-known") {
    if (!acquired.cacheDir) {
      throw new ResolveError(
        `No skills found at ${acquired.resolvedUrl}. If this is a git repository, use the git: prefix: git:${acquired.resolvedUrl}`,
      );
    }

    const discovered = await discoverSkill(acquired.cacheDir, skillName, { scanDirs: opts.scanDirs });
    if (!discovered) {
      throw new ResolveError(
        `Skill "${skillName}" not found in ${dep.source}. ` +
          `Tried conventional directories. Use the 'path' field to specify the location explicitly.`,
      );
    }

    return {
      type: "well-known",
      source: dep.source,
      resolvedUrl: acquired.resolvedUrl,
      skillDir: join(acquired.cacheDir, discovered.path),
    };
  }

  let discovered: DiscoveredSkill | null;
  if (dep.path) {
    const meta = await loadSkillMd(join(acquired.repoDir, dep.path, "SKILL.md"));
    discovered = { path: dep.path, meta };
  } else {
    discovered = await discoverSkill(acquired.repoDir, skillName, { scanDirs: opts.scanDirs });
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
    resolvedUrl: acquired.resolvedUrl,
    resolvedPath: discovered.path,
    resolvedRef: acquired.resolvedRef,
    commit: acquired.commit,
    skillDir: join(acquired.repoDir, discovered.path),
  };
}

export interface NamedResolvedSkill {
  name: string;
  resolved: ResolvedSkill;
}

interface ScopedDiscoveredSkill extends DiscoveredSkill {
  skillDir: string;
}

function isOutsideRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function escapesSourceRoot(path: string): boolean {
  const posixPath = posix.normalize(path);
  const windowsPath = win32.normalize(path);
  return (
    posixPath === ".." ||
    posixPath.startsWith("../") ||
    windowsPath === ".." ||
    windowsPath.startsWith(`..${win32.sep}`)
  );
}

async function discoverWildcardScope(
  sourceRoot: string,
  path: string | undefined,
  scanDirs: readonly string[] | undefined,
): Promise<ScopedDiscoveredSkill[]> {
  const root = resolve(sourceRoot);
  const canonicalPath = path?.replaceAll("\\", "/");
  const scopeDir = canonicalPath ? resolve(root, canonicalPath) : root;
  const scopePath = relative(root, scopeDir);
  if (isOutsideRoot(root, scopeDir)) {
    throw new ResolveError(`Wildcard path "${path}" resolves outside source root`);
  }
  if (canonicalPath) {
    let scopeStat;
    try {
      scopeStat = await stat(scopeDir);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        throw err;
      }
      throw new ResolveError(`Wildcard path "${path}" does not exist in source`);
    }
    if (!scopeStat.isDirectory()) {
      throw new ResolveError(`Wildcard path "${path}" is not a directory in source`);
    }
    if (isOutsideRoot(await realpath(root), await realpath(scopeDir))) {
      throw new ResolveError(`Wildcard path "${path}" resolves outside source root`);
    }
  }

  const pathPrefix = scopePath.split(sep).join("/");
  const discovered = await discoverAllSkills(scopeDir, {
    scanDirs: canonicalPath ? ["."] : scanDirs,
  });
  return discovered.map((skill) => {
    const resolvedPath = pathPrefix
      ? skill.path === "." ? pathPrefix : `${pathPrefix}/${skill.path}`
      : skill.path;
    return {
      path: resolvedPath,
      meta: skill.meta,
      skillDir: join(scopeDir, skill.path),
    };
  });
}

/** Skill names must be safe for use in file paths. */
export const VALID_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Resolve a wildcard dependency, optionally restricting recursive discovery to
 * a contained source subdirectory. Excludes are filtered out and skill names
 * are validated before they are used as install paths.
 */
export async function resolveWildcardSkills(
  dep: WildcardDependencyInput,
  opts: ResolveOpts,
): Promise<NamedResolvedSkill[]> {
  if (dep.path === "") {
    throw new ResolveError("Wildcard path must not be empty");
  }
  if (dep.path && (posix.isAbsolute(dep.path) || win32.parse(dep.path).root !== "")) {
    throw new ResolveError("Wildcard path must be relative to the source root");
  }
  if (dep.path && escapesSourceRoot(dep.path)) {
    throw new ResolveError(`Wildcard path "${dep.path}" resolves outside source root`);
  }
  if (dep.path) {
    const source = applyDefaultRepositorySource(dep.source, opts.defaultRepositorySource);
    if (parseSource(source).type === "well-known") {
      throw new ResolveError("Wildcard path is not supported for well-known sources");
    }
  }

  const acquired = await acquireSkillSource(dep, opts);
  const excludeSet = new Set(dep.exclude);

  if (acquired.type === "local") {
    const discovered = await discoverWildcardScope(
      acquired.skillDir,
      dep.path,
      opts.scanDirs,
    );
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
          resolvedPath: dep.path ? d.path : undefined,
          skillDir: d.skillDir,
        },
      }));
  }

  if (acquired.type === "well-known") {
    if (!acquired.cacheDir) {
      return [];
    }

    const discovered = await discoverWildcardScope(
      acquired.cacheDir,
      dep.path,
      opts.scanDirs,
    );
    return discovered
      .filter(
        (d) => !excludeSet.has(d.meta.name) && VALID_SKILL_NAME.test(d.meta.name),
      )
      .map((d) => ({
        name: d.meta.name,
        resolved: {
          type: "well-known" as const,
          source: dep.source,
          resolvedUrl: acquired.resolvedUrl,
          skillDir: d.skillDir,
        },
      }));
  }

  const discovered = await discoverWildcardScope(
    acquired.repoDir,
    dep.path,
    opts.scanDirs,
  );

  return discovered
    .filter(
      (d) => !excludeSet.has(d.meta.name) && VALID_SKILL_NAME.test(d.meta.name),
    )
    .map((d) => ({
      name: d.meta.name,
      resolved: {
        type: "git" as const,
        source: dep.source,
        resolvedUrl: acquired.resolvedUrl,
        resolvedPath: d.path,
        resolvedRef: acquired.resolvedRef,
        commit: acquired.commit,
        skillDir: d.skillDir,
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
