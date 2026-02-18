import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import type { SkillDependency } from "../../config/schema.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { isGitLocked } from "../../lockfile/schema.js";
import type { Lockfile, LockedSkill } from "../../lockfile/schema.js";
import { resolveSkill, resolveWildcardSkills } from "../../skills/resolver.js";
import { validateTrustedSource, TrustError } from "../../trust/index.js";
import type { ResolvedSkill } from "../../skills/resolver.js";
import { hashDirectory } from "../../utils/hash.js";
import { copyDir } from "../../utils/fs.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { ensureSkillsSymlink } from "../../symlinks/manager.js";
import { getAgent } from "../../agents/registry.js";
import { writeMcpConfigs, toMcpDeclarations, projectMcpResolver } from "../../agents/mcp-writer.js";
import { writeHookConfigs, toHookDeclarations, projectHookResolver } from "../../agents/hook-writer.js";
import { userMcpResolver } from "../../agents/paths.js";
import { resolveScope, resolveDefaultScope, ScopeError } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

/** A skill whose source points to its own install location (adopted orphan). */
function isInPlaceSkill(source: string): boolean {
  return source.startsWith("path:.agents/skills/") || source.startsWith("path:skills/");
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

export interface InstallOptions {
  scope: ScopeRoot;
  frozen?: boolean;
  force?: boolean;
}

export interface InstallResult {
  installed: string[];
  skipped: string[];
  hookWarnings: { agent: string; message: string }[];
}

/** Expanded skill ready for install — either from an explicit entry or a wildcard */
interface ExpandedSkill {
  name: string;
  dep: SkillDependency;
  lockedCommit?: string;
  resolved?: ResolvedSkill;
}

/**
 * Expand config skills into a flat list, resolving wildcards.
 * Explicit entries always win over wildcard-discovered skills.
 */
async function expandSkills(
  config: { skills: SkillDependency[]; trust?: Parameters<typeof validateTrustedSource>[1] },
  lockfile: Lockfile | null,
  opts: { frozen?: boolean; force?: boolean; projectRoot: string },
): Promise<ExpandedSkill[]> {
  const regularDeps = config.skills.filter((d) => !isWildcardDep(d));
  const wildcardDeps = config.skills.filter(isWildcardDep);
  const explicitNames = new Set(regularDeps.map((d) => d.name));

  const expanded: ExpandedSkill[] = [];

  // Add regular deps
  for (const dep of regularDeps) {
    const locked = lockfile?.skills[dep.name];
    const lockedCommit =
      !opts.force && locked && isGitLocked(locked) ? locked.commit : undefined;
    expanded.push({ name: dep.name, dep, lockedCommit });
  }

  // Expand wildcards
  const wildcardNames = new Map<string, string>(); // name → source (for conflict detection)
  for (const wDep of wildcardDeps) {
    validateTrustedSource(wDep.source, config.trust);
    const excludeSet = new Set(wDep.exclude);

    if (opts.frozen) {
      // In frozen mode, expand from lockfile — no network needed
      if (!lockfile) continue;
      for (const [name, locked] of Object.entries(lockfile.skills)) {
        if (locked.source !== wDep.source) continue;
        if (explicitNames.has(name)) continue;
        if (excludeSet.has(name)) continue;

        const lockedCommit = isGitLocked(locked) ? locked.commit : undefined;
        expanded.push({ name, dep: wDep, lockedCommit });
      }
    } else {
      // resolveWildcardSkills already filters by exclude list
      const named = await resolveWildcardSkills(wDep, { projectRoot: opts.projectRoot });
      for (const { name, resolved } of named) {
        if (explicitNames.has(name)) continue; // explicit wins

        // Check for conflicts between different wildcards
        const existingSource = wildcardNames.get(name);
        if (existingSource && existingSource !== wDep.source) {
          throw new InstallError(
            `Skill "${name}" found in both wildcard sources: "${existingSource}" and "${wDep.source}". ` +
              `Use an explicit [[skills]] entry or add it to one source's exclude list.`,
          );
        }
        wildcardNames.set(name, wDep.source);

        const locked = lockfile?.skills[name];
        const lockedCommit =
          !opts.force && locked && isGitLocked(locked) ? locked.commit : undefined;
        expanded.push({ name, dep: wDep, lockedCommit, resolved });
      }
    }
  }

  return expanded;
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const { scope, frozen, force } = opts;
  const { configPath, lockPath, agentsDir, skillsDir } = scope;

  // 1. Read config
  const config = await loadConfig(configPath);
  const installed: string[] = [];
  const skipped: string[] = [];

  // Ensure skills/ exists (needed for symlinks even without skills)
  await mkdir(skillsDir, { recursive: true });

  // 2. Resolve and install skills (if any declared)
  if (config.skills.length > 0) {
    const lockfile = await loadLockfile(lockPath);

    if (frozen && !lockfile) {
      throw new InstallError("--frozen requires agents.lock to exist.");
    }

    const expanded = await expandSkills(config, lockfile, {
      frozen,
      force,
      projectRoot: scope.root,
    });

    if (frozen) {
      for (const { name } of expanded) {
        if (!lockfile!.skills[name]) {
          throw new InstallError(
            `--frozen: skill "${name}" is in agents.toml but missing from agents.lock.`,
          );
        }
      }
    }

    const newLock: Lockfile = { version: 1, skills: {} };

    for (const item of expanded) {
      const { name, dep, lockedCommit } = item;

      // Validate trust before any network work
      validateTrustedSource(dep.source, config.trust);

      const locked = lockfile?.skills[name];

      let resolved: ResolvedSkill;
      if (item.resolved) {
        // Already resolved during wildcard expansion (use locked commit if available and unchanged)
        if (lockedCommit && item.resolved.type === "git" && item.resolved.commit !== lockedCommit) {
          // Re-resolve with locked commit for cache hit
          resolved = await resolveSkill(name, dep, {
            projectRoot: scope.root,
            lockedCommit,
          });
        } else {
          resolved = item.resolved;
        }
      } else {
        try {
          resolved = await resolveSkill(name, dep, {
            projectRoot: scope.root,
            lockedCommit,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new InstallError(`Failed to resolve skill "${name}": ${msg}`);
        }
      }

      const destDir = join(skillsDir, name);

      // Skip copy when source resolves to the install destination (in-place skills)
      if (resolve(resolved.skillDir) !== resolve(destDir)) {
        await copyDir(resolved.skillDir, destDir);
      }

      const integrity = await hashDirectory(destDir);

      if (frozen && locked) {
        if (locked.integrity !== integrity) {
          throw new InstallError(
            `--frozen: integrity mismatch for "${name}". ` +
              `Expected ${locked.integrity}, got ${integrity}.`,
          );
        }
      }

      const lockEntry: LockedSkill =
        resolved.type === "git"
          ? {
              source: dep.source,
              resolved_url: resolved.resolvedUrl,
              resolved_path: resolved.resolvedPath,
              ...(resolved.resolvedRef ? { resolved_ref: resolved.resolvedRef } : {}),
              commit: resolved.commit,
              integrity,
            }
          : {
              source: dep.source,
              integrity,
            };

      newLock.skills[name] = lockEntry;
      installed.push(name);
    }

    if (!frozen) {
      await writeLockfile(lockPath, newLock);
    }
  }

  // 3. Gitignore (skip for user scope — ~/.agents/ is not a git repo)
  if (scope.scope === "project") {
    // For wildcard entries all expanded skills are managed (wildcards can't be in-place)
    const managedNames = installed.filter((name) => {
      const dep = config.skills.find((s) => s.name === name);
      // Wildcard-sourced skills are always managed
      if (!dep || isWildcardDep(dep)) return true;
      return !isInPlaceSkill(dep.source);
    });
    await updateAgentsGitignore(agentsDir, config.gitignore, managedNames);
  }

  // 4. Symlinks — create per-agent symlinks so each agent discovers skills
  if (scope.scope === "user") {
    const seen = new Set<string>();
    for (const agentId of config.agents) {
      const agent = getAgent(agentId);
      if (!agent?.userSkillsParentDirs) continue;
      for (const dir of agent.userSkillsParentDirs) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        await ensureSkillsSymlink(agentsDir, dir);
      }
    }
  } else {
    const targets = config.symlinks?.targets ?? [];
    for (const target of targets) {
      await ensureSkillsSymlink(agentsDir, join(scope.root, target));
    }

    const seenParentDirs = new Set(targets);
    for (const agentId of config.agents) {
      const agent = getAgent(agentId);
      if (!agent?.skillsParentDir) continue;
      if (seenParentDirs.has(agent.skillsParentDir)) continue;
      seenParentDirs.add(agent.skillsParentDir);
      await ensureSkillsSymlink(agentsDir, join(scope.root, agent.skillsParentDir));
    }
  }

  // 5. Write MCP config files
  const mcpResolver = scope.scope === "user" ? userMcpResolver() : projectMcpResolver(scope.root);
  await writeMcpConfigs(config.agents, toMcpDeclarations(config.mcp), mcpResolver);

  // 6. Write hook config files (skip for user scope)
  let hookWarnings: { agent: string; message: string }[] = [];
  if (scope.scope === "project") {
    hookWarnings = await writeHookConfigs(
      config.agents,
      toHookDeclarations(config.hooks),
      projectHookResolver(scope.root),
    );
  }

  return { installed, skipped, hookWarnings };
}

export default async function install(args: string[], flags?: { user?: boolean }): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      frozen: { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: true,
  });

  try {
    const scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    const result = await runInstall({
      scope,
      frozen: values["frozen"],
      force: values["force"],
    });

    if (result.installed.length > 0) {
      console.log(
        chalk.green(`Installed ${result.installed.length} skill(s): ${result.installed.join(", ")}`),
      );
    }
    for (const w of result.hookWarnings) {
      console.log(chalk.yellow(`  warn: ${w.message}`));
    }
  } catch (err) {
    if (err instanceof ScopeError || err instanceof InstallError || err instanceof TrustError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
