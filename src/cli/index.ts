#!/usr/bin/env node
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };
export { version };

const COMMANDS = {
  init, install, add, remove, sync, list, mcp, trust, doctor,
} as const;
type Command = keyof typeof COMMANDS;

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`dotagents - shared tooling for coding agents

Usage: npx @sentry/dotagents [--user] <command> [options]

Commands:
  init        Initialize agents.toml and .agents/skills/
  install     Install dependencies from agents.toml
  add         Add a skill dependency
  remove      Remove a skill or all skills from a source
  sync        Reconcile state offline and repair generated config
  list        Show installed skills
  mcp         Manage MCP server declarations
  trust       Manage trusted sources
  doctor      Check project health and fix issues

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
  if (isUser) {args.splice(userIndex, 1);}

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

  if (!Object.hasOwn(COMMANDS, first)) {
    console.error(`Unknown command: ${first}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const command = COMMANDS[first as Command];

  // Start update check in background (only for actual commands)
  const updateMessage = checkForUpdate(version);

  // Pass remaining args (after command name) to the subcommand
  await command(args.slice(1), { user: isUser });

  const message = await updateMessage;
  if (message) {
    console.error(`\n${message}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
