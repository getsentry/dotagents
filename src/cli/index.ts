#!/usr/bin/env node
import { createRequire } from "node:module";
import { checkForUpdate } from "./update-notifier.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };
export { version };

const COMMANDS = ["init", "install", "add", "remove", "update", "sync", "list", "mcp"] as const;
type Command = (typeof COMMANDS)[number];

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`dotagents - package manager for .agents directories

Usage: dotagents [--user] <command> [options]

Commands:
  init        Initialize agents.toml and .agents/skills/
  install     Install dependencies from agents.toml
  add         Add a skill dependency
  remove      Remove a skill dependency
  update      Update skills to latest versions
  sync        Reconcile gitignore, symlinks, verify state
  list        Show installed skills
  mcp         Manage MCP server declarations

Options:
  --user      Operate on user-scope (~/.agents/) instead of project
  --help, -h  Show this help message
  --version   Show version`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Extract --user flag before command dispatch
  const userIndex = args.indexOf("--user");
  const isUser = userIndex !== -1;
  if (isUser) args.splice(userIndex, 1);

  const first = args[0];

  // Handle top-level flags before any command (no update check needed)
  if (!first || first === "--help" || first === "-h") {
    printUsage();
    return;
  }
  if (first === "--version" || first === "-V") {
    // eslint-disable-next-line no-console
    console.log(version);
    return;
  }

  if (!COMMANDS.includes(first as Command)) {
    console.error(`Unknown command: ${first}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  // Start update check in background (only for actual commands)
  const updateMessage = checkForUpdate(version);

  // Pass remaining args (after command name) to the subcommand
  const mod = await import(`./commands/${first}.js`);
  await mod.default(args.slice(1), { user: isUser });

  const message = await updateMessage;
  if (message) {
    console.error(`\n${message}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
