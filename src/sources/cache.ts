import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { clone, fetchAndReset, fetchRef, headCommit, headCommitDate, findCommitOlderThan, checkout, isGitRepo } from "./git.js";

const DEFAULT_STATE_DIR = join(homedir(), ".local", "dotagents");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheError";
  }
}

export interface CacheResult {
  /** Path to the cached repo checkout */
  repoDir: string;
  /** Resolved commit SHA */
  commit: string;
}

/**
 * Get or populate the global cache for a git source.
 *
 * Cache layout:
 *   ~/.local/dotagents/<owner>/<repo>/          -- TTL-refreshed shallow clone
 */
export async function ensureCached(opts: {
  url: string;
  /** Cache key, e.g. "anthropics/skills" or "git.corp.example.com/team/skills" */
  cacheKey: string;
  ref?: string;
  ttlMs?: number;
  /** When set, resolve to the newest commit at least this many minutes old. */
  minimumReleaseAge?: number;
}): Promise<CacheResult> {
  const stateDir = process.env["DOTAGENTS_STATE_DIR"] || DEFAULT_STATE_DIR;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  const repoDir = join(stateDir, opts.cacheKey);

  if (isGitRepo(repoDir)) {
    // Always fetch when: a specific ref is requested, age gating is active
    // (checkout may have left HEAD at an old commit), or cache is stale.
    const needsRefresh = opts.ref || opts.minimumReleaseAge || await isStale(repoDir, ttl);
    if (needsRefresh) {
      if (opts.ref) {
        await fetchRef(repoDir, opts.ref);
      } else {
        await fetchAndReset(repoDir);
      }
    }
  } else {
    // Not cached yet — clone
    await mkdir(join(stateDir, opts.cacheKey, ".."), { recursive: true });
    await clone(opts.url, repoDir, opts.ref);
  }

  // Age gate: reject or resolve to an older commit when HEAD is too new
  if (opts.minimumReleaseAge) {
    const age = minutesOld(await headCommitDate(repoDir));
    if (age < opts.minimumReleaseAge) {
      if (opts.ref) {
        // Pinned skill — can't resolve to a different commit, just reject
        throw new CacheError(
          `ref "${opts.ref}" is ${Math.floor(age)} minutes old, minimum_release_age requires ${opts.minimumReleaseAge}`,
        );
      }
      const older = await findCommitOlderThan(repoDir, opts.minimumReleaseAge);
      if (!older) {
        throw new CacheError(
          `minimum_release_age is ${opts.minimumReleaseAge} minutes but no commit that old exists in ${opts.cacheKey}`,
        );
      }
      await checkout(repoDir, older);
    }
  }

  const commit = await headCommit(repoDir);
  return { repoDir, commit };
}

function minutesOld(date: Date): number {
  return (Date.now() - date.getTime()) / (60 * 1000);
}

async function isStale(repoDir: string, ttlMs: number): Promise<boolean> {
  try {
    const gitDir = join(repoDir, ".git", "FETCH_HEAD");
    const s = await stat(gitDir);
    return Date.now() - s.mtimeMs > ttlMs;
  } catch {
    // No FETCH_HEAD yet — consider stale
    return true;
  }
}
