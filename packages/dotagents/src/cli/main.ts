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
import { getCommandHelp } from "./help.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };
export { version };

const COMMANDS = {
  init, install, add, remove, sync, list, mcp, trust, doctor,
} as const;
type Command = keyof typeof COMMANDS;

function printUsage(): void {
  console.log(`dotagents - shared tooling for coding agents

Usage: npx @sentry/dotagents [--user|--global] <command> [options]

Commands:
  init        Initialize agents.toml and .agents/skills/
  install     Install dependencies from agents.toml
  add         Add a skill dependency
  remove      Remove a skill, plugin, or source
  sync        Reconcile state offline and repair generated config
  list        Show declared skills and plugins
  mcp         Manage MCP server declarations
  trust       Manage trusted sources
  doctor      Check project health and fix issues

Options:
  --user      Operate on user-scope (~/.agents/) instead of project
  --global    Alias for --user
  --help, -h  Show this help message
  --version   Show version`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  const userIndex = args.findIndex((arg) => arg === "--user" || arg === "--global");
  const isUser = userIndex !== -1;
  if (isUser) {args.splice(userIndex, 1);}

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

  const updateMessage = checkForUpdate(version);
  await command(commandArgs, { user: isUser });

  const message = await updateMessage;
  if (message) {
    console.error(`\n${message}`);
  }
}
