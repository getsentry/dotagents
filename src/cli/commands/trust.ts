import { resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import type { AgentsConfig } from "../../config/schema.js";
import { addTrustSource, removeTrustSource } from "../../config/writer.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";

export class TrustCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustCommandError";
  }
}

type TrustField = "github_orgs" | "github_repos" | "git_domains";

export function classifyTrustSource(source: string): { field: TrustField; value: string } {
  if (source.includes("/")) {
    return { field: "github_repos", value: source };
  }
  if (source.includes(".")) {
    return { field: "git_domains", value: source };
  }
  return { field: "github_orgs", value: source };
}

export interface TrustAddOptions {
  scope: ScopeRoot;
  source: string;
}

export async function runTrustAdd(opts: TrustAddOptions): Promise<void> {
  const { scope, source } = opts;
  const config = await loadConfig(scope.configPath);
  const { field, value } = classifyTrustSource(source);

  // Check for duplicates (case-insensitive)
  const existing = config.trust?.[field] ?? [];
  if (existing.some((e) => e.toLowerCase() === value.toLowerCase())) {
    throw new TrustCommandError(`"${value}" is already in ${field}.`);
  }

  await addTrustSource(scope.configPath, field, value);
}

export interface TrustRemoveOptions {
  scope: ScopeRoot;
  source: string;
}

export async function runTrustRemove(opts: TrustRemoveOptions): Promise<void> {
  const { scope, source } = opts;
  const config = await loadConfig(scope.configPath);
  const { field, value } = classifyTrustSource(source);

  const existing = config.trust?.[field] ?? [];
  if (!existing.some((e) => e.toLowerCase() === value.toLowerCase())) {
    throw new TrustCommandError(`"${value}" not found in ${field}.`);
  }

  await removeTrustSource(scope.configPath, field, value);
}

export interface TrustListEntry {
  type: string;
  value: string;
}

export function getTrustList(config: AgentsConfig): TrustListEntry[] | "allow_all" {
  if (!config.trust) {return [];}
  if (config.trust.allow_all) {return "allow_all";}

  const entries: TrustListEntry[] = [];
  for (const org of config.trust.github_orgs) {
    entries.push({ type: "github_org", value: org });
  }
  for (const repo of config.trust.github_repos) {
    entries.push({ type: "github_repo", value: repo });
  }
  for (const domain of config.trust.git_domains) {
    entries.push({ type: "git_domain", value: domain });
  }
  return entries;
}

// --- CLI wrappers ---

async function trustAdd(args: string[], scope: ScopeRoot): Promise<void> {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
  });

  const source = positionals[0];
  if (!source) {
    console.error(chalk.red("Usage: dotagents trust add <source>"));
    console.error(chalk.red("  <source> can be: org, owner/repo, or domain.name"));
    process.exitCode = 1;
    return;
  }

  const { field } = classifyTrustSource(source);
  await runTrustAdd({ scope, source });
  console.log(chalk.green(`Added "${source}" to ${field}.`));
}

async function trustRemove(args: string[], scope: ScopeRoot): Promise<void> {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
  });

  const source = positionals[0];
  if (!source) {
    console.error(chalk.red("Usage: dotagents trust remove <source>"));
    process.exitCode = 1;
    return;
  }

  const { field } = classifyTrustSource(source);
  await runTrustRemove({ scope, source });
  console.log(chalk.green(`Removed "${source}" from ${field}.`));
}

async function trustList(args: string[], scope: ScopeRoot): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
    },
    strict: true,
  });

  const config = await loadConfig(scope.configPath);
  const entries = getTrustList(config);

  if (values["json"]) {
    const json = entries === "allow_all" ? { allow_all: true } : entries;
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  if (entries === "allow_all") {
    console.log(chalk.yellow("allow_all = true — all sources are trusted."));
    return;
  }

  if (entries.length === 0) {
    console.log(chalk.dim("No trust rules declared in agents.toml."));
    return;
  }

  console.log(chalk.bold("Trusted sources:"));
  for (const e of entries) {
    console.log(`  ${e.value}  ${chalk.dim(e.type)}`);
  }
}

function printTrustUsage(): void {
  console.error(`Usage: dotagents trust <subcommand>

Subcommands:
  add      Add a trusted source (org, owner/repo, or domain)
  remove   Remove a trusted source
  list     Show trusted sources`);
}

export default async function trust(args: string[], flags?: { user?: boolean }): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printTrustUsage();
    return;
  }

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

  const subArgs = args.slice(1);

  try {
    switch (sub) {
      case "add":
        await trustAdd(subArgs, scope);
        break;
      case "remove":
        await trustRemove(subArgs, scope);
        break;
      case "list":
        await trustList(subArgs, scope);
        break;
      default:
        console.error(chalk.red(`Unknown trust subcommand: ${sub}`));
        printTrustUsage();
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ScopeError || err instanceof TrustCommandError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
