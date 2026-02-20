import { exec, ExecError } from "../utils/exec.js";
import { existsSync } from "node:fs";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Clone a repo with --depth=1 into the given directory.
 * If ref is provided, clones that specific ref.
 */
export async function clone(
  url: string,
  dest: string,
  ref?: string,
): Promise<void> {
  const args = ["clone", "--depth=1"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push("--", url, dest);

  try {
    await exec("git", args);
  } catch (err) {
    if (err instanceof ExecError) {
      const stderr = err.stderr;
      if (
        url.startsWith("https://github.com/") &&
        (/terminal prompts disabled/i.test(stderr) ||
          /could not read Username/i.test(stderr))
      ) {
        // Convert https://github.com/org/repo[.git][/] → git@github.com:org/repo.git
        let path = url.slice("https://github.com/".length);
        while (path.endsWith("/")) path = path.slice(0, -1);
        const sshUrl = "git@github.com:" + (path.endsWith(".git") ? path : path + ".git");
        throw new GitError(
          `Failed to clone ${url}: authentication required.\n` +
            `Hint: for private repos, use the SSH URL instead:\n` +
            `  dotagents add ${sshUrl}`,
        );
      }
      throw new GitError(`Failed to clone ${url}: ${stderr}`);
    }
    throw err;
  }
}

/**
 * Fetch latest and reset to origin's HEAD. For updating unpinned repos.
 */
export async function fetchAndReset(repoDir: string): Promise<void> {
  try {
    await exec("git", ["fetch", "--depth=1", "--", "origin"], { cwd: repoDir });
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
    await exec("git", ["fetch", "--depth=1", "--", "origin", ref], { cwd: repoDir });
    await exec("git", ["checkout", "FETCH_HEAD"], { cwd: repoDir });
  } catch (err) {
    if (err instanceof ExecError) {
      throw new GitError(`Failed to fetch ref ${ref} in ${repoDir}: ${err.stderr}`);
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
 * Check if a directory is a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return existsSync(`${dir}/.git`);
}
