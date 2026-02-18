import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { isGitLocked } from "../../lockfile/schema.js";
import { hashDirectory } from "../../utils/hash.js";
import { existsSync } from "node:fs";
import { resolveScope, resolveDefaultScope, ScopeError } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

export interface SkillStatus {
  name: string;
  source: string;
  commit?: string;
  status: "ok" | "modified" | "missing" | "unlocked";
  /** If this skill comes from a wildcard entry, the source string */
  wildcard?: string;
}

export interface ListOptions {
  scope: ScopeRoot;
  json?: boolean;
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
      const excludeSet = new Set(wDep.exclude);
      for (const [name, locked] of Object.entries(lockfile.skills)) {
        if (locked.source !== wDep.source) continue;
        if (explicitNames.has(name)) continue;
        if (excludeSet.has(name)) continue;
        if (skillEntries.has(name)) continue;
        skillEntries.set(name, { source: wDep.source, wildcard: wDep.source });
      }
    }
  }

  const skillNames = [...skillEntries.keys()].sort();
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

    // Check integrity
    const integrity = await hashDirectory(installed);
    const commit = isGitLocked(locked) ? locked.commit.slice(0, 8) : undefined;

    if (integrity !== locked.integrity) {
      results.push({ name, source: entry.source, commit, status: "modified", wildcard: entry.wildcard });
    } else {
      results.push({ name, source: entry.source, commit, status: "ok", wildcard: entry.wildcard });
    }
  }

  return results;
}

function formatStatus(s: SkillStatus): string {
  const commit = s.commit ? chalk.dim(` (${s.commit})`) : "";
  const source = chalk.dim(s.source);
  const wildcard = s.wildcard ? chalk.dim(" (* wildcard)") : "";

  switch (s.status) {
    case "ok":
      return `  ${chalk.green("✓")} ${s.name}${commit}  ${source}${wildcard}`;
    case "modified":
      return `  ${chalk.yellow("~")} ${s.name}${commit}  ${source}${wildcard}  ${chalk.yellow("modified")}`;
    case "missing":
      return `  ${chalk.red("✗")} ${s.name}  ${source}${wildcard}  ${chalk.red("not installed")}`;
    case "unlocked":
      return `  ${chalk.yellow("?")} ${s.name}  ${source}${wildcard}  ${chalk.yellow("not in lockfile")}`;
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

  if (results.length === 0) {
    console.log(chalk.dim("No skills declared in agents.toml."));
    return;
  }

  if (values["json"]) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(chalk.bold("Skills:"));
  for (const s of results) {
    console.log(formatStatus(s));
  }
}
