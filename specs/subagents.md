# Subagents Specification

Subagents are best-effort portable dependencies. dotagents should let teams declare a subagent once, preserve native runtime artifacts when they already exist, and generate reasonable files for other supported runtimes from a small portable projection.

This is not a universal behavior schema. Runtime-specific behavior such as model routing, tool permissions, read-only modes, background execution, and reasoning effort belongs in the runtime's native artifact.

## Configuration

Subagents are declared in `agents.toml`:

```toml
[[subagents]]
name = "code-reviewer"
source = "getsentry/agent-pack"
targets = ["claude", "codex"]
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Portable dotagents ID. Must start with lowercase `a-z` and contain only lowercase letters, numbers, and hyphens. |
| `source` | Yes | Source repository or local directory. Supports GitHub/GitLab shorthands, git URLs, and `path:` sources. HTTPS well-known skill indexes are not supported for subagents. |
| `ref` | No | Optional git ref override. |
| `path` | No | Optional explicit subagent file path inside the source. Markdown paths are portable or native Markdown; `.toml` paths are Codex native artifacts. |
| `targets` | No | Optional subset of agent IDs. Defaults to every configured agent in `agents`; unsupported agents produce warnings. |

## Portable Projection

Every imported subagent must produce this portable shape:

| Field | Meaning |
|-------|---------|
| `name` | dotagents portable ID from `agents.toml`, filename, or portable source metadata |
| `description` | short description used by runtimes that support it |
| `instructions` | prompt/instructions body used when converting to another runtime |
| `native` | optional raw native source content keyed by runtime |

Only `name`, `description`, and `instructions` are portable. Native-only fields are preserved for the matching runtime but are not standardized or converted.

## Source and Output Formats

Input and matching-runtime output use the same format. dotagents adds only its managed-file marker when writing a native artifact back to its own runtime.

| Format | Source Discovery | Matching Runtime Output | Required Source Fields | Portable Projection |
|--------|------------------|-------------------------|------------------------|---------------------|
| Portable Markdown | `agents/*.md`, `.agents/agents/*.md` | `.agents/agents/<name>.md` canonical install file | YAML `name`, `description`; Markdown body | `name`, `description`, body instructions |
| Claude Markdown | `.claude/agents/*.md` | `.claude/agents/<name>.md` | YAML `name`, `description`; Markdown body | `name`, `description`, body instructions |
| Cursor Markdown | `.cursor/agents/*.md` | `.cursor/agents/<name>.md` | YAML `description`; Markdown body; `name` optional | YAML `name` or filename; `description`; body instructions |
| Codex TOML | `.codex/agents/*.toml` | `.codex/agents/<name>.toml` | TOML `name`, `description`, `developer_instructions` | dotagents ID from `agents.toml` or filename when native `name` is not portable; `description`; `developer_instructions` |
| OpenCode Markdown | `.opencode/agents/*.md` | `.opencode/agents/<name>.md` | YAML `description`; Markdown body | filename; `description`; body instructions |

Portable Markdown example:

```md
---
name: code-reviewer
description: Review code for correctness, security, and missing tests.
---

Review the current diff and return findings with file references.
```

Codex TOML example:

```toml
name = "code_reviewer"
description = "Review code for correctness, security, and missing tests."
developer_instructions = "Review the current diff and return findings with file references."
sandbox_mode = "read-only"
```

When installing the Codex example to Codex, dotagents preserves `name = "code_reviewer"` and `sandbox_mode = "read-only"`. When installing it to Claude or Cursor, dotagents generates Markdown from the portable projection and does not attempt to convert `sandbox_mode`.

## Discovery

Without an explicit `path`, dotagents scans source directories in this order:

1. `*.md` at the source root, flat only
2. `agents/**/*.md`
3. `.agents/agents/**/*.md`
4. `.claude/agents/**/*.md`
5. `.cursor/agents/**/*.md`
6. `.codex/agents/**/*.toml`
7. `.opencode/agents/**/*.md`

Within each scanned directory, filename matches for `agents.toml` `name` take precedence over metadata-only matches. Multiple filename or metadata matches in one scanned directory are rejected as ambiguous. Matching artifacts from multiple runtimes are merged into one subagent declaration so native Claude and native Codex sources for the same portable ID can both be preserved.

If `path` is set, dotagents imports only that file. A `.toml` path is treated as Codex native. Markdown under `.claude/agents/`, `.cursor/agents/`, or `.opencode/agents/` is treated as native for that runtime; other Markdown is treated as portable.

## Naming

The `agents.toml` `name` is the portable dotagents ID and controls generated filenames.

Runtime native names may differ when the runtime allows a different naming convention. Codex commonly uses underscores, so `name = "code_reviewer"` in native TOML can map to portable dotagents ID `code-reviewer` when the file is selected by filename or explicit config. The Codex TOML name is preserved when writing Codex output.

Cursor native Markdown may omit `name`; dotagents uses the filename only when `name` is absent. OpenCode native Markdown always uses the filename as the portable name because OpenCode treats the Markdown filename as the agent name.

## Install and Sync

Install writes two layers:

1. Canonical installed Markdown in `.agents/agents/<name>.md`
2. Runtime output for each configured target that supports subagents

The canonical installed Markdown stores the portable projection plus raw native overlays so `sync` can regenerate matching native outputs without network access.

Generated runtime paths:

| Agent | Project Scope | User Scope | Format |
|-------|---------------|------------|--------|
| Claude Code | `.claude/agents/<name>.md` | `~/.claude/agents/<name>.md` | Markdown with YAML frontmatter |
| Cursor | `.cursor/agents/<name>.md` | `~/.cursor/agents/<name>.md` | Markdown with YAML frontmatter |
| Codex | `.codex/agents/<name>.toml` | `~/.codex/agents/<name>.toml` | TOML |
| OpenCode | `.opencode/agents/<name>.md` | `~/.config/opencode/agents/<name>.md` | Markdown with YAML frontmatter |

Installed and generated files are marked as dotagents-managed. `install` and `sync` overwrite stale managed files and prune removed managed files, but they do not overwrite hand-written files without the marker. For runtimes whose agent identity can differ from the filename, dotagents also avoids writing a managed file when an unmanaged file in the same runtime directory already declares the same runtime identity.

## Non-goals

dotagents does not standardize or enforce runtime-specific agent behavior. In particular, dotagents should not add portable config for model selection, permissions, sandboxing, background execution, reasoning effort, hooks, or other runtime-specific controls unless there is a maintainable common contract across runtimes.
