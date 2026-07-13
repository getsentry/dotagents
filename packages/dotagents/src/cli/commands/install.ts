import { resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { GitError, TrustError } from "@sentry/dotagents-lib";
import { loadConfig } from "../../config/loader.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import type { Lockfile } from "../../lockfile/schema.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";
import { formatGitError, formatTrustError } from "../errors.js";
import { InstallError } from "./install/errors.js";
import { installSkills } from "./install/skills.js";
import { installSubagents, writeCanonicalSubagents } from "./install/subagents.js";
import { writeInstallGitignore } from "./install/gitignore.js";
import {
  writeHookRuntime,
  writeMcpRuntime,
  writeSkillSymlinks,
  writeSubagentRuntime,
} from "./install/agent-runtime.js";

export { InstallError };

// Owns install orchestration only: concern modules resolve/copy/prune
// canonical artifacts, this command assembles the lockfile once canonical
// writes have succeeded, then writes runtime projections and CLI output.
export interface InstallOptions {
  scope: ScopeRoot;
  frozen?: boolean;
}

export interface InstallResult {
  installed: string[];
  skipped: string[];
  pruned: string[];
  mcpWarnings: { agent: string; message: string }[];
  hookWarnings: { agent: string; message: string }[];
  subagentWarnings: { agent: string; name: string; message: string }[];
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const { scope, frozen } = opts;
  const config = await loadConfig(scope.configPath);
  const lockfile = await loadLockfile(scope.lockPath);
  const skills = await installSkills(config, lockfile, scope, frozen);
  const subagents = await installSubagents(config, lockfile, scope, frozen);
  const newLock: Lockfile = {
    version: 1,
    skills: skills.lockEntries,
    subagents: subagents.lockEntries,
  };

  await writeCanonicalSubagents(config, scope, subagents.subagents, frozen);
  const writeLock = !frozen && (
    !!lockfile ||
    config.skills.length > 0 ||
    config.subagents.length > 0
  );
  if (writeLock) {
    await writeLockfile(scope.lockPath, newLock);
  }

  await writeInstallGitignore(config, lockfile, scope, {
    installedSkillNames: skills.installed,
    subagents: subagents.subagents,
  }, frozen);
  await writeSkillSymlinks(config, scope);
  const mcpWarnings = await writeMcpRuntime(config, scope);
  const hookWarnings = await writeHookRuntime(config, scope);
  const subagentWarnings = await writeSubagentRuntime(config, scope, subagents.subagents, frozen);

  return {
    installed: skills.installed,
    skipped: [],
    pruned: skills.pruned,
    mcpWarnings,
    hookWarnings,
    subagentWarnings,
  };
}

export default async function install(args: string[], flags?: { user?: boolean }): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      frozen: { type: "boolean" },
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
    for (const w of result.mcpWarnings) {
      console.log(chalk.yellow(`  warn: ${w.message}`));
    }
    for (const w of result.hookWarnings) {
      console.log(chalk.yellow(`  warn: ${w.message}`));
    }
    for (const w of result.subagentWarnings) {
      console.log(chalk.yellow(`  warn: ${w.message}`));
    }
  } catch (err) {
    if (err instanceof TrustError) {
      console.error(chalk.red(formatTrustError(err)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof GitError) {
      console.error(chalk.red(formatGitError(err)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof ScopeError || err instanceof InstallError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
