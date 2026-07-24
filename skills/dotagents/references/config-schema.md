# agents.toml Schema

## Top Level

```toml
version = 1
defaultRepositorySource = "github"
agents = ["claude", "cursor", "codex", "vscode", "opencode"]
minimum_release_age = 60
minimum_release_age_exclude = ["getsentry/*"]
```

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `version` | literal `1` | required | Config format version |
| `defaultRepositorySource` | `github` or `gitlab` | `github` | Host for shorthand sources |
| `agents` | string[] | `[]` | Runtime targets |
| `minimum_release_age` | non-negative integer | unset | Minimum Git commit age in minutes |
| `minimum_release_age_exclude` | string[] | `[]` | Source patterns exempt from age gating |

Unknown agent IDs fail configuration loading.

## Project Metadata

```toml
[project]
name = "my-project"
```

`name` is optional display metadata.

## Legacy Symlink Targets

```toml
[symlinks]
targets = [".claude", ".cursor"]
```

`targets` is optional and defaults to `[]`. Prefer the top-level `agents` field for standard runtimes.

## Named Skills

```toml
[[skills]]
name = "find-bugs"
source = "getsentry/skills"
ref = "v1.0.0"
path = "plugins/core/skills/find-bugs"
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | string | yes | Safe skill name matching `[a-zA-Z0-9][a-zA-Z0-9._-]*` |
| `source` | string | yes | Repository, Git URL, HTTPS catalog, or local path |
| `ref` | string | no | Git tag, branch, or commit |
| `path` | string | no | Exact skill directory within the source |

## Wildcard Skills

```toml
[[skills]]
name = "*"
source = "getsentry/skills"
ref = "v1.0.0"
exclude = ["deprecated-skill"]
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | literal `"*"` | yes | Wildcard marker |
| `source` | string | yes | Same source formats as named skills |
| `ref` | string | no | Git tag, branch, or commit |
| `exclude` | string[] | no | Skill names to omit; defaults to `[]` |

Only one wildcard entry per source is allowed.

## Trust

```toml
[trust]
allow_all = false
github_orgs = ["getsentry"]
github_repos = ["external-org/repo"]
git_domains = ["git.corp.example/team"]
```

| Field | Type | Default |
|-------|------|---------|
| `allow_all` | boolean | `false` |
| `github_orgs` | string[] | `[]` |
| `github_repos` | string[] | `[]` |
| `git_domains` | string[] | `[]` |

If `[trust]` is absent, sources are allowed for backward compatibility. `allow_all = true` overrides restrictions.

## MCP Servers

Stdio transport:

```toml
[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]
```

HTTP transport:

```toml
[[mcp]]
name = "remote"
url = "https://mcp.example.com/sse"
headers = { Authorization = "Bearer ${TOKEN}" }
env = ["TOKEN"]
```

Each entry requires `name` and exactly one of `command` or `url`. `args`, `headers`, and `env` are optional; `env` defaults to `[]`.

## Hooks

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "./scripts/check-command"
```

| Field | Type | Required |
|-------|------|----------|
| `event` | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, or `Stop` | yes |
| `matcher` | string | no |
| `command` | non-empty string | yes |

## Subagents

```toml
[[subagents]]
name = "code-reviewer"
source = "getsentry/agent-pack"
ref = "v1.0.0"
path = "agents/code-reviewer.md"
targets = ["claude", "codex", "opencode"]
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | lowercase kebab-case string | yes | Subagent identity |
| `source` | skill source string | yes | Git or local source; well-known HTTPS is rejected |
| `ref` | string | no | Git tag, branch, or commit |
| `path` | string | no | Explicit source file path |
| `targets` | string[] | no | Runtime targets; defaults to configured agents |

Subagent names must match `[a-z][a-z0-9-]*`, and duplicate names are rejected.

## Lockfile

`agents.lock` is generated and gitignored. Skill entries may record:

| Field | Purpose |
|-------|---------|
| `source` | Original dependency source |
| `resolved_url` | Resolved Git or HTTP source |
| `resolved_path` | Skill path within the source |
| `resolved_ref` | Resolved Git ref |
| `resolved_commit` | Informational installed commit SHA |

Subagents use the same Git resolution fields. Never edit the lockfile manually.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DOTAGENTS_HOME` | Override user-scope directory; default `~/.agents` |
| `DOTAGENTS_STATE_DIR` | Override cache directory; default platform state path |
