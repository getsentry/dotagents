import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { isGitLocked } from "../../lockfile/schema.js";
import { hashDirectory } from "../../utils/hash.js";
import { existsSync } from "node:fs";
import { resolveScope } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

export interface SkillStatus {
  name: string;
  source: string;
  commit?: string;
  status: "ok" | "modified" | "missing" | "unlocked";
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
  const skillNames = config.skills.map((s) => s.name).sort();

  const results: SkillStatus[] = [];

  for (const name of skillNames) {
    const dep = config.skills.find((s) => s.name === name)!;
    const locked = lockfile?.skills[name];
    const installed = join(skillsDir, name);

    if (!existsSync(installed)) {
      results.push({ name, source: dep.source, status: "missing" });
      continue;
    }

    if (!locked) {
      results.push({ name, source: dep.source, status: "unlocked" });
      continue;
    }

    // Check integrity
    const integrity = await hashDirectory(installed);
    const commit = isGitLocked(locked) ? locked.commit.slice(0, 8) : undefined;

    if (integrity !== locked.integrity) {
      results.push({ name, source: dep.source, commit, status: "modified" });
    } else {
      results.push({ name, source: dep.source, commit, status: "ok" });
    }
  }

  return results;
}

function formatStatus(s: SkillStatus): string {
  const commit = s.commit ? chalk.dim(` (${s.commit})`) : "";
  const source = chalk.dim(s.source);

  switch (s.status) {
    case "ok":
      return `  ${chalk.green("✓")} ${s.name}${commit}  ${source}`;
    case "modified":
      return `  ${chalk.yellow("~")} ${s.name}${commit}  ${source}  ${chalk.yellow("modified")}`;
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

  const scope = resolveScope(flags?.user ? "user" : "project", resolve("."));
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
