## 1. Workspace bootstrap

- [x] 1.1 Add top-level `pnpm-workspace.yaml` listing `packages/*`.
- [x] 1.2 Convert root `package.json` into a private workspace manifest (no `main`, no `bin`, no runtime deps; keep dev deps + scripts that proxy to packages).
- [x] 1.3 Move existing `src/` to `packages/dotagents/src/` and existing `tsconfig.json` / `vitest` / `oxlint` config into `packages/dotagents/`.
- [x] 1.4 Move existing `package.json` runtime/dev deps into `packages/dotagents/package.json` (keeping the `@sentry/dotagents` name, version, bin, types, and exports as-is).
- [x] 1.5 Add root scripts (`pnpm -r build`, `pnpm -r test`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm check`) so `pnpm check` runs across all packages.
- [x] 1.6 Verify `pnpm install && pnpm check` passes with no functional changes.

## 2. Lib package scaffold

- [x] 2.1 Create `packages/dotagents-lib/` with `package.json`: `name: "@sentry/dotagents-lib"`, `version` matched to the host's current published version, `private: false`, `type: "module"`, `main: "dist/index.js"`, `types: "dist/index.d.ts"`, `files: ["dist/", "README.md", "LICENSE"]`, `engines.node >= 20`, `license: MIT`.
- [x] 2.2 Add `tsconfig.json` matching the host's strict settings; emit to `dist/`.
- [x] 2.3 Add `vitest.config.ts` and oxlint settings mirroring the host's.
- [x] 2.4 Add the lib as a workspace dependency of `@sentry/dotagents` (`"@sentry/dotagents-lib": "workspace:^"`). Use `^` not `*` so pnpm rewrites it to a caret-range at pack time.
- [x] 2.5 Stub `packages/dotagents-lib/src/index.ts` with a placeholder `export {}` and confirm `pnpm check` still passes.

## 3. Move modules into the lib

- [x] 3.1 Move `src/utils/exec.ts` and `src/utils/fs.ts` (only the symbols sources/skills depend on, e.g. `stripTrailingSlashes`) into `packages/dotagents-lib/src/utils/`. Move co-located tests.
- [x] 3.2 Move `src/sources/` (git, cache, wellknown, local, plus their tests) into `packages/dotagents-lib/src/sources/`.
- [x] 3.3 Move `src/skills/` (loader, discovery, resolver, plus their tests, including the integration test) into `packages/dotagents-lib/src/skills/`.
- [x] 3.4 Move `src/trust/` (validator, plus its test) into `packages/dotagents-lib/src/trust/`.
- [x] 3.5 Move the `RepositorySource` type definition out of `src/config/schema.ts` into `packages/dotagents-lib/src/sources/repository-source.ts` (or co-located with the parser); export it from the lib's index.
- [x] 3.6 Define a structural `TrustPolicy` interface in `packages/dotagents-lib/src/trust/policy.ts` covering only the fields the lib's trust functions read.
- [x] 3.7 Update host imports: `src/skills/resolver.ts` no longer exists in host; remaining host modules that referenced moved code now import from `dotagents-lib`.
- [x] 3.8 Update `packages/dotagents/src/config/schema.ts` to import `RepositorySource` from `dotagents-lib`.
- [x] 3.9 Update `packages/dotagents/src/trust/...` references — host's `TrustConfig` zod schema stays in the host config; assert (in TS) that it satisfies the lib's `TrustPolicy`.
- [x] 3.10 Wire the lib's `src/index.ts` to export the public surface listed in the spec: `loadSkillMd`, `SkillLoadError`, `SkillMeta`; `parseSource`, `isExplicitSourceSpecifier`, `parseOwnerRepoShorthand`, `applyDefaultRepositorySource`, `normalizeSource`, `sourcesMatch`; `discoverSkill`, `discoverAllSkills`, `DiscoveredSkill`; `resolveSkill`, `resolveWildcardSkills`, `ResolvedSkill`, `ResolveError`, `NamedResolvedSkill`, `VALID_SKILL_NAME`; `ensureCached`, `ensureWellKnownCached`, `resolveLocalSource`, `CacheResult`, `CacheError`, `LocalSourceError`; `configureCache`; `validateTrustedSource`, `extractDomain`, `TrustError`, `TrustPolicy`; `RepositorySource`; the git primitives currently re-exported (`clone`, `fetchAndReset`, `fetchRef`, `headCommit`, `isGitRepo`, `GitError`); `exec`, `ExecError`, `copyDir`.

## 4. New lib APIs

- [x] 4.1 Implement `configureCache({ stateDir })` in `packages/dotagents-lib/src/sources/cache.ts`. Resolution order on every cache read: `configureCache` value → `DOTAGENTS_STATE_DIR` env var → `~/.local/dotagents/`. Replace the existing `DEFAULT_STATE_DIR` constant with this resolver.
- [x] 4.2 Add an optional `trust?: TrustPolicy` parameter to `resolveSkill` and `resolveWildcardSkills`. When provided, validate the source via `validateTrustedSource` BEFORE any network call (clone, fetch, well-known fetch). When omitted, skip validation (today's behavior).

## 5. Tests

- [x] 5.1 Add `configureCache` unit tests: override is honored; falls back to `DOTAGENTS_STATE_DIR` env var when override absent; falls back to `~/.local/dotagents/` when neither is set.
- [x] 5.2 Add `trust?` resolver tests using a mocked git layer that asserts the network call was NOT made when validation rejects: covers `resolveSkill` and `resolveWildcardSkills`; covers the "no `trust?` opt → no validation" path so today's behavior is locked down.
- [x] 5.3 Add a TS type test (a `.test-d.ts` or compile-only fixture) confirming the host's `TrustConfig` (zod-inferred) structurally satisfies `TrustPolicy` from the lib. Type drift fails CI fast.
- [x] 5.4 Add a single cross-package smoke test in `packages/dotagents/` that imports `parseSource` (or another public symbol) from `@sentry/dotagents-lib` and asserts a basic parse round-trips. This catches a broken workspace link without re-testing lib internals.
- [x] 5.5 Confirm the existing `skills/resolver.integration.test.ts` (real-clone integration) ran in CI before the move and still runs after — same network-touching behavior, new package.
- [x] 5.6 Coverage / test-count parity check: baseline 33 files / 612 tests; post-split `pnpm -r test` shows lib 9/199 + host 24/413 = 33/612 — exact parity.

## 6. Host re-export shim

- [x] 6.1 In `packages/dotagents/src/index.ts`, replace internal-relative re-exports of moved symbols with re-exports from `@sentry/dotagents-lib` so the host's published API is identical to before.
- [x] 6.2 Mark the relocated re-exports with JSDoc `@deprecated Import from @sentry/dotagents-lib instead` so editors surface the migration to any external library consumers.
- [x] 6.3 Confirm `packages/dotagents`'s built `.d.ts` still exports every previously-public symbol with the same types.

## 7. CI

- [x] 7.1 Update `.github/workflows/ci.yml` `check` job: replace `pnpm lint`, `pnpm typecheck`, `pnpm test` with `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` (or top-level scripts that proxy to `-r`).
- [x] 7.2 Update `.github/workflows/ci.yml` `build` job: build with `pnpm -r build`; smoke-test the host CLI at its new path (`node packages/dotagents/dist/cli/index.js --help`); pack both packages with `pnpm -r --filter "@sentry/dotagents-lib" --filter "@sentry/dotagents" pack` (or equivalent), and upload BOTH `*.tgz` files as the existing `npm-package` artifact.
- [x] 7.3 Add a CI step that, after pack, untars both tarballs into a temp dir and asserts: (a) the host's `package.json` contains NO `workspace:` strings, (b) `dependencies["@sentry/dotagents-lib"]` is set to a concrete semver range matching the lib's published version, (c) `node packages/dotagents/dist/cli/index.js --help` runs from the unpacked tarball. Fail the build if any of these break. Implemented as `scripts/verify-pack.mjs`; verified locally.
- [x] 7.4 Confirm `.github/workflows/warden.yml` still works against the new layout — `warden.toml` updated to glob `packages/*/src/**/*.ts`.
- [x] 7.5 Update `lint-staged` to glob across `packages/*/src/**/*.ts` (done in root `package.json`).

## 8. Release

- [x] 8.1 Craft's `npm` target publishes every `*.tgz` from the artifact bundle, so a single npm target handles both packages. No craft bump needed.
- [x] 8.2 Update `.craft.yml`: keep the single `npm` target (publishes all tarballs from the artifact) and add `preReleaseCommand: node scripts/bump-version.mjs` for lock-step bumping.
- [x] 8.3 Add `scripts/bump-version.mjs` that updates `version` in root, `packages/dotagents/package.json`, and `packages/dotagents-lib/package.json` to the same value. Tolerates both craft's two-arg invocation and one-arg manual invocation.
- [ ] 8.4 Release rehearsal: on a non-`main` branch, manually trigger `release.yml` with a pre-release version (e.g. `1.14.0-rc.1`). Verify on npm that both `@sentry/dotagents@1.14.0-rc.1` and `@sentry/dotagents-lib@1.14.0-rc.1` are present and the host's `dependencies["@sentry/dotagents-lib"]` is `^1.14.0-rc.1` (or whatever pnpm rewrites to). Test install in a scratch project: `npm install @sentry/dotagents@1.14.0-rc.1` resolves cleanly without `workspace:` errors. **(Cannot run from this PR — must be done by a human after the PR is reviewed and before the first real release.)**
- [x] 8.5 Document the release procedure in `RELEASING.md` (created at repo root) covering: how versions are kept in lock-step, how to roll back a mismatched-pair release if it ever happens, and which package owns which surface.

## 9. Verification

- [x] 9.1 `pnpm install && pnpm check` is green at the workspace root.
- [x] 9.2 `pnpm --filter @sentry/dotagents-lib typecheck` passes in isolation.
- [x] 9.3 `pnpm --filter @sentry/dotagents typecheck` passes (host-to-lib import path works through pnpm workspace).
- [ ] 9.4 Run `warden` per AGENTS.md guidance and address any flagged issues before opening the PR. **(User to run.)**
- [x] 9.5 Smoke-tested the host CLI from `packages/dotagents/dist/cli/index.js`: `--help` works, `list` against a scratch directory gives the expected "no agents.toml" guidance. Full E2E (`init`/`install`/`sync` against real network) left as a manual step.
- [x] 9.6 Cache location is unchanged — defaults to `~/.local/dotagents/` and `DOTAGENTS_STATE_DIR` is honored, so existing on-disk caches continue to work without migration. `configureCache` only changes behavior when called.
- [x] 9.7 Update AGENTS.md (CLAUDE.md is a symlink) "Architecture" section so the source-tree map reflects the new layout (`packages/dotagents/`, `packages/dotagents-lib/`).

## 10. Documentation

- [x] 10.1 Add a brief `packages/dotagents-lib/README.md` describing the lib's purpose and pointing at the spec for the public API.
- [x] 10.2 Update root `README.md` to mention the workspace layout, that the reusable core lives in `@sentry/dotagents-lib`, and that the two packages are versioned in lock-step.
- [x] 10.3 Note in `specs/SPEC.md` that the skill-resolution layer is now provided by `@sentry/dotagents-lib`. No grammar changes.
- [x] 10.4 Confirmed `docs/public/llms.txt` does not need updates — no user-visible CLI flags changed.
