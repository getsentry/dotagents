# dotagents

Shared tooling for coding agents. Declare skills, MCP servers, hooks, subagents, and plugins in `agents.toml` — dotagents wires them into every agent tool on your team.

## Why dotagents?

**One source of truth.** Skills live in `.agents/skills/` and symlink into `.claude/skills/` or wherever your tools expect them. Cursor shares Claude-compatible skills. No copy-pasting between directories.

**One command to install.** Global dependencies live under `~/.agents/`. Repository-local dependencies can be declared in a committed `agents.toml`; collaborators run `dotagents --project install` to fetch or refresh that project's managed state.

**Shareable.** Skills are directories with a `SKILL.md`. Host them in any git repo, discover them automatically, install with one command.

**Multi-agent.** Configure Claude, Cursor, Codex, Grok, VS Code, and OpenCode from a single `agents.toml` -- skills, MCP servers, hooks, subagents, and plugins where supported. Pi reads `.agents/skills/` directly.

## Quick Start: Global by Default

```bash
npx @sentry/dotagents init
```

Without a scope flag, every command operates on global state under `~/.agents/`, even when run inside a repository. The interactive setup walks you through selecting agents and trust policy. Then add skills or plugins:

```bash
# Add a skill from a GitHub repo
npx @sentry/dotagents add getsentry/skills find-bugs

# Add multiple skills at once
npx @sentry/dotagents add getsentry/skills find-bugs code-review commit

# Or add all skills from a repo
npx @sentry/dotagents add getsentry/skills --all

# Add a plugin (auto-detected from the source)
npx @sentry/dotagents add getsentry/agent-plugins review-tools
```

This creates `~/.agents/agents.toml` and `~/.agents/agents.lock`, making the dependencies available across projects.

Run `install` again whenever you want to refresh global managed state:

```bash
npx @sentry/dotagents install
```

## Repository-Local Workflow

Use `--project` for repository-local state. Inside Git, dotagents uses the repository root; outside Git, `--project init` uses the current directory.

```bash
# Initialize this repository
npx @sentry/dotagents --project init

# Add a dependency only for this repository
npx @sentry/dotagents --project add getsentry/skills find-bugs

# After cloning or pulling a repository with agents.toml
npx @sentry/dotagents --project install

# Check and repair repository-local state
npx @sentry/dotagents --project doctor --fix
```

Project commands other than `init` require `agents.toml` and never fall back to global state. Existing project and global files are not copied, merged, or removed when switching scopes.

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create the selected scope's config and managed directories |
| `add <source> [names...]` | Discover and add plugins, otherwise skills; exact repeats refresh installation |
| `remove <name\|source> [-y]` | Remove a skill, plugin, or all dependencies from a source |
| `install` | Install all dependencies from `agents.toml` |
| `list` | Show declared skills, plugins, and their status |
| `sync` | Reconcile state offline: adopt local skills, prune stale managed ones, repair configs |
| `mcp` | Manage MCP server declarations |
| `trust` | Manage trusted sources |
| `doctor` | Check active-scope health, including plugin runtime projections, and fix supported issues |

All commands default to global scope (`~/.agents/`). `--global` selects it explicitly, and legacy `--user` remains a compatibility alias. `--project` selects repository-local state. Combining `--project` with either global alias is an error.

## Source Formats

Skills can come from GitHub, GitLab, any git server, well-known HTTPS skill sources, or local directories. Git and local sources are checked for plugins first. If any plugin is found, `add` treats the entire source as plugin-only; standalone and bundled skills in that source are not offered. Malformed plugin-shaped content is an error rather than a fallback to skills. Local plugin sources that overlap the project's managed `.agents/plugins` directory are rejected before configuration changes. Well-known HTTPS sources remain skill-only:

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
```

Shorthand (`owner/repo`) resolves to GitHub by default. Set `defaultRepositorySource = "gitlab"` in `agents.toml` to resolve to GitLab instead.

## Agent Targets

The `agents` field tells dotagents which tools to configure:

```toml
agents = ["claude", "cursor", "codex", "grok", "opencode", "pi"]
```

| Agent | Config Dir | MCP Config | Hooks | Subagents |
|-------|-----------|------------|-------|-----------|
| `claude` | `.claude` | `.mcp.json` | `.claude/settings.json` | `.claude/agents/*.md` |
| `cursor` | `.cursor` | `.cursor/mcp.json` | `.cursor/hooks.json` | `.cursor/agents/*.md` |
| `codex` | `.codex` | `.codex/config.toml` | -- | `.codex/agents/*.toml` |
| `grok` | `.grok` | -- | -- | -- |
| `vscode` | `.vscode` | `.vscode/mcp.json` | `.claude/settings.json` | -- |
| `opencode` | `.opencode` | `.opencode/opencode.jsonc` | -- | `.opencode/agents/*.md` |

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

OpenCode reuses an existing project config from `.opencode/opencode.jsonc`, `.opencode/opencode.json`, `opencode.jsonc`, or `opencode.json`, in that order. New projects use `.opencode/opencode.jsonc`.

Plugins are declared with `[[plugins]]` entries. In project scope, dotagents installs canonical bundles into `.agents/plugins/<name>/` and generates runtime plugin outputs such as `.claude-plugin/marketplace.json`, `.agents/plugins/<name>/.claude-plugin/plugin.json`, `.cursor-plugin/marketplace.json`, `.agents/plugins/<name>/.cursor-plugin/plugin.json`, `.agents/plugins/marketplace.json`, `.agents/plugins/<name>/.codex-plugin/plugin.json`, `.grok/plugins/<name>/`, `.opencode/skills/<skill>/`, OpenCode MCP entries, and Pi skill links under `.agents/skills/<skill>/` where supported. During legacy migration, generalized bundles can also project Markdown agents into `.opencode/agents/`; standard extension agents are preserved but are not projected yet:

```toml
[[plugins]]
name = "review-tools"
source = "getsentry/agent-plugins"
path = "plugins/review-tools"
targets = ["claude", "cursor", "codex", "grok", "opencode", "pi"]
```

The canonical portable format is an [Agent Plugins](https://agent-plugins.org/) v1 bundle: required `plugin.json`, optional `skills/`, optional `mcp.json`, and reverse-domain client extensions. dotagents preserves those portable source files under `.agents/plugins/<name>/` and generates isolated target harnesses. OpenCode receives portable MCP servers under managed keys such as `plugin.<plugin>.<server>`; `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded into the installed bundle and persistent `.agents/plugin-data/` paths. Generated JSON uses adjacent ownership sidecars, while component symlinks use markers in reserved `.dotagents-managed/` directories, so client-owned JSON remains unchanged. Legacy generalized and native Claude/Cursor/Codex manifests remain discoverable during migration. A valid standard root may also coexist with authored native manifests as a hybrid compatibility bundle: the portable root remains the source of truth, reproducible native manifests are ignored in favor of portable generation, and manifests with behavior an adapter cannot represent are retained byte-for-byte only as matching-client fallbacks. Generated adapters are disposable output and are never imported back into the portable core. Native commands, agents, hooks, MCP, and other resources never leak into unrelated targets. Invalid standard roots still fail instead of falling back to legacy parsing.

Global plugins install canonical bundles under `~/.agents/plugins/`. Claude and Cursor marketplaces are generated under `~/.agents/`, the Codex marketplace is generated at `~/.agents/plugins/marketplace.json`, Grok plugins are copied into `~/.grok/plugins/`, OpenCode skills are linked into `~/.config/opencode/skills/`, portable MCP servers are merged into `~/.config/opencode/opencode.json`, and Pi skills are linked into `~/.agents/skills/`. `--user` remains a compatibility alias for `--global`.

All generated marketplaces use the name `dotagents`. Native plugin selectors use `<name>@dotagents`.

Pi plugin targets are global skill projections rather than isolated plugin installs: a Pi-targeted plugin skill is added to `.agents/skills/` and is therefore visible to other clients that consume that shared directory.

[Pi](https://github.com/badlogic/pi-mono) reads `.agents/skills/` natively. Normal skills need no Pi-specific configuration; plugin bundles can target `pi` when their `skills/` components should be exposed there.

## Documentation

For the full guide -- including MCP servers, hooks, subagents, plugins, trust policies, wildcard skills, global and project scope, and CI setup -- see the [documentation site](https://dotagents.sentry.dev).

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
