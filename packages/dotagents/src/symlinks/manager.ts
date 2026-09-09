import { symlink, readlink, unlink, mkdir, lstat, readdir, realpath, rename, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { exec } from "@sentry/dotagents-lib";
import { hasErrorCode } from "../utils/type-guards.js";

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

  // Ensure parent directory exists
  await mkdir(targetDir, { recursive: true });

  const [physicalAgentsDir, physicalTargetDir] = await Promise.all([
    realpath(agentsDir),
    realpath(targetDir),
  ]);
  let physicalSkillsSource: string;
  try {
    physicalSkillsSource = await realpath(skillsSource);
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) {throw err;}
    physicalSkillsSource = join(physicalAgentsDir, "skills");
  }
  const physicalSkillsLink = join(physicalTargetDir, "skills");
  // Relative link text is interpreted from the physical parent directory,
  // even when targetDir itself is a symlinked home alias.
  const relativeTarget = relative(physicalTargetDir, physicalSkillsSource);

  // Homes may be aliases or nested inside one another. Detect that from the
  // physical parent directories without following an existing skills link.
  if (physicalSkillsSource === physicalSkillsLink) {
    return { created: false, migrated: [] };
  }
  if (
    isStrictDescendant(physicalSkillsSource, physicalSkillsLink)
    || isStrictDescendant(physicalSkillsLink, physicalSkillsSource)
  ) {
    throw new SymlinkError(
      `Cannot link ${skillsLink} to ${skillsSource} because the paths overlap. Choose non-nested agent home directories.`,
    );
  }

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
    try {
      if (await realpath(skillsLink) === physicalSkillsSource) {
        return { created: false, migrated: [] };
      }
    } catch {
      // Broken or recursive links are replaced below.
    }
    // Wrong target, replace
    await unlink(skillsLink);
    await symlink(relativeTarget, skillsLink);
    return { created: true, migrated: [] };
  }

  // Real directory - migrate contents then replace with symlink
  if (stat.isDirectory()) {
    const migrated = await migrateDirectory(skillsLink, skillsSource);
    await removeFromGitIndex(targetDir, "skills");
    // Fail safely if another process adds a native skill after migration.
    await rmdir(skillsLink);
    await symlink(relativeTarget, skillsLink);
    return { created: true, migrated };
  }

  throw new SymlinkError(
    `${skillsLink} exists but is not a directory or symlink`,
  );
}

function isStrictDescendant(path: string, parent: string): boolean {
  const pathFromParent = relative(parent, path);
  return pathFromParent !== ""
    && pathFromParent !== ".."
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent);
}

async function migrateDirectory(
  from: string,
  to: string,
): Promise<string[]> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  const conflicts: string[] = [];

  for (const entry of entries) {
    try {
      await lstat(join(to, entry.name));
      conflicts.push(entry.name);
    } catch (err) {
      if (!hasErrorCode(err, "ENOENT")) {throw err;}
    }
  }
  if (conflicts.length > 0) {
    throw new SymlinkError(
      `Cannot migrate ${from} because these entries already exist in ${to}: ${conflicts.join(", ")}. Resolve the conflicts before retrying.`,
    );
  }

  const migrated: string[] = [];

  for (const entry of entries) {
    const srcPath = join(from, entry.name);
    const destPath = join(to, entry.name);
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
  let physicalSkillsSource: string;
  try {
    physicalSkillsSource = await realpath(skillsSource);
  } catch {
    return targets.map((target) => ({
      target,
      issue: `${skillsSource} does not resolve`,
    }));
  }

  for (const target of targets) {
    const skillsLink = join(target, "skills");

    try {
      const stat = await lstat(skillsLink);
      if (!stat.isSymbolicLink()) {
        issues.push({ target, issue: `${skillsLink} is not a symlink` });
        continue;
      }
      const currentTarget = await readlink(skillsLink);
      let resolvedTarget: string;
      try {
        resolvedTarget = await realpath(skillsLink);
      } catch {
        issues.push({
          target,
          issue: `${skillsLink} points to ${currentTarget}, which does not resolve`,
        });
        continue;
      }
      if (resolvedTarget !== physicalSkillsSource) {
        issues.push({
          target,
          issue: `${skillsLink} resolves to ${resolvedTarget}, expected ${physicalSkillsSource}`,
        });
      }
    } catch {
      issues.push({ target, issue: `${skillsLink} does not exist` });
    }
  }

  return issues;
}
