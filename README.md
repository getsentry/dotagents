# dotagents

A package manager for `.agents` directories. Declare agent skill dependencies in `agents.toml`, lock versions for reproducibility, and let every tool on your team discover skills from a single place.

## Why dotagents?

**One source of truth.** Skills live in `.agents/skills/` and symlink into `.claude/skills/`, `.cursor/skills/`, or wherever your tools expect them. No copy-pasting between directories.

**Reproducible.** `agents.lock` tracks managed skills. Pin versions directly in `agents.toml` with ref syntax.

**Shareable.** Skills are just directories with a `SKILL.md`. Host them in any git repo, discover them automatically, install with one command.

**Multi-agent.** Configure Claude, Cursor, Codex, VS Code, OpenCode, and Pi from a single `agents.toml` -- skills, MCP servers, and hooks.

## Quick Start

```bash
# Initialize a new project
npx @sentry/dotagents init

# Add a skill from a GitHub repo
npx @sentry/dotagents add getsentry/skills find-bugs

# Add multiple skills at once
npx @sentry/dotagents add getsentry/skills find-bugs code-review commit

# Or add all skills from a repo
npx @sentry/dotagents add getsentry/skills --all

# Install all declared skills
npx @sentry/dotagents install
```

This creates an `agents.toml`:

```toml
version = 1
agents = ["claude"]

[[skills]]
name = "find-bugs"
source = "getsentry/skills"
```

And a lockfile (`agents.lock`) tracking which skills are managed. Both `agents.lock` and `.agents/.gitignore` are automatically gitignored.

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create `agents.toml` and `.agents/skills/` |
| `add <source> [skills...]` | Add skill dependencies |
| `remove <name>` | Remove a skill |
| `install` | Install all dependencies from `agents.toml` |
| `list` | Show installed skills and their status |
| `sync` | Reconcile gitignore, symlinks, and verify state |
| `mcp` | Manage MCP server declarations |
| `trust` | Manage trusted sources |
| `doctor` | Check project health and fix issues |

All commands accept `--user` to operate on user scope (`~/.agents/`) instead of the current project.

### init

```bash
dotagents init [--agents claude,cursor] [--force]
```

Interactive mode prompts for agent targets and trust policy. Sets up gitignore entries automatically. Includes the `dotagents` skill from `getsentry/dotagents` for CLI guidance.

### install

```bash
dotagents install [--force]
```

Always fetches latest versions. Use `--force` to re-resolve everything from scratch.

### add

```bash
dotagents add <source> [<skill>...] [--skill <name>...] [--ref <ref>] [--all]
```

Add one or more skills and install them. Specify skill names as positional arguments or with `--skill` flags.

```bash
# Add a single skill
dotagents add getsentry/skills find-bugs

# Add multiple skills
dotagents add getsentry/skills find-bugs code-review commit

# Equivalent using --skill flags
dotagents add getsentry/skills --skill find-bugs --skill code-review

# Pin to a ref
dotagents add getsentry/skills find-bugs --ref v1.0.0

# Add all skills as a wildcard entry
dotagents add getsentry/skills --all
```

When a repo has one skill, it's added automatically. When multiple are found and no names are given, interactive mode shows a picker.

When adding multiple skills, any that already exist in `agents.toml` are skipped with a warning. The rest are added normally.

### remove

```bash
dotagents remove <name>
```

For wildcard-sourced skills, adds the skill to the `exclude` list instead of removing the whole entry.

### list

```bash
dotagents list [--json]
```

Status indicators: `✓` installed, `✗` missing, `?` unlocked.

### sync

```bash
dotagents sync
```

Adopts orphaned skills, regenerates gitignore, repairs symlinks and configs.

### mcp

Manage MCP server declarations from the CLI.

```bash
# Add a stdio server
dotagents mcp add github --command npx --args -y @modelcontextprotocol/server-github --env GITHUB_TOKEN

# Add an HTTP server
dotagents mcp add remote-api --url https://mcp.example.com/sse

# Remove a server
dotagents mcp remove github

# List declared servers
dotagents mcp list [--json]
```

### trust

Manage trusted sources from the CLI.

```bash
# Trust a GitHub org (all repos)
dotagents trust add getsentry

# Trust a specific repo
dotagents trust add external-org/specific-repo

# Trust a git domain
dotagents trust add git.corp.example.com

# Remove a trusted source
dotagents trust remove getsentry

# List trusted sources
dotagents trust list [--json]
```

The source type is inferred automatically: `owner/repo` for repos, names with `.` for domains, and bare names for GitHub orgs.

### doctor

```bash
dotagents doctor [--fix]
```

Check project health: gitignore setup, installed skills, symlinks, and legacy config fields. Use `--fix` to auto-repair issues. Useful when migrating to a new version.

## Source Formats

```toml
[[skills]]
name = "find-bugs"
source = "getsentry/skills"              # GitHub repo

[[skills]]
name = "review"
source = "getsentry/skills@v1.0.0"       # Pinned to a ref

[[skills]]
name = "internal"
source = "git:https://git.corp.dev/repo"  # Non-GitHub git

[[skills]]
name = "local"
source = "path:./my-skills/local-skill"   # Local directory
```

## Wildcard Skills

Add all skills from a repo with a single entry. Use `exclude` to skip specific ones.

```toml
[[skills]]
name = "*"
source = "getsentry/skills"
exclude = ["deprecated-skill"]
```

Or from the CLI: `dotagents add getsentry/skills --all`

## Agent Targets

The `agents` field tells dotagents which tools to configure.

```toml
agents = ["claude", "cursor"]
```

| Agent | Config Dir | MCP Config | Hooks |
|-------|-----------|------------|-------|
| `claude` | `.claude` | `.mcp.json` | `.claude/settings.json` |
| `cursor` | `.cursor` | `.cursor/mcp.json` | `.cursor/hooks.json` |
| `codex` | `.codex` | `.codex/config.toml` | -- |
| `vscode` | `.vscode` | `.vscode/mcp.json` | `.claude/settings.json` |
| `opencode` | `.claude` | `opencode.json` | -- |

### Pi

[Pi](https://github.com/badlogic/pi-mono) reads `.agents/skills/` natively. No agent target or symlink configuration is needed -- install skills with dotagents and Pi picks them up automatically.

## MCP Servers

Declare MCP servers once in `agents.toml` and dotagents generates the correct config file for each agent during `install` and `sync`.

```toml
# Stdio transport
[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]

# HTTP transport
[[mcp]]
name = "remote-api"
url = "https://mcp.example.com/sse"
```

Each server uses either `command` (stdio) or `url` (HTTP), not both.

You can also manage MCP servers from the CLI with `dotagents mcp add` and `dotagents mcp remove`.

## Hooks

Declare hooks once and dotagents writes the correct hook config for each agent that supports them (Claude, Cursor, VS Code).

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "my-lint-check"

[[hooks]]
event = "Stop"
command = "notify-done"
```

Supported events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`.

## Trust

Restrict which skill sources are allowed by adding a `[trust]` section. Without it, all sources are allowed.

```toml
[trust]
github_orgs = ["getsentry"]
github_repos = ["external-org/specific-repo"]
git_domains = ["git.corp.example.com"]
```

You can also manage trust from the CLI:

```bash
dotagents trust add getsentry
dotagents trust add external-org/specific-repo
dotagents trust add git.corp.example.com
```

Local `path:` sources are always allowed.

## User Scope

Use `--user` to manage skills shared across all projects:

```bash
dotagents --user init
dotagents --user add getsentry/skills --all
```

User-scope files live in `~/.agents/` (override with `DOTAGENTS_HOME`).

## How It Works

1. Skills are declared in `agents.toml` at the project root
2. `install` clones repos (always fetching latest), discovers skills by convention, and copies them into `.agents/skills/`
3. `agents.lock` tracks which skills are managed (gitignored automatically)
4. Managed skills are gitignored. Collaborators run `dotagents install` after cloning to get skills. Custom skills in `.agents/skills/` are tracked by git normally.
5. Symlinks connect `.agents/skills/` to wherever your tools look (configured via the `agents` field)
6. MCP and hook configs are generated for each declared agent
7. `dotagents doctor` checks project health and can auto-fix configuration issues

## Contributing

```bash
git clone git@github.com:getsentry/dotagents.git
cd dotagents
pnpm install
pnpm check  # lint + typecheck + test
```

## License

MIT
