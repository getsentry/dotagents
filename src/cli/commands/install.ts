import { join, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import {
  isWildcardDep,
  type RepositorySource,
  type SkillDependency,
} from "../../config/schema.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { type Lockfile, type LockedSkill } from "../../lockfile/schema.js";
import {
  applyDefaultRepositorySource,
  resolveSkill,
  resolveWildcardSkills,
  sourcesMatch,
  type ResolvedSkill,
} from "../../skills/resolver.js";
import { validateTrustedSource, TrustError } from "../../trust/index.js";
import { copyDir } from "../../utils/fs.js";
import { writeAgentsGitignore, checkRootGitignoreEntries } from "../../gitignore/writer.js";
import { ensureSkillsSymlink } from "../../symlinks/manager.js";
import { getAgent } from "../../agents/registry.js";
import { writeMcpConfigs, toMcpDeclarations, projectMcpResolver } from "../../agents/mcp-writer.js";
import { writeHookConfigs, toHookDeclarations, projectHookResolver } from "../../agents/hook-writer.js";
import { userMcpResolver } from "../../agents/paths.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";

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
  pruned: string[];
  hookWarnings: { agent: string; message: string }[];
}

/** Expanded skill ready for install — either from an explicit entry or a wildcard */
interface ExpandedSkill {
  name: string;
  dep: SkillDependency;
  resolved?: ResolvedSkill;
}

/**
 * Expand config skills into a flat list, resolving wildcards.
 * Explicit entries always win over wildcard-discovered skills.
 */
async function expandSkills(
  config: {
    skills: SkillDependency[];
    trust?: Parameters<typeof validateTrustedSource>[1];
    defaultRepositorySource: RepositorySource;
  },
  lockfile: Lockfile | null,
  opts: { frozen?: boolean; force?: boolean; projectRoot: string; minimumReleaseAge?: number; updateExclude?: string[] },
): Promise<ExpandedSkill[]> {
  const regularDeps = config.skills.filter((d) => !isWildcardDep(d));
  const wildcardDeps = config.skills.filter(isWildcardDep);
  const explicitNames = new Set(regularDeps.map((d) => d.name));

  const expanded: ExpandedSkill[] = [];

  // Add regular deps
  for (const dep of regularDeps) {
    expanded.push({ name: dep.name, dep });
  }

  // Expand wildcards
  const wildcardNames = new Map<string, string>(); // name → source (for conflict detection)
  for (const wDep of wildcardDeps) {
    const wildcardSourceForTrust = applyDefaultRepositorySource(
      wDep.source,
      config.defaultRepositorySource,
    );
    validateTrustedSource(wildcardSourceForTrust, config.trust);
    const excludeSet = new Set(wDep.exclude);

    if (opts.frozen) {
      // In frozen mode, expand from lockfile — no network needed
      if (!lockfile) {continue;}
      for (const [name, locked] of Object.entries(lockfile.skills)) {
        if (!sourcesMatch(locked.source, wDep.source)) {continue;}
        if (explicitNames.has(name)) {continue;}
        if (excludeSet.has(name)) {continue;}

        expanded.push({ name, dep: wDep });
      }
    } else {
      const named = await resolveWildcardSkills(wDep, {
        projectRoot: opts.projectRoot,
        ...(opts.force ? { ttlMs: 0 } : {}),
        defaultRepositorySource: config.defaultRepositorySource,
        minimumReleaseAge: opts.minimumReleaseAge,
        updateExclude: opts.updateExclude,
      });
      for (const { name, resolved } of named) {
        if (explicitNames.has(name)) {continue;} // explicit wins

        // Check for conflicts between different wildcards
        const existingSource = wildcardNames.get(name);
        if (existingSource && !sourcesMatch(existingSource, wDep.source)) {
          throw new InstallError(
            `Skill "${name}" found in both wildcard sources: "${existingSource}" and "${wDep.source}". ` +
              `Use an explicit [[skills]] entry or add it to one source's exclude list.`,
          );
        }
        wildcardNames.set(name, wDep.source);

        expanded.push({ name, dep: wDep, resolved });
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
  const pruned: string[] = [];

  // Ensure skills/ exists (needed for symlinks even without skills)
  await mkdir(skillsDir, { recursive: true });

  // 2. Resolve and install skills (if any declared)
  if (config.skills.length > 0) {
    const lockfile = await loadLockfile(lockPath);

    if (frozen && !lockfile) {
      throw new InstallError("--frozen requires agents.lock to exist.");
    }

    const minimumReleaseAge = config.update?.minimum_release_age;
    const updateExclude = config.update?.exclude;
    const expanded = await expandSkills(
      {
        skills: config.skills,
        trust: config.trust,
        defaultRepositorySource: config.defaultRepositorySource,
      },
      lockfile,
      { frozen, force, projectRoot: scope.root, minimumReleaseAge, updateExclude },
    );

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
      const { name, dep } = item;

      // Validate trust before any network work
      const sourceForTrust = applyDefaultRepositorySource(
        dep.source,
        config.defaultRepositorySource,
      );
      validateTrustedSource(sourceForTrust, config.trust);

      const resolveOpts = {
        projectRoot: scope.root,
        ...(force ? { ttlMs: 0 } : {}),
        defaultRepositorySource: config.defaultRepositorySource,
        minimumReleaseAge,
        updateExclude,
      };

      let resolved: ResolvedSkill;
      if (item.resolved) {
        resolved = item.resolved;
      } else {
        try {
          resolved = await resolveSkill(name, dep, resolveOpts);
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

      let lockEntry: LockedSkill;
      if (resolved.type === "git") {
        lockEntry = {
          source: dep.source,
          resolved_url: resolved.resolvedUrl,
          resolved_path: resolved.resolvedPath,
          ...(resolved.resolvedRef ? { resolved_ref: resolved.resolvedRef } : {}),
          resolved_commit: resolved.commit,
        };
      } else if (resolved.type === "well-known") {
        lockEntry = {
          source: dep.source,
          resolved_url: resolved.resolvedUrl,
        };
      } else {
        lockEntry = { source: dep.source };
      }

      newLock.skills[name] = lockEntry;
      installed.push(name);
    }

    // Prune stale wildcard-sourced skills (skip in frozen mode to avoid disk/lockfile inconsistency)
    if (!frozen && lockfile) {
      const wildcardDeps = config.skills.filter(isWildcardDep);
      for (const [name, locked] of Object.entries(lockfile.skills)) {
        if (newLock.skills[name]) {continue;} // still tracked
        const fromWildcard = wildcardDeps.some((w) =>
          sourcesMatch(locked.source, w.source),
        );
        if (fromWildcard) {
          await rm(join(skillsDir, name), { recursive: true, force: true });
          pruned.push(name);
        }
      }
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
      if (!dep || isWildcardDep(dep)) {return true;}
      return !isInPlaceSkill(dep.source);
    });
    await writeAgentsGitignore(agentsDir, managedNames);

    // Health check: warn if agents.lock and .agents/.gitignore are not in root .gitignore
    const missing = await checkRootGitignoreEntries(scope.root);
    if (missing.length > 0) {
      console.log(chalk.yellow(`Warning: ${missing.join(", ")} should be in .gitignore. Run 'npx @sentry/dotagents doctor --fix' to fix.`));
    }
  }

  // 4. Symlinks — create per-agent symlinks so each agent discovers skills
  if (scope.scope === "user") {
    const seen = new Set<string>();
    for (const agentId of config.agents) {
      const agent = getAgent(agentId);
      if (!agent?.userSkillsParentDirs) {continue;}
      for (const dir of agent.userSkillsParentDirs) {
        if (seen.has(dir)) {continue;}
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
      if (!agent?.skillsParentDir) {continue;}
      if (seenParentDirs.has(agent.skillsParentDir)) {continue;}
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

  return { installed, skipped, pruned, hookWarnings };
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
    await ensureUserScopeBootstrapped(scope);
    if (values["frozen"]) {
      console.log(chalk.yellow("Warning: --frozen is deprecated and will be removed in a future release. Pinning is now managed via agents.toml refs."));
    }

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
    if (result.pruned.length > 0) {
      console.log(
        chalk.yellow(`Pruned ${result.pruned.length} stale skill(s): ${result.pruned.join(", ")}`),
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
