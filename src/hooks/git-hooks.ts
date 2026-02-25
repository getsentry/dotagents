import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOOK_CONTENT = `#!/bin/sh
# Installed by dotagents. Modify this to match your project setup.
# Failures are non-fatal — a broken hook should never block pulls.
npx @sentry/dotagents install 2>&1 || echo "warning: dotagents install failed (post-merge hook). Run it manually."
`;

/**
 * Resolve the .git directory for a project root.
 * Handles both normal repos (.git is a directory) and worktrees (.git is a file with gitdir: line).
 * Returns null if no .git entry exists.
 */
export function findGitDir(projectRoot: string): string | null {
  const dotGit = join(projectRoot, ".git");

  if (!existsSync(dotGit)) return null;

  if (statSync(dotGit).isDirectory()) return dotGit;

  // Worktree: .git is a file containing "gitdir: <path>"
  const content = readFileSync(dotGit, "utf-8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) return null;

  return resolve(projectRoot, match[1]!);
}

/**
 * Create a post-merge git hook that runs `dotagents install`.
 * Skips if the hook already exists and contains "dotagents".
 * Returns true if the hook was created.
 */
export async function bootstrapPostMergeHook(projectRoot: string): Promise<boolean> {
  const gitDir = findGitDir(projectRoot);
  if (!gitDir) return false;

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "post-merge");

  if (existsSync(hookPath)) {
    const content = await readFile(hookPath, "utf-8");
    if (content.includes("dotagents")) return false;
  }

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookPath, HOOK_CONTENT, { mode: 0o755 });
  return true;
}
