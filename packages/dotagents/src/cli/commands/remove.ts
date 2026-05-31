import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { removeSkillFromConfig, removeSkillBlocksBySource, addExcludeToWildcard } from "../../config/writer.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { writeAgentsGitignore } from "../../gitignore/writer.js";
import { sourcesMatch, parseOwnerRepoShorthand, isExplicitSourceSpecifier } from "@sentry/dotagents-lib";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";
import { isInPlaceSkill } from "../../utils/fs.js";

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
  skillName: string;
}

export async function runRemove(opts: RemoveOptions): Promise<void> {
  const { scope, skillName } = opts;
  const { configPath, lockPath, skillsDir } = scope;
  const skillDir = join(skillsDir, skillName);

  const config = await loadConfig(configPath);

  // Check if skill is an explicit entry
  const explicitDep = config.skills.find((s) => s.name === skillName);
  if (explicitDep && !isWildcardDep(explicitDep)) {
    // Regular explicit entry — remove as before
    await removeSkillFromConfig(configPath, skillName);
    await rm(skillDir, { recursive: true, force: true });

    const lockfile = await loadLockfile(lockPath);
    if (lockfile) {
      delete lockfile.skills[skillName];
      await writeLockfile(lockPath, lockfile);
    }

    await updateProjectGitignore(scope);
    return;
  }

  // Check if skill is from a wildcard entry (via lockfile source matching)
  const lockfile = await loadLockfile(lockPath);
  const locked = lockfile?.skills[skillName];
  if (locked) {
    const wildcardDep = config.skills.find(
      (s) =>
        isWildcardDep(s) &&
        sourcesMatch(s.source, locked.source),
    );
    if (wildcardDep) {
      throw new WildcardSkillRemoveError(skillName, locked.source);
    }
  }

  throw new RemoveError(`Skill "${skillName}" not found in agents.toml.`);
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
    await rm(join(skillsDir, name), { recursive: true, force: true });
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
  await writeAgentsGitignore(
    scope.agentsDir,
    managedNames,
    config.subagents.map((subagent) => subagent.name),
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
      await runRemove({ scope, skillName: arg });
      console.log(chalk.green(`Removed skill: ${arg}`));
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

      // It's a valid source specifier — preview, confirm, then remove
      const skillNames = await collectSkillsFromSource(scope, arg);

      if (!skipConfirm) {
        const names = skillNames.join(", ");
        const confirmed = await promptYesNo(
          `Will remove ${skillNames.length} skill(s) from "${arg}": ${names}\nContinue? (y/N) `,
        );
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }

      const removed = await runRemoveSource({ scope, source: arg });
      console.log(chalk.green(`Removed ${removed.length} skill(s) from "${arg}": ${removed.join(", ")}`));
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
