import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import type { WildcardSkillDependency } from "../../config/schema.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { isGitLocked } from "../../lockfile/schema.js";
import { resolveSkill, resolveWildcardSkills } from "../../skills/resolver.js";
import { validateTrustedSource, TrustError } from "../../trust/index.js";
import { hashDirectory } from "../../utils/hash.js";
import { copyDir } from "../../utils/fs.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import type { Lockfile, LockedSkill } from "../../lockfile/schema.js";
import { resolveScope, resolveDefaultScope, ScopeError } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

/** A skill whose source points to its own install location (adopted orphan). */
function isInPlaceSkill(source: string): boolean {
  return source.startsWith("path:.agents/skills/") || source.startsWith("path:skills/");
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateOptions {
  scope: ScopeRoot;
  skillName?: string;
}

export interface UpdatedSkill {
  name: string;
  oldCommit: string;
  newCommit: string;
}

export interface UpdateResult {
  updated: UpdatedSkill[];
  removed: string[];
}

export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const { scope, skillName } = opts;
  const { configPath, lockPath, agentsDir, skillsDir } = scope;

  const config = await loadConfig(configPath);
  const lockfile = await loadLockfile(lockPath);

  if (!lockfile) {
    throw new UpdateError("No agents.lock found. Run 'dotagents install' first.");
  }

  const regularDeps = config.skills.filter((d) => !isWildcardDep(d));
  const wildcardDeps = config.skills.filter(isWildcardDep);
  const explicitNames = new Set(regularDeps.map((d) => d.name));

  const updated: UpdatedSkill[] = [];
  const removed: string[] = [];
  const newLock: Lockfile = { version: 1, skills: { ...lockfile.skills } };

  if (skillName) {
    const dep = regularDeps.find((s) => s.name === skillName);
    if (dep) {
      const result = await updateRegularSkill(skillName, dep, lockfile, newLock, scope, config.trust);
      if (result) updated.push(result);
    } else {
      // Check if it's from a wildcard source (via lockfile)
      const locked = lockfile.skills[skillName];
      if (!locked) {
        throw new UpdateError(`Skill "${skillName}" not found in agents.toml or lockfile.`);
      }
      const wDep = wildcardDeps.find((w) => w.source === locked.source);
      if (!wDep) {
        throw new UpdateError(`Skill "${skillName}" not found in agents.toml.`);
      }
      const results = await updateWildcardSource(wDep, explicitNames, lockfile, newLock, scope, skillsDir, config.trust);
      updated.push(...results.updated);
      removed.push(...results.removed);
    }
  } else {
    for (const dep of regularDeps) {
      const result = await updateRegularSkill(dep.name, dep, lockfile, newLock, scope, config.trust);
      if (result) updated.push(result);
    }

    for (const wDep of wildcardDeps) {
      const results = await updateWildcardSource(wDep, explicitNames, lockfile, newLock, scope, skillsDir, config.trust);
      updated.push(...results.updated);
      removed.push(...results.removed);
    }
  }

  // Write updated lockfile
  if (updated.length > 0 || removed.length > 0) {
    await writeLockfile(lockPath, newLock);

    // Regenerate gitignore (skip for user scope)
    if (scope.scope === "project") {
      const allNames = Object.keys(newLock.skills);
      const managedNames = allNames.filter((name) => {
        const dep = regularDeps.find((s) => s.name === name);
        if (!dep) return true; // wildcard-sourced skills are always managed
        return !isInPlaceSkill(dep.source);
      });
      await updateAgentsGitignore(agentsDir, config.gitignore, managedNames);
    }
  }

  return { updated, removed };
}

async function updateRegularSkill(
  name: string,
  dep: { source: string; ref?: string },
  lockfile: Lockfile,
  newLock: Lockfile,
  scope: ScopeRoot,
  trust?: Parameters<typeof validateTrustedSource>[1],
): Promise<UpdatedSkill | null> {
  const locked = lockfile.skills[name];
  if (!locked) return null;
  if (!isGitLocked(locked)) return null;

  validateTrustedSource(dep.source, trust);

  if (dep.ref && /^[a-f0-9]{40}$/.test(dep.ref)) return null;

  const resolved = await resolveSkill(name, dep, { projectRoot: scope.root });
  if (resolved.type !== "git") return null;

  const oldCommit = locked.commit;
  const newCommit = resolved.commit;
  if (oldCommit === newCommit) return null;

  const destDir = join(scope.skillsDir, name);
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
  return {
    name,
    oldCommit: oldCommit.slice(0, 8),
    newCommit: newCommit.slice(0, 8),
  };
}

async function updateWildcardSource(
  wDep: WildcardSkillDependency,
  explicitNames: Set<string>,
  lockfile: Lockfile,
  newLock: Lockfile,
  scope: ScopeRoot,
  skillsDir: string,
  trust?: Parameters<typeof validateTrustedSource>[1],
): Promise<{ updated: UpdatedSkill[]; removed: string[] }> {
  validateTrustedSource(wDep.source, trust);

  if (wDep.ref && /^[a-f0-9]{40}$/.test(wDep.ref)) return { updated: [], removed: [] };

  // Re-discover all skills fresh
  const named = await resolveWildcardSkills(wDep, { projectRoot: scope.root });
  const discoveredNames = new Set(named.map((n) => n.name));
  const excludeSet = new Set(wDep.exclude);
  const updated: UpdatedSkill[] = [];

  // Find lockfile entries that belong to this wildcard source
  const lockedFromSource = Object.entries(lockfile.skills).filter(
    ([name, locked]) => locked.source === wDep.source && !explicitNames.has(name),
  );

  // Process discovered skills (new + changed)
  for (const { name, resolved } of named) {
    if (explicitNames.has(name)) continue;
    if (resolved.type !== "git") continue;

    const locked = lockfile.skills[name];
    const oldCommit = locked && isGitLocked(locked) ? locked.commit : undefined;
    const newCommit = resolved.commit;

    if (oldCommit && oldCommit === newCommit) continue;

    const destDir = join(skillsDir, name);
    await copyDir(resolved.skillDir, destDir);
    const integrity = await hashDirectory(destDir);

    const lockEntry: LockedSkill = {
      source: wDep.source,
      resolved_url: resolved.resolvedUrl,
      resolved_path: resolved.resolvedPath,
      ...(resolved.resolvedRef ? { resolved_ref: resolved.resolvedRef } : {}),
      commit: newCommit,
      integrity,
    };

    newLock.skills[name] = lockEntry;
    if (oldCommit) {
      updated.push({
        name,
        oldCommit: oldCommit.slice(0, 8),
        newCommit: newCommit.slice(0, 8),
      });
    } else {
      // New skill — treat as update from "new"
      updated.push({
        name,
        oldCommit: "(new)",
        newCommit: newCommit.slice(0, 8),
      });
    }
  }

  // Remove skills no longer discovered (removed from upstream)
  const removed: string[] = [];
  for (const [name] of lockedFromSource) {
    if (!discoveredNames.has(name) && !excludeSet.has(name)) {
      delete newLock.skills[name];
      await rm(join(skillsDir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }

  return { updated, removed };
}

export default async function update(args: string[], flags?: { user?: boolean }): Promise<void> {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
  });

  try {
    const scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    const result = await runUpdate({
      scope,
      skillName: positionals[0],
    });

    if (result.updated.length === 0 && result.removed.length === 0) {
      console.log(chalk.dim("All skills are up to date."));
      return;
    }

    for (const u of result.updated) {
      console.log(
        chalk.green(`  ${u.name}: ${chalk.dim(u.oldCommit)} → ${u.newCommit}`),
      );
    }
    for (const name of result.removed) {
      console.log(chalk.yellow(`  ${name}: removed (no longer upstream)`));
    }
    if (result.updated.length > 0) {
      console.log(chalk.green(`Updated ${result.updated.length} skill(s).`));
    }
  } catch (err) {
    if (err instanceof ScopeError || err instanceof UpdateError || err instanceof TrustError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
