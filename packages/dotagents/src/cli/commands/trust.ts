import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import type { AgentsConfig, RepositorySource } from "../../config/schema.js";
import { addTrustSource, removeTrustSource } from "../../config/writer.js";
import type { ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";
import { commandPrefix, type CommandContext } from "../context.js";

export class TrustCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustCommandError";
  }
}

type TrustField = "github_orgs" | "github_repos" | "git_domains";

export function classifyTrustSource(
  source: string,
  defaultRepositorySource?: RepositorySource,
): { field: TrustField; value: string } {
  // When configured for GitLab, expand shorthands (no dots) to gitlab.com/... domain paths
  if (defaultRepositorySource === "gitlab" && !source.includes(".")) {
    return { field: "git_domains", value: `gitlab.com/${source}` };
  }

  if (source.includes("/")) {
    // If the segment before the first / contains a dot, it's a domain path
    // (e.g., gitlab.com/owner), not a GitHub owner/repo
    const firstSegment = source.slice(0, source.indexOf("/"));
    if (firstSegment.includes(".")) {
      return { field: "git_domains", value: source };
    }
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
  const { field, value } = classifyTrustSource(source, config.defaultRepositorySource);

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
  const { field, value } = classifyTrustSource(source, config.defaultRepositorySource);

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
    console.error(chalk.red(`Usage: ${commandPrefix(scope)} trust add <source>`));
    console.error(chalk.red("  <source> can be: org, owner/repo, or domain.name"));
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(scope.configPath);
  const { field, value } = classifyTrustSource(source, config.defaultRepositorySource);
  await runTrustAdd({ scope, source });
  console.log(chalk.green(`Added "${value}" to ${field}.`));
}

async function trustRemove(args: string[], scope: ScopeRoot): Promise<void> {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
  });

  const source = positionals[0];
  if (!source) {
    console.error(chalk.red(`Usage: ${commandPrefix(scope)} trust remove <source>`));
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(scope.configPath);
  const { field, value } = classifyTrustSource(source, config.defaultRepositorySource);
  await runTrustRemove({ scope, source });
  console.log(chalk.green(`Removed "${value}" from ${field}.`));
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

function printTrustUsage(scope: ScopeRoot): void {
  console.error(`Usage: ${commandPrefix(scope)} trust <subcommand>

Subcommands:
  add      Add a trusted source (org, owner/repo, or domain)
  remove   Remove a trusted source
  list     Show trusted sources`);
}

export default async function trust(args: string[], context: CommandContext): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printTrustUsage(context.scope);
    return;
  }

  const { scope } = context;
  await ensureUserScopeBootstrapped(scope);

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
        printTrustUsage(scope);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof TrustCommandError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
