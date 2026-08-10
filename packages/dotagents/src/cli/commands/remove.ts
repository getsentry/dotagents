import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import {
  isWildcardDep,
  SKILL_NAME_PATTERN,
  type PluginConfig,
} from "../../config/schema.js";
import {
  addExcludeToWildcard,
  removePluginBlocksBySource,
  removePluginFromConfig,
  removeSkillBlocksBySource,
  removeSkillFromConfig,
} from "../../config/writer.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { filterManagedPluginSkillNames } from "../../gitignore/skills.js";
import { wildcardContainsLockedSkill } from "../../lockfile/wildcard.js";
import { writeAgentsGitignore } from "../../gitignore/writer.js";
import { sourcesMatch, parseOwnerRepoShorthand, isExplicitSourceSpecifier } from "@sentry/dotagents-lib";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";
import { isInPlaceSkill } from "../../utils/fs.js";
import {
  isInPlacePluginSource,
  isManagedPluginInstall,
  isSameProjectPluginConfig,
  loadInstalledPlugins,
  pruneInstalledPlugins,
} from "../../plugins/store.js";
import { projectedPiSkillNames, prunePluginOutputs } from "../../plugins/runtime/writer.js";
import { pluginRuntimeLayout } from "../../plugins/runtime/layout.js";

export class RemoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoveError";
  }
}

export class WildcardSkillRemoveError extends Error {
  source: string;
  constructor(skillName: string, source: string) {
    super(
      `Skill "${skillName}" is provided by wildcard entry for "${source}".`,
    );
    this.name = "WildcardSkillRemoveError";
    this.source = source;
  }
}

export interface RemoveOptions {
  scope: ScopeRoot;
  name: string;
}

export async function runRemove(opts: RemoveOptions): Promise<void> {
  const { scope, name } = opts;
  const { configPath, lockPath, skillsDir } = scope;
  const skillDir = join(skillsDir, name);

  const config = await loadConfig(configPath);
  const lockfile = await loadLockfile(lockPath);

  // Check if skill is an explicit entry
  const explicitDep = config.skills.find((s) => s.name === name);
  const explicitPlugin = config.plugins.find((plugin) => plugin.name === name);
  if (explicitDep && !isWildcardDep(explicitDep) && explicitPlugin) {
    throw new RemoveError(
      `Name "${name}" matches both a skill and a plugin. When their sources differ, remove one by its source to disambiguate.`,
    );
  }
  const locked = lockfile?.skills[name];
  const wildcardDep = locked
    ? config.skills.find((skill) => isWildcardDep(skill) && wildcardContainsLockedSkill(skill, name, locked))
    : undefined;
  if (explicitPlugin && wildcardDep) {
    throw new RemoveError(
      `Name "${name}" matches both a wildcard-provided skill and a plugin. When their sources differ, remove one by its source to disambiguate.`,
    );
  }
  if (explicitDep && !isWildcardDep(explicitDep)) {
    await removeSkillFromConfig(configPath, name);
    await rm(skillDir, { recursive: true, force: true });

    if (lockfile) {
      delete lockfile.skills[name];
    }

    if (lockfile) {
      await writeLockfile(lockPath, lockfile);
    }
    await updateProjectGitignore(scope);
    return;
  }

  if (explicitPlugin) {
    await removePluginFromConfig(configPath, name);
    await removePluginArtifacts(scope, [name], [explicitPlugin], lockfile);
    return;
  }

  // Check if skill is from a wildcard entry (via lockfile source matching)
  if (locked && wildcardDep) {
    throw new WildcardSkillRemoveError(name, locked.source);
  }

  throw new RemoveError(`Skill or plugin "${name}" not found in agents.toml.`);
}

export interface RemoveSourceOptions {
  scope: ScopeRoot;
  source: string;
}

/**
 * Collect all concrete skill names from a source (config + lockfile).
 * Returns sorted, deduplicated names.
 */
export async function collectSkillsFromSource(scope: ScopeRoot, source: string): Promise<string[]> {
  const config = await loadConfig(scope.configPath);
  const lockfile = await loadLockfile(scope.lockPath);

  const names = new Set<string>();

  // From explicit config entries
  for (const dep of config.skills) {
    if (!isWildcardDep(dep) && sourcesMatch(dep.source, source)) {
      names.add(dep.name);
    }
  }

  // From lockfile entries (covers wildcard-expanded skills)
  if (lockfile) {
    for (const [name, locked] of Object.entries(lockfile.skills)) {
      if (sourcesMatch(locked.source, source)) {
        names.add(name);
      }
    }
  }

  if (names.size === 0) {
    throw new RemoveError(`No skills found from source "${source}".`);
  }

  return [...names].toSorted();
}

/** Collect all concrete plugin names from a source (config + lockfile). */
export async function collectPluginsFromSource(scope: ScopeRoot, source: string): Promise<string[]> {
  const config = await loadConfig(scope.configPath);
  const lockfile = await loadLockfile(scope.lockPath);

  const names = new Set<string>();
  for (const plugin of config.plugins) {
    if (sourcesMatch(plugin.source, source)) {
      names.add(plugin.name);
    }
  }
  if (lockfile) {
    for (const [name, locked] of Object.entries(lockfile.plugins)) {
      if (sourcesMatch(locked.source, source)) {
        names.add(name);
      }
    }
  }

  if (names.size === 0) {
    throw new RemoveError(`No plugins found from source "${source}".`);
  }

  return [...names].toSorted();
}

/**
 * Remove all skills from a source. Returns the list of removed skill names.
 */
export async function runRemoveSource(opts: RemoveSourceOptions): Promise<string[]> {
  const { scope, source } = opts;
  const { configPath, lockPath, skillsDir } = scope;

  const skillNames = await collectSkillsFromSource(scope, source);
  const lockfile = await loadLockfile(lockPath);

  // Remove all matching [[skills]] blocks from config
  await removeSkillBlocksBySource(configPath, source);

  // Delete skill dirs and remove from lockfile
  for (const name of skillNames) {
    if (SKILL_NAME_PATTERN.test(name)) {
      await rm(join(skillsDir, name), { recursive: true, force: true });
    }
    if (lockfile) {
      delete lockfile.skills[name];
    }
  }

  if (lockfile) {
    await writeLockfile(lockPath, lockfile);
  }

  await updateProjectGitignore(scope);

  return skillNames;
}

/** Remove all plugins from a source. Returns removed plugin names. */
export async function runRemovePluginSource(opts: RemoveSourceOptions): Promise<string[]> {
  const { scope, source } = opts;
  const pluginNames = await collectPluginsFromSource(scope, source);
  const config = await loadConfig(scope.configPath);
  const removedPlugins = config.plugins.filter((plugin) => pluginNames.includes(plugin.name));
  const lockfile = await loadLockfile(scope.lockPath);

  await removePluginBlocksBySource(scope.configPath, source);
  await removePluginArtifacts(scope, pluginNames, removedPlugins, lockfile);

  return pluginNames;
}

/** Removes managed plugin state after config mutation while preserving in-place plugin sources. */
async function removePluginArtifacts(
  scope: ScopeRoot,
  pluginNames: string[],
  plugins: PluginConfig[],
  lockfile: Awaited<ReturnType<typeof loadLockfile>>,
): Promise<void> {
  const managedPluginNames = new Set<string>();
  const sameProjectPluginNames = new Set(
    plugins
      .filter((plugin) => isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root))
      .map((plugin) => plugin.name),
  );
  for (const plugin of plugins) {
    const name = plugin.name;
    if (sameProjectPluginNames.has(name)) {continue;}
    const pluginDir = join(scope.pluginsDir, name);
    if (await isManagedPluginInstall(pluginDir)) {
      managedPluginNames.add(name);
      continue;
    }
    if (!existsSync(pluginDir)) {continue;}

    if (!isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root)) {
      managedPluginNames.add(name);
    }
  }

  for (const name of pluginNames) {
    if (sameProjectPluginNames.has(name)) {continue;}
    const locked = lockfile?.plugins[name];
    if (locked && !isInPlacePluginSource(locked.source)) {
      managedPluginNames.add(name);
    }
  }
  await pruneInstalledPlugins(scope.pluginsDir, managedPluginNames);

  if (lockfile) {
    for (const name of pluginNames) {
      delete lockfile.plugins[name];
    }
    await writeLockfile(scope.lockPath, lockfile);
  }

  const config = await loadConfig(scope.configPath);
  const remainingPluginConfigs = config.plugins
    .filter((plugin) => !isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root))
    .filter((plugin) => existsSync(join(scope.pluginsDir, plugin.name)));
  const installedPlugins = await loadInstalledPlugins(scope.pluginsDir, remainingPluginConfigs);
  if (installedPlugins.issues.length === 0) {
    await prunePluginOutputs(
      config.agents,
      installedPlugins.plugins,
      pluginRuntimeLayout(scope),
    );
  } else {
    console.log(chalk.yellow(
      `Warning: Plugin runtime cleanup was skipped because these remaining plugins could not be loaded: ${installedPlugins.issues.map((issue) => issue.name).join(", ")}.`,
    ));
  }

  await updateProjectGitignore(scope);
}

async function updateProjectGitignore(scope: ScopeRoot): Promise<void> {
  if (scope.scope !== "project") {return;}
  const config = await loadConfig(scope.configPath);
  const lockfile = await loadLockfile(scope.lockPath);
  const allNames = lockfile ? Object.keys(lockfile.skills) : [];
  const managedNames = allNames.filter((name) => {
    const dep = config.skills.find((s) => s.name === name);
    if (!dep || isWildcardDep(dep)) {return true;}
    return !isInPlaceSkill(dep.source);
  });
  const managedSubagentNames = new Set(config.subagents.map((subagent) => subagent.name));
  if (lockfile) {
    for (const name of Object.keys(lockfile.subagents)) {
      managedSubagentNames.add(name);
    }
  }
  const managedPluginNames = new Set(
    config.plugins
      .filter((plugin) => !isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root))
      .map((plugin) => plugin.name),
  );
  const sameProjectPluginNames = new Set(
    config.plugins
      .filter((plugin) => isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root))
      .map((plugin) => plugin.name),
  );
  if (lockfile) {
    for (const [name, locked] of Object.entries(lockfile.plugins)) {
      if (sameProjectPluginNames.has(name)) {continue;}
      if (!isInPlacePluginSource(locked.source)) {
        managedPluginNames.add(name);
      }
    }
  }
  const installedPlugins = await loadInstalledPlugins(
    scope.pluginsDir,
    config.plugins.filter((plugin) => !isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root)),
  );
  await writeAgentsGitignore(
    scope.agentsDir,
    [
      ...managedNames,
      ...await filterManagedPluginSkillNames(
        await projectedPiSkillNames(config.agents, installedPlugins.plugins),
        config,
        scope.skillsDir,
        scope.pluginsDir,
      ),
    ],
    [...managedSubagentNames],
    [...managedPluginNames],
  );
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

export default async function remove(args: string[], flags?: { user?: boolean }): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
    },
  });

  const arg = positionals[0];
  if (!arg) {
    console.error(chalk.red("Usage: npx @sentry/dotagents remove <name|source> [-y]"));
    process.exitCode = 1;
    return;
  }

  const skipConfirm = values.yes as boolean;

  try {
    const scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    await ensureUserScopeBootstrapped(scope);

    try {
      const before = await loadConfig(scope.configPath);
      const kind = before.plugins.some((plugin) => plugin.name === arg) &&
        !before.skills.some((skill) => skill.name === arg)
        ? "plugin"
        : "skill";
      await runRemove({ scope, name: arg });
      console.log(chalk.green(`Removed ${kind}: ${arg}`));
    } catch (err) {
      if (err instanceof WildcardSkillRemoveError) {
        console.log(chalk.yellow(err.message));
        const shouldExclude = skipConfirm || await promptYesNo("Add to exclude list? (y/N) ");
        if (shouldExclude) {
          await addExcludeToWildcard(
            scope.configPath,
            err.source,
            arg,
          );

          const skillDir = join(scope.skillsDir, arg);
          await rm(skillDir, { recursive: true, force: true });
          const lockfile = await loadLockfile(scope.lockPath);
          if (lockfile) {
            delete lockfile.skills[arg];
            await writeLockfile(scope.lockPath, lockfile);
          }

          console.log(chalk.green(`Added "${arg}" to exclude list and removed skill.`));
        }
        return;
      }

      if (!(err instanceof RemoveError)) {throw err;}

      // Skill name not found — try as source specifier
      const isSource = isExplicitSourceSpecifier(arg) || parseOwnerRepoShorthand(arg) !== undefined;
      if (!isSource) {throw err;}

      // It's a valid source specifier — preview, confirm, then remove.
      let skillNames: string[] = [];
      let pluginNames: string[] = [];
      try {
        skillNames = await collectSkillsFromSource(scope, arg);
      } catch (sourceErr) {
        if (!(sourceErr instanceof RemoveError)) {throw sourceErr;}
      }
      try {
        pluginNames = await collectPluginsFromSource(scope, arg);
      } catch (sourceErr) {
        if (!(sourceErr instanceof RemoveError)) {throw sourceErr;}
      }
      if (skillNames.length === 0 && pluginNames.length === 0) {
        throw new RemoveError(`No skills or plugins found from source "${arg}".`);
      }

      if (!skipConfirm) {
        const names = [
          ...skillNames.map((name) => `skill:${name}`),
          ...pluginNames.map((name) => `plugin:${name}`),
        ].join(", ");
        const confirmed = await promptYesNo(
          `Will remove ${skillNames.length} skill(s) and ${pluginNames.length} plugin(s) from "${arg}": ${names}\nContinue? (y/N) `,
        );
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }

      const removedSkills = skillNames.length > 0
        ? await runRemoveSource({ scope, source: arg })
        : [];
      const removedPlugins = pluginNames.length > 0
        ? await runRemovePluginSource({ scope, source: arg })
        : [];
      const summary = [
        removedSkills.length > 0 ? `${removedSkills.length} skill(s): ${removedSkills.join(", ")}` : undefined,
        removedPlugins.length > 0 ? `${removedPlugins.length} plugin(s): ${removedPlugins.join(", ")}` : undefined,
      ].filter(Boolean).join("; ");
      console.log(chalk.green(`Removed from "${arg}": ${summary}`));
    }
  } catch (err) {
    if (err instanceof ScopeError || err instanceof RemoveError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
