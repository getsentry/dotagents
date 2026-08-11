import { parseArgs } from "node:util";
import chalk from "chalk";
import { GitError, TrustError, type CacheReuse } from "@sentry/dotagents-lib";
import { loadConfig } from "../../config/loader.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import type { Lockfile } from "../../lockfile/schema.js";
import type { ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";
import type { CommandContext } from "../context.js";
import { formatGitError, formatTrustError } from "../errors.js";
import { InstallError } from "./install/errors.js";
import { installSkills } from "./install/skills.js";
import { installSubagents, writeCanonicalSubagents } from "./install/subagents.js";
import { installPlugins } from "./install/plugins.js";
import { writeInstallGitignore } from "./install/gitignore.js";
import {
  writeHookRuntime,
  writeMcpRuntime,
  writePluginRuntime,
  writeSkillSymlinks,
  writeSubagentRuntime,
} from "./install/agent-runtime.js";

export { InstallError };

// Owns install orchestration only: concern modules resolve/copy/prune
// canonical artifacts, this command assembles the lockfile once canonical
// writes have succeeded, then writes runtime projections and CLI output.
export interface InstallOptions {
  scope: ScopeRoot;
  /** Exact source checkout already acquired earlier in this command. */
  reuse?: CacheReuse;
}

export interface InstallResult {
  installed: string[];
  installedPlugins: string[];
  pruned: string[];
  prunedPlugins: string[];
  mcpWarnings: { agent: string; message: string }[];
  hookWarnings: { agent: string; message: string }[];
  subagentWarnings: { agent: string; name: string; message: string }[];
  pluginWarnings: { agent: string; name: string; message: string }[];
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const { scope } = opts;
  const config = await loadConfig(scope.configPath);
  const lockfile = await loadLockfile(scope.lockPath);
  const skills = await installSkills(config, lockfile, scope, opts.reuse);
  const subagents = await installSubagents(config, scope);
  const plugins = await installPlugins(config, lockfile, scope, opts.reuse);
  const newLock: Lockfile = {
    version: 1,
    skills: skills.lockEntries,
    subagents: subagents.lockEntries,
    plugins: plugins.lockEntries,
  };

  await writeCanonicalSubagents(config, scope, subagents.subagents);
  const writeLock = (
    !!lockfile ||
    config.skills.length > 0 ||
    config.subagents.length > 0 ||
    config.plugins.length > 0
  );
  if (writeLock) {
    await writeLockfile(scope.lockPath, newLock);
  }

  await writeInstallGitignore(config, scope, {
    installedSkillNames: skills.installed,
    subagents: subagents.subagents,
    plugins: plugins.plugins,
  });
  await writeSkillSymlinks(config, scope);
  const mcpWarnings = await writeMcpRuntime(config, scope);
  const hookWarnings = await writeHookRuntime(config, scope);
  const subagentWarnings = await writeSubagentRuntime(config, scope, subagents.subagents);
  const pluginWarnings = await writePluginRuntime(
    config,
    scope,
    plugins.plugins,
  );

  return {
    installed: skills.installed,
    installedPlugins: plugins.plugins.map((plugin) => plugin.name),
    pruned: skills.pruned,
    prunedPlugins: plugins.pruned,
    mcpWarnings,
    hookWarnings,
    subagentWarnings,
    pluginWarnings,
  };
}

export default async function install(args: string[], context: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      frozen: { type: "boolean" },
    },
    strict: true,
  });

  try {
    const { scope } = context;
    await ensureUserScopeBootstrapped(scope);
    if (values["frozen"]) {
      console.log(chalk.yellow("Warning: --frozen is ignored and will be removed in the next major release. Install now follows normal agents.toml resolution; use explicit refs to pin sources."));
    }

    const result = await runInstall({ scope });

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
    if (result.installedPlugins.length > 0) {
      console.log(
        chalk.green(`Installed ${result.installedPlugins.length} plugin(s): ${result.installedPlugins.join(", ")}`),
      );
    }
    if (result.prunedPlugins.length > 0) {
      console.log(
        chalk.yellow(`Pruned ${result.prunedPlugins.length} stale plugin(s): ${result.prunedPlugins.join(", ")}`),
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
    for (const w of result.pluginWarnings) {
      console.log(chalk.yellow(`  warn: ${w.message}`));
    }
  } catch (err) {
    if (err instanceof TrustError) {
      console.error(chalk.red(formatTrustError(err, context.scope)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof GitError) {
      console.error(chalk.red(formatGitError(err, context.scope)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof InstallError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
