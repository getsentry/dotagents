import { symlink, readlink, unlink, mkdir, lstat, readdir, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { exec } from "@sentry/dotagents-lib";

export class SymlinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkError";
  }
}

/**
 * Ensure <targetDir>/skills/ is a symlink pointing to <agentsDir>/skills/.
 * Creates the parent directory if it doesn't exist.
 */
export async function ensureSkillsSymlink(
  agentsDir: string,
  targetDir: string,
): Promise<{ created: boolean; migrated: string[] }> {
  const skillsSource = join(agentsDir, "skills");
  const skillsLink = join(targetDir, "skills");
  const relativeTarget = relative(targetDir, skillsSource);

  // Ensure parent directory exists
  await mkdir(targetDir, { recursive: true });

  // Check if skills path already exists
  let stat;
  try {
    stat = await lstat(skillsLink);
  } catch {
    // Doesn't exist, create symlink
    await symlink(relativeTarget, skillsLink);
    return { created: true, migrated: [] };
  }

  // Already a symlink - check if it points to the right place
  if (stat.isSymbolicLink()) {
    const currentTarget = await readlink(skillsLink);
    if (currentTarget === relativeTarget) {
      return { created: false, migrated: [] };
    }
    // Wrong target, replace
    await unlink(skillsLink);
    await symlink(relativeTarget, skillsLink);
    return { created: true, migrated: [] };
  }

  // Real directory - migrate contents then replace with symlink
  if (stat.isDirectory()) {
    const migrated = await migrateDirectory(skillsLink, skillsSource);
    // migrateDirectory *moves* every entry it can, so whatever is still here
    // is what it had to skip: a name already taken under skillsSource. The
    // recursive rm below would delete it, silently destroying a skill the user
    // never agreed to lose — stop and let them resolve the collision instead.
    const conflicts = await readdir(skillsLink);
    if (conflicts.length > 0) {
      throw new SymlinkError(
        `Cannot replace ${skillsLink} with a symlink — these already exist in ` +
          `${skillsSource}: ${conflicts.join(", ")}. Remove or rename them, ` +
          `then run install again.`,
      );
    }
    await removeFromGitIndex(targetDir, "skills");
    await rm(skillsLink, { recursive: true });
    await symlink(relativeTarget, skillsLink);
    return { created: true, migrated };
  }

  throw new SymlinkError(
    `${skillsLink} exists but is not a directory or symlink`,
  );
}

async function migrateDirectory(
  from: string,
  to: string,
): Promise<string[]> {
  const entries = await readdir(from, { withFileTypes: true });
  const migrated: string[] = [];

  for (const entry of entries) {
    const srcPath = join(from, entry.name);
    const destPath = join(to, entry.name);

    // Skip if destination already exists
    try {
      await lstat(destPath);
      continue;
    } catch {
      // Doesn't exist, proceed with migration
    }

    await rename(srcPath, destPath);
    migrated.push(entry.name);
  }

  return migrated;
}

/**
 * Best-effort removal of tracked files from git's index.
 * Prevents "beyond a symbolic link" errors when a tracked directory
 * is replaced by a symlink.
 */
async function removeFromGitIndex(cwd: string, path: string): Promise<void> {
  try {
    await exec("git", ["rm", "-r", "--cached", "--ignore-unmatch", path], {
      cwd,
    });
  } catch {
    // Silently ignore: not a git repo, git not installed, etc.
  }
}

/**
 * Verify all configured symlinks are correct.
 * Returns a list of issues found.
 */
export async function verifySymlinks(
  agentsDir: string,
  targets: string[],
): Promise<{ target: string; issue: string }[]> {
  const issues: { target: string; issue: string }[] = [];
  const skillsSource = join(agentsDir, "skills");

  for (const target of targets) {
    const skillsLink = join(target, "skills");
    const relativeTarget = relative(target, skillsSource);

    try {
      const stat = await lstat(skillsLink);
      if (!stat.isSymbolicLink()) {
        issues.push({ target, issue: `${skillsLink} is not a symlink` });
        continue;
      }
      const currentTarget = await readlink(skillsLink);
      if (currentTarget !== relativeTarget) {
        issues.push({
          target,
          issue: `${skillsLink} points to ${currentTarget}, expected ${relativeTarget}`,
        });
      }
    } catch {
      issues.push({ target, issue: `${skillsLink} does not exist` });
    }
  }

  return issues;
}
