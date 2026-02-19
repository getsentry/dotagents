import { resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import type { AgentsConfig, McpConfig } from "../../config/schema.js";
import { addMcpToConfig, removeMcpFromConfig } from "../../config/writer.js";
import { runInstall } from "./install.js";
import { resolveScope, resolveDefaultScope, ScopeError } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validateMcpName(name: string): void {
  if (!MCP_NAME_RE.test(name)) {
    throw new McpError(
      `Invalid MCP server name "${name}". Names must start with alphanumeric and contain only [a-zA-Z0-9._-].`,
    );
  }
}

export function parseHeader(raw: string): [string, string] {
  const idx = raw.indexOf(":");
  if (idx < 1) {
    throw new McpError(`Invalid header format: "${raw}". Expected "Key:Value".`);
  }
  return [raw.slice(0, idx), raw.slice(idx + 1)];
}

export interface McpAddOptions {
  scope: ScopeRoot;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: string[];
  env?: string[];
}

export async function runMcpAdd(opts: McpAddOptions): Promise<void> {
  const { scope, name, command, url } = opts;

  validateMcpName(name);

  if (command && url) {
    throw new McpError("Cannot specify both --command and --url.");
  }
  if (!command && !url) {
    throw new McpError("Must specify either --command or --url.");
  }

  const config = await loadConfig(scope.configPath);

  if (config.mcp.some((m) => m.name === name)) {
    throw new McpError(`MCP server "${name}" already exists in agents.toml. Remove it first.`);
  }

  const entry: McpConfig = {
    name,
    ...(command ? { command, args: opts.args } : {}),
    ...(url ? { url, headers: buildHeaders(opts.headers) } : {}),
    env: opts.env ?? [],
  };

  await addMcpToConfig(scope.configPath, entry);
  await runInstall({ scope });
}

function buildHeaders(raw?: string[]): Record<string, string> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const h of raw) {
    const [key, value] = parseHeader(h);
    headers[key] = value;
  }
  return headers;
}

export interface McpRemoveOptions {
  scope: ScopeRoot;
  name: string;
}

export async function runMcpRemove(opts: McpRemoveOptions): Promise<void> {
  const { scope, name } = opts;
  const config = await loadConfig(scope.configPath);

  if (!config.mcp.some((m) => m.name === name)) {
    throw new McpError(`MCP server "${name}" not found in agents.toml.`);
  }

  await removeMcpFromConfig(scope.configPath, name);
  await runInstall({ scope });
}

export interface McpListEntry {
  name: string;
  transport: "stdio" | "http";
  target: string;
  env: string[];
}

export function getMcpList(config: AgentsConfig): McpListEntry[] {
  return config.mcp.map((m) => ({
    name: m.name,
    transport: m.command ? "stdio" : "http",
    target: (m.command ?? m.url)!,
    env: m.env,
  }));
}

// --- CLI wrappers ---

async function mcpAdd(args: string[], scope: ScopeRoot): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      command: { type: "string" },
      args: { type: "string", multiple: true },
      url: { type: "string" },
      header: { type: "string", multiple: true },
      env: { type: "string", multiple: true },
    },
    strict: true,
  });

  const name = positionals[0];
  if (!name) {
    console.error(
      chalk.red("Usage: dotagents mcp add <name> --command <cmd> [--args <a>...] [--env <VAR>...]"),
    );
    console.error(
      chalk.red("       dotagents mcp add <name> --url <url> [--header <Key:Value>...] [--env <VAR>...]"),
    );
    process.exitCode = 1;
    return;
  }

  await runMcpAdd({
    scope,
    name,
    command: values["command"],
    args: values["args"],
    url: values["url"],
    headers: values["header"],
    env: values["env"],
  });
  console.log(chalk.green(`Added MCP server: ${name}`));
}

async function mcpRemove(args: string[], scope: ScopeRoot): Promise<void> {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
  });

  const name = positionals[0];
  if (!name) {
    console.error(chalk.red("Usage: dotagents mcp remove <name>"));
    process.exitCode = 1;
    return;
  }

  await runMcpRemove({ scope, name });
  console.log(chalk.green(`Removed MCP server: ${name}`));
}

async function mcpList(args: string[], scope: ScopeRoot): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
    },
    strict: true,
  });

  const config = await loadConfig(scope.configPath);
  const entries = getMcpList(config);

  if (entries.length === 0) {
    console.log(chalk.dim("No MCP servers declared in agents.toml."));
    return;
  }

  if (values["json"]) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log(chalk.bold("MCP servers:"));
  for (const e of entries) {
    const env = e.env.length > 0 ? chalk.dim(` env=[${e.env.join(",")}]`) : "";
    console.log(`  ${e.name}  ${chalk.dim(e.transport)}  ${chalk.dim(e.target)}${env}`);
  }
}

function printMcpUsage(): void {
  console.error(`Usage: dotagents mcp <subcommand>

Subcommands:
  add      Add an MCP server declaration
  remove   Remove an MCP server declaration
  list     Show declared MCP servers`);
}

export default async function mcp(args: string[], flags?: { user?: boolean }): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printMcpUsage();
    return;
  }

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

  const subArgs = args.slice(1);

  try {
    switch (sub) {
      case "add":
        await mcpAdd(subArgs, scope);
        break;
      case "remove":
        await mcpRemove(subArgs, scope);
        break;
      case "list":
        await mcpList(subArgs, scope);
        break;
      default:
        console.error(chalk.red(`Unknown mcp subcommand: ${sub}`));
        printMcpUsage();
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ScopeError || err instanceof McpError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
