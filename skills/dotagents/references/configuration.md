# Configuration Workflows

## Scope

Project scope discovers the Git repository root from the current directory, uses its `agents.toml`, and installs managed skills under `.agents/skills/`.

User scope uses `~/.agents/agents.toml` and `~/.agents/skills/`:

```bash
npx --yes @sentry/dotagents@latest --user add getsentry/skills find-bugs
```

User-scope commands create `~/.agents/agents.toml` automatically. Use project scope in a configured repository; use `--user` when the user asks for personal, global, or cross-project management.

`DOTAGENTS_HOME` overrides the user-scope directory.

## Skill Sources

| Format | Example |
|--------|---------|
| GitHub shorthand | `getsentry/skills` |
| Pinned shorthand | `getsentry/skills@v1.0.0` |
| GitHub/GitLab URL | `https://gitlab.com/group/repo` |
| SSH URL | `git@github.com:owner/repo.git` |
| Generic Git | `git:https://git.corp.example/team/skills` |
| Well-known HTTPS catalog | `https://skills.example.com` |
| Local project path | `path:./local-skills/review` |

Shorthand uses `defaultRepositorySource = "github"` unless configured as `gitlab`.

## Named Skills

Prefer the CLI:

```bash
npx --yes @sentry/dotagents@latest add getsentry/skills find-bugs
```

Use direct configuration for an explicit non-standard source path:

```toml
[[skills]]
name = "review"
source = "acme/agent-skills"
path = "plugins/core/skills/review"
ref = "v1.2.0"
```

Run `install` after direct edits.

## Wildcard Skills

Track all discovered skills from a source:

```bash
npx --yes @sentry/dotagents@latest add getsentry/skills --all
```

Equivalent configuration:

```toml
[[skills]]
name = "*"
source = "getsentry/skills"
exclude = ["deprecated-skill"]
```

To scope a Git/local wildcard, edit `agents.toml` directly:

```toml
[[skills]]
name = "*"
source = "getsentry/skills"
path = "skills/engineering"
exclude = ["deprecated-skill"]
```

Set `path` to an existing source subdirectory whose complete skill subtree is discovered recursively, without limiting discovery to conventional scan locations; use `"."` for the complete source root. It cannot escape the source root, and well-known sources do not support it. Each discovered skill records its source-relative path so `list` and offline `sync` can enforce the current scope. Legacy lock entries without path metadata remain selected until `install` refreshes them. New skills appearing in that scope are discovered by later installs. Removing one wildcard-provided skill adds it to `exclude`.

## Trust

Without `[trust]`, sources are allowed for backward compatibility. Restricted teams can allow specific sources:

```toml
[trust]
github_orgs = ["getsentry"]
github_repos = ["external-org/specific-repo"]
git_domains = ["git.corp.example/team"]
```

Use `trust add`, `trust remove`, and `trust list` for normal changes. Do not set `allow_all = true` merely to bypass an error.

## Agents and Runtime Projection

```toml
agents = ["claude", "cursor", "codex", "vscode", "opencode"]
```

dotagents installs canonical skills once and writes or links each supported runtime surface. Do not manually copy managed skills into runtime-specific directories.

## MCP Servers

```toml
[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]
```

```toml
[[mcp]]
name = "remote"
url = "https://mcp.example.com/sse"
headers = { Authorization = "Bearer ${TOKEN}" }
env = ["TOKEN"]
```

Prefer `mcp add`, `mcp remove`, and `mcp list` for normal mutations.

## Hooks

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "./scripts/check-command"
```

Supported events are `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop`. Hooks are project-scoped.

## Subagents

```toml
[[subagents]]
name = "code-reviewer"
source = "getsentry/agent-pack"
path = "agents/code-reviewer.md"
targets = ["claude", "codex", "opencode"]
```

`targets` defaults to configured agents. Runtime-specific behavior remains in native source artifacts.

## Minimum Release Age

```toml
minimum_release_age = 60
minimum_release_age_exclude = ["getsentry/*"]
```

The age gate applies to Git commits. Local and well-known HTTPS skills are unaffected.

## Generated State

- `agents.lock` records managed skills and subagents; do not edit it.
- `.agents/.gitignore` identifies managed local artifacts.
- Managed skills are gitignored; in-place custom skills remain tracked.
- `install` fetches and refreshes dependencies.
- `sync` repairs local state without network resolution.
