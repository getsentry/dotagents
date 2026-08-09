const COMMAND_HELP: Record<string, string> = {
  init: `Usage: npx @sentry/dotagents [--user] init [options]

Initialize agents.toml and the managed .agents directory.

Options:
  --agents <ids>  Comma-separated agent IDs for non-interactive setup
  --force         Replace an existing configuration
  --help, -h      Show this help message`,
  install: `Usage: npx @sentry/dotagents [--user] install [options]

Install or refresh dependencies declared in agents.toml.

Options:
  --frozen        Deprecated compatibility flag; normal install still runs
  --help, -h      Show this help message`,
  add: `Usage: npx @sentry/dotagents [--user] add <source> [skill...] [options]

Add skill dependencies to agents.toml and install them immediately.

Options:
  --skill <name>  Skill name to add; repeatable
  --name <name>   Alias for --skill; repeatable
  --ref <ref>     Git tag, branch, or commit
  --all           Add every discovered skill as a wildcard dependency
  --help, -h      Show this help message`,
  remove: `Usage: npx @sentry/dotagents [--user] remove <name|source> [options]

Remove a skill or plugin, or remove every dependency from a source.

Options:
  -y, --yes       Skip confirmation when excluding or removing by source
  --help, -h      Show this help message`,
  sync: `Usage: npx @sentry/dotagents [--user] sync [options]

Reconcile local state without fetching dependency updates.

Options:
  --help, -h      Show this help message`,
  list: `Usage: npx @sentry/dotagents [--user] list [options]

Show declared skills and plugins with installation status.

Options:
  --json          Print structured output
  --help, -h      Show this help message`,
  doctor: `Usage: npx @sentry/dotagents [--user] doctor [options]

Check configuration, managed state, symlinks, and generated files.

Options:
  --fix           Apply supported repairs
  --help, -h      Show this help message`,
  mcp: `Usage: npx @sentry/dotagents [--user] mcp <subcommand>

Manage MCP server declarations.

Subcommands:
  add             Add an MCP server declaration
  remove          Remove an MCP server declaration
  list            Show declared MCP servers

Run 'npx @sentry/dotagents mcp <subcommand> --help' for details.`,
  "mcp add": `Usage: npx @sentry/dotagents [--user] mcp add <name> (--command <cmd> | --url <url>) [options]

Add an MCP server declaration to agents.toml.

Options:
  --command <cmd>       Stdio command including arguments
  --url <url>           HTTP or SSE server URL
  --header <Key:Value>  HTTP header; repeatable and URL transport only
  --env <VAR>           Environment variable name; repeatable
  --help, -h            Show this help message`,
  "mcp remove": `Usage: npx @sentry/dotagents [--user] mcp remove <name> [options]

Remove an MCP server declaration from agents.toml.

Options:
  --help, -h      Show this help message`,
  "mcp list": `Usage: npx @sentry/dotagents [--user] mcp list [options]

Show MCP server declarations from agents.toml.

Options:
  --json          Print structured output
  --help, -h      Show this help message`,
  trust: `Usage: npx @sentry/dotagents [--user] trust <subcommand>

Manage trusted skill sources.

Subcommands:
  add             Add a trusted org, repository, or domain
  remove          Remove a trusted source
  list            Show trusted sources

Run 'npx @sentry/dotagents trust <subcommand> --help' for details.`,
  "trust add": `Usage: npx @sentry/dotagents [--user] trust add <source> [options]

Add a trusted GitHub org, owner/repo, or Git domain.

Options:
  --help, -h      Show this help message`,
  "trust remove": `Usage: npx @sentry/dotagents [--user] trust remove <source> [options]

Remove a trusted source from agents.toml.

Options:
  --help, -h      Show this help message`,
  "trust list": `Usage: npx @sentry/dotagents [--user] trust list [options]

Show trusted sources from agents.toml.

Options:
  --json          Print structured output
  --help, -h      Show this help message`,
};

export function getCommandHelp(command: string, args: string[]): string | undefined {
  if (!args.some((arg) => arg === "--help" || arg === "-h")) {return undefined;}
  const subcommand = args[0];
  return COMMAND_HELP[subcommand ? `${command} ${subcommand}` : command] ?? COMMAND_HELP[command];
}
