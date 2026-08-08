# Configuration (agents.toml)

See [config-schema.md](config-schema.md) for the complete schema reference.

## Minimal Example

```toml
version = 1
agents = ["claude"]

[[skills]]
name = "find-bugs"
source = "getsentry/skills"
```

## Skills

Each skill requires `name` and `source`. Optionally pin with `ref` or specify a subdirectory with `path`.

```toml
[[skills]]
name = "find-bugs"
source = "getsentry/skills"
ref = "v1.0.0"
path = "plugins/sentry-skills/skills/find-bugs"
```

**Source formats:**

| Format | Example | Resolves to |
|--------|---------|-------------|
| GitHub shorthand | `getsentry/skills` | `https://github.com/getsentry/skills.git` |
| GitHub pinned | `getsentry/skills@v1.0.0` | Same, checked out at `v1.0.0` |
| GitHub HTTPS | `https://github.com/owner/repo` | URL used directly |
| GitHub SSH | `git@github.com:owner/repo.git` | SSH clone |
| GitLab HTTPS | `https://gitlab.com/group/repo` | URL used directly |
| Git URL | `git:https://git.corp.dev/team/skills` | Any non-GitHub git remote |
| Well-known HTTPS | `https://cli.sentry.dev` | HTTP source using `.well-known/skills/` |
| Local | `path:./my-skills/custom` | Relative to project root |

**Skill name rules:** Must start with alphanumeric, contain only `[a-zA-Z0-9._-]`.

### Wildcard Skills

Add all skills from a source with a single entry:

```toml
[[skills]]
name = "*"
source = "getsentry/skills"
path = "skills/engineering"
exclude = ["deprecated-skill"]
```

During `install`, dotagents recursively discovers skills under `path` and installs each one except those in `exclude`. Use `path = "."` for the complete source root. The path cannot escape the source root, and well-known HTTPS sources do not support wildcard path scoping. Each skill gets its own lockfile entry. Use `npx @sentry/dotagents add <source> --all` to create a wildcard entry from the CLI.

## Trust

Restrict which sources are allowed. Without a `[trust]` section, all sources are allowed.

```toml
# Allow all sources explicitly
[trust]
allow_all = true
```

```toml
# Restrict to specific GitHub orgs and repos
[trust]
github_orgs = ["getsentry"]
github_repos = ["external-org/specific-repo"]
git_domains = ["git.corp.example.com"]
```

- GitHub sources match against `github_orgs` (by owner) or `github_repos` (exact owner/repo)
- Git URL sources match against `git_domains` (supports domain path prefixes, e.g., `gitlab.com/myorg`)
- Local `path:` sources are always allowed
- A source passes if it matches any rule (org OR repo OR domain/path prefix)

Trust is validated before any network operations in `add` and `install`.

## MCP Servers

Declare MCP servers that get written to each agent's config.

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
headers = { Authorization = "Bearer token" }
```

MCP configs are written per-agent in the appropriate format:
- Claude: `.mcp.json` (JSON)
- Cursor: `.cursor/mcp.json` (JSON)
- Codex: `.codex/config.toml` (TOML, shared with other Codex config)
- VS Code: `.vscode/mcp.json` (JSON)
- OpenCode: `.opencode/opencode.jsonc` by default (JSONC, shared); existing nested or root OpenCode config files are reused.

## Hooks

Declare hooks for agent tool events.

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "my-lint-check"
```

**Supported events:** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`

Hook configs are written per-agent:
- Claude: `.claude/settings.json` (merged into existing file)
- Cursor: `.cursor/hooks.json` (dedicated file, events mapped to Cursor equivalents)
- VS Code: `.claude/settings.json` (same file as Claude)
- Codex/OpenCode: not supported (warnings emitted during install/sync)

**Cursor event mapping:**
- `PreToolUse` -> `beforeShellExecution` + `beforeMCPExecution`
- `PostToolUse` -> `afterFileEdit`
- `UserPromptSubmit` -> `beforeSubmitPrompt`
- `Stop` -> `stop`

## Subagents

Declare portable or native subagent artifacts with `[[subagents]]`. dotagents installs canonical managed files under `.agents/agents/` and writes runtime-specific files for supported agents.

```toml
[[subagents]]
name = "code-reviewer"
source = "getsentry/agent-pack"
path = "agents/code-reviewer.md"
targets = ["claude", "codex", "opencode"]
```

## Plugins

Declare plugin bundles with `[[plugins]]`. dotagents installs canonical bundles under `.agents/plugins/<name>/` and generates runtime-specific plugin outputs for configured targets.

```toml
[[plugins]]
name = "review-tools"
source = "getsentry/agent-plugins"
path = "plugins/review-tools"
targets = ["claude", "cursor", "codex", "grok", "opencode", "pi"]
```

Plugin declarations are project-scope only. User-scope plugin declarations are rejected.

## Agents

The `agents` array controls which agent tools get symlinks and configs.

```toml
agents = ["claude", "cursor", "codex", "vscode", "grok", "opencode", "pi"]
```

Each agent gets:
- A `<agent-dir>/skills/` symlink pointing to `.agents/skills/` (Claude, Cursor)
- Or native discovery from `.agents/skills/` (Codex, VS Code, OpenCode)
- MCP server configs in the agent's config file
- Hook configs (where supported)
- Subagent and plugin runtime outputs (where supported)

## Scopes

### Project Scope (default)

Operates on the current project. Requires `agents.toml` at the project root.

### User Scope (`--user`)

Operates on `~/.agents/` for skills shared across all projects. Override with `DOTAGENTS_HOME`.

```bash
npx @sentry/dotagents --user init
npx @sentry/dotagents --user add getsentry/skills --all
```

User-scope symlinks go to `~/.claude/skills/` and `~/.cursor/skills/`.

When no `agents.toml` exists and you're not inside a git repo, dotagents falls back to user scope automatically.

## Minimum Release Age

Use `minimum_release_age` to require git commits to age before install. The value is in minutes. Local and well-known HTTPS sources are not affected.

```toml
minimum_release_age = 60
minimum_release_age_exclude = ["getsentry/*"]
```

Use `minimum_release_age_exclude` for trusted sources that can bypass the age gate.

## Gitignore

dotagents always manages gitignore. It generates `.agents/.gitignore` listing managed skills, subagents, and plugins. In-place skills (`path:.agents/skills/...`) and in-place plugin sources are not gitignored since they must be tracked in git.

Two files are added to the root `.gitignore` during `init`:
- `agents.lock` — tracks managed skills, subagents, and plugins
- `.agents/.gitignore` — excludes managed skill directories, subagent files, and plugin bundles

If these entries are missing, `install` and `sync` warn. Run `npx @sentry/dotagents doctor --fix` to add them.

## Caching

- Cache location: `~/.local/dotagents/` (override with `DOTAGENTS_STATE_DIR`)
- Git sources use shallow clones and refresh on every install
- Well-known HTTPS sources refresh after a 24-hour TTL

## Troubleshooting

**Skills not installing:**
- Check `agents.toml` syntax with `npx @sentry/dotagents list`
- Verify source is accessible (`git clone` the URL manually)
- Check trust config if using restricted mode
- Run `npx @sentry/dotagents doctor` to check project health

**Symlinks broken:**
- Run `npx @sentry/dotagents sync` to repair

**Configuration issues:**
- Run `npx @sentry/dotagents doctor --fix` to auto-repair gitignore and legacy config fields
