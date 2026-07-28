# dotagents

Shared tooling for coding agents. Declare skills, MCP servers, hooks, and subagents in `agents.toml` — dotagents wires them into every agent tool on your team.

## Why dotagents?

**One source of truth.** Skills live in `.agents/skills/` and symlink into `.claude/skills/` or wherever your tools expect them. Cursor shares Claude-compatible skills. No copy-pasting between directories.

**One command to install.** `agents.toml` is committed, managed skills and canonical installed subagents under `.agents/` are gitignored. Collaborators run `dotagents install` to fetch or refresh local agent state.

**Shareable.** Skills are directories with a `SKILL.md`. Host them in any git repo, discover them automatically, install with one command.

**Multi-agent.** Configure Claude, Cursor, Codex, VS Code, and OpenCode from a single `agents.toml` -- skills, MCP servers, hooks, and subagents where supported. Pi reads `.agents/skills/` directly.

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

This creates an `agents.toml` at your project root and an `agents.lock` tracking installed skills and subagents. Project commands discover that repository root when run from a subdirectory.

After cloning a project that already has `agents.toml`, run `install` to fetch skills and subagents. Run it again to refresh managed local state:

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

`install --frozen` is a deprecated compatibility no-op. It warns, performs a normal install, and will be removed in the next major release. Use explicit `ref` values in `agents.toml` to pin sources.

## Source Formats

Skills can come from GitHub, GitLab, any git server, well-known HTTPS skill sources, or local directories:

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
name = "error-tracking"
source = "https://cli.sentry.dev"        # Well-known HTTPS source

[[skills]]
name = "local"
source = "path:./my-skills/local-skill"  # Local directory

[[skills]]
name = "*"
source = "getsentry/skills"
path = "skills/engineering"              # All skills under one subdirectory
```

Wildcard `path` is supported for Git and local sources and must name an existing directory inside the source; use `"."` for the complete source root. Well-known sources do not support wildcard paths. Discovered source-relative paths are stored in `agents.lock`, allowing `list` and offline `sync` to enforce the current scope. Legacy entries without path metadata remain selected until install refreshes them.

Shorthand (`owner/repo`) resolves to GitHub by default. Set `defaultRepositorySource = "gitlab"` in `agents.toml` to resolve to GitLab instead.

## Agent Targets

The `agents` field tells dotagents which tools to configure:

```toml
agents = ["claude", "cursor", "codex", "opencode"]
```

| Agent | Config Dir | MCP Config | Hooks | Subagents |
|-------|-----------|------------|-------|-----------|
| `claude` | `.claude` | `.mcp.json` | `.claude/settings.json` | `.claude/agents/*.md` |
| `cursor` | `.cursor` | `.cursor/mcp.json` | `.cursor/hooks.json` | `.cursor/agents/*.md` |
| `codex` | `.codex` | `.codex/config.toml` | -- | `.codex/agents/*.toml` |
| `vscode` | `.vscode` | `.vscode/mcp.json` | `.claude/settings.json` | -- |
| `opencode` | `.opencode` | `.opencode/opencode.jsonc` | -- | `.opencode/agents/*.md` |

For OpenCode, dotagents uses an existing config in this order: `.opencode/opencode.jsonc`, `.opencode/opencode.json`, `opencode.jsonc`, then `opencode.json`. New projects use `.opencode/opencode.jsonc`.

Install and sync repair currently declared MCP entries while preserving undeclared servers and unrelated content in every existing target file. When no servers are declared, existing MCP files remain unchanged because dotagents has no durable evidence that it owns them. Unreadable or structurally incompatible files are reported and left unchanged.

Install and sync repair the complete generated hook root when hooks are declared. When no hooks are declared, existing hook files remain unchanged because dotagents has no durable evidence that it owns them.

Custom subagents are declared with `[[subagents]]` entries. dotagents writes generated runtime-specific files during `install` and repairs them during `sync`:

```toml
[[subagents]]
name = "code-reviewer"
source = "getsentry/agent-pack"
targets = ["claude", "codex", "opencode"]
```

If `targets` is omitted or empty, dotagents targets every configured agent and warns for agents that do not support custom subagents.

dotagents discovers portable subagent Markdown from conventional source directories such as `agents/` and `.agents/agents/`. The frontmatter supplies the portable `name` and `description`; the body supplies the runtime instructions:

```md
---
name: code-reviewer
description: Review code for correctness, security, and missing tests.
---

Review the current diff and return findings with file references.
```

dotagents can also import native runtime subagent files from `.claude/agents/`, `.cursor/agents/`, `.codex/agents/*.toml`, and `.opencode/agents/`. Input and matching-runtime output use the same native format: Markdown with YAML frontmatter for Claude, Cursor, and OpenCode; TOML for Codex. Claude and Codex identify agents by `name`, Cursor can derive `name` from the filename when omitted, and OpenCode uses the filename as the agent name. Multiple portable matches for the same subagent are rejected as ambiguous, while matching native runtime artifacts are merged. When the source format matches a target runtime, dotagents reuses the native source content for that runtime and only adds its managed-file marker. Other runtimes are generated from the portable `name`, `description`, and instructions. Subagent declarations intentionally cover only dependency source and runtime targets, not universal model/tool/permission behavior.

[Pi](https://github.com/badlogic/pi-mono) reads `.agents/skills/` natively and needs no configuration.

## Documentation

For the full guide -- including MCP servers, hooks, subagents, trust policies, wildcard skills, user scope, and CI setup -- see the [documentation site](https://dotagents.sentry.dev).

## Contributing

```bash
git clone git@github.com:getsentry/dotagents.git
cd dotagents
pnpm install
pnpm check  # lint + typecheck + test
```

Requires Node.js 20+ and pnpm.

This repo is a pnpm workspace with two packages:

- [`packages/dotagents/`](packages/dotagents/) — `@sentry/dotagents`, the CLI and host library. Owns `agents.toml`, the `.agents/` convention, and the per-agent (Claude/Cursor/etc.) integrations.
- [`packages/dotagents-lib/`](packages/dotagents-lib/) — `@sentry/dotagents-lib`, the reusable core (SKILL.md loading, source resolution, trust validation). Depend on this directly if you want to consume agent skills from your own tooling without `agents.toml`.

Both packages are versioned in lock-step — see [`RELEASING.md`](RELEASING.md).

## License

MIT
