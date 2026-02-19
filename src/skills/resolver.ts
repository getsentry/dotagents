import { join } from "node:path";
import type { WildcardSkillDependency } from "../config/schema.js";
import { GITHUB_HTTPS_URL, GITHUB_SSH_URL } from "../config/schema.js";
import { ensureCached } from "../sources/cache.js";
import { resolveLocalSource } from "../sources/local.js";
import { discoverSkill, discoverAllSkills } from "./discovery.js";
import type { DiscoveredSkill } from "./discovery.js";

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

export type ResolvedSkill = ResolvedGitSkill | ResolvedLocalSkill;

/**
 * Parse a source string into its components.
 */
export function parseSource(source: string): {
  type: "github" | "git" | "local";
  url?: string;
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
    return {
      type: "github",
      owner,
      repo,
      ref,
      url: `https://github.com/${owner}/${repo}.git`,
    };
  }

  // owner/repo or owner/repo@ref
  const atIdx = source.indexOf("@");
  const base = atIdx !== -1 ? source.slice(0, atIdx) : source;
  const ref = atIdx !== -1 ? source.slice(atIdx + 1) : undefined;
  const [owner, repo] = base.split("/");

  return {
    type: "github",
    owner,
    repo,
    ref,
    url: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Resolve a skill dependency to a concrete directory on disk.
 */
export async function resolveSkill(
  skillName: string,
  dep: { source: string; ref?: string; path?: string },
  opts?: {
    projectRoot?: string;
    /** Locked commit from agents.lock — skip resolution, use this exact commit */
    lockedCommit?: string;
  },
): Promise<ResolvedSkill> {
  const parsed = parseSource(dep.source);

  if (parsed.type === "local") {
    const projectRoot = opts?.projectRoot || process.cwd();
    const skillDir = await resolveLocalSource(projectRoot, parsed.path!);
    return { type: "local", source: dep.source, skillDir };
  }

  // Git source (GitHub or generic git)
  const url = parsed.url!;
  const ref = dep.ref ?? parsed.ref;
  const cacheKey =
    parsed.type === "github"
      ? `${parsed.owner}/${parsed.repo}`
      : url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

  const cached = await ensureCached({
    url,
    cacheKey,
    ref,
    pinnedCommit: opts?.lockedCommit,
  });

  // Discover the skill within the repo
  let discovered: DiscoveredSkill | null;
  if (dep.path) {
    // Explicit path override — load directly
    const { loadSkillMd } = await import("./loader.js");
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
    resolvedUrl: url,
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
const VALID_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Resolve a wildcard dependency: discover all skills from a source and return them.
 * Excludes are filtered out. Skill names are validated to prevent path traversal.
 */
export async function resolveWildcardSkills(
  dep: Pick<WildcardSkillDependency, "source" | "ref" | "exclude">,
  opts?: {
    projectRoot?: string;
    lockedCommit?: string;
  },
): Promise<NamedResolvedSkill[]> {
  const parsed = parseSource(dep.source);
  const excludeSet = new Set(dep.exclude);

  if (parsed.type === "local") {
    const projectRoot = opts?.projectRoot || process.cwd();
    const skillDir = await resolveLocalSource(projectRoot, parsed.path!);
    const discovered = await discoverAllSkills(skillDir);
    return discovered
      .filter((d) => !excludeSet.has(d.meta.name) && VALID_SKILL_NAME.test(d.meta.name))
      .map((d) => ({
        name: d.meta.name,
        resolved: { type: "local" as const, source: dep.source, skillDir: join(skillDir, d.path) },
      }));
  }

  // Git source
  const url = parsed.url!;
  const ref = dep.ref ?? parsed.ref;
  const cacheKey =
    parsed.type === "github"
      ? `${parsed.owner}/${parsed.repo}`
      : url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

  const cached = await ensureCached({
    url,
    cacheKey,
    ref,
    pinnedCommit: opts?.lockedCommit,
  });

  const discovered = await discoverAllSkills(cached.repoDir);

  return discovered
    .filter((d) => !excludeSet.has(d.meta.name) && VALID_SKILL_NAME.test(d.meta.name))
    .map((d) => ({
      name: d.meta.name,
      resolved: {
        type: "git" as const,
        source: dep.source,
        resolvedUrl: url,
        resolvedPath: d.path,
        resolvedRef: ref,
        commit: cached.commit,
        skillDir: join(cached.repoDir, d.path),
      },
    }));
}
