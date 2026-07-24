# CLI Reference

## Invocation

No global installation is required:

```bash
npx --yes @sentry/dotagents@latest [--user] <command> [options]
```

In the examples below, `dotagents` means that full invocation.

Global flags:

| Flag | Purpose |
|------|---------|
| `--user` | Use personal scope under `~/.agents/`; place before the command |
| `--help`, `-h` | Show non-mutating help |
| `--version`, `-V` | Show the CLI version |

Every command supports help, including nested commands:

```bash
dotagents add --help
dotagents mcp add --help
dotagents trust list --help
```

## Skill Lifecycle

### `init`

```bash
dotagents init [--agents claude,cursor] [--force]
dotagents --user init
```

Creates `agents.toml`, managed directories, and gitignore entries. Interactive project setup asks for agent targets, trust policy, and optional post-merge installation.

| Flag | Purpose |
|------|---------|
| `--agents <ids>` | Comma-separated agent IDs for non-interactive setup |
| `--force` | Replace an existing configuration |

### `add`

```bash
dotagents add <source> [skill...] [--skill <name>...] [--ref <ref>] [--all]
```

Adds dependencies to `agents.toml` **and installs immediately**.

```bash
dotagents add getsentry/skills find-bugs
dotagents add getsentry/skills find-bugs commit pr-writer
dotagents add getsentry/skills --all
dotagents add getsentry/warden --ref v1.0.0
dotagents add git:https://git.corp.example/team/skills review
dotagents add https://skills.example.com error-tracking
dotagents add path:./local-skills/review
```

| Flag | Purpose |
|------|---------|
| `--skill <name>` | Skill name; repeatable |
| `--name <name>` | Alias for `--skill` |
| `--ref <ref>` | Git tag, branch, or commit |
| `--all` | Create a wildcard dependency for all discovered skills |

Use explicit names or `--all` in non-interactive agent workflows. Do not combine names with `--all`.

### `install`

```bash
dotagents install
```

Fetches or refreshes declarations from `agents.toml`, updates managed skill copies, prunes stale managed entries, writes `agents.lock`, and regenerates runtime links/configuration. This is the update command; there is no separate `update` command.

`--frozen` is deprecated and ignored. Use `ref` to pin a source.

### `list`

```bash
dotagents list
dotagents list --json
```

Shows explicit and wildcard-expanded skills with installed, missing, or unlocked status.

### `remove`

```bash
dotagents remove <name|source> [-y]
```

Removes a named dependency or every dependency from a source. A wildcard-provided skill uses the exclusion flow so later installs do not restore it.

| Flag | Purpose |
|------|---------|
| `-y`, `--yes` | Skip confirmation for exclusion or source removal |

### `sync`

```bash
dotagents sync
```

Repairs local state **without network resolution**. It adopts local orphaned skills, prunes stale managed entries, regenerates gitignore state, and repairs symlinks plus generated MCP, hook, and subagent configuration.

Use `install`, not `sync`, when the user expects newer remote skill content.

### `doctor`

```bash
dotagents doctor
dotagents doctor --fix
```

Checks configuration, gitignore state, installed skills, symlinks, and generated files. `--fix` applies supported repairs.

## MCP Declarations

### `mcp add`

```bash
dotagents mcp add <name> --command "<cmd> [args...]" [--env <VAR>...]
dotagents mcp add <name> --url <url> [--header <Key:Value>...] [--env <VAR>...]
```

Adds one stdio or HTTP MCP server declaration. Command and URL transports are mutually exclusive.

### `mcp remove`

```bash
dotagents mcp remove <name>
```

### `mcp list`

```bash
dotagents mcp list
dotagents mcp list --json
```

## Trust Policy

### `trust add`

```bash
dotagents trust add <org|owner/repo|domain>
```

Adds a GitHub organization, exact repository, or Git domain/path rule. Obtain user approval before changing trust.

### `trust remove`

```bash
dotagents trust remove <source>
```

### `trust list`

```bash
dotagents trust list
dotagents trust list --json
```
