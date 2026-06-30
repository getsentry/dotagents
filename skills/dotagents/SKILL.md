---
name: dotagents
description: Manage dotagents dependencies and runtime config. Use when asked to "add a skill", "install skills", "remove a skill", "configure plugins", "configure subagents", "dotagents init", "agents.toml", "agents.lock", "sync skills", "list skills", "set up dotagents", "configure trust", "add MCP server", "add hook", "wildcard skills", "user scope", "dotagents doctor", or any dotagents-related task.
---

Manage dependencies declared in `agents.toml`. dotagents resolves skills, subagents, plugins, MCP servers, and hooks so agent tools (Claude Code, Cursor, Codex, Grok, VS Code, OpenCode, Pi) can use shared project config.

## Running dotagents

Always use `npx @sentry/dotagents` to run commands. For example: `npx @sentry/dotagents sync`.

## References

Read the relevant reference when the task requires deeper detail:

| Document | Read When |
|----------|-----------|
| [references/cli-reference.md](references/cli-reference.md) | Full command options, flags, examples |
| [references/configuration.md](references/configuration.md) | Editing agents.toml, source formats, trust, MCP, hooks, wildcards, scopes |
| [references/config-schema.md](references/config-schema.md) | Exact field names, types, and defaults |

## Quick Start

```bash
# Initialize a new project (interactive TUI)
npx @sentry/dotagents init

# Add a skill from GitHub
npx @sentry/dotagents add getsentry/skills find-bugs

# Add multiple skills at once
npx @sentry/dotagents add getsentry/skills find-bugs code-review commit

# Add all skills from a repo
npx @sentry/dotagents add getsentry/skills --all

# Add a pinned skill
npx @sentry/dotagents add getsentry/warden@v1.0.0

# Install or refresh all dependencies from agents.toml
npx @sentry/dotagents install

# List installed skills
npx @sentry/dotagents list
```

## Commands

| Command | Description |
|---------|-------------|
| `npx @sentry/dotagents init` | Initialize `agents.toml` and `.agents/` directory |
| `npx @sentry/dotagents install` | Install all dependencies from `agents.toml` |
| `npx @sentry/dotagents add <specifier>` | Add a skill dependency |
| `npx @sentry/dotagents remove <name>` | Remove a skill or plugin |
| `npx @sentry/dotagents sync` | Reconcile state (adopt orphans, prune stale managed artifacts, repair configs) |
| `npx @sentry/dotagents list` | Show declared skills, plugins, and status |
| `npx @sentry/dotagents mcp` | Add, remove, or list MCP server declarations |
| `npx @sentry/dotagents trust` | Add, remove, or list trusted sources |
| `npx @sentry/dotagents doctor` | Check project health and fix issues |

All commands accept `--user` to operate on user scope (`~/.agents/`) instead of the current project.

For full options and flags, read [references/cli-reference.md](references/cli-reference.md).

## Source Formats

| Format | Example | Description |
|--------|---------|-------------|
| GitHub shorthand | `getsentry/skills` | Owner/repo (resolves to GitHub HTTPS) |
| GitHub pinned | `getsentry/warden@v1.0.0` | With tag, branch, or commit |
| GitHub SSH | `git@github.com:owner/repo.git` | SSH clone URL |
| GitHub HTTPS | `https://github.com/owner/repo` | Full HTTPS URL |
| Git URL | `git:https://git.corp.dev/team/skills` | Any non-GitHub git remote |
| Well-known HTTPS | `https://cli.sentry.dev` | HTTP source using `.well-known/skills/` |
| Local path | `path:./my-skills/custom` | Relative to project root |

## Key Concepts

- **`.agents/skills/`** is the canonical home for skills; **`.agents/plugins/`** is the canonical home for plugins
- **`agents.toml`** declares dependencies; **`agents.lock`** tracks managed skills, subagents, and plugins
- **Symlinks**: `.claude/skills/`, `.cursor/skills/` point to `.agents/skills/`
- **Wildcards**: `name = "*"` installs all skills from a source, with optional `exclude` list
- **Trust**: Optional `[trust]` section restricts which sources are allowed
- **Hooks**: `[[hooks]]` declarations write tool-event hooks to each agent's config
- **Subagents**: `[[subagents]]` declarations install portable or native subagent files
- **Plugins**: `[[plugins]]` declarations install canonical bundles and generate runtime-specific plugin outputs
- **Gitignore**: Managed skills, subagents, and plugin bundles are gitignored; custom in-place sources are tracked
- **User scope**: `--user` flag manages skills in `~/.agents/` shared across all projects; plugins are project-scope only
- **Updates**: Run `npx @sentry/dotagents install` to refresh managed skills, subagents, and plugins; there is no `update` command
