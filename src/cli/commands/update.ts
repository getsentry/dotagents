import { join } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { isGitLocked } from "../../lockfile/schema.js";
import { resolveSkill } from "../../skills/resolver.js";
import { validateTrustedSource, TrustError } from "../../trust/index.js";
import { hashDirectory } from "../../utils/hash.js";
import { copyDir } from "../../utils/fs.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import type { Lockfile, LockedSkill } from "../../lockfile/schema.js";

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateOptions {
  projectRoot: string;
  skillName?: string;
}

export interface UpdatedSkill {
  name: string;
  oldCommit: string;
  newCommit: string;
}

export async function runUpdate(opts: UpdateOptions): Promise<UpdatedSkill[]> {
  const { projectRoot, skillName } = opts;
  const configPath = join(projectRoot, "agents.toml");
  const lockPath = join(projectRoot, "agents.lock");
  const agentsDir = join(projectRoot, ".agents");
  const skillsDir = join(agentsDir, "skills");

  const config = await loadConfig(configPath);
  const lockfile = await loadLockfile(lockPath);

  if (!lockfile) {
    throw new UpdateError("No agents.lock found. Run 'dotagents install' first.");
  }

  // Determine which skills to update
  const toUpdate = skillName ? [skillName] : config.skills.map((s) => s.name);
  const updated: UpdatedSkill[] = [];
  const newLock: Lockfile = { version: 1, skills: { ...lockfile.skills } };

  for (const name of toUpdate) {
    const dep = config.skills.find((s) => s.name === name);
    if (!dep) {
      throw new UpdateError(`Skill "${name}" not found in agents.toml.`);
    }

    const locked = lockfile.skills[name];
    if (!locked) {
      // Not in lockfile yet — skip, user should run install
      continue;
    }

    // Skip non-git sources (local paths are always re-copied by install)
    if (!isGitLocked(locked)) continue;

    // Validate trust before any network work
    validateTrustedSource(dep.source, config.trust);

    // Skip pinned commits (SHA refs are immutable)
    if (dep.ref && /^[a-f0-9]{40}$/.test(dep.ref)) continue;

    // Resolve fresh (no locked commit → forces a new fetch)
    const resolved = await resolveSkill(name, dep, { projectRoot });

    if (resolved.type !== "git") continue;

    const oldCommit = locked.commit;
    const newCommit = resolved.commit;

    if (oldCommit === newCommit) continue;

    // Copy updated skill
    const destDir = join(skillsDir, name);
    await copyDir(resolved.skillDir, destDir);
    const integrity = await hashDirectory(destDir);

    const lockEntry: LockedSkill = {
      source: dep.source,
      resolved_url: resolved.resolvedUrl,
      resolved_path: resolved.resolvedPath,
      ...(resolved.resolvedRef ? { resolved_ref: resolved.resolvedRef } : {}),
      commit: newCommit,
      integrity,
    };

    newLock.skills[name] = lockEntry;
    updated.push({
      name,
      oldCommit: oldCommit.slice(0, 8),
      newCommit: newCommit.slice(0, 8),
    });
  }

  // Write updated lockfile
  if (updated.length > 0) {
    await writeLockfile(lockPath, newLock);
    await updateAgentsGitignore(agentsDir, config.gitignore, config.skills.map((s) => s.name));
  }

  return updated;
}

export default async function update(args: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
  });

  const { resolve } = await import("node:path");
  try {
    const updated = await runUpdate({
      projectRoot: resolve("."),
      skillName: positionals[0],
    });

    if (updated.length === 0) {
      console.log(chalk.dim("All skills are up to date."));
      return;
    }

    for (const u of updated) {
      console.log(
        chalk.green(`  ${u.name}: ${chalk.dim(u.oldCommit)} → ${u.newCommit}`),
      );
    }
    console.log(chalk.green(`Updated ${updated.length} skill(s).`));
  } catch (err) {
    if (err instanceof UpdateError || err instanceof TrustError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
