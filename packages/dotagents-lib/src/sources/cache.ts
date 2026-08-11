import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { clone, fetchAndReset, fetchRef, headCommit, headCommitDate, findCommitOlderThan, checkout, isGitRepo } from "./git.js";

export class CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheError";
  }
}

/**
 * Derive a safe relative cache-key from a clone URL.
 *
 * Strips schemes, leading slashes (so `file:///abs/path` and `/abs/path`
 * both land under `<stateDir>/abs/path/`), and `.git` suffixes. Drops `.`
 * and `..` segments to keep the result inside the cache root.
 *
 * Callers that build a cacheKey from a hosted owner/repo (e.g. GitHub) can
 * skip this and use the parsed values directly.
 */
export function sanitizeCacheKey(url: string): string {
  const stripped = url
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\.git$/, "");
  const segments = stripped
    .split("/")
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..");
  return segments.join("/");
}

/**
 * Reject `cacheKey` values that would let `path.join(stateDir, cacheKey)`
 * resolve outside `stateDir`.
 *
 * The cacheKey is derived from URL paths or owner/repo strings, which can
 * contain `..` if a caller pipes through a malicious source spec. Without
 * this guard, a cacheKey like `evil.com/../../etc` would let `git clone`
 * write into arbitrary filesystem locations.
 */
export function validateCacheKey(cacheKey: string): void {
  if (!cacheKey) {
    throw new CacheError("cacheKey must be a non-empty string");
  }
  if (cacheKey.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(cacheKey)) {
    throw new CacheError(`cacheKey must be a relative path, got "${cacheKey}"`);
  }
  if (cacheKey.includes("\\")) {
    throw new CacheError(`cacheKey may not contain backslashes, got "${cacheKey}"`);
  }
  for (const segment of cacheKey.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new CacheError(`cacheKey may not contain "${segment}" segments, got "${cacheKey}"`);
    }
  }
}

export interface CacheResult {
  /** Path to the cached repo checkout */
  repoDir: string;
  /** Resolved commit SHA */
  commit: string;
}

const cacheLocks = new Map<string, Promise<void>>();

async function withCacheLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => {}).then(() => current);

  cacheLocks.set(key, next);
  await previous.catch(() => {});

  try {
    return await fn();
  } finally {
    release();
    if (cacheLocks.get(key) === next) {
      cacheLocks.delete(key);
    }
  }
}

/**
 * Get or populate the global cache for a git source.
 *
 * Always fetches the latest from the remote when a cached clone exists.
 * A shallow `git fetch --depth=1` is essentially free when already at
 * the latest commit, so there is no TTL — callers always get fresh state.
 *
 * The caller MUST supply the cache root directory (`stateDir`); the lib
 * does not impose a default. Hosts typically resolve this from their own
 * convention (e.g. `~/.local/<host>/`) plus an optional env var override.
 *
 * Cache layout:  `<stateDir>/<cacheKey>/`  -- shallow clone
 */
export async function ensureCached(opts: {
  /** Cache root directory. Required — host owns this. */
  stateDir: string;
  url: string;
  /** Cache key, e.g. "anthropics/skills" or "git.corp.example.com/team/skills" */
  cacheKey: string;
  ref?: string;
  /** When set, resolve to the newest commit at least this many minutes old. */
  minimumReleaseAge?: number;
  /** Reuse an existing checkout without fetching. Missing checkouts are still cloned. */
  refresh?: boolean;
}): Promise<CacheResult> {
  validateCacheKey(opts.cacheKey);
  const repoDir = join(opts.stateDir, opts.cacheKey);

  return withCacheLock(repoDir, async () => {
    const cached = isGitRepo(repoDir);
    if (cached && opts.refresh !== false) {
      if (opts.ref) {
        await fetchRef(repoDir, opts.ref);
      } else {
        await fetchAndReset(repoDir);
      }
    } else if (!cached) {
      // Remove an interrupted or stale non-git cache dir before cloning.
      await rm(repoDir, { recursive: true, force: true });
      await mkdir(join(opts.stateDir, opts.cacheKey, ".."), { recursive: true });
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
  });
}

function minutesOld(date: Date): number {
  return (Date.now() - date.getTime()) / (60 * 1000);
}
