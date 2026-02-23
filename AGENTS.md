# Agent Instructions

## Package Manager

Use **pnpm**: `pnpm install`, `pnpm build`, `pnpm test`

## What This Project Is

dotagents is a package manager for `.agents` directories. It manages agent skill dependencies declared in `agents.toml`, maintains a lockfile for reproducibility, and handles symlinks so tools like Claude Code can discover skills from a single canonical location.

See `specs/SPEC.md` for the full design.

## Architecture

```
src/
├── index.ts              # Library entry point
├── scope.ts              # Project/user scope resolution
├── cli/
│   ├── index.ts          # CLI entry point, command routing
│   └── commands/         # init, install, add, remove, update, sync, list, mcp
├── agents/               # Agent definitions, MCP/hook config writers
├── config/               # agents.toml schema, loader, writer
├── lockfile/             # agents.lock schema, loader, writer
├── skills/               # SKILL.md loader, discovery, resolver
├── sources/              # git.ts, local.ts, cache.ts
├── symlinks/             # Symlink creation/management
├── trust/                # Trust policy validation
├── gitignore/            # .agents/.gitignore generation
└── utils/                # exec.ts, hash.ts, fs.ts
```

## Principles

- **Fight entropy.** Leave the codebase better than you found it.
- **Prefer simpler solutions** where it reasonably makes sense. Three lines of straightforward code beats an abstraction.
- **Minimal dependencies.** Reach for the standard library first.
- **Early returns, fail fast.** Guard clauses over nested conditionals.

## Key Conventions

- TypeScript strict mode
- Zod v4 for runtime validation (`import { z } from "zod/v4"`)
- ESM modules (`"type": "module"`)
- Vitest for testing
- oxlint for linting (with `--deny-warnings`)
- Use `export type` for type-only exports (required for Bun compatibility)
- Pre-commit hooks: oxlint via lint-staged

## Testing

New functionality requires tests, but only tests that are functionally additive. Don't write tests for the sake of testing. A test should exist because it catches a real bug or verifies a meaningful behavior, not to hit a coverage number.

- Co-locate tests with source (`foo.ts` -> `foo.test.ts`)
- Prefer integration tests over unit tests
- Add regression tests for bugs
- Mock external services, use real-world fixtures

## Documentation

When changes affect CLI behavior, command interfaces, or user-facing semantics (flags, error messages, default behavior), update the relevant documentation: `README.md`, `specs/SPEC.md`, and `--help` output. Code and docs ship together.

## Verifying Changes

```bash
pnpm check
```

Or individually: `pnpm lint && pnpm typecheck && pnpm test`

## Before Creating a PR

Run warden to check for bugs and code quality issues:

```bash
warden
```

The `warden-skill` is available in this project (installed via dotagents) and provides guidance on warden configuration and usage.
