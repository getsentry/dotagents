# dotagents Specification

## Overview

dotagents is shared tooling for coding agents. It manages agent skill dependencies using the [agentskills.io](https://agentskills.io) standard, and handles MCP servers, hooks, subagents, plugins, and symlinks so that multiple agent tools (Claude Code, Cursor, Codex, etc.) can be configured from a single `agents.toml`.

Declare what you need, run `dotagents install`, and skills appear in `.agents/skills/` with symlinks into each tool's expected directory. Plugins install into `.agents/plugins/`. MCP, hook, subagent, and plugin configs are generated per agent.

> **Implementation note.** The skill-loading, source-fetching, and trust-validation primitives that drive the CLI are factored into a separate npm package, [`@sentry/dotagents-lib`](../packages/dotagents-lib/), versioned in lock-step with `@sentry/dotagents`. The `agents.toml` grammar and the `.agents/` convention described below remain entirely the host's responsibility — the lib only knows about source strings, SKILL.md, and the cache.

### Why

Agent skills, MCP servers, hooks, and subagents are configured differently for every agent tool, and skills are distributed as loose folders copied from git repos. There's no way to declare what you need once and have it work everywhere, or to keep a team's agent setup in sync. dotagents fills this gap.

### Key Principles

- **`.agents/skills/` is the canonical home** for all skills (managed and custom)
- **`.agents/plugins/` is the canonical home** for all plugins (managed and custom)
- **`agents.toml`** declares what you want; **`agents.lock`** tracks what's managed
- **Selective gitignore**: managed skills, canonical installed subagents, and managed plugin bundles are gitignored; custom skills and project-authored plugin source directories are tracked
- **Subdirectory symlinks**: `.claude/skills/ -> .agents/skills/`, not full directory symlinks
- **agentskills.io format**: skills are folders with a `SKILL.md` file containing YAML frontmatter

---

## agents.toml

The manifest file. Lives at the project root.

### Schema

```toml
version = 1
agents = ["claude", "cursor", "codex", "grok", "opencode", "pi"]

[project]
name = "my-project"              # Optional. For display purposes.

[symlinks]
targets = [".claude", ".cursor"] # Creates <target>/skills/ -> .agents/skills/

[[skills]]
name = "find-bugs"
source = "getsentry/skills"

[[skills]]
name = "warden-skill"
source = "getsentry/warden"

[[skills]]
name = "internal-review"
source = "git:https://git.corp.example.com/team/skills.git"
ref = "v2.0.0"

[[skills]]
name = "my-custom-skill"
source = "path:../shared-skills/my-custom-skill"

[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]

[[mcp]]
name = "remote-api"
url = "https://mcp.example.com/sse"
headers = { Authorization = "Bearer tok" }

# HTTP server with secrets via env vars
[[mcp]]
name = "authed-api"
url = "https://${API_HOST}/mcp"
headers = { X-Api-Key = "${API_KEY}" }

[[subagents]]
name = "code-reviewer"
source = "getsentry/agent-pack"
targets = ["claude", "codex", "opencode"]

[[plugins]]
name = "review-tools"
source = "getsentry/agent-plugins"
path = "plugins/review-tools"
targets = ["claude", "cursor", "codex", "grok", "opencode", "pi"]
```

### Fields

#### Top-level

| Field | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Schema version. Always `1`. |
| `defaultRepositorySource` | No | Host used for shorthand `owner/repo` skill sources. Valid values: `github`, `gitlab`. Defaults to `github`. |
| `agents` | No | Array of agent tool IDs. Valid: `claude`, `cursor`, `codex`, `vscode`, `grok`, `opencode`, `pi`. Defaults to `[]`. When set, dotagents creates skills symlinks and runtime config files for each agent where supported. `grok` and `pi` are plugin-only targets. |
| `project` | No | Project metadata. |
| `symlinks` | No | Symlink configuration (legacy — prefer `agents` for new projects). |
| `skills` | No | Skill dependencies (array of tables). |
| `mcp` | No | MCP server declarations (array of tables). Generates agent-specific config files during install/sync. |
| `hooks` | No | Hook declarations (array of tables). Generates agent-specific hook config files during install/sync for agents that support hooks. |
| `subagents` | No | Custom subagent declarations (array of tables). Generates runtime-specific subagent files during install/sync for Claude, Cursor, Codex, and OpenCode. |
| `plugins` | No | Plugin declarations (array of tables). Installs canonical bundles into `.agents/plugins/` and generates runtime-specific plugin outputs during install/sync for Claude, Cursor, Codex, Grok, OpenCode, and Pi skill projection. |
| `trust` | No | Trusted source restrictions. When absent, all sources allowed. See `[trust]` below. |
| `minimum_release_age` | No | Minimum age in **minutes** a commit must have before it's eligible for install. Applies to all git skills, subagents, and plugins (pinned and unpinned). For unpinned sources, resolves to the newest qualifying commit. For pinned sources (`ref`), rejects if the pinned commit is too new. Install fails with an error if no qualifying commit exists. When absent, always uses HEAD. |
| `minimum_release_age_exclude` | No | Sources excluded from the age gate. Accepts org names (`"myorg"` matches all repos), org/repo (`"myorg/skills"` exact match), or org wildcards (`"myorg/*"`). Defaults to `[]`. |

**Age gate semantics:**
- `minimum_release_age` absent → no age gating (default behavior)
- `minimum_release_age` set → for git skills, subagents, and plugins, enforce commit age. Unpinned sources resolve to the newest qualifying commit; pinned sources error if the ref is too new
- `minimum_release_age_exclude` → listed sources bypass the age gate entirely (useful for internal/trusted repos)
- Local `path:` sources and well-known skills are unaffected
- The age check uses the git committer date, which reflects when code landed on the branch

#### `[trust]`

Optional section to restrict which skill, subagent, and plugin sources are allowed. Useful for teams that want to lock down agent dependency provenance.

```toml
# Restrictive: only allow specific sources
[trust]
github_orgs = ["getsentry", "anthropics"]      # owner/repo where owner matches
github_repos = ["external-org/one-approved"]    # exact owner/repo match
git_domains = ["git.corp.example.com"]          # domain extracted from git: URLs

# Explicit opt-out: trust everything (makes intent clear in shared repos)
[trust]
allow_all = true
```

| Field | Required | Description |
|-------|----------|-------------|
| `allow_all` | No | When `true`, all sources are allowed (ignores other fields). Defaults to `false`. |
| `github_orgs` | No | Array of GitHub org/user names. A GitHub source `owner/repo` passes if `owner` matches. Defaults to `[]`. |
| `github_repos` | No | Array of exact `owner/repo` strings. Defaults to `[]`. |
| `git_domains` | No | Array of domain names or domain path prefixes. A `git:` source passes if its domain (or domain/path) matches. Supports path prefixes for scoping trust to specific orgs or groups (e.g., `gitlab.com/myorg`). Defaults to `[]`. |

**Semantics:**
- `[trust]` absent → all sources allowed (backward compat)
- `allow_all = true` → all sources allowed (explicit intent)
- `[trust]` present without `allow_all` → only matching sources allowed (allow-list)
- A source passes if it matches ANY rule (org OR repo OR domain/path prefix)
- `git_domains` entries match by prefix: `gitlab.com` matches all repos on GitLab, `gitlab.com/myorg` matches repos under that org, `gitlab.com/myorg/repo` matches only that repo
- Local `path:` sources are always allowed (already sandboxed to project root)

Trust is checked before any network work in `dotagents add` for skills and `dotagents install` for configured skills, subagents, and plugins.

#### `[project]`

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Project name for display. |

#### `[symlinks]`

| Field | Required | Description |
|-------|----------|-------------|
| `targets` | No | Array of directories to symlink. Each gets a `skills/` subdirectory pointing to `.agents/skills/`. Defaults to `[]`. |

#### `[[skills]]`

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill name. Must start with alphanumeric and contain only `[a-zA-Z0-9._-]`. |
| `source` | Yes | Skill source. `owner/repo` (resolved via `defaultRepositorySource`), `owner/repo@ref`, GitHub/GitLab URLs, well-known `https://<domain>` sources, `git:<url>`, or `path:<relative>`. |
| `ref` | No | Git ref (tag, branch, or SHA). Can also be specified inline as `owner/repo@ref`. Defaults to repo's default branch. |
| `path` | No | Explicit subdirectory path to the skill within the repo. Only needed when automatic discovery fails. |

#### `[[mcp]]`

MCP server declarations. Each entry defines an MCP server that dotagents will configure for the agents listed in the `agents` field.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Server name (used as key in generated config files). |
| `command` | Conditional | Command to run (stdio transport). Required if `url` is not set. |
| `args` | No | Arguments for the command. Defaults to `[]`. |
| `url` | Conditional | URL for HTTP/SSE transport. Required if `command` is not set. |
| `headers` | No | HTTP headers (only for `url` servers). Supports `${VAR}` syntax for env var interpolation. |
| `env` | No | Array of environment variable names. Values are referenced from the user's environment. Defaults to `[]`. |

A server must have either `command` (stdio) or `url` (HTTP), but not both.

**Environment variable interpolation.** Use `${VAR}` in header values and `url` to reference secrets from the environment (e.g. `headers = { X-Api-Key = "${API_KEY}" }`). Write `${VAR}` in `agents.toml` — dotagents translates it to each agent's native syntax when generating config files:

| Agent | Output syntax |
|-------|---------------|
| Claude Code | `${VAR}` (unchanged) |
| Cursor | `${env:VAR}` |
| VS Code | `${env:VAR}` |
| OpenCode | `{env:VAR}` |
| Codex | Pure `${VAR}` refs move to a separate `env_http_headers` field. Mixed values like `"Bearer ${TOKEN}"` stay as literals in `http_headers` (Codex limitation). |

#### `[[hooks]]`

Hook declarations. Each entry defines a hook that dotagents will configure for agents that support hooks (Claude, Cursor, VS Code).

| Field | Required | Description |
|-------|----------|-------------|
| `event` | Yes | Hook event: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, or `Stop`. |
| `matcher` | No | Tool name to match (e.g. `Bash`). Only for `PreToolUse` and `PostToolUse`. |
| `command` | Yes | Shell command to execute when the hook fires. |

#### `[[subagents]]`

Custom subagent dependencies. Each entry selects one subagent artifact from a source. dotagents imports the artifact into a portable subagent declaration, installs canonical managed Markdown into `.agents/agents/`, and writes generated runtime files for agents listed in `agents` that support custom subagents: Claude, Cursor, Codex, and OpenCode.

Subagents are best-effort portable dependencies, not a universal behavior schema. dotagents preserves native artifacts for their matching runtime and converts only from the portable `name`, `description`, and instructions when the target runtime is different.

See [Subagents Specification](subagents.md) for discovery order, native input/output formats, naming rules, merge behavior, and non-goals.

```md
---
name: code-reviewer
description: Review code for correctness, security, and missing tests.
---

Review the current diff and return findings with file references.
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Subagent name to discover. Must start with lowercase `a-z` and contain only lowercase letters, numbers, and hyphens. |
| `source` | Yes | Source repository or local directory. Supports GitHub/GitLab shorthands, git URLs, and `path:` sources; HTTPS well-known skill indexes are not supported for subagents. |
| `ref` | No | Optional git ref override. |
| `path` | No | Optional explicit subagent file path inside the source. Markdown paths are portable or native Markdown; `.toml` paths are treated as Codex native artifacts. |
| `targets` | No | Optional subset of agent IDs. When absent or empty, defaults to every configured agent in `agents`; unsupported agents produce warnings. |

dotagents intentionally does not standardize runtime-specific subagent behavior such as model routing, tool permissions, read-only modes, background execution, or reasoning effort. Those controls differ across runtimes and should stay in each tool's native config until there is a maintainable common contract.

Installed and generated files are marked as dotagents-managed with a generated header marker. `install` and `sync` overwrite stale managed files and prune removed managed files, but they do not overwrite hand-written files without the generated header marker. The deprecated `--frozen` flag is accepted as a warned compatibility no-op and does not change this behavior.

Generated paths:

| Agent | Project Scope | User Scope | Format |
|-------|---------------|------------|--------|
| Claude Code | `.claude/agents/<name>.md` | `~/.claude/agents/<name>.md` | Markdown with YAML frontmatter |
| Cursor | `.cursor/agents/<name>.md` | `~/.cursor/agents/<name>.md` | Markdown with YAML frontmatter |
| Codex | `.codex/agents/<name>.toml` | `~/.codex/agents/<name>.toml` | TOML |
| OpenCode | `.opencode/agents/<name>.md` | `~/.config/opencode/agents/<name>.md` | Markdown with YAML frontmatter |

#### `[[plugins]]`

Plugin dependencies. Each entry selects one plugin bundle from a source. dotagents installs the canonical plugin bundle into `.agents/plugins/<name>/` and writes deterministic runtime-specific plugin outputs for the configured agents selected by the plugin's `targets`.

The target canonical plugin input is an [Agent Plugins](https://agent-plugins.org/) bundle under `.agents/plugins/<name>/`: required `plugin.json`, optional `skills/`, optional `mcp.json`, and client-specific extension namespaces. dotagents source declarations, lock entries, marketplaces, target selection, and generated runtime files remain management concerns outside the portable bundle. Generated Claude, Cursor, and Codex marketplaces or native manifests are adapters, not source-of-truth plugin metadata.

See [Plugin Support Specification](plugins.md) for the Agent Plugins-aligned bundle contract, legacy migration plan, discovery rules, normalized internal model, downstream target transformations, and implementation gaps.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Plugin name to discover. Must start with lowercase `a-z`, end with lowercase `a-z` or `0-9`, and contain only lowercase letters, numbers, hyphens, and dots. |
| `source` | Yes | Source repository or local directory. Supports GitHub/GitLab shorthands, git URLs, and `path:` sources; HTTPS well-known skill indexes are not supported for plugins. |
| `ref` | No | Optional git ref override. |
| `path` | No | Optional explicit plugin directory path inside the source. |
| `targets` | No | Optional subset of configured agent IDs. When absent or empty, defaults to every configured agent in `agents`; targets not listed in top-level `agents` are skipped with a warning. |

Generated project-scope plugin outputs in the current implementation (before
the Agent Plugins migration described in `specs/plugins.md`):

| Agent | Project Scope Output |
|-------|----------------------|
| Claude Code | `.claude-plugin/marketplace.json`; `.agents/plugins/<name>/.claude-plugin/plugin.json` |
| Cursor | `.cursor-plugin/marketplace.json`; `.agents/plugins/<name>/.cursor-plugin/plugin.json` |
| Codex | `.agents/plugins/marketplace.json`; `.agents/plugins/<name>/.codex-plugin/plugin.json` |
| Grok Build | `.grok/plugins/<name>/` managed copy |
| OpenCode | Plugin `skills/` symlinked into `.opencode/skills/`; plugin Markdown `agents/` symlinked into `.opencode/agents/` |
| Pi | Plugin `skills/` symlinked into `.agents/skills/` when `pi` is a configured plugin target |

Generated plugin JSON is stable: keys are sorted, plugin entries are sorted by name, and files end with one trailing newline. Generated marketplaces and Claude/Cursor/Codex manifests use adjacent `.dotagents-managed` sidecars so client-owned JSON remains schema-native; legacy `metadata.managedBy` output remains recognizable during migration. Managed Grok copies and OpenCode/Pi component symlinks are pruned when their plugin or target is removed. Plugin sources that resolve to this project's `.agents/plugins/<name>/` install destination are rejected so dotagents never installs a same-repo plugin onto itself. Existing plugin install destinations are overwritten only when their on-disk `.dotagents-managed` marker proves ownership.

Plugins are currently project-scope only. `install --user` rejects `[[plugins]]` entries because user-scope runtime plugin projections are not generated yet.

#### Supported Agents

| ID | Tool | Config Dir | MCP File | MCP Format | Subagents |
|----|------|-----------|----------|------------|-----------|
| `claude` | Claude Code | `.claude` | `.mcp.json` | JSON | `.claude/agents/*.md` |
| `cursor` | Cursor | `.cursor` | `.cursor/mcp.json` | JSON | `.cursor/agents/*.md` |
| `codex` | Codex | `.codex` | `.codex/config.toml` | TOML (shared) | `.codex/agents/*.toml` |
| `grok` | Grok Build | `.grok` | Not generated | Not generated | Not generated |
| `vscode` | VS Code Copilot | `.vscode` | `.vscode/mcp.json` | JSON | Not supported |
| `opencode` | OpenCode | `.opencode` | `.opencode/opencode.jsonc` | JSONC (shared) | `.opencode/agents/*.md` |

Each agent has its own MCP config format. dotagents translates the universal `[[mcp]]` declarations into the format each tool expects during `install` and `sync`. Grok is currently supported for plugin projections only.

### Source Types

The source format is inferred from the value. Shorthand `owner/repo` resolves using `defaultRepositorySource` (default: GitHub).

#### `owner/repo` -- shorthand (most common)

Resolves to `https://github.com/<owner>/<repo>.git` by default, or `https://gitlab.com/<owner>/<repo>.git` when `defaultRepositorySource = "gitlab"`. The skill is discovered by scanning the repo for SKILL.md files matching the skill name.

```toml
[[skills]]
name = "find-bugs"
source = "getsentry/skills"
# -> clone https://github.com/getsentry/skills.git
# -> discover skill named "find-bugs" in conventional directories

[[skills]]
name = "warden-skill"
source = "getsentry/warden"
ref = "v1.0.0"
# -> clone, checkout v1.0.0, discover "warden-skill"
```

Ref pinning can also be inline: `source = "getsentry/warden@v1.0.0"`

#### `https://github.com/...` / `https://gitlab.com/...` -- explicit hosted URL

Use explicit URLs when you want to pin the host per source instead of relying on `defaultRepositorySource`.

#### Skill discovery within a repo

After cloning, dotagents scans these base directories (in priority order) for a skill matching the name:

1. `.` (repo root)
2. `skills/`
3. `.agents/skills/`
4. `.claude/skills/`

The repo root (`.`) is scanned **flat** — only direct children are checked. The other base directories (`skills/`, `.agents/skills/`, `.claude/skills/`) are scanned **recursively**: dotagents walks the directory tree looking for directories containing `SKILL.md`. When a `SKILL.md` is found, that directory is treated as a skill and its children are not descended into. This supports both flat layouts (`skills/<name>/SKILL.md`) and categorized layouts (`skills/<category>/<name>/SKILL.md`, `skills/<org>/<team>/<name>/SKILL.md`, etc.).

Additionally, the root directory itself is checked for a `SKILL.md` file as a fallback after child directories. This supports single-skill repositories where the entire repo is one skill, with the skill name derived from the SKILL.md frontmatter `name` field.

Matching proceeds in two phases:
1. **Directory name match**: the skill directory's name matches the requested skill name
2. **Frontmatter name match**: the `name` field in SKILL.md's YAML frontmatter matches the requested skill name

Directory name matches take priority over frontmatter matches. Earlier base directories take priority over later ones.

Additionally, the **marketplace format** is supported: `plugins/*/skills/<name>/SKILL.md` (requires `.claude-plugin/` marker directory).

If discovery fails, the `path` field can be used as an explicit override:

```toml
[[skills]]
name = "my-skill"
source = "myorg/monorepo"
path = "tools/agent-skills/my-skill"
```

#### `https://<domain>` -- well-known HTTP discovery

For skill servers that serve skills via the `.well-known/skills/` convention. dotagents fetches `{url}/.well-known/skills/index.json` to discover available skills, then downloads each skill's files.

```toml
[[skills]]
name = "error-tracking"
source = "https://cli.sentry.dev"
```

Any bare `https://` URL that doesn't match GitHub or GitLab patterns is treated as a well-known source candidate. If the well-known endpoint doesn't exist, the error message suggests using the `git:` prefix.

Skills are cached locally with the same 24h TTL as git sources. On fetch failure with existing cache, stale cache is used (same offline behavior as git).

#### `git:<url>` -- non-GitHub git

For self-hosted GitLab, corporate git servers, etc. Same discovery logic applies.

```toml
[[skills]]
name = "internal-review"
source = "git:https://git.corp.example.com/team/skills.git"
ref = "main"
```

#### `path:<relative-path>` -- local filesystem

Relative to the project root. Copied (not symlinked) into `.agents/skills/` during install.

```toml
[[skills]]
name = "my-custom-skill"
source = "path:../shared-skills/my-custom-skill"
```

Local path skills are re-copied on each install.

---

## agents.lock

The lockfile. Lives at the project root alongside `agents.toml`. TOML format.

**This file is auto-generated.** Do not edit manually. Gitignored automatically (`dotagents init` adds it to `.gitignore`).

### Format

```toml
# Auto-generated by dotagents. Do not edit.
version = 1

[skills.find-bugs]
source = "getsentry/skills"
resolved_url = "https://github.com/getsentry/skills.git"
resolved_path = "plugins/sentry-skills/skills/find-bugs"
resolved_commit = "0123456789abcdef0123456789abcdef01234567"

[skills.warden-skill]
source = "getsentry/warden"
resolved_url = "https://github.com/getsentry/warden.git"
resolved_path = ".claude/skills/warden-skill"
resolved_commit = "89abcdef0123456789abcdef0123456789abcdef"

[skills.error-tracking]
source = "https://cli.sentry.dev"
resolved_url = "https://cli.sentry.dev"

[skills.my-custom-skill]
source = "path:../shared-skills/my-custom-skill"

[subagents.code-reviewer]
source = "getsentry/agent-pack"
resolved_url = "https://github.com/getsentry/agent-pack.git"
resolved_path = "agents/code-reviewer.md"
resolved_commit = "fedcba9876543210fedcba9876543210fedcba98"

[subagents.local-reviewer]
source = "path:../shared-agents"

[plugins.review-tools]
source = "getsentry/agent-plugins"
resolved_url = "https://github.com/getsentry/agent-plugins.git"
resolved_path = "plugins/review-tools"
resolved_commit = "0123456789abcdef0123456789abcdef01234567"

[plugins.local-tools]
source = "path:../shared-plugins/local-tools"
```

### Fields per skill

| Field | Present For | Description |
|-------|-------------|-------------|
| `source` | All | Original source specifier from agents.toml. |
| `resolved_url` | Git and well-known sources | Resolved clone URL or HTTP base URL. |
| `resolved_path` | Git sources | Subdirectory within the repo where the skill was discovered. |
| `resolved_ref` | Git sources (optional) | The ref that was resolved (tag/branch name). Omitted when using default branch. |
| `resolved_commit` | Git sources (optional) | Full 40-char commit SHA that was installed. **Informational only** — not used for resolution. The lockfile is not checked in, so this field must never be relied on for locking behavior. |

### Fields per subagent

Subagent lock entries use the same source-resolution fields under `[subagents.<name>]`. Git subagents record the resolved clone URL, discovered or explicit subagent file path, optional ref, and installed commit. Local `path:` subagents record `source` only.

| Field | Present For | Description |
|-------|-------------|-------------|
| `source` | All | Original source specifier from agents.toml. |
| `resolved_url` | Git sources | Resolved clone URL. |
| `resolved_path` | Git sources | File path within the repo where the subagent was discovered or loaded from. |
| `resolved_ref` | Git sources (optional) | The ref that was resolved (tag/branch name). Omitted when using default branch. |
| `resolved_commit` | Git sources (optional) | Full 40-char commit SHA that was installed. Informational only. |

### Fields per plugin

Plugin lock entries use the same source-resolution fields under `[plugins.<name>]`. Git plugins record the resolved clone URL, discovered or explicit plugin directory path, optional ref, and installed commit. Local `path:` plugins record `source` only.

| Field | Present For | Description |
|-------|-------------|-------------|
| `source` | All | Original source specifier from agents.toml. |
| `resolved_url` | Git sources | Resolved clone URL. |
| `resolved_path` | Git sources | Directory path within the repo where the plugin was discovered or loaded from. |
| `resolved_ref` | Git sources (optional) | The ref that was resolved (tag/branch name). Omitted when using default branch. |
| `resolved_commit` | Git sources (optional) | Full 40-char commit SHA that was installed. Informational only. |

---

## CLI Commands

The CLI binary is `dotagents`. During development, run it with `pnpm dev -- <command>` or `tsx`. Published packages are built with `tsc` and run on Node.js 20+.

### `dotagents init`

Initialize a new project.

```
dotagents init [--force] [--agents claude,cursor]
```

**Behavior:**
1. Create `agents.toml` with `version = 1` and a bootstrap `dotagents` skill from `getsentry/dotagents`
2. Create `.agents/skills/` directory
3. Generate `.agents/.gitignore`
4. Add `agents.lock` and `.agents/.gitignore` to the root `.gitignore`
5. If symlink targets or agents are configured, set up symlinks
6. Attempt to install the bootstrap skill (best-effort — warns on failure)
7. (Interactive, project scope) Offer to install a git `post-merge` hook that runs `dotagents install` on pull (defaults to no). The hook tries `dotagents` first, falling back to `npx --yes @sentry/dotagents`.
8. Print next steps

**Flags:**
- `--force`: Overwrite existing `agents.toml`
- `--agents <list>`: Comma-separated list of agent IDs to include in config (e.g. `claude,cursor`)

### `dotagents install`

Install all dependencies from `agents.toml`.

```
dotagents install
```

**Behavior:**
1. Read `agents.toml`
2. For each skill:
   a. Resolve source (check cache with TTL-based refresh, clone/fetch if needed)
   b. Discover skill within the repo
   c. Copy skill directory into `.agents/skills/<name>/`
3. Resolve configured subagents
4. Resolve and install configured project-scope plugins into `.agents/plugins/<name>/`; reject user-scope plugin declarations
5. Write `agents.lock` with the current configured skills, subagents, and plugins
6. Install configured subagents into `.agents/agents/`
7. Regenerate `.agents/.gitignore`
8. Warn if `agents.lock` and `.agents/.gitignore` are not in the root `.gitignore`
9. Create/verify symlinks (legacy `[symlinks]` and agent-specific)
10. Write MCP config files for each declared agent
11. Write hook config files for each declared agent that supports hooks
12. Write generated subagent files for each declared agent that supports custom subagents
13. Write generated plugin runtime projections for each declared agent that supports plugins
14. Print summary

The deprecated `--frozen` option is accepted for compatibility, prints a warning, and follows this normal install flow. Use explicit `ref` values to pin sources.

### `dotagents add <specifier>`

Add one or more skill dependencies.

```
dotagents add <specifier> [<skill>...] [--skill <name>...] [--ref <ref>] [--all]
```

**Examples:**
```bash
dotagents add getsentry/skills find-bugs
dotagents add getsentry/skills find-bugs code-review commit
dotagents add getsentry/skills --skill find-bugs --skill code-review
dotagents add getsentry/warden warden-skill --ref v1.0.0
dotagents add getsentry/skills --all
dotagents add path:../shared-skills/my-skill
dotagents add myorg/single-skill-repo   # auto-detects if repo has one skill
```

**Behavior:**
1. Validate source against trust policy before any network operations
2. Parse specifier to determine source type
3. Clone/fetch repo to cache
4. Discover skill(s) in the repo
   - If skill names are given (positional or `--skill`), verify each exists in the source
   - If `--all`, add a wildcard entry for the entire source
   - If repo has exactly one skill, use it automatically
   - If repo has multiple skills and no names given, show interactive picker (TTY) or list them (non-TTY)
5. When adding multiple skills, skip any that already exist in `agents.toml` (with a warning). Error only if all specified skills already exist.
6. Add `[[skills]]` entry to `agents.toml` for each new skill
7. Run install to fetch and place the skills
8. Update `agents.lock`

**Flags:**
- `--ref <ref>`: Pin to a specific tag/branch/commit
- `--skill <name>` (repeatable): Specify which skill(s) to add. Alternative to positional arguments.
- `--all`: Add all skills from the source as a wildcard entry

Positional skill names and `--skill` flags cannot be mixed.

### `dotagents remove <name|source> [-y]`

Remove a skill or plugin dependency, or all skills and plugins from a source.

```
dotagents remove <name|source> [-y]
```

**Behavior (single dependency):**
1. Remove matching `[[skills]]` or `[[plugins]]` entry from `agents.toml`
2. Delete the managed installed artifact (`.agents/skills/<name>/` for skills or `.agents/plugins/<name>/` for managed plugins)
3. Remove entry from the relevant `agents.lock` section
4. Prune generated plugin runtime outputs when removing a plugin
5. Regenerate `.agents/.gitignore`

**Behavior (source removal):**
When the argument matches a source specifier (e.g. `owner/repo`, a URL) rather than a dependency name, removes all skills and plugins from that source:
1. Find all skills and plugins from the source (explicit entries from config + wildcard-expanded skill entries from lockfile)
2. Confirm with the user (unless `-y` is passed)
3. Remove all matching `[[skills]]` and `[[plugins]]` entries from `agents.toml`
4. Delete managed installed artifacts and lockfile entries
5. Prune generated plugin runtime outputs for removed managed plugins
6. Regenerate `.agents/.gitignore`

**Flags:**
- `-y`, `--yes`: Skip confirmation prompt

### `dotagents sync`

Reconcile actual state with declared state.

```
dotagents sync
```

**Behavior:**
1. Adopt orphaned local skills (installed but not in `agents.toml`, and not previously managed) into config
2. Prune stale managed skills that were removed from config but still exist on disk locally
3. Regenerate `.agents/.gitignore`
4. Warn if `agents.lock` and `.agents/.gitignore` are not in the root `.gitignore`
5. Check for missing skills (in `agents.toml` but not installed)
6. Create/verify/repair symlinks
7. Verify and repair MCP config files for declared agents
8. Verify and repair hook config files for declared agents
9. Verify and repair generated subagent files for declared agents
10. Verify and repair generated plugin runtime projections for declared agents

### `dotagents mcp`

Manage MCP server declarations.

```
dotagents mcp add <name> --command "<cmd> [args...]" [--env <VAR>...]
dotagents mcp add <name> --url <url> [--header <Key:Value>...] [--env <VAR>...]
dotagents mcp remove <name>
dotagents mcp list [--json]
```

**Behavior:**
- `add`: Append an `[[mcp]]` entry to `agents.toml` and run install to generate agent configs. Each server uses either `--command` (stdio) or `--url` (HTTP), not both.
- `remove`: Remove the named `[[mcp]]` entry from `agents.toml` and run install.
- `list`: Show declared MCP servers with transport type, target, and environment variables.

### `dotagents trust`

Manage trusted sources.

```
dotagents trust add <source>
dotagents trust remove <source>
dotagents trust list [--json]
```

**Source classification** (automatic, no flags needed):
- Contains `/` → `github_repos` (e.g., `external-org/specific-repo`)
- Contains `.` (no `/`) → `git_domains` (e.g., `git.corp.example.com`)
- Otherwise → `github_orgs` (e.g., `getsentry`)

When `defaultRepositorySource = "gitlab"`, shorthand sources (without dots) are expanded to `gitlab.com/...` and stored in `git_domains` instead. For example, `trust add myorg` becomes `gitlab.com/myorg` in `git_domains`.

**Behavior:**
- `add`: Classify the source, check for duplicates (case-insensitive), and append it to the appropriate field in `[trust]`. Creates the section if absent.
- `remove`: Remove the source from the appropriate field (case-insensitive). Removes the field line if the array becomes empty.
- `list`: Show trusted sources with their type. Use `--json` for machine-readable output.

### `dotagents doctor`

Check project health and fix issues.

```
dotagents doctor [--fix]
```

**Checks:**
1. `agents.toml` exists
2. No legacy fields (`pin`, `gitignore`) in `agents.toml`
3. No legacy fields (`commit`, `integrity`) in `agents.lock`
4. Root `.gitignore` has required entries (`agents.lock`, `.agents/.gitignore`)
5. `.agents/.gitignore` exists
6. `.agents/skills/` directory exists
7. All declared skills are installed
8. All declared plugins are installed
9. Symlinks are intact

**Flags:**
- `--fix`: Auto-fix issues where possible (add gitignore entries, remove legacy fields, create missing `.agents/.gitignore`)

### `dotagents list`

Show declared skills, plugins, and status.

```
dotagents list [--json]
```

**Status indicators:**
- `✓` ok — installed and present in lockfile
- `✗` missing — in agents.toml but not installed
- `?` unlocked — installed but not in lockfile

**Output:** name, source, status. Human output groups results under `Skills:` and `Plugins:` when both are present. JSON output is an object with `skills` and `plugins` arrays.

---

## Skill Resolution

How dotagents resolves a specifier to a concrete skill directory.

### Resolution Flow

```
Source string
  |
  ├─ starts with "path:" -> Resolve relative to project root
  ├─ starts with "git:"  -> Parse URL, clone, discover skill by name
  └─ otherwise           -> Parse as owner/repo[@ref], clone from GitHub, discover skill by name
        |
        v
  Clone/fetch repo to cache (~/.local/dotagents/owner/repo/ or owner/repo@sha/)
        |
        v
  Discover skill: scan conventional directories for SKILL.md matching skill name
  (or use explicit `path` field if discovery fails)
        |
        v
  Parse YAML frontmatter, validate (requires `name` and `description`)
        |
        v
  Copy skill directory to .agents/skills/<name>/
```

### Caching

Cache location: `~/.local/dotagents/` (overridable via `DOTAGENTS_STATE_DIR`)

Structure:
- `owner/repo/` -- shallow git clone, refreshed on every install
- `<https-domain>/` -- well-known HTTPS cache, refreshed after a 24-hour TTL

Git operations (all non-interactive: `GIT_TERMINAL_PROMPT=0`, SSH `BatchMode=yes`):
- Initial: `git clone --depth=1`
- Update: `git fetch --depth=1 origin && git reset --hard FETCH_HEAD`

### Skill Validation

A valid skill directory must contain:
- `SKILL.md` with YAML frontmatter (delimited by `---`)
- Frontmatter must include `name` (string) and `description` (string)

The YAML frontmatter is parsed with the `yaml` package. `allowed-tools` can be a space-delimited string or a YAML list.

---

## Gitignore Strategy

dotagents always manages gitignore. Two files are added to the root `.gitignore` during `init`:
- `agents.lock` — tracks managed skills, subagents, and plugins
- `.agents/.gitignore` — excludes managed skill directories, canonical installed subagent files, and managed plugin bundles from git

### How It Works

Managed (external) skills, canonical installed subagent files, and managed copied plugin bundles are gitignored. Custom local skills and project-authored plugin source directories in `.agents/plugins/<name>/` are tracked when they are not installed dependencies. dotagents generates `.agents/.gitignore` listing every managed skill, installed subagent, and managed plugin bundle:

```gitignore
# Auto-generated by dotagents. Do not edit.
# Managed artifacts (installed by dotagents)
/skills/find-bugs/
/skills/warden-skill/
/agents/code-reviewer.md
/plugins/review-tools/
```

Custom skills in `.agents/skills/my-local-skill/` and canonical local plugins in `.agents/plugins/my-plugin/` are NOT listed, so git tracks them normally.

### Regeneration

`.agents/.gitignore` is regenerated on every:
- `dotagents install`
- `dotagents add`
- `dotagents remove`
- `dotagents sync`

### Health Checks

`install` and `sync` warn if gitignore entries are missing but do not modify the root `.gitignore`. Run `dotagents doctor --fix` to add them.

### Edge Cases

- **Custom skill name collides with managed skill**: `dotagents add` refuses to install if `.agents/skills/<name>/` already exists and is tracked by git
- **Someone commits a managed skill**: `dotagents sync` detects this and warns

---

## Symlink Strategy

### Problem

Each agent tool has its own directory with tool-specific files:
- `.claude/` -- `settings.json`, `commands/`, `skills/`
- `.cursor/` -- `rules/`, MCP, hooks, agents
- `.codex/` -- config, agents

Symlinking the entire directory (e.g., `.claude/ -> .agents/`) would clobber tool-specific files.

### Solution

Symlink only the `skills/` subdirectory for agents that need one. Cursor uses Claude-compatible skills, so it shares `.claude/skills/`:

```
.claude/skills/  -> .agents/skills/
```

`.agents/skills/` is the canonical home. Legacy `[symlinks]` targets can still create additional `<target>/skills/` symlinks when explicitly configured.

### Configuration

```toml
[symlinks]
targets = [".claude", ".cursor"]
```

For each target in the array, dotagents creates `<target>/skills/ -> .agents/skills/`.

### Behavior

- Parent directory (`.claude/`) is created if it doesn't exist
- If `<target>/skills/` exists as a real directory, contents are migrated into `.agents/skills/` and replaced with a symlink
- If `<target>/skills/` is already a correct symlink, no action needed
- `dotagents sync` verifies and repairs broken symlinks

---

## Project Source Layout

```
dotagents/
  AGENTS.md                  # Agent instructions
  CLAUDE.md -> AGENTS.md     # Symlink
  agents.toml                # Self-dogfooding
  agents.lock                # Tracks managed skills, subagents, and plugins (gitignored)
  warden.toml                # Warden config for code analysis
  package.json               # pnpm workspace root
  pnpm-workspace.yaml
  specs/
    SPEC.md                  # This file
  docs/                      # Next.js docs site
  packages/
    dotagents/               # @sentry/dotagents CLI and host library
      src/
        index.ts             # Host public API re-exports
        scope.ts             # Project/user scope resolution
        cli/
          index.ts           # CLI entry point, command routing
          update-notifier.ts # npm update check
          commands/
            init.ts
            install.ts
            add.ts
            remove.ts
            sync.ts
            list.ts
            mcp.ts
            trust.ts
            doctor.ts
        targets/
          types.ts           # Target agent interfaces and MCP/hook declarations
          registry.ts        # Target registry (claude, cursor, codex, vscode, opencode)
          definitions/       # Per-target definitions
          mcp-writer.ts      # MCP config file generation per target
          hook-writer.ts     # Hook config file generation per target
          paths.ts           # Target config path resolution
          errors.ts          # Target-specific error types
        subagents/
          types.ts           # Subagent declaration and runtime projection types
          identity.ts        # Runtime subagent identity parsing
          store.ts           # Canonical installed subagent loading/writing
          writer.ts          # Runtime subagent config generation
          format.ts          # Subagent serialization and managed markers
        plugins/
          schema.ts          # Plugin manifest schema
          store.ts           # Canonical installed plugin loading/writing
          targets.ts         # Plugin target selection and validation
          runtime/           # Target-specific plugin runtime projection
        agents/
          index.ts           # Compatibility re-export barrel
        config/              # agents.toml schema, loader, writer
        lockfile/            # agents.lock schema, loader, writer
        symlinks/            # Symlink create/verify/repair
        gitignore/           # .agents/.gitignore generation
        utils/               # Host-local helpers
    dotagents-lib/           # @sentry/dotagents-lib reusable core
      src/
        index.ts             # Library public API
        skills/              # SKILL.md loader, discovery, resolver
        sources/             # git, cache, local, well-known source handling
        trust/               # Trust policy validation
        utils/               # exec and filesystem helpers
```

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `smol-toml` | TOML parsing and serialization |
| `zod` | Runtime schema validation (v4, imported as `zod/v4`) |
| `chalk` | Terminal colors |
| `@clack/prompts` | Interactive CLI prompts |
| `yaml` | SKILL.md frontmatter parsing in `@sentry/dotagents-lib` |

### Dev

| Package | Purpose |
|---------|---------|
| `typescript` | Type checking (strict mode) |
| `vitest` | Testing framework |
| `oxlint` | Linting (with `--deny-warnings`) |
| `tsx` | Dev-time TypeScript execution |
| `simple-git-hooks` | Pre-commit hook management |
| `lint-staged` | Run oxlint on staged files |
| `@types/node` | Node.js type definitions |

No git library -- dotagents uses the `git` CLI directly with non-interactive mode. SKILL.md frontmatter is parsed with the `yaml` package.

## Build and Distribution

### Development

```bash
pnpm dev -- init          # Run via tsx
npx tsx packages/dotagents/src/cli/index.ts  # Direct execution
```

### Package Build

```bash
pnpm build
```

Both workspace packages build TypeScript into `dist/`. The CLI package exposes `dist/cli/index.js` as the `dotagents` binary.

### Distribution

npm is the supported distribution channel:

```bash
npm install -g @sentry/dotagents
npx @sentry/dotagents <command>
```
