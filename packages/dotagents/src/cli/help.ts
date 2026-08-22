const COMMAND_HELP: Record<string, string> = {
  init: `Usage: npx @sentry/dotagents [--project|--global|--user] init [options]

Initialize agents.toml and the selected scope's managed directories.

Options:
  --agents <ids>  Comma-separated agent IDs for non-interactive setup
  --force         Replace an existing configuration
  --help, -h      Show this help message`,
  install: `Usage: npx @sentry/dotagents [--project|--global|--user] install [options]

Install or refresh dependencies declared in agents.toml.

Options:
  --frozen        Deprecated compatibility flag; normal install still runs
  --help, -h      Show this help message`,
  add: `Usage: npx @sentry/dotagents [--project|--global|--user] add <source> [name...] [options]

Discover plugins first, otherwise skills, then add and install the selected dependencies.
Re-adding an identical declaration refreshes its installation successfully.

Options:
  --name <name>   Dependency name to add; repeatable
  --skill <name>  Compatibility alias for --name; repeatable
  --ref <ref>     Git tag, branch, or commit
  --all           Add plugins explicitly, or all skills as a wildcard dependency
  --help, -h      Show this help message`,
  remove: `Usage: npx @sentry/dotagents [--project|--global|--user] remove <name|source> [options]

Remove a skill or plugin, or remove every dependency from a source.

Options:
  -y, --yes       Skip confirmation when excluding or removing by source
  --help, -h      Show this help message`,
  sync: `Usage: npx @sentry/dotagents [--project|--global|--user] sync [options]

Reconcile local state without fetching dependency updates.

Options:
  --help, -h      Show this help message`,
  list: `Usage: npx @sentry/dotagents [--project|--global|--user] list [options]

Show declared skills and plugins with installation status.

Options:
  --json          Print structured output
  --help, -h      Show this help message`,
  doctor: `Usage: npx @sentry/dotagents [--project|--global|--user] doctor [options]

Check configuration, managed state, symlinks, and generated files.

Options:
  --fix           Apply supported repairs
  --help, -h      Show this help message`,
  mcp: `Usage: npx @sentry/dotagents [--project|--global|--user] mcp <subcommand>

Manage MCP server declarations.

Subcommands:
  add             Add an MCP server declaration
  remove          Remove an MCP server declaration
  list            Show declared MCP servers

Run 'npx @sentry/dotagents mcp <subcommand> --help' for details.`,
  "mcp add": `Usage: npx @sentry/dotagents [--project|--global|--user] mcp add <name> (--command <cmd> | --url <url>) [options]

Add an MCP server declaration to agents.toml.

Options:
  --command <cmd>       Stdio command including arguments
  --url <url>           Streamable HTTP server URL
  --header <Key:Value>  HTTP header; repeatable and URL transport only
  --env <VAR>           Environment variable name; repeatable
  --help, -h            Show this help message`,
  "mcp remove": `Usage: npx @sentry/dotagents [--project|--global|--user] mcp remove <name> [options]

Remove an MCP server declaration from agents.toml.

Options:
  --help, -h      Show this help message`,
  "mcp list": `Usage: npx @sentry/dotagents [--project|--global|--user] mcp list [options]

Show MCP server declarations from agents.toml.

Options:
  --json          Print structured output
  --help, -h      Show this help message`,
  trust: `Usage: npx @sentry/dotagents [--project|--global|--user] trust <subcommand>

Manage trusted skill sources.

Subcommands:
  add             Add a trusted org, repository, or domain
  remove          Remove a trusted source
  list            Show trusted sources

Run 'npx @sentry/dotagents trust <subcommand> --help' for details.`,
  "trust add": `Usage: npx @sentry/dotagents [--project|--global|--user] trust add <source> [options]

Add a trusted GitHub org, owner/repo, or Git domain.

Options:
  --help, -h      Show this help message`,
  "trust remove": `Usage: npx @sentry/dotagents [--project|--global|--user] trust remove <source> [options]

Remove a trusted source from agents.toml.

Options:
  --help, -h      Show this help message`,
  "trust list": `Usage: npx @sentry/dotagents [--project|--global|--user] trust list [options]

Show trusted sources from agents.toml.

Options:
  --json          Print structured output
  --help, -h      Show this help message`,
};

const SCOPE_HELP = `Scope:
  (no flag)  Global scope (~/.agents/); this is the default
  --project  Current project (Git root, or current directory outside Git)
  --global   Explicit global scope
  --user     Compatibility alias for --global`;

export function getCommandHelp(command: string, args: string[]): string | undefined {
  if (!args.some((arg) => arg === "--help" || arg === "-h")) {return undefined;}
  const subcommand = args[0];
  const help = COMMAND_HELP[subcommand ? `${command} ${subcommand}` : command] ?? COMMAND_HELP[command];
  return help ? `${help}\n\n${SCOPE_HELP}` : undefined;
}
