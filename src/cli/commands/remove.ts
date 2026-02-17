import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { removeSkillFromConfig } from "../../config/writer.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { resolveScope } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

export class RemoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoveError";
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

  // Verify skill exists in config
  const config = await loadConfig(configPath);
  if (!config.skills.some((s) => s.name === skillName)) {
    throw new RemoveError(`Skill "${skillName}" not found in agents.toml.`);
  }

  // 1. Remove from agents.toml
  await removeSkillFromConfig(configPath, skillName);

  // 2. Delete skill directory
  await rm(skillDir, { recursive: true, force: true });

  // 3. Update lockfile
  const lockfile = await loadLockfile(lockPath);
  if (lockfile) {
    delete lockfile.skills[skillName];
    await writeLockfile(lockPath, lockfile);
  }

  // 4. Regenerate gitignore (skip for user scope)
  if (scope.scope === "project") {
    const updatedConfig = await loadConfig(configPath);
    const managedNames = updatedConfig.skills.map((s) => s.name);
    await updateAgentsGitignore(scope.agentsDir, updatedConfig.gitignore, managedNames);
  }
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
    const scope = resolveScope(flags?.user ? "user" : "project", resolve("."));
    await runRemove({ scope, skillName });
    console.log(chalk.green(`Removed skill: ${skillName}`));
  } catch (err) {
    if (err instanceof RemoveError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
