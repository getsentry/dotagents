import { exec, ExecError } from "../utils/exec.js";
import { existsSync } from "node:fs";

function toSshCloneUrl(url: string): string | undefined {
  const hostedMatch = url.match(
    /^https?:\/\/(github\.com|gitlab\.com)\/(.+)$/i,
  );
  if (!hostedMatch) {return undefined;}

  const host = hostedMatch[1]!;
  const rawPath = hostedMatch[2]!;
  let path = rawPath;
  while (path.endsWith("/")) {path = path.slice(0, -1);}

  return `git@${host.toLowerCase()}:${path.endsWith(".git") ? path : `${path}.git`}`;
}

/**
 * Structured details on why a git operation failed.
 *
 * Hosts inspect `kind` to render whatever guidance is appropriate for their
 * surface. The lib never embeds CLI hints or vendor copy in the message.
 */
export interface GitErrorDetails {
  /** Classifies the failure for host-specific recovery hints. */
  kind: "auth-required" | "other";
  /** The HTTPS clone URL that was attempted. */
  url?: string;
  /** When the failure looked like missing auth, an SSH-form URL the host can suggest. */
  sshUrl?: string;
  /** Raw stderr from git, if available. */
  stderr?: string;
}

export class GitError extends Error {
  constructor(message: string, public readonly details?: GitErrorDetails) {
    super(message);
    this.name = "GitError";
  }
}

/** Hex-only string of 7-40 chars — looks like a commit SHA. */
const SHA_LIKE = /^[0-9a-f]{7,40}$/i;

/**
 * Clone a repo with --depth=1 into the given directory.
 * If ref is provided, clones that specific ref.
 *
 * Commit SHAs can't be passed to `git clone --branch`, so for SHA-like refs
 * we clone the default branch first, then fetch the specific commit.
 */
export async function clone(
  url: string,
  dest: string,
  ref?: string,
): Promise<void> {
  const isSha = ref && SHA_LIKE.test(ref);
  const args = ["clone", "--depth=1"];
  if (ref && !isSha) {
    args.push("--branch", ref);
  }
  args.push("--", url, dest);

  try {
    await exec("git", args);
  } catch (err) {
    if (err instanceof ExecError) {
      const stderr = err.stderr;
      const sshUrl = toSshCloneUrl(url);
      if (
        sshUrl &&
        (/terminal prompts disabled/i.test(stderr) ||
          /could not read Username/i.test(stderr))
      ) {
        throw new GitError(
          `Failed to clone ${url}: authentication required.`,
          { kind: "auth-required", url, sshUrl, stderr },
        );
      }
      throw new GitError(`Failed to clone ${url}: ${stderr}`, {
        kind: "other",
        url,
        stderr,
      });
    }
    throw err;
  }

  // For SHA refs, fetch the specific commit after the initial clone
  if (isSha) {
    await fetchRef(dest, ref);
  }
}

/**
 * Fetch latest and reset to origin's HEAD. For updating unpinned repos.
 */
export async function fetchAndReset(repoDir: string): Promise<void> {
  try {
    await exec("git", ["fetch", "--force", "--depth=1", "--", "origin"], { cwd: repoDir });
    await exec("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: repoDir });
  } catch (err) {
    if (err instanceof ExecError) {
      throw new GitError(`Failed to update ${repoDir}: ${err.stderr}`);
    }
    throw err;
  }
}

/**
 * Fetch a specific ref and checkout.
 */
export async function fetchRef(repoDir: string, ref: string): Promise<void> {
  try {
    await exec("git", ["fetch", "--force", "--depth=1", "--", "origin", ref], {
      cwd: repoDir,
    });
    await exec("git", ["checkout", "FETCH_HEAD"], { cwd: repoDir });
  } catch (err) {
    if (err instanceof ExecError) {
      throw new GitError(
        `Failed to fetch ref ${ref} in ${repoDir}: ${err.stderr}`,
      );
    }
    throw err;
  }
}

/**
 * Get the current HEAD commit SHA (full 40 chars).
 */
export async function headCommit(repoDir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
  return stdout.trim();
}

/**
 * Get the committer date of HEAD as a Date.
 * Uses committer date (not author date) to reflect when the commit landed on the branch,
 * which aligns with "release age" semantics (survives cherry-picks and merges).
 */
export async function headCommitDate(repoDir: string): Promise<Date> {
  const { stdout } = await exec("git", ["log", "-1", "--format=%cI", "HEAD"], { cwd: repoDir });
  return new Date(stdout.trim());
}

/**
 * Find the newest commit on the current branch whose committer date is at least
 * `minAgeMinutes` minutes old. Unshallows the repo to search full history.
 *
 * Returns the SHA, or `null` if no qualifying commit exists (repo is younger
 * than the threshold).
 */
export async function findCommitOlderThan(
  repoDir: string,
  minAgeMinutes: number,
): Promise<string | null> {
  const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000);
  const iso = cutoff.toISOString();

  // Unshallow to get full history — needed to find commits older than the cutoff.
  // Only called when HEAD is too new, so the extra fetch is acceptable.
  try {
    await exec("git", ["fetch", "--force", "--unshallow", "--", "origin"], { cwd: repoDir });
  } catch (err) {
    if (!(err instanceof ExecError)) {throw err;}
    // --unshallow fails on a complete (non-shallow) repository — that's fine
    if (!/unshallow on a complete repository/i.test(err.stderr)) {
      throw new GitError(`Failed to fetch history for age gate: ${err.stderr}`);
    }
  }

  // Find the newest commit at or before the cutoff.
  // Use HEAD (not FETCH_HEAD) — after the prior fetchAndReset, HEAD is at the
  // latest commit and --unshallow made full history available behind it.
  const { stdout } = await exec(
    "git",
    ["log", "--format=%H", "--before", iso, "-1", "HEAD"],
    { cwd: repoDir },
  );
  const sha = stdout.trim();
  return sha || null;
}

/**
 * Checkout a local ref (commit, branch, tag). No fetch — the ref must already exist locally.
 */
export async function checkout(repoDir: string, ref: string): Promise<void> {
  try {
    await exec("git", ["checkout", ref], { cwd: repoDir });
  } catch (err) {
    if (err instanceof ExecError) {
      throw new GitError(`Failed to checkout ${ref} in ${repoDir}: ${err.stderr}`);
    }
    throw err;
  }
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return existsSync(`${dir}/.git`);
}
