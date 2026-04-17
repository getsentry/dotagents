# dotagents

Shared tooling for coding agents. Declare skills, MCP servers, and hooks in `agents.toml` — dotagents wires them into every agent tool on your team.

## Why dotagents?

**One source of truth.** Skills live in `.agents/skills/` and symlink into `.claude/skills/`, `.cursor/skills/`, or wherever your tools expect them. No copy-pasting between directories.

**One command to install.** `agents.toml` is committed, managed skills are gitignored. Collaborators run `dotagents install` and get the same setup.

**Shareable.** Skills are directories with a `SKILL.md`. Host them in any git repo, discover them automatically, install with one command.

**Multi-agent.** Configure Claude, Cursor, Codex, VS Code, OpenCode, and Pi from a single `agents.toml` -- skills, MCP servers, and hooks.

## Quick Start

```bash
npx @sentry/dotagents init
```

The interactive setup walks you through selecting agents and trust policy. Then add skills:

```bash
# Add a skill from a GitHub repo
npx @sentry/dotagents add getsentry/skills find-bugs

# Add multiple skills at once
npx @sentry/dotagents add getsentry/skills find-bugs code-review commit

# Or add all skills from a repo
npx @sentry/dotagents add getsentry/skills --all
```

This creates an `agents.toml` at your project root and an `agents.lock` tracking installed skills.

After cloning a project that already has `agents.toml`, run `install` to fetch everything:

```bash
npx @sentry/dotagents install
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create `agents.toml` and `.agents/skills/` |
| `add <source> [skills...]` | Add skill dependencies |
| `remove <name\|source> [-y]` | Remove a skill or all skills from a source |
| `install` | Install all dependencies from `agents.toml` |
| `list` | Show installed skills and their status |
| `sync` | Reconcile state offline: adopt local skills, prune stale managed ones, repair configs |
| `mcp` | Manage MCP server declarations |
| `trust` | Manage trusted sources |
| `doctor` | Check project health and fix issues |

All commands accept `--user` to operate on user scope (`~/.agents/`) instead of the current project.

## Source Formats

Skills can come from GitHub, GitLab, any git server, or local directories:

```toml
[[skills]]
name = "find-bugs"
source = "getsentry/skills"              # GitHub shorthand

[[skills]]
name = "review"
source = "getsentry/skills@v1.0.0"       # Pinned to a ref

[[skills]]
name = "gitlab-skill"
source = "https://gitlab.com/group/repo" # GitLab URL

[[skills]]
name = "internal"
source = "git:https://git.corp.dev/repo" # Any git server

[[skills]]
name = "local"
source = "path:./my-skills/local-skill"  # Local directory
```

Shorthand (`owner/repo`) resolves to GitHub by default. Set `defaultRepositorySource = "gitlab"` in `agents.toml` to resolve to GitLab instead.

## Agent Targets

The `agents` field tells dotagents which tools to configure:

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

[Pi](https://github.com/badlogic/pi-mono) reads `.agents/skills/` natively and needs no configuration.

## Documentation

For the full guide -- including MCP servers, hooks, trust policies, wildcard skills, user scope, and CI setup -- see the [documentation site](https://dotagents.sentry.dev).

## Contributing

```bash
git clone git@github.com:getsentry/dotagents.git
cd dotagents
pnpm install
pnpm check  # lint + typecheck + test
```

Requires Node.js 20+ and pnpm.

## License

MIT
