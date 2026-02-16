# CLI Reference

## Usage

```
dotagents <command> [options]
```

## Commands

### `init`

Initialize a new project with `agents.toml` and `.agents/` directory.

```bash
dotagents init
dotagents init --agents claude,cursor
dotagents init --force
```

| Option | Description |
|--------|-------------|
| `--agents <list>` | Comma-separated agent targets (claude, cursor, codex, vscode, opencode) |
| `--force` | Overwrite existing `agents.toml` |

**Interactive mode** (when TTY is available):
1. Select agents (multiselect)
2. Manage `.gitignore` for installed skills?
3. Trust policy: allow all sources or restrict to trusted
4. If restricted: enter trusted GitHub orgs/repos (comma-separated)

### `install`

Install all skill dependencies declared in `agents.toml`.

```bash
dotagents install
dotagents install --frozen
dotagents install --force
```

| Option | Description |
|--------|-------------|
| `--frozen` | Fail if lockfile is missing or out of sync; do not modify lockfile |
| `--force` | Re-install all skills even if already present |

**Workflow:**
1. Load config and lockfile
2. Validate trust for each skill source
3. Resolve skills (use locked commits when available)
4. Copy skills into `.agents/skills/<name>/`
5. Write/update lockfile with integrity hashes
6. Generate `.agents/.gitignore`
7. Create/verify agent symlinks
8. Write MCP and hook configs

### `add <specifier>`

Add a skill dependency and install it.

```bash
dotagents add getsentry/skills
dotagents add getsentry/warden@v1.0.0
dotagents add git:https://git.corp.dev/team/skills
dotagents add path:./my-skills/custom
dotagents add getsentry/skills --name find-bugs
dotagents add getsentry/skills --ref v2.0.0
```

| Option | Description |
|--------|-------------|
| `--ref <ref>` | Pin to a specific tag, branch, or commit |
| `--name <name>` | Explicit skill name (skip auto-discovery) |

**Specifier formats:**
- `owner/repo` — GitHub shorthand
- `owner/repo@ref` — GitHub with pinned ref
- `git:https://...` — Non-GitHub git URL
- `path:../relative` — Local filesystem path

When a repo contains multiple skills, dotagents auto-discovers them. If only one skill is found, it's added automatically. If multiple are found, they're listed for selection.

### `remove <name>`

Remove a skill dependency.

```bash
dotagents remove find-bugs
```

Removes from `agents.toml`, deletes `.agents/skills/<name>/`, updates lockfile, and regenerates `.gitignore`.

### `update [name]`

Update skills to their latest versions.

```bash
dotagents update           # Update all
dotagents update find-bugs # Update one
```

Skips skills pinned to immutable commits (40-char SHAs). Prints changelog showing old and new commits.

### `sync`

Reconcile project state: adopt orphans, verify integrity, repair symlinks and configs.

```bash
dotagents sync
```

**Actions performed:**
1. Adopt orphaned skills (installed but not declared in config)
2. Regenerate `.agents/.gitignore`
3. Check for missing skills
4. Verify integrity hashes
5. Repair agent symlinks
6. Verify/repair MCP configs
7. Verify/repair hook configs

### `list`

Show installed skills and their status.

```bash
dotagents list
dotagents list --json
```

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

**Status indicators:**
- `✓` ok — installed, integrity matches
- `~` modified — locally modified since install
- `✗` missing — in config but not installed
- `?` unlocked — installed but not in lockfile
