---
name: dotagents
description: Manage dotagents dependencies and runtime config. Use when asked to "add a skill", "install skills", "remove a skill", "configure plugins", "configure subagents", "dotagents init", "agents.toml", "agents.lock", "sync skills", "list skills", "set up dotagents", "configure trust", "add MCP server", "add hook", "wildcard skills", "global scope", "project scope", "dotagents doctor", or any dotagents-related task.
spec_hash: 618e5a1625a1
---

Manage dependencies declared in `agents.toml`. dotagents resolves skills, subagents, plugins, MCP servers, and hooks so agent tools (Claude Code, Cursor, Codex, Grok, VS Code, OpenCode, Pi) can use shared global or project config.

## Running dotagents

Always use `npx @sentry/dotagents` to run commands. Unqualified commands are global by default. Add `--project` whenever the user asks to manage the current repository. Do not infer project intent merely because the current directory contains `agents.toml`.

Apply this literally: “add this skill” with no repository-local wording means `npx @sentry/dotagents add ...`, even inside a repository that has `agents.toml`. “Add this skill to this repository/project” means `npx @sentry/dotagents --project add ...`.

Global `add` bootstraps `~/.agents/agents.toml` when it is missing. Do not run a separate global `init` or `install` before or after `add` unless the user independently requested it.

## References

Read the relevant reference when the task requires deeper detail:

| Document | Read When |
|----------|-----------|
| [references/cli-reference.md](references/cli-reference.md) | Full command options, flags, examples |
| [references/configuration.md](references/configuration.md) | Editing agents.toml, source formats, trust, MCP, hooks, wildcards, scopes |
| [references/config-schema.md](references/config-schema.md) | Exact field names, types, and defaults |

## Quick Start

```bash
# Initialize global state (interactive TUI)
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

For repository-local management, keep `--project` on every command:

```bash
npx @sentry/dotagents --project init
npx @sentry/dotagents --project add getsentry/skills find-bugs
npx @sentry/dotagents --project install
npx @sentry/dotagents --project list
npx @sentry/dotagents --project doctor --fix
```

## Commands

| Command | Description |
|---------|-------------|
| `npx @sentry/dotagents init` | Initialize global config and managed directories |
| `npx @sentry/dotagents install` | Install all dependencies from `agents.toml` |
| `npx @sentry/dotagents add <specifier>` | Add a skill dependency |
| `npx @sentry/dotagents remove <name>` | Remove a skill or plugin |
| `npx @sentry/dotagents sync` | Reconcile state (adopt orphans, prune stale managed artifacts, repair configs) |
| `npx @sentry/dotagents list` | Show declared skills, plugins, and status |
| `npx @sentry/dotagents mcp` | Add, remove, or list MCP server declarations |
| `npx @sentry/dotagents trust` | Add, remove, or list trusted sources |
| `npx @sentry/dotagents doctor` | Check global health and fix issues |

All commands default to global scope (`~/.agents/`). `--project` selects the current repository (or current directory outside Git). `--global` is an explicit global spelling, and `--user` is its compatibility alias. Never combine `--project` with a global alias.

For full options and flags, read [references/cli-reference.md](references/cli-reference.md).

## Safe Removal and Trust

Use `remove` instead of manually deleting managed files or editing `agents.lock`. For a project dependency, keep explicit scope: `npx @sentry/dotagents --project remove <name>`. When a wildcard provides the skill, let `remove` add the name to the wildcard's `exclude` list so the next install does not restore it.

When trust blocks a source, inspect syntax without mutation using `npx @sentry/dotagents trust add --help`. Then show the exact scoped command, such as `npx @sentry/dotagents trust add git.corp.example.com`, and explicitly ask approval before running it. Never enable `allow_all` or add a trusted source without explicit user intent.

## Source Formats

| Format | Example | Description |
|--------|---------|-------------|
| GitHub shorthand | `getsentry/skills` | Owner/repo (resolves to GitHub HTTPS) |
| GitHub pinned | `getsentry/warden@v1.0.0` | With tag, branch, or commit |
| GitHub SSH | `git@github.com:owner/repo.git` | SSH clone URL |
| GitHub HTTPS | `https://github.com/owner/repo` | Full HTTPS URL |
| Git URL | `git:https://git.corp.dev/team/skills` | Any non-GitHub git remote |
| Well-known HTTPS | `https://cli.sentry.dev` | HTTP source using `.well-known/skills/` |
| Local path | `path:./my-skills/custom` | Relative to the selected scope root |

## Key Concepts

- **Managed paths** live under `~/.agents/` globally or `.agents/` in project scope
- **`agents.toml`** declares dependencies; **`agents.lock`** tracks managed skills, subagents, and plugins
- **Symlinks**: agent skill directories point to the selected scope's managed skills directory
- **Wildcards**: `name = "*"` installs all skills from a source, with optional `exclude` list
- **Trust**: Optional `[trust]` section restricts which sources are allowed
- **Hooks**: `[[hooks]]` declarations write tool-event hooks to each agent's config
- **Subagents**: `[[subagents]]` declarations install portable or native subagent files
- **Plugins**: `[[plugins]]` declarations install canonical bundles and generate runtime-specific plugin outputs
- **Gitignore**: In project scope, managed skills, subagents, and plugin bundles are gitignored; custom in-place sources are tracked
- **Global scope**: the default; manages dependencies in `~/.agents/` shared across projects, including plugins
- **Project scope**: `--project` manages repository-local `agents.toml`, `agents.lock`, and `.agents/`
- **Updates**: Run `npx @sentry/dotagents install` to refresh managed skills, subagents, and plugins; there is no `update` command
