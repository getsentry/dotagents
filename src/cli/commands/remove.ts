import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { removeSkillFromConfig, addExcludeToWildcard } from "../../config/writer.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { sourcesMatch } from "../../skills/resolver.js";
import { resolveScope, resolveDefaultScope, ScopeError } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

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

    if (scope.scope === "project") {
      const updatedConfig = await loadConfig(configPath);
      // Use lockfile for concrete skill names (wildcard entries expand to concrete names there)
      const updatedLock = await loadLockfile(lockPath);
      const allNames = updatedLock ? Object.keys(updatedLock.skills) : [];
      const managedNames = allNames.filter((name) => {
        const dep = updatedConfig.skills.find((s) => s.name === name);
        if (!dep || isWildcardDep(dep)) return true; // wildcard-sourced skills are always managed
        return !dep.source.startsWith("path:.agents/skills/") && !dep.source.startsWith("path:skills/");
      });
      await updateAgentsGitignore(scope.agentsDir, updatedConfig.gitignore, managedNames);
    }
    return;
  }

  // Check if skill is from a wildcard entry (via lockfile source matching)
  const lockfile = await loadLockfile(lockPath);
  const locked = lockfile?.skills[skillName];
  if (locked) {
    const wildcardDep = config.skills.find(
      (s) => isWildcardDep(s) && sourcesMatch(s.source, locked.source),
    );
    if (wildcardDep) {
      throw new WildcardSkillRemoveError(skillName, locked.source);
    }
  }

  throw new RemoveError(`Skill "${skillName}" not found in agents.toml.`);
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
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
  });

  const skillName = positionals[0];
  if (!skillName) {
    console.error(chalk.red("Usage: dotagents remove <name>"));
    process.exitCode = 1;
    return;
  }

  try {
    const scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    await runRemove({ scope, skillName });
    console.log(chalk.green(`Removed skill: ${skillName}`));
  } catch (err) {
    if (err instanceof WildcardSkillRemoveError) {
      console.log(chalk.yellow(err.message));
      const shouldExclude = await promptYesNo("Add to exclude list? (y/N) ");
      if (shouldExclude) {
        const scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
        await addExcludeToWildcard(scope.configPath, err.source, skillName);

        // Delete skill directory and update lockfile
        const skillDir = join(scope.skillsDir, skillName);
        await rm(skillDir, { recursive: true, force: true });
        const lockfile = await loadLockfile(scope.lockPath);
        if (lockfile) {
          delete lockfile.skills[skillName];
          await writeLockfile(scope.lockPath, lockfile);
        }

        console.log(chalk.green(`Added "${skillName}" to exclude list and removed skill.`));
      }
      return;
    }
    if (err instanceof ScopeError || err instanceof RemoveError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
