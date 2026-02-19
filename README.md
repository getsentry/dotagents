# dotagents

A package manager for `.agents` directories. Declare agent skill dependencies in `agents.toml`, lock versions for reproducibility, and let every tool on your team discover skills from a single place.

## Why dotagents?

**One source of truth.** Skills live in `.agents/skills/` and symlink into `.claude/skills/`, `.cursor/skills/`, or wherever your tools expect them. No copy-pasting between directories.

**Reproducible.** `agents.lock` pins exact commits and integrity hashes. `dotagents install --frozen` in CI guarantees everyone runs the same skills.

**Shareable.** Skills are just directories with a `SKILL.md`. Host them in any git repo, discover them automatically, install with one command.

**Multi-agent.** Configure Claude, Cursor, Codex, VS Code, and OpenCode from a single `agents.toml` -- skills, MCP servers, and hooks.

## Quick Start

```bash
# Initialize a new project
npx @sentry/dotagents init

# Add a skill from a GitHub repo
npx @sentry/dotagents add getsentry/skills --name find-bugs

# Or add all skills from a repo
npx @sentry/dotagents add getsentry/skills --all

# Install all declared skills
npx @sentry/dotagents install
```

This creates an `agents.toml`:

```toml
version = 1
gitignore = false
agents = ["claude"]

[[skills]]
name = "find-bugs"
source = "getsentry/skills"
```

And a lockfile (`agents.lock`) pinning the exact commit and integrity hash.

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create `agents.toml` and `.agents/skills/` |
| `add <source>` | Add a skill dependency |
| `remove <name>` | Remove a skill |
| `install` | Install all dependencies from `agents.toml` |
| `update [name]` | Update skills to latest versions |
| `list` | Show installed skills and their status |
| `sync` | Reconcile gitignore, symlinks, and verify state |

All commands accept `--user` to operate on user scope (`~/.agents/`) instead of the current project.

### init

```bash
dotagents init [--agents claude,cursor] [--force]
```

Interactive mode prompts for agent targets, gitignore preference, and trust policy.

### install

```bash
dotagents install [--frozen] [--force]
```

Use `--frozen` in CI to fail if the lockfile is missing or out of sync. Use `--force` to re-resolve everything from scratch.

### add

```bash
dotagents add <source> [--name <name>] [--ref <ref>] [--all]
```

Add a skill and install it. When a repo has one skill, it's added automatically. When multiple are found, use `--name` to pick one or `--all` to add them all as a wildcard entry.

### remove

```bash
dotagents remove <name>
```

For wildcard-sourced skills, adds the skill to the `exclude` list instead of removing the whole entry.

### update

```bash
dotagents update [name]
```

Fetches latest versions. Skips SHA-pinned refs. For wildcards, re-discovers all skills and adds or removes as needed. Prints a changelog.

### list

```bash
dotagents list [--json]
```

Status indicators: `✓` ok, `~` modified, `✗` missing, `?` unlocked.

### sync

```bash
dotagents sync
```

Adopts orphaned skills, regenerates gitignore, verifies integrity, repairs symlinks and configs.

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

[Pi](https://github.com/badlogic/pi-mono) discovers skills from `.pi/skills/`. It is not listed as an `agents` target, so instead add a symlink target to your `agents.toml`:

```toml
[symlinks]
targets = [".pi"]
```

After running `dotagents install`, Pi will read skills from `.pi/skills/ -> .agents/skills/`.

Pi does not use dotagents for MCP configuration. If you use an MCP extension with Pi, configure it separately via `.pi/mcp.json`.

## MCP Servers

Declare MCP servers once in `agents.toml` and dotagents generates the correct config file for each agent during `install` and `sync`.

```toml
# Stdio transport
[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]

# HTTP transport (OAuth)
[[mcp]]
name = "remote-api"
url = "https://mcp.example.com/sse"
```

Each server uses either `command` (stdio) or `url` (HTTP), not both.

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
2. `install` clones repos, discovers skills by convention, and copies them into `.agents/skills/`
3. `agents.lock` records the resolved commit and a SHA-256 integrity hash
4. By default (`gitignore = false`), skills are checked into git so collaborators get them immediately. Set `gitignore = true` to auto-generate `.agents/.gitignore` and exclude managed skills instead.
5. Symlinks connect `.agents/skills/` to wherever your tools look (configured via the `agents` field)
6. MCP and hook configs are generated for each declared agent

## Checking In Skills

By default, `init` sets `gitignore = false` so installed skills are committed to git. Anyone cloning the repo gets skills immediately -- they only need dotagents when adding or updating skills.

To gitignore managed skills instead, set `gitignore = true` in `agents.toml`. Collaborators must run `dotagents install` after cloning.

## Contributing

```bash
git clone git@github.com:getsentry/dotagents.git
cd dotagents
pnpm install
pnpm check  # lint + typecheck + test
```

## License

MIT
