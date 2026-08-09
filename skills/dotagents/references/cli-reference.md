# CLI Reference

## Usage

```
npx @sentry/dotagents [--user] <command> [options]
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--user` | Operate on user scope (`~/.agents/`) instead of current project |
| `--help`, `-h` | Show help |
| `--version`, `-V` | Show version |

## Commands

### `init`

Initialize a new project with `agents.toml` and `.agents/` directory. Automatically includes the `dotagents` skill from `getsentry/dotagents` for CLI guidance, and attempts to install it.

```bash
npx @sentry/dotagents init
npx @sentry/dotagents init --agents claude,cursor
npx @sentry/dotagents init --force
npx @sentry/dotagents --user init
```

| Flag | Description |
|------|-------------|
| `--agents <list>` | Comma-separated agent targets (claude, cursor, codex, vscode, opencode) |
| `--force` | Overwrite existing `agents.toml` |

**Interactive mode** (when TTY is available):
1. Select agents (multiselect)
2. Trust policy: allow all sources or restrict to trusted
3. If restricted: enter trusted GitHub orgs/repos (comma-separated)

### `install`

Install or refresh skill, subagent, and plugin dependencies declared in `agents.toml`. There is no separate `update` command.

```bash
npx @sentry/dotagents install
```

**Workflow:**
1. Load config and lockfile
2. Expand wildcard skill entries
3. Validate trust for each skill, subagent, and plugin source
4. Resolve skills, subagents, and plugins
5. Copy canonical artifacts into `.agents/skills/`, `.agents/agents/`, and `.agents/plugins/`
6. Write/update lockfile
7. Generate `.agents/.gitignore`
8. Create/verify agent symlinks
9. Write MCP, hook, subagent, and plugin runtime configs

`dotagents --user install` rejects `[[plugins]]` because plugin runtime projections are project-scoped.

### `add <specifier> [skill...]`

Add one or more skill dependencies and install them.

```bash
npx @sentry/dotagents add getsentry/skills                          # Interactive selection if multiple skills
npx @sentry/dotagents add getsentry/skills find-bugs                # Add by positional name
npx @sentry/dotagents add getsentry/skills find-bugs code-review    # Add multiple skills at once
npx @sentry/dotagents add getsentry/skills --name find-bugs         # Add by --name flag
npx @sentry/dotagents add getsentry/skills --skill find-bugs        # --skill is an alias for --name
npx @sentry/dotagents add getsentry/skills --all                    # Add all as wildcard
npx @sentry/dotagents add getsentry/warden@v1.0.0                   # Pinned ref (inline)
npx @sentry/dotagents add getsentry/skills --ref v2.0.0             # Pinned ref (flag)
npx @sentry/dotagents add git:https://git.corp.dev/team/skills      # Non-GitHub git URL
npx @sentry/dotagents add https://cli.sentry.dev --name error-tracking # Well-known HTTPS source
npx @sentry/dotagents add path:./my-skills/custom                   # Local path
```

| Flag | Description |
|------|-------------|
| `--name <name>` | Specify which skill to add (repeatable; alias: `--skill`) |
| `--skill <name>` | Alias for `--name` (repeatable) |
| `--ref <ref>` | Pin to a specific tag, branch, or commit |
| `--all` | Add all skills from the source as a wildcard entry (`name = "*"`) |

**Specifier formats:**
- `owner/repo` -- GitHub shorthand
- `owner/repo@ref` -- GitHub with pinned ref
- `https://github.com/owner/repo` -- GitHub HTTPS URL
- `git@github.com:owner/repo.git` -- GitHub SSH URL
- `git:https://...` -- Non-GitHub git URL
- `https://<domain>` -- Well-known HTTP skill source
- `path:../relative` -- Local filesystem path

When a repo contains multiple skills, dotagents auto-discovers them. If only one skill is found, it's added automatically. If multiple are found and no names are given, an interactive picker is shown (TTY) or skills are listed (non-TTY).

When adding multiple skills, already-existing entries are skipped with a warning. An error is only raised if all specified skills already exist.

`--all` and `--name`/positional args are mutually exclusive.

### `remove <name|source>`

Remove a skill or plugin dependency.

```bash
npx @sentry/dotagents remove find-bugs
```

Removes from `agents.toml`, deletes managed installed files, updates the lockfile, prunes generated plugin outputs when needed, and regenerates `.agents/.gitignore`. Passing a source removes all matching skills and plugins from that source.

If a skill and plugin share the same name, name-based removal is rejected. When their sources differ, pass the dependency's source to disambiguate.

For skills sourced from a wildcard entry (`name = "*"`), interactively prompts whether to add the skill to the wildcard's `exclude` list. If declined, the removal is cancelled.

### `sync`

Reconcile project state without network access: adopt local orphans, prune stale managed skills/subagents/plugins, and repair symlinks and generated configs.

```bash
npx @sentry/dotagents sync
```

**Actions performed:**
1. Adopt orphaned skills (installed but not declared in config)
2. Regenerate `.agents/.gitignore`
3. Prune stale managed skills, subagents, and plugins removed from config
4. Check for missing skills and plugins
5. Repair agent symlinks
6. Verify/repair MCP configs
7. Verify/repair hook configs
8. Verify/repair subagent and plugin runtime configs

Reports issues as warnings or errors, including user-scope plugin declarations and same-project plugin declarations.

### `doctor`

Check project health and fix issues.

```bash
npx @sentry/dotagents doctor
npx @sentry/dotagents doctor --fix
```

| Flag | Description |
|------|-------------|
| `--fix` | Auto-fix issues where possible |

**Checks:** gitignore setup, legacy config fields, installed skills/plugins, symlinks, and `.agents/.gitignore`. Use `dotagents sync` to repair generated runtime configs.

Useful when migrating to a new version of dotagents.

### `list`

Show declared skills and plugins with their status.

```bash
npx @sentry/dotagents list
npx @sentry/dotagents list --json
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |

**Status indicators:**
- `✓` installed -- present in lockfile
- `✗` missing -- in config but not installed
- `?` unlocked -- installed but not in lockfile

Skills from wildcard entries are marked with a wildcard indicator.

JSON output contains separate `skills` and `plugins` arrays.

### `mcp`

Manage MCP (Model Context Protocol) server declarations in `agents.toml`.

#### `mcp add <name>`

Add an MCP server declaration.

```bash
npx @sentry/dotagents mcp add github --command "npx -y @modelcontextprotocol/server-github" --env GITHUB_TOKEN
npx @sentry/dotagents mcp add remote-api --url https://mcp.example.com/sse --header "Authorization:Bearer token"
```

| Flag | Description |
|------|-------------|
| `--command "<cmd> [args...]"` | Command to run (stdio transport), including optional arguments |
| `--url <url>` | HTTP endpoint URL (HTTP transport) |
| `--header <Key:Value>` | HTTP headers (repeatable) |
| `--env <VAR>` | Environment variable names to pass through (repeatable) |

Either `--command` or `--url` is required (mutually exclusive).

#### `mcp remove <name>`

Remove an MCP server declaration.

```bash
npx @sentry/dotagents mcp remove github
```

#### `mcp list`

Show declared MCP servers.

```bash
npx @sentry/dotagents mcp list
npx @sentry/dotagents mcp list --json
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
