import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import type { AgentsConfig, McpConfig } from "../../config/schema.js";
import { addMcpToConfig, removeMcpFromConfig } from "../../config/writer.js";
import { runInstall } from "./install.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export class McpCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "McpCancelledError";
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

function splitCommaList(input: string): string[] | undefined {
  const trimmed = input.trim();
  if (!trimmed) {return undefined;}
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

function buildHeaders(raw?: string[]): Record<string, string> | undefined {
  if (!raw || raw.length === 0) {return undefined;}
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

async function mcpAddInteractive(name: string | undefined, scope: ScopeRoot): Promise<void> {
  let serverName = name;

  if (serverName) {
    validateMcpName(serverName);
  } else {
    const result = await clack.text({
      message: "MCP server name",
      validate: (v) => {
        if (!v?.trim()) {return "Name is required.";}
        if (!MCP_NAME_RE.test(v.trim())) {
          return "Names must start with alphanumeric and contain only [a-zA-Z0-9._-].";
        }
      },
    });
    if (clack.isCancel(result)) {throw new McpCancelledError();}
    serverName = result.trim();
  }

  const transport = await clack.select({
    message: "Transport",
    options: [
      { label: "Command (stdio)", value: "stdio" as const },
      { label: "URL (HTTP)", value: "http" as const },
    ],
  });
  if (clack.isCancel(transport)) {throw new McpCancelledError();}

  let command: string | undefined;
  let commandArgs: string[] | undefined;
  let url: string | undefined;
  let headers: string[] | undefined;

  if (transport === "stdio") {
    const cmdInput = await clack.text({
      message: "Command",
      placeholder: "npx -y @modelcontextprotocol/server-github",
      validate: (v) => {
        if (!v?.trim()) {return "Command is required.";}
      },
    });
    if (clack.isCancel(cmdInput)) {throw new McpCancelledError();}

    const parts = cmdInput.trim().split(/\s+/).filter(Boolean);
    command = parts[0];
    commandArgs = parts.length > 1 ? parts.slice(1) : undefined;
  } else {
    const urlInput = await clack.text({
      message: "URL",
      placeholder: "https://mcp.example.com/sse",
      validate: (v) => {
        if (!v?.trim()) {return "URL is required.";}
      },
    });
    if (clack.isCancel(urlInput)) {throw new McpCancelledError();}
    url = urlInput.trim();

    const headersInput = await clack.text({
      message: "Headers (semicolon-separated Key:Value, optional)",
      placeholder: "Authorization:Bearer tok; X-Custom:value",
    });
    if (clack.isCancel(headersInput)) {throw new McpCancelledError();}
    if (headersInput.trim()) {
      headers = headersInput.trim().split(";").map((h) => h.trim()).filter(Boolean);
    }
  }

  const envInput = await clack.text({
    message: "Environment variables (comma-separated, optional)",
    placeholder: "GITHUB_TOKEN,API_KEY",
  });
  if (clack.isCancel(envInput)) {throw new McpCancelledError();}
  const env = splitCommaList(envInput);

  await runMcpAdd({
    scope,
    name: serverName,
    command,
    args: commandArgs,
    url,
    headers,
    env,
  });
  console.log(chalk.green(`Added MCP server: ${serverName}`));
}

async function mcpAdd(args: string[], scope: ScopeRoot): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      command: { type: "string" },
      url: { type: "string" },
      header: { type: "string", multiple: true },
      env: { type: "string", multiple: true },
    },
    strict: true,
  });

  const interactive = process.stdout.isTTY === true && !values["command"] && !values["url"];

  if (interactive) {
    await mcpAddInteractive(positionals[0], scope);
    return;
  }

  const name = positionals[0];
  if (!name) {
    console.error(
      chalk.red("Usage: npx @sentry/dotagents mcp add <name> --command <cmd> [--env <VAR>...]"),
    );
    console.error(
      chalk.red("       npx @sentry/dotagents mcp add <name> --url <url> [--header <Key:Value>...] [--env <VAR>...]"),
    );
    process.exitCode = 1;
    return;
  }

  let command: string | undefined;
  let commandArgs: string[] | undefined;
  if (values["command"]) {
    const parts = values["command"].trim().split(/\s+/).filter(Boolean);
    command = parts[0];
    commandArgs = parts.length > 1 ? parts.slice(1) : undefined;
  }

  await runMcpAdd({
    scope,
    name,
    command,
    args: commandArgs,
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
    console.error(chalk.red("Usage: npx @sentry/dotagents mcp remove <name>"));
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
  console.error(`Usage: npx @sentry/dotagents mcp <subcommand>

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
    if (err instanceof McpCancelledError) {return;}
    if (err instanceof ScopeError || err instanceof McpError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
