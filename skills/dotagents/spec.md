# dotagents Skill Management

## Intent

This skill makes an agent use dotagents as the dependency manager for coding-agent skills and related shared configuration. The agent should add, install, update, remove, and inspect skills through `agents.toml` and the dotagents CLI instead of copying skill directories into individual agent runtimes.

The skill teaches the difference between project and user scope, the lifecycle of `add`, `install`, and `sync`, and the safe handling of trust, wildcard dependencies, and advanced configuration.

## Triggers

- **SHOULD** apply when the user asks to add, install, update, remove, list, share, or manage coding-agent skills with dotagents or `agents.toml`.
- **SHOULD** apply when the repository contains `agents.toml` and the task concerns skills, MCP declarations, hooks, subagents, trust, or generated agent configuration.
- **SHOULD** apply when the user asks to set up project-wide or personal user-scope skill management.
- **SHOULD NOT** apply to normal application package dependencies such as npm, Python, Rust, or system packages.
- **SHOULD NOT** apply when the user explicitly asks to install a standalone Codex skill through another skill installer rather than manage it with dotagents.

## Behaviors

### Behavior: Choose management scope

The agent SHALL use project scope for skill management in a repository with `agents.toml`, and use user scope only when the user requests personal, global, or cross-project management.

#### Scenario: Repository skill installation

- **GIVEN** the current repository contains `agents.toml`
- **WHEN** the user asks to install or add a coding-agent skill
- **THEN** the agent uses project scope without `--user`

#### Scenario: Personal or global wording

- **WHEN** the user asks to install a skill globally, personally, or for every project
- **THEN** the agent maps that request to dotagents user scope

### Behavior: Initialize dotagents management

The agent SHALL initialize a project before adding dependencies when its repository root has no `agents.toml`, while allowing user-scope commands to bootstrap their configuration automatically.

#### Scenario: New project setup

- **GIVEN** the current project has no `agents.toml`
- **WHEN** the user asks to start managing project skills with dotagents
- **THEN** the agent runs `npx --yes @sentry/dotagents@latest init` or presents that command when interactive choices require the user

#### Scenario: First user-scope command

- **GIVEN** `~/.agents/agents.toml` does not exist
- **WHEN** the user asks to add a personal skill
- **THEN** the agent runs the requested command with `--user` without a separate `init`

### Behavior: Add skills through dotagents

The agent SHALL prefer `dotagents add` over manually editing ordinary named skill dependencies or copying skill directories.

#### Scenario: Add one named skill

- **WHEN** the user asks to add `find-bugs` from `getsentry/skills`
- **THEN** the agent runs `npx --yes @sentry/dotagents@latest add getsentry/skills find-bugs`
- **AND** the agent understands that `add` updates `agents.toml` and installs immediately

#### Scenario: Add several known skills

- **WHEN** the user asks to add multiple named skills from one source
- **THEN** the agent passes the names as positional arguments in one `add` command

#### Scenario: Add every skill from a source

- **WHEN** the user asks to track all current and future skills from a source
- **THEN** the agent uses `add <source> --all` to create a wildcard dependency

### Behavior: Configure advanced dependencies

The agent SHALL edit `agents.toml` directly only for dependency options not represented by the `add` command, then run `install` to apply the change.

#### Scenario: Explicit named skill path

- **WHEN** a named skill lives at a non-standard directory inside its source
- **THEN** the agent creates or updates a named `[[skills]]` entry with the exact `path`
- **AND** runs `npx --yes @sentry/dotagents@latest install`

#### Scenario: Pin a source ref

- **WHEN** the user requests a specific tag, branch, or commit
- **THEN** the agent passes `--ref` to `add` or records `ref` in `agents.toml`

### Behavior: Use the correct lifecycle command

The agent SHALL choose `add`, `install`, or `sync` according to the requested lifecycle operation.

#### Scenario: Refresh dependency contents

- **WHEN** the user asks to update or refresh installed skills
- **THEN** the agent runs `install`, because install performs network resolution and refreshes unpinned dependencies

#### Scenario: Repair local state offline

- **WHEN** the user asks to repair symlinks, generated configuration, gitignore state, or offline drift
- **THEN** the agent runs `sync`, which does not fetch dependency updates

#### Scenario: Inspect installed state

- **WHEN** the user asks which skills are declared or installed
- **THEN** the agent runs `list` and uses `--json` when structured output is useful

### Behavior: Remove skills safely

The agent SHALL use `dotagents remove` and preserve wildcard semantics rather than manually deleting installed directories or lockfile entries.

#### Scenario: Remove a named dependency

- **WHEN** the user asks to remove an explicitly declared skill
- **THEN** the agent runs `remove <name>`

#### Scenario: Remove a wildcard-provided skill

- **WHEN** removal reports that the skill is provided by a wildcard
- **THEN** the agent offers or uses the wildcard exclusion flow instead of deleting the wildcard source

### Behavior: Respect trust and discover syntax safely

The agent SHALL use trust commands and non-mutating help output instead of bypassing policy or probing syntax through mutating commands.

#### Scenario: Source rejected by trust policy

- **WHEN** dotagents rejects a requested source as untrusted
- **THEN** the agent explains the required trust change and uses `trust add` only with user approval

#### Scenario: Command syntax is uncertain

- **WHEN** the agent needs exact command or nested subcommand syntax
- **THEN** the agent runs `<command> --help` or `<command> <subcommand> --help`
- **AND** does not run the command without help merely to observe an error

## Constraints

### Constraint: No manual runtime copies

The agent MUST NOT copy managed skills directly into `.claude/skills`, `.cursor/skills`, `.codex/skills`, or other runtime-specific directories.

### Constraint: Do not edit generated state

The agent MUST NOT manually edit `agents.lock`, generated runtime configuration, or managed directories to perform dependency changes.

### Constraint: Do not weaken trust silently

The agent MUST NOT set `allow_all = true` or add a trusted source without explicit user intent.

### Constraint: Do not misuse sync

The agent MUST NOT describe `sync` as an update command or use it when the user expects remote dependency changes to be fetched.

<!-- skillet-version: 1.5.0 -->
