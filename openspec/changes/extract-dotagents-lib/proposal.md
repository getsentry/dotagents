## Why

The skill-loading, source-fetching, and trust-validation logic at the heart of `@sentry/dotagents` is generally useful for any tool that needs to consume Anthropic-style SKILL.md skills from git, local paths, or well-known HTTP endpoints — but today it is welded to the dotagents CLI, the `agents.toml` config grammar, and the `.agents/` project convention. Splitting the reusable core into a separate workspace package lets other tools build on the same primitives, narrows the host package's surface to its actual job (orchestrating `agents.toml` for Claude Code/Cursor/etc.), and forces clean module boundaries that the current monolithic layout has eroded.

## What Changes

- Convert the repository into a pnpm workspace with two packages: `dotagents-lib` (the reusable core, working name) and `@sentry/dotagents` (the existing CLI, unchanged externally).
- Move into `dotagents-lib`: `src/skills/`, `src/sources/`, `src/trust/`, and the small `src/utils/` helpers those depend on (`exec.ts`, `fs.ts`).
- Keep in `@sentry/dotagents`: `src/config/` (the `agents.toml` grammar), `src/scope.ts`, `src/agents/`, `src/gitignore/`, `src/symlinks/`, `src/lockfile/`, `src/cli/`.
- Move the `RepositorySource` type into `dotagents-lib`; the host's `config/schema.ts` imports it from the lib (type ownership inversion).
- Define a minimal `TrustPolicy` interface in `dotagents-lib`; the host's `TrustConfig` structurally satisfies it (the host stays the policy author, the lib stays the policy consumer).
- Add `configureCache({ stateDir })` to the lib so non-dotagents callers can override the cache location. Default remains `~/.local/dotagents/` and the existing `DOTAGENTS_STATE_DIR` env var stays honored — no migration of existing caches.
- Add an optional `trust?: TrustPolicy` parameter to `resolveSkill` and `resolveWildcardSkills` so library callers can opt into trust enforcement at the resolver layer. Host CLI behavior is unchanged: it continues to call `validateTrustedSource` explicitly during install/sync.
- Host package re-exports lib symbols from `src/index.ts` for one release as a deprecation shim, then drops them in a follow-up major.
- Move tests for the relocated modules into `dotagents-lib` alongside their sources. Add a cross-package smoke test verifying the host consumes the lib through workspace resolution.
- **No public API change** for `@sentry/dotagents` consumers in this change. CLI behavior is unchanged.
- **Publish both packages in lock-step** under the `@sentry` scope (`@sentry/dotagents` and `@sentry/dotagents-lib`). Both bump to the same version on every release. `workspace:^` references in the host's `package.json` are rewritten by pnpm at pack time to the real lib version. Rationale: pnpm cannot resolve a `workspace:*` dep against an unpublished package when end-users `npm install @sentry/dotagents`, so the lib must be published; lock-step versioning is the simplest release coordination story.
- CI and release workflows extended to lint/typecheck/test/build/pack both packages, and `craft` publishes both tarballs from a single release run.
- Out of scope: bikeshedding the *final* public name for the lib (the proposal uses `@sentry/dotagents-lib` as a publishable placeholder under the existing scope). Renaming/rescoping is a follow-up if desired. Also out of scope: independent (staggered) version cadence — revisit after the split has settled.

## Capabilities

### New Capabilities
- `skill-resolution`: The reusable lib's public surface for parsing skill source specifiers, resolving them to on-disk directories (clone/cache as needed), discovering SKILL.md files inside repos, and optionally enforcing a trust policy at resolution time.

### Modified Capabilities
<!-- None. The host package's CLI behaviors do not change semantically; this is an internal restructure. Existing CLI specs do not need deltas. -->

## Impact

- **Repo layout**: `src/` moves under `packages/dotagents/src/` and `packages/dotagents-lib/src/`. Top-level `pnpm-workspace.yaml` is added. The root `package.json` becomes a workspace manifest.
- **Public APIs**: No change for `@sentry/dotagents` consumers in this release — the host's `src/index.ts` continues to export the same symbols, with relocated ones re-exported from the lib via a deprecation shim. A follow-up major drops the shim.
- **Internal APIs**: Modules in the host that today import from `../skills`, `../sources`, `../trust`, or `../utils/{exec,fs}` switch to importing from `dotagents-lib`. The host's `config/schema.ts` imports `RepositorySource` from the lib instead of defining it.
- **Build/tooling**: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm check` need to run across both packages (workspace-level scripts). Vitest, oxlint, tsc all need workspace-aware config. Pre-commit hooks (`lint-staged`) keep working at the repo root.
- **CI** (`.github/workflows/ci.yml`): the `check` job runs `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` so both packages are exercised. The `build` job builds both packages, runs the existing CLI smoke (`node packages/dotagents/dist/cli/index.js --help`), packs both packages (`pnpm -r --filter @sentry/dotagents-lib --filter @sentry/dotagents pack`), and uploads both tarballs as the `npm-package` artifact craft already consumes.
- **Release** (`.github/workflows/release.yml` + `.craft.yml`): craft picks up multiple tarballs from the `npm-package` artifact and publishes both via the npm target. Lock-step version bumping: both packages get the same version on every release. The `version` script (or a small pre-craft step) bumps both `package.json`s atomically.
- **Cache**: Default location and `DOTAGENTS_STATE_DIR` are preserved. New `configureCache({ stateDir })` API for non-dotagents callers.
- **Trust**: New optional `trust?` opt on `resolveSkill`/`resolveWildcardSkills`. Existing CLI flow is unchanged.
- **Testing**: existing tests move with their modules (no coverage loss). One new cross-package integration test in the host validates the workspace dep resolves and the CLI's published surface still works. Existing integration test (`skills/resolver.integration.test.ts`) moves with skills into the lib and continues to clone real repos in CI.
- **Risk**: Low for end-users (no behavior change). Medium for contributors during the transition (import paths, package boundaries). Medium for release ops (first multi-package craft release — validate against a dry-run before tagging the real release). The deprecation shim limits the window where downstream library consumers (if any exist) are forced to migrate imports.
