# Agent Instructions

## Package Manager

Use **pnpm**: `pnpm install`, `pnpm build`, `pnpm test`

## What This Project Is

dotagents is shared tooling for coding agents. It manages skills, MCP servers, and hooks declared in `agents.toml`, and handles symlinks and config generation so tools like Claude Code can be configured from a single source of truth.

See `specs/SPEC.md` for the full design.

## Architecture

This repo is a pnpm workspace with two packages, versioned in lock-step (see `RELEASING.md`).

```
packages/
├── dotagents/            # @sentry/dotagents — the host CLI + agents.toml orchestrator
│   └── src/
│       ├── index.ts          # Library entry point (re-exports lib symbols with @deprecated)
│       ├── scope.ts          # Project/user scope resolution
│       ├── cli/              # CLI entry point + commands (init, install, add, remove, sync, list, mcp, doctor, trust)
│       ├── targets/          # Target agent definitions plus MCP/hook config writers
│       ├── subagents/        # Subagent identity, store, and runtime writer
│       ├── agents/           # Compatibility re-export barrel for older internal imports
│       ├── config/           # agents.toml schema, loader, writer
│       ├── lockfile/         # agents.lock schema, loader, writer
│       ├── symlinks/         # Symlink creation/management
│       ├── gitignore/        # .agents/.gitignore generation
│       └── utils/            # isInPlaceSkill (host-specific path conventions)
│
└── dotagents-lib/        # @sentry/dotagents-lib — the reusable core
    └── src/
        ├── index.ts          # Public API of the lib
        ├── skills/           # SKILL.md loader, discovery, resolver (parseSource, etc.)
        ├── sources/          # git.ts, cache.ts (configureCache), local.ts, wellknown.ts, repository-source.ts
        ├── trust/            # Trust validation (validateTrustedSource), TrustPolicy interface
        └── utils/            # exec.ts, fs.ts (copyDir, stripTrailingSlashes)
```

The host depends on the lib via `workspace:^` (rewritten at pack time). For cross-workspace typecheck, the host's `tsconfig.json` declares a project reference to the lib (composite mode); the host's `vitest.config.ts` aliases `@sentry/dotagents-lib` directly to the lib's source so tests run without a build step.

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

When changes affect CLI behavior, command interfaces, or user-facing semantics (flags, error messages, default behavior), update the relevant documentation: `README.md`, `specs/SPEC.md`, `docs/public/llms.txt`, and `--help` output. Code and docs ship together.

## Verifying Changes

```bash
pnpm check
```

Or individually: `pnpm lint && pnpm typecheck && pnpm test`

- Changes affecting install, sync, doctor, skill placement, agent symlinks,
  generated configs, user scope, or package/runtime behavior should use
  `skills/dotagents-qa/SKILL.md` for proportionate Docker QA.
