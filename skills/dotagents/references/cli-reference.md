# CLI Reference

## Usage

```
npx @sentry/dotagents [--project|--global|--user] <command> [options]
```

### Global Flags

| Flag | Description |
|------|-------------|
| no scope flag | Operate on global scope (`~/.agents/`); the default in every directory |
| `--project` | Operate on the containing Git repository, or current directory outside Git |
| `--global` | Explicitly operate on global scope |
| `--user` | Compatibility alias for `--global` |
| `--help`, `-h` | Show help |
| `--version`, `-V` | Show version |

Scope flags may appear before or after the command. `--global --user` is allowed; combining `--project` with either global alias is an error before execution. Project commands other than `init` require `agents.toml` and never fall back globally. No files are migrated between scopes.

All unqualified examples below are intentionally global. For repository-local work, use:

```bash
npx @sentry/dotagents --project init
npx @sentry/dotagents --project add getsentry/skills find-bugs
npx @sentry/dotagents --project install
npx @sentry/dotagents --project doctor --fix
```

## Commands

### `init`

Initialize the selected scope. Automatically includes the `dotagents` skill from `getsentry/dotagents` for CLI guidance, and attempts to install it.

```bash
npx @sentry/dotagents init
npx @sentry/dotagents init --agents claude,cursor
npx @sentry/dotagents init --force
npx @sentry/dotagents --project init
```

| Flag | Description |
|------|-------------|
| `--agents <list>` | Comma-separated agent targets (claude, cursor, codex, vscode, opencode) |
| `--force` | Overwrite existing `agents.toml` |

**Interactive mode** (when TTY is available):
1. Select agents (multiselect)
2. Trust policy: allow all sources or restrict to trusted
3. If restricted: enter trusted GitHub orgs/repos (comma-separated)
4. In a Git project, optionally install a post-merge hook whose direct and npx fallback commands both run `--project install`

Outside Git, `--project init` uses the current directory and skips Git-only hook setup. It also upgrades legacy marker-delimited project hooks while preserving unrelated content and executable permissions.

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
5. Copy canonical artifacts into the selected scope's managed skills, agents, and plugins directories
6. Write/update lockfile
7. In project scope, generate `.agents/.gitignore`
8. Create/verify agent symlinks
9. Write MCP, hook, subagent, and plugin runtime configs

Global and project installs both support plugins, with outputs rooted in their selected scope.

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

Removes from `agents.toml`, deletes files from the selected scope's managed directories, updates the lockfile, and prunes generated plugin outputs when needed. In project scope, it also regenerates `.agents/.gitignore`. Passing a source removes all matching skills and plugins from that source.

If a skill and plugin share the same name, name-based removal is rejected. When their sources differ, pass the dependency's source to disambiguate.

For skills sourced from a wildcard entry (`name = "*"`), interactively prompts whether to add the skill to the wildcard's `exclude` list. If declined, the removal is cancelled.

### `sync`

Reconcile selected-scope state without network access: adopt local orphans, prune stale managed skills/subagents/plugins, and repair symlinks and generated configs.

```bash
npx @sentry/dotagents sync
```

**Actions performed:**
1. Adopt orphaned skills (installed but not declared in config)
2. In project scope, regenerate `.agents/.gitignore`
3. Prune stale managed skills, subagents, and plugins removed from config
4. Check for missing skills and plugins
5. Repair agent symlinks
6. Verify/repair MCP configs
7. Verify/repair hook configs
8. Verify/repair subagent and plugin runtime configs

Reports issues as warnings or errors, including invalid same-project plugin declarations.

### `doctor`

Check selected-scope health and fix issues.

```bash
npx @sentry/dotagents doctor
npx @sentry/dotagents doctor --fix
```

| Flag | Description |
|------|-------------|
| `--fix` | Auto-fix issues where possible |

**Checks:** applicable gitignore setup, legacy config fields, installed skills/plugins, symlinks, `.agents/.gitignore`, and legacy managed project hooks. Use the same scope on `sync` to repair generated runtime configs. Run `npx @sentry/dotagents --project doctor --fix` to migrate a legacy project hook.

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
