# dotagents Specification

## Overview

dotagents is shared tooling for coding agents. It manages agent skill dependencies using the [agentskills.io](https://agentskills.io) standard, and handles MCP servers, hooks, and symlinks so that multiple agent tools (Claude Code, Cursor, Codex, etc.) can be configured from a single `agents.toml`.

Declare what you need, run `dotagents install`, and skills appear in `.agents/skills/` with symlinks into each tool's expected directory. MCP and hook configs are generated per agent.

### Why

Agent skills, MCP servers, and hooks are configured differently for every agent tool, and skills are distributed as loose folders copied from git repos. There's no way to declare what you need once and have it work everywhere, or to keep a team's agent setup in sync. dotagents fills this gap.

### Key Principles

- **`.agents/skills/` is the canonical home** for all skills (managed and custom)
- **`agents.toml`** declares what you want; **`agents.lock`** tracks what's managed
- **Selective gitignore**: managed skills are gitignored, custom skills are tracked
- **Subdirectory symlinks**: `.claude/skills/ -> .agents/skills/`, not full directory symlinks
- **agentskills.io format**: skills are folders with a `SKILL.md` file containing YAML frontmatter

---

## agents.toml

The manifest file. Lives at the project root.

### Schema

```toml
version = 1
agents = ["claude", "cursor"]

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
```

### Fields

#### Top-level

| Field | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Schema version. Always `1`. |
| `defaultRepositorySource` | No | Host used for shorthand `owner/repo` skill sources. Valid values: `github`, `gitlab`. Defaults to `github`. |
| `agents` | No | Array of agent tool IDs. Valid: `claude`, `cursor`, `codex`, `vscode`, `opencode`. Defaults to `[]`. When set, dotagents creates skills symlinks and MCP config files for each agent. |
| `project` | No | Project metadata. |
| `symlinks` | No | Symlink configuration (legacy — prefer `agents` for new projects). |
| `skills` | No | Skill dependencies (array of tables). |
| `mcp` | No | MCP server declarations (array of tables). Generates agent-specific config files during install/sync. |
| `trust` | No | Trusted source restrictions. When absent, all sources allowed. See `[trust]` below. |

#### `[trust]`

Optional section to restrict which skill sources are allowed. Useful for teams that want to lock down skill provenance.

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

Trust is checked before any network work in both `dotagents add` and `dotagents install`.

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
| `source` | Yes | Skill source. `owner/repo` (resolved via `defaultRepositorySource`), `owner/repo@ref`, `https://github.com/owner/repo`, `https://gitlab.com/group/repo`, `git:<url>`, or `path:<relative>`. |
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

#### Supported Agents

| ID | Tool | Config Dir | MCP File | MCP Format |
|----|------|-----------|----------|------------|
| `claude` | Claude Code | `.claude` | `.mcp.json` | JSON |
| `cursor` | Cursor | `.cursor` | `.cursor/mcp.json` | JSON |
| `codex` | Codex | `.codex` | `.codex/config.toml` | TOML (shared) |
| `vscode` | VS Code Copilot | `.vscode` | `.vscode/mcp.json` | JSON |
| `opencode` | OpenCode | `.claude` | `opencode.json` | JSON (shared) |

Each agent has its own MCP config format. dotagents translates the universal `[[mcp]]` declarations into the format each tool expects during `install` and `sync`.

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

[skills.warden-skill]
source = "getsentry/warden"
resolved_url = "https://github.com/getsentry/warden.git"
resolved_path = ".claude/skills/warden-skill"

[skills.error-tracking]
source = "https://cli.sentry.dev"
resolved_url = "https://cli.sentry.dev"

[skills.my-custom-skill]
source = "path:../shared-skills/my-custom-skill"
```

### Fields per skill

| Field | Present For | Description |
|-------|-------------|-------------|
| `source` | All | Original source specifier from agents.toml. |
| `resolved_url` | Git and well-known sources | Resolved clone URL or HTTP base URL. |
| `resolved_path` | Git sources | Subdirectory within the repo where the skill was discovered. |
| `resolved_ref` | Git sources (optional) | The ref that was resolved (tag/branch name). Omitted when using default branch. |

---

## CLI Commands

The CLI binary is `dotagents`. Currently runs via `tsx` during development; will be compiled with Bun for standalone distribution.

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
dotagents install [--force]
```

**Behavior:**
1. Read `agents.toml`
2. For each skill:
   a. Resolve source (check cache with TTL-based refresh, clone/fetch if needed)
   b. Discover skill within the repo
   c. Copy skill directory into `.agents/skills/<name>/`
3. Write `agents.lock`
4. Regenerate `.agents/.gitignore`
5. Warn if `agents.lock` and `.agents/.gitignore` are not in the root `.gitignore`
6. Create/verify symlinks (legacy `[symlinks]` and agent-specific)
7. Write MCP config files for each declared agent
8. Print summary

**Flags:**
- `--force`: Re-resolve everything, ignore cache.

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

Remove a skill dependency, or all skills from a source.

```
dotagents remove <name|source> [-y]
```

**Behavior (single skill):**
1. Remove `[[skills]]` entry from `agents.toml`
2. Delete `.agents/skills/<name>/`
3. Remove entry from `agents.lock`
4. Regenerate `.agents/.gitignore`

**Behavior (source removal):**
When the argument matches a source specifier (e.g. `owner/repo`, a URL) rather than a skill name, removes all skills from that source:
1. Find all skills from the source (explicit entries from config + wildcard-expanded entries from lockfile)
2. Confirm with the user (unless `-y` is passed)
3. Remove all matching `[[skills]]` entries from `agents.toml` (both explicit and wildcard)
4. Delete skill directories and lockfile entries
5. Regenerate `.agents/.gitignore`

**Flags:**
- `-y`, `--yes`: Skip confirmation prompt

### `dotagents sync`

Reconcile actual state with declared state.

```
dotagents sync
```

**Behavior:**
1. Adopt orphaned skills (installed but not in `agents.toml`) into config
2. Regenerate `.agents/.gitignore`
3. Warn if `agents.lock` and `.agents/.gitignore` are not in the root `.gitignore`
4. Check for missing skills (in `agents.toml` but not installed)
5. Create/verify/repair symlinks
6. Verify and repair MCP config files for declared agents
7. Verify and repair hook config files for declared agents

### `dotagents mcp`

Manage MCP server declarations.

```
dotagents mcp add <name> --command <cmd> [--args <a>...] [--env <VAR>...]
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
8. Symlinks are intact

**Flags:**
- `--fix`: Auto-fix issues where possible (add gitignore entries, remove legacy fields, create missing `.agents/.gitignore`)

### `dotagents list`

Show installed skills and status.

```
dotagents list [--json]
```

**Status indicators:**
- `✓` ok — installed and present in lockfile
- `✗` missing — in agents.toml but not installed
- `?` unlocked — installed but not in lockfile

**Output:** name, source, status

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
- `owner/repo/` — shallow clone, refreshed per TTL (default 24h)

Git operations (all non-interactive: `GIT_TERMINAL_PROMPT=0`, SSH `BatchMode=yes`):
- Initial: `git clone --depth=1`
- Update: `git fetch --depth=1 origin && git reset --hard FETCH_HEAD`

### Skill Validation

A valid skill directory must contain:
- `SKILL.md` with YAML frontmatter (delimited by `---`)
- Frontmatter must include `name` (string) and `description` (string)

The YAML frontmatter is parsed with a minimal key-value parser (no external YAML dependency). Supports simple `key: value` pairs and quoted values.

---

## Gitignore Strategy

dotagents always manages gitignore. Two files are added to the root `.gitignore` during `init`:
- `agents.lock` — tracks managed skills
- `.agents/.gitignore` — excludes managed skill directories from git

### How It Works

Managed (external) skills are gitignored. Custom (local) skills are tracked. dotagents generates `.agents/.gitignore` listing every managed skill:

```gitignore
# Auto-generated by dotagents. Do not edit.
# Managed skills (installed by dotagents)
/skills/find-bugs/
/skills/warden-skill/
```

Custom skills in `.agents/skills/my-local-skill/` are NOT listed, so git tracks them normally.

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
- `.cursor/` -- `rules/`, `skills/`
- `.codex/` -- `skills/`

Symlinking the entire directory (e.g., `.claude/ -> .agents/`) would clobber tool-specific files.

### Solution

Symlink only the `skills/` subdirectory:

```
.claude/skills/  -> .agents/skills/
.cursor/skills/  -> .agents/skills/
```

`.agents/skills/` is the canonical home. Each tool's `skills/` directory is a symlink.

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
  AGENTS.md                # Agent instructions
  CLAUDE.md -> AGENTS.md   # Symlink
  agents.toml              # Self-dogfooding
  agents.lock              # Tracks managed skills (gitignored)
  warden.toml              # Warden config for code analysis
  package.json
  tsconfig.json
  vitest.config.ts
  .gitignore
  specs/
    SPEC.md                # This file
  src/
    index.ts               # Library entry point (re-exports all modules)
    scope.ts               # Project/user scope resolution
    cli/
      index.ts             # CLI entry point, command routing
      commands/
        init.ts
        install.ts
        add.ts
        remove.ts
        sync.ts
        list.ts
        mcp.ts
    agents/
      types.ts             # McpDeclaration, AgentDefinition interfaces
      registry.ts          # Agent registry (claude, cursor, codex, vscode, opencode)
      definitions/         # Per-agent definitions (claude.ts, cursor.ts, etc.)
      mcp-writer.ts        # MCP config file generation per agent
      hook-writer.ts       # Hook config file generation per agent
      paths.ts             # Agent config path resolution
      errors.ts            # Agent-specific error types
      index.ts             # Re-exports
    config/
      schema.ts            # Zod schemas for agents.toml
      loader.ts            # TOML parse + validate
      writer.ts            # TOML modification (add/remove skills, MCP, hooks)
      index.ts             # Re-exports
    lockfile/
      schema.ts            # Zod schemas for agents.lock
      loader.ts            # Parse + validate lockfile
      writer.ts            # Serialize lockfile (deterministic sorting)
      index.ts             # Re-exports
    skills/
      loader.ts            # Parse SKILL.md YAML frontmatter
      discovery.ts         # Scan conventional dirs + marketplace format
      resolver.ts          # Source specifier -> resolved skill on disk
      index.ts             # Re-exports
    sources/
      git.ts               # Git clone/fetch/checkout (shallow, non-interactive)
      local.ts             # Local path resolution
      cache.ts             # Global cache (~/.local/dotagents/) with TTL
      index.ts             # Re-exports
    symlinks/
      manager.ts           # Create/verify/repair symlinks, directory migration
      index.ts             # Re-exports
    trust/
      validator.ts         # Trust policy enforcement
      index.ts             # Re-exports
    gitignore/
      writer.ts            # Generate .agents/.gitignore
      index.ts             # Re-exports
    utils/
      exec.ts              # Child process execution (non-interactive git)
      hash.ts              # Deterministic SHA-256 directory hashing
      fs.ts                # copyDir helper
      index.ts             # Re-exports
```

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `smol-toml` | TOML parsing and serialization |
| `zod` | Runtime schema validation (v4, imported as `zod/v4`) |
| `chalk` | Terminal colors |
| `@clack/prompts` | Interactive CLI prompts |

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

No git library -- uses `git` CLI directly with non-interactive mode. No YAML library -- uses minimal key-value parser for SKILL.md frontmatter.

## Build and Distribution

### Current (Development)

```bash
pnpm dev -- init          # Run via tsx
npx tsx src/cli/index.ts  # Direct execution
```

### Planned (Bun Compile)

Standalone binary with no runtime dependencies:

```bash
bun build src/cli/index.ts --compile --outfile dist/dotagents
```

### Platform Matrix

Build per-platform binaries via GitHub Actions:

| Platform | Target |
|----------|--------|
| macOS arm64 | `darwin-arm64` |
| macOS x64 | `darwin-x64` |
| Linux x64 | `linux-x64` |
| Linux arm64 | `linux-arm64` |

### Distribution Channels

1. **GitHub Releases**: Per-platform binaries attached to releases
2. **Install script**: `curl -fsSL https://dotagents.dev/install.sh | sh` (detects platform, downloads binary)
3. **npm** (fallback): `npx dotagents` for users with Node.js
