# dotagents

A package manager for `.agents` directories. Declare agent skill dependencies in `agents.toml`, lock versions for reproducibility, and let every tool on your team discover skills from a single place.

## Why dotagents?

**One source of truth.** Skills live in `.agents/skills/` and symlink into `.claude/skills/`, `.cursor/skills/`, or wherever your tools expect them. No copy-pasting between directories.

**Reproducible.** `agents.lock` pins exact commits and integrity hashes. `npx @sentry/dotagents install --frozen` in CI guarantees everyone runs the same skills.

**Shareable.** Skills are just directories with a `SKILL.md`. Host them in any git repo, discover them automatically, install with one command.

## Quick Start

```bash
# Initialize a new project
npx @sentry/dotagents init

# Add a skill from a GitHub repo
npx @sentry/dotagents add getsentry/skills --name find-bugs

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

## Source Formats

```toml
[[skills]]
name = "find-bugs"
source = "getsentry/skills"              # GitHub repo (auto-discover)

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

## Agent Targets

The `agents` field tells dotagents which tools to configure. It handles skills symlinks, MCP config files, and hook config files for each agent.

```toml
agents = ["claude", "cursor"]
```

Supported agents: `claude`, `cursor`, `codex`, `vscode`, `opencode`, `pi`.

## MCP Servers

Declare MCP servers once in `agents.toml` and dotagents generates the correct config file for each agent during `install` and `sync`.

```toml
agents = ["claude", "cursor"]

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
headers = { Authorization = "Bearer tok" }
```

Each server uses either `command` (stdio) or `url` (HTTP), not both. The `env` field lists environment variable names to pass through from the user's environment.

## Hooks

Declare hooks once in `agents.toml` and dotagents writes the correct hook config for each agent that supports them.

```toml
agents = ["claude"]

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "my-lint-check"

[[hooks]]
event = "Stop"
command = "notify-done"
```

| Field | Required | Description |
|-------|----------|-------------|
| `event` | Yes | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, or `Stop` |
| `matcher` | No | Filter to specific tool names (e.g. `Bash`, `Write`) |
| `command` | Yes | Shell command to run when the hook fires |

## How It Works

1. Skills are declared in `agents.toml` at the project root
2. `install` clones repos, discovers skills by convention, and copies them into `.agents/skills/`
3. `agents.lock` records the resolved commit and a SHA-256 integrity hash
4. By default (`gitignore = false`), skills are checked into git so collaborators get them immediately. Set `gitignore = true` to auto-generate `.agents/.gitignore` and exclude managed skills instead.
5. Symlinks connect `.agents/skills/` to wherever your tools look (configured via the `agents` field)
6. MCP and hook configs are generated for each declared agent

## Checking In Skills

By default, `init` sets `gitignore = false` so installed skills are committed to git. This means anyone cloning the repo gets skills immediately — they only need dotagents when adding or updating skills.

To gitignore managed skills instead (collaborators must run `install`), set `gitignore = true` in `agents.toml` or remove the field entirely (it defaults to `true` when absent for backward compatibility).

## Contributing

```bash
git clone git@github.com:getsentry/dotagents.git
cd dotagents
pnpm install
pnpm check  # lint + typecheck + test
```

## License

MIT
