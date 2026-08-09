import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { wildcardContainsLockedSkill } from "../../lockfile/wildcard.js";
import { existsSync } from "node:fs";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";

export interface SkillStatus {
  name: string;
  source: string;
  status: "ok" | "missing" | "unlocked";
  /** If this skill comes from a wildcard entry, the source string */
  wildcard?: string;
}

export interface PluginStatus {
  name: string;
  source: string;
  status: "ok" | "missing" | "unlocked";
}

export interface ListOptions {
  scope: ScopeRoot;
  json?: boolean;
}

export interface PluginListOptions {
  scope: ScopeRoot;
}

export async function runList(opts: ListOptions): Promise<SkillStatus[]> {
  const { scope } = opts;
  const { configPath, lockPath, skillsDir } = scope;

  const config = await loadConfig(configPath);
  const lockfile = await loadLockfile(lockPath);

  // Build full skill list: explicit names + wildcard-expanded names from lockfile
  const regularDeps = config.skills.filter((d) => !isWildcardDep(d));
  const wildcardDeps = config.skills.filter(isWildcardDep);
  const explicitNames = new Set(regularDeps.map((d) => d.name));

  // Collect all skills: start with explicit entries
  const skillEntries = new Map<string, { source: string; wildcard?: string }>();
  for (const dep of regularDeps) {
    skillEntries.set(dep.name, { source: dep.source });
  }

  // For wildcard entries, expand from lockfile
  if (lockfile) {
    for (const wDep of wildcardDeps) {
      for (const [name, locked] of Object.entries(lockfile.skills)) {
        if (!wildcardContainsLockedSkill(wDep, name, locked)) {continue;}
        if (explicitNames.has(name)) {continue;}
        if (skillEntries.has(name)) {continue;}
        skillEntries.set(name, { source: wDep.source, wildcard: wDep.source });
      }
    }
  }

  const skillNames = [...skillEntries.keys()].toSorted();
  const results: SkillStatus[] = [];

  for (const name of skillNames) {
    const entry = skillEntries.get(name)!;
    const locked = lockfile?.skills[name];
    const installed = join(skillsDir, name);

    if (!existsSync(installed)) {
      results.push({ name, source: entry.source, status: "missing", wildcard: entry.wildcard });
      continue;
    }

    if (!locked) {
      results.push({ name, source: entry.source, status: "unlocked", wildcard: entry.wildcard });
      continue;
    }

    results.push({ name, source: entry.source, status: "ok", wildcard: entry.wildcard });
  }

  return results;
}

/** Returns configured plugin install and lock status for the selected scope. */
export async function runPluginList(opts: PluginListOptions): Promise<PluginStatus[]> {
  const { scope } = opts;
  const { configPath, lockPath, pluginsDir } = scope;

  const config = await loadConfig(configPath);
  const lockfile = await loadLockfile(lockPath);

  const results: PluginStatus[] = [];
  for (const plugin of config.plugins.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const locked = lockfile?.plugins[plugin.name];
    const installed = join(pluginsDir, plugin.name);

    if (!existsSync(installed)) {
      results.push({ name: plugin.name, source: plugin.source, status: "missing" });
      continue;
    }

    if (!locked) {
      results.push({ name: plugin.name, source: plugin.source, status: "unlocked" });
      continue;
    }

    results.push({ name: plugin.name, source: plugin.source, status: "ok" });
  }

  return results;
}

function formatStatus(s: SkillStatus): string {
  const source = chalk.dim(s.source);
  const wildcard = s.wildcard ? chalk.dim(" (* wildcard)") : "";

  switch (s.status) {
    case "ok":
      return `  ${chalk.green("✓")} ${s.name}  ${source}${wildcard}`;
    case "missing":
      return `  ${chalk.red("✗")} ${s.name}  ${source}${wildcard}  ${chalk.red("not installed")}`;
    case "unlocked":
      return `  ${chalk.yellow("?")} ${s.name}  ${source}${wildcard}  ${chalk.yellow("not in lockfile")}`;
  }
}

function formatPluginStatus(s: PluginStatus): string {
  const source = chalk.dim(s.source);

  switch (s.status) {
    case "ok":
      return `  ${chalk.green("✓")} ${s.name}  ${source}`;
    case "missing":
      return `  ${chalk.red("✗")} ${s.name}  ${source}  ${chalk.red("not installed")}`;
    case "unlocked":
      return `  ${chalk.yellow("?")} ${s.name}  ${source}  ${chalk.yellow("not in lockfile")}`;
  }
}

export default async function list(args: string[], flags?: { user?: boolean }): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
    },
    strict: true,
  });

  let scope: ScopeRoot;
  try {
    scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    await ensureUserScopeBootstrapped(scope);
  } catch (err) {
    if (err instanceof ScopeError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const results = await runList({
    scope,
    json: values["json"],
  });
  const pluginResults = await runPluginList({
    scope,
  });

  if (results.length === 0 && pluginResults.length === 0) {
    console.log(chalk.dim("No skills or plugins declared in agents.toml."));
    return;
  }

  if (values["json"]) {
    console.log(JSON.stringify({ skills: results, plugins: pluginResults }, null, 2));
    return;
  }

  if (results.length > 0) {
    console.log(chalk.bold("Skills:"));
    for (const s of results) {
      console.log(formatStatus(s));
    }
  }
  if (pluginResults.length > 0) {
    if (results.length > 0) {console.log("");}
    console.log(chalk.bold("Plugins:"));
    for (const p of pluginResults) {
      console.log(formatPluginStatus(p));
    }
  }
}
