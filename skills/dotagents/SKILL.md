---
name: dotagents
description: Manages coding-agent skills and shared agent configuration with dotagents. Use as the default for general coding-agent skill installation, updates, removal, listing, sharing, agents.toml or agents.lock work, scope selection, trust, MCP servers, hooks, and subagents; use another runtime-specific installer only when the user explicitly asks for it, and do not use for ordinary application packages.
spec_hash: 2f23ad82f079
---

# dotagents Skill Management

Use dotagents as the skill dependency manager. Do not copy managed skills into individual agent directories.

## Choose the scope first

1. Use project scope when the repository has `agents.toml` or the user ties the dependency to the repository or team.
2. Translate “global,” “personal,” or “for every project” into dotagents `--user` scope.
3. Do not add `--user` to a general request made in a configured project.
4. If a Git repository has no `agents.toml`, initialize the project before adding dependencies.
5. Do not initialize user scope separately; user commands create `~/.agents/agents.toml` automatically.

```bash
# Initialize an unconfigured project
npx --yes @sentry/dotagents@latest init

# Personal user scope bootstraps on first use
npx --yes @sentry/dotagents@latest --user add getsentry/skills find-bugs
```

Interactive `init` asks which agent tools and trust policy to configure. If those choices require user input, present the command instead of inventing answers.

## Add skills through dotagents

`add` updates `agents.toml` and runs install immediately. Do not run a redundant install afterward.

```bash
# Project dependency
npx --yes @sentry/dotagents@latest add getsentry/skills find-bugs

# Several skills from one source
npx --yes @sentry/dotagents@latest add getsentry/skills find-bugs commit pr-writer

# Explicit personal/global skill
npx --yes @sentry/dotagents@latest --user add getsentry/skills find-bugs

# Track every current and future skill from a source
npx --yes @sentry/dotagents@latest add dcramer/agents --all

# Pin a tag, branch, or commit
npx --yes @sentry/dotagents@latest add getsentry/warden --ref v1.0.0
```

If a source contains multiple skills, pass explicit names or `--all`; do not depend on an interactive picker in an agent workflow.

Supported sources include GitHub/GitLab repositories, explicit Git URLs, well-known HTTPS catalogs, and project-relative `path:` sources. Read [references/configuration.md](references/configuration.md) when choosing source syntax.

## Edit configuration only for advanced options

Prefer `add`, `remove`, `mcp`, and `trust` commands for normal mutations. Edit `agents.toml` directly for fields the CLI does not expose, then run install.

Example: use a named skill stored outside standard discovery directories.

```toml
[[skills]]
name = "review"
source = "acme/agent-skills"
path = "plugins/core/skills/review"
```

```bash
npx --yes @sentry/dotagents@latest install
```

Read [references/config-schema.md](references/config-schema.md) for exact fields used by skills, hooks, subagents, MCP servers, trust, and agent targets.

## Choose the correct lifecycle command

- `add`: declare and immediately install new skills.
- `install`: fetch or refresh dependencies from `agents.toml`, prune stale managed skills, and regenerate runtime configuration.
- `sync`: repair local state without fetching remote dependency updates.
- `list`: inspect declared and wildcard-expanded skill status; use `--json` when structured output helps.
- `doctor`: diagnose configuration and generated-state problems; use `--fix` only for supported repairs.

There is no update command. Use install when the user asks to update skills.

```bash
npx --yes @sentry/dotagents@latest install
npx --yes @sentry/dotagents@latest sync
npx --yes @sentry/dotagents@latest list --json
npx --yes @sentry/dotagents@latest doctor
```

## Remove skills through dotagents

```bash
npx --yes @sentry/dotagents@latest remove find-bugs
```

If the skill comes from a wildcard, use the offered exclusion flow so future installs do not restore it. Use `-y` only when the user has clearly approved the removal. Never delete `.agents/skills/<name>` or edit `agents.lock` manually.

## Respect trust policy

When a source is rejected, explain the required trust rule. Add it only with user approval.

```bash
npx --yes @sentry/dotagents@latest trust add getsentry
npx --yes @sentry/dotagents@latest trust add external-org/specific-repo
npx --yes @sentry/dotagents@latest trust add git.corp.example.com
```

Never switch to `allow_all = true` merely to bypass an error.

## Discover syntax without side effects

Use help output before unfamiliar commands. Help must not execute command behavior.

```bash
npx --yes @sentry/dotagents@latest add --help
npx --yes @sentry/dotagents@latest mcp add --help
npx --yes @sentry/dotagents@latest trust list --help
```

Read [references/cli-reference.md](references/cli-reference.md) for the full command surface.

## Never do these

- Never manually copy managed skills into `.claude/skills`, `.cursor/skills`, `.codex/skills`, or similar runtime directories.
- Never manually edit `agents.lock` or generated agent configuration.
- Never describe `sync` as fetching or updating remote skills.
- Never add trust rules or weaken trust without explicit user intent.
