import { createRequire } from "node:module";
import { resolve } from "node:path";
import { checkForUpdate } from "./update-notifier.js";
import init from "./commands/init.js";
import install from "./commands/install.js";
import add from "./commands/add.js";
import remove from "./commands/remove.js";
import sync from "./commands/sync.js";
import list from "./commands/list.js";
import mcp from "./commands/mcp.js";
import trust from "./commands/trust.js";
import doctor from "./commands/doctor.js";
import { getCommandHelp } from "./help.js";
import { resolveProjectScope, resolveScope, ScopeError, type Scope } from "../scope.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };
export { version };

const COMMANDS = {
  init, install, add, remove, sync, list, mcp, trust, doctor,
} as const;
type Command = keyof typeof COMMANDS;

export interface ParsedScopeArgs {
  args: string[];
  scope: Scope;
}

export function parseScopeArgs(argv: string[]): ParsedScopeArgs {
  const project = argv.includes("--project");
  const global = argv.some((arg) => arg === "--global" || arg === "--user");
  if (project && global) {
    throw new ScopeError("Cannot combine --project with --global or --user.");
  }
  return {
    args: argv.filter((arg) => !["--project", "--global", "--user"].includes(arg)),
    scope: project ? "project" : "user",
  };
}

function printUsage(): void {
  console.log(`dotagents - shared tooling for coding agents

Usage: npx @sentry/dotagents [--project|--global|--user] <command> [options]

Commands:
  init        Initialize configuration and managed directories
  install     Install dependencies from agents.toml
  add         Add a skill dependency
  remove      Remove a skill, plugin, or source
  sync        Reconcile state offline and repair generated config
  list        Show declared skills and plugins
  mcp         Manage MCP server declarations
  trust       Manage trusted sources
  doctor      Check active-scope health and fix issues

Options:
  --project   Operate on the current project instead of global scope
  --global    Explicitly operate on global scope (~/.agents/, the default)
  --user      Compatibility alias for --global
  --help, -h  Show this help message
  --version   Show version`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedScopeArgs;
  try {
    parsed = parseScopeArgs(argv);
  } catch (err) {
    if (err instanceof ScopeError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const { args } = parsed;

  const first = args[0];
  if (!first || first === "--help" || first === "-h") {
    printUsage();
    return;
  }
  if (first === "--version" || first === "-V") {
    console.log(version);
    return;
  }

  if (!Object.hasOwn(COMMANDS, first)) {
    console.error(`Unknown command: ${first}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const command = COMMANDS[first as Command];
  const commandArgs = args.slice(1);
  const commandHelp = getCommandHelp(first, commandArgs);
  if (commandHelp) {
    console.log(commandHelp);
    return;
  }

  let scope;
  try {
    scope = parsed.scope === "project"
      ? resolveProjectScope(resolve("."), { requireConfig: first !== "init" })
      : resolveScope("user");
  } catch (err) {
    if (err instanceof ScopeError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const updateMessage = checkForUpdate(version);
  await command(commandArgs, { scope });

  const message = await updateMessage;
  if (message) {
    console.error(`\n${message}`);
  }
}
