## Context

`@sentry/dotagents` is a CLI plus library for managing Anthropic-style coding-agent skills declared in `agents.toml`. Today it ships as a single npm package with everything in `src/`: skill loading and resolution, git/HTTP source fetching, trust validation, the `agents.toml` grammar, the `.agents/` project convention, agent-specific writers (Claude Code, Cursor, etc.), gitignore generation, symlink wiring, lockfile management, and the CLI.

The skill/source/trust modules are reusable in principle: the SKILL.md format is open, the source-string grammar is general (`owner/repo@ref`, `git:`, `path:`, `https://`, well-known), and the cache layout is host-agnostic. In practice they are coupled to the host through:

- `src/skills/resolver.ts` imports `RepositorySource` and `WildcardSkillDependency` types from `src/config/schema.ts`.
- `src/trust/validator.ts` imports `TrustConfig` from `src/config/schema.ts`.
- `src/sources/cache.ts` hardcodes `~/.local/dotagents/` and `DOTAGENTS_STATE_DIR`.
- Trust enforcement happens in CLI commands, not in the resolver — easy for a third-party library caller to forget.

A previous planning conversation between the user and the assistant settled the carve-up (skills + sources + trust + utils into the lib; config + scope + agents + gitignore + symlinks + lockfile + cli stay in the host) and the three decisions captured below.

**Stakeholders:** the dotagents maintainers (Sentry); future internal/external consumers of the lib who want SKILL.md fetching/resolution without buying into `agents.toml`.

**Constraints:** TypeScript strict mode, ESM, Node ≥20, pnpm, Vitest, oxlint, zod v4, smol-toml, @clack/prompts, chalk. Pre-commit hooks via simple-git-hooks + lint-staged. Existing `~/.local/dotagents/` caches on user machines must continue to work without migration.

## Goals / Non-Goals

**Goals:**
- Two clean packages in a pnpm workspace: `dotagents-lib` (reusable) and `@sentry/dotagents` (host CLI).
- `dotagents-lib` has no compile-time dependency on the host. The host depends on the lib.
- Zero behavior change for `@sentry/dotagents` end-users in this release.
- Library callers can override the cache directory and opt into trust enforcement at the resolver layer.
- Existing tests for the relocated modules move with the code; coverage does not regress.
- A single workspace-level `pnpm check` continues to lint, typecheck, and test everything.

**Non-Goals:**
- Publishing `dotagents-lib` to npm in this change. Internal-only / unpublished workspace package is fine for now.
- Bikeshedding the final public package name. The proposal uses `dotagents-lib` as a working name; the final published name (e.g. `@sentry/skill-kit`, `@sentry/agents-core`) is a follow-up decision.
- Extracting `lockfile/`, `agents/`, `symlinks/`, or `gitignore/` into the lib. These are dotagents-specific.
- Migrating existing user caches to a new location.
- Changing the `agents.toml` grammar.
- Removing the deprecation re-export shim — that is a follow-up major.

## Decisions

### Decision 1: Cache location — keep dotagents-flavored default, expose `configureCache`

**What:** The lib defaults its cache to `~/.local/dotagents/` and continues to honor the `DOTAGENTS_STATE_DIR` env var. It additionally exposes `configureCache({ stateDir })` so non-dotagents callers can set their own cache root at startup. Resolution order: `configureCache` value → `DOTAGENTS_STATE_DIR` → default.

**Why:** Three options were considered:

1. **Rename to a generic location and break existing caches** — clean, but every existing dotagents user re-clones every source on first run after upgrade. Loud, irritating, no benefit for them.
2. **Require callers to pass `stateDir` always** — purest, but cumbersome for trivial callers and forces the host to thread `stateDir` through every `resolveSkill` call site.
3. **Keep dotagents-flavored default + override hook** — preserves back-compat, pushes the brand-leak cost onto only non-dotagents callers, who pay it once at process startup.

(3) is the cheapest path to "library is usable by others" without disrupting existing users. The brand leak in the default path is cosmetic; non-dotagents callers can set their own root with a one-liner.

**Trade-off:** A future renaming of the default would be a coordinated breaking change. We are not blocked from doing that later — we just choose not to do it now.

### Decision 2: Type ownership — `RepositorySource` moves to lib, `TrustPolicy` is structural in lib

**What:**
- The `RepositorySource` union (`"github" | "gitlab"`) moves from `src/config/schema.ts` into `dotagents-lib`. The host's `config/schema.ts` imports it from the lib.
- The lib defines its own minimal `TrustPolicy` interface (the shape the lib's trust functions need). The host's existing `TrustConfig` (a zod-validated TOML shape) structurally satisfies `TrustPolicy` and continues to live in the host.

**Why:** `RepositorySource` is fundamentally a property of git remote hosts, not of `agents.toml`. It belongs to the lib's source-parsing grammar. The host's config schema is a *consumer* of this enum — that is the inversion. There is exactly one type, and it lives where the parsing logic lives.

`TrustPolicy` is different: the *policy format* (what fields, what zod validation, where it lives in `agents.toml`) is a host concern. The lib only needs to read a structural subset (allowed orgs, allowed repos, allowed domains). Defining a minimal interface in the lib lets the host stay the policy author without forcing the lib to import host code.

**Alternative considered:** keep both types in the host and have the lib accept opaque `unknown` or generic params. Rejected — that pushes type-safety onto every caller and makes the lib's signatures useless without host context.

### Decision 3: Trust enforcement — opt-in at the resolver, host CLI behavior unchanged

**What:** `resolveSkill` and `resolveWildcardSkills` gain an optional `trust?: TrustPolicy` parameter. When supplied, the resolver validates the source against the policy *before* any network access; failure throws `TrustError`. When omitted, the resolver does no trust check — matching today's behavior. The host CLI continues to call `validateTrustedSource` explicitly in `install`/`sync` flows; this is unchanged.

**Why:** Today the resolver has no idea what trust is. Third-party library callers who reach for `resolveSkill` get arbitrary remote clones with no gate — a footgun. Adding `trust?` to the resolver lets safety-conscious callers opt into a single-call-site enforcement model.

We do *not* make `trust` mandatory because:
- The host already enforces trust at a higher layer (CLI commands), and there is no value in enforcing twice.
- Several legitimate library use cases (e.g. testing, internal scripts hitting known-good sources) want resolution without a policy.
- A required parameter is a breaking change to the public API even before the lib is published.

**Alternative considered:** make trust enforcement automatic with a global `setTrustPolicy(...)` side-effect. Rejected — globals are surprising and racy when multiple callers share a process.

### Decision 4: Release strategy — lock-step versions, both packages published from this change

**What:** From the first release that lands this change, both `@sentry/dotagents-lib` and `@sentry/dotagents` are published to npm with the same version. They bump together on every release. The host's `package.json` declares `"@sentry/dotagents-lib": "workspace:^"`; pnpm rewrites that to the concrete version (e.g. `"^1.14.0"`) at `pnpm pack` time so the published tarball installs cleanly.

CI is extended to:
- Run `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` so both packages are exercised on every PR.
- Build both packages and pack both tarballs into the existing `npm-package` artifact.

`.craft.yml` is extended to declare a `targets[].name: npm` entry per package (or a single `npm` target with multiple package paths — whichever syntax craft supports cleanly), so a single release run publishes both. `release.yml` is unchanged in structure; craft handles the multi-tarball publish.

**Why:** Three options were considered:

1. **Don't publish the lib (vendor it into the host's tarball).** The host bundles the lib's compiled JS into its own `dist/`, package.json drops the `dotagents-lib` dep at pack time. Keeps the public surface single-package. *Rejected:* defeats the goal — other tools cannot consume the lib until it's published, and the bundling logic adds nontrivial build complexity (rewriting workspace deps, copying compiled output, deduping types) that we'd just rip out in the follow-up "publish the lib" change.
2. **Independent (staggered) versions.** Each package has its own changelog and bump cadence. Maximally flexible. *Rejected for now:* requires craft config per-package, semver discipline across the host→lib boundary, and contributors thinking about which version bumps which package. Worth revisiting once the split has settled, but premature optimization for a two-package repo with one team.
3. **Lock-step versions, both published.** Same version on both, single release run publishes both, no per-package changelog logic needed. The cost is that the lib gets a version bump even when only the host changed (and vice versa) — but consumers don't care, and our changelog already lives at the repo level via craft's auto policy.

(3) is the simplest path that preserves the goal. We can move to (2) later without a breaking change to lib consumers (a `1.13.0`-tagged lib is still a `1.13.0`-tagged lib regardless of whether the host bumped at the same time).

**Trade-off / migration order within a single release:**
- Pre-publish step: bump both `package.json`s to the target version (a small script, run by craft via the `bump.command` hook or a manual pre-step).
- pnpm rewrites `workspace:^` → the concrete version at pack time, so by the time the tarball lands, the host's lib dep is `^X.Y.Z` of an actual published version.
- Publish order is not user-visible (npm publish is atomic per package, but the CI run publishes both back-to-back inside seconds); end-users running `npm install @sentry/dotagents` after the run completes get matching versions.

**Alternative considered for "tandem" specifically:** publish the lib version N first, wait, then bump host to depend on `^N` and publish the host. Rejected — the wait creates a window where users installing the host get an old lib (or a mismatched pair). Lock-step within a single craft run avoids the window.

## Risks / Trade-offs

- **[Risk]** Workspace tooling churn (pnpm, vitest, oxlint, tsc) breaks the existing `pnpm check` flow during the transition. **Mitigation:** make tooling changes the first commit, validate `pnpm check` before moving any source files, then move modules in small chunks each verified by a green check.
- **[Risk]** Re-export shim drifts from lib reality (e.g. types diverge after the move). **Mitigation:** the shim is mechanical re-export only (`export * from "dotagents-lib"` for the moved bits or named re-exports of the previous public symbols), not a wrapper layer. A typecheck failure would catch drift immediately.
- **[Risk]** Hidden import from a "host-only" module into a "lib-only" module is missed and creates a circular package dependency. **Mitigation:** after the split, run `tsc --noEmit` per package in isolation (no cross-package path mapping); any leftover host import from inside the lib will fail fast.
- **[Trade-off]** Two packages mean two `package.json`s to keep version-aligned, two changelogs (eventually), and an extra `pnpm publish` step when we do publish. Acceptable cost for the modularity.
- **[Trade-off]** The deprecation shim keeps the host's `src/index.ts` larger than necessary for one release. Worth it to avoid breaking any existing library consumer of `@sentry/dotagents` mid-migration.
- **[Risk]** Cache directory remains brand-leaked (`~/.local/dotagents`) for non-dotagents callers who forget to call `configureCache`. **Mitigation:** documented in the lib's README; non-dotagents callers paying for the default is the intended trade for not breaking dotagents users.
- **[Risk]** First multi-package craft release goes wrong (e.g. craft only picks up one tarball, or `workspace:^` is not rewritten correctly, or one package publishes and the other fails leaving a mismatched pair on npm). **Mitigation:** before the first real release, run the release workflow against a non-`main` branch with a `--dry-run` or test scope, or do a manual `pnpm pack` of both packages and inspect the tarballs (no `workspace:` strings left, version matches, `dependencies` block has the rewritten lib version). Document the verified procedure in the change's tasks.
- **[Risk]** Contributors don't realize they need to bump both packages and accidentally publish a mismatched pair. **Mitigation:** centralize version bumping in a single command/script invoked by craft; both packages always read from the same source-of-truth version. Don't allow per-package manual bumps in this regime.

## Testing Strategy

**Unit / module tests (the bulk of existing coverage):** existing tests for `skills/`, `sources/`, `trust/`, and the relocated `utils/` move with their modules into `packages/dotagents-lib/`. They continue to run unchanged via `vitest run`. Existing host tests stay where they are.

**Integration test:** `skills/resolver.integration.test.ts` (which clones real repos) moves to the lib alongside the resolver. CI continues to run it.

**New cross-package smoke (host):** add a single new test in `packages/dotagents/` that imports a public symbol from `dotagents-lib` (e.g. `parseSource`) and verifies it is reachable through the workspace dependency. This catches a broken workspace link without re-testing lib internals.

**New tests required by this change** (also enumerated in tasks.md):
- `configureCache` overrides default; `DOTAGENTS_STATE_DIR` honored when `configureCache` not called; default falls back to `~/.local/dotagents/`.
- `trust?` opt on `resolveSkill`/`resolveWildcardSkills` blocks disallowed source *before* any network access; allows valid source; absent opt performs no validation.
- Type test (`tsc --noEmit` against a small fixture) confirming the host's `TrustConfig` zod schema's inferred type structurally satisfies the lib's `TrustPolicy` interface, so a future drift fails CI fast.

**Pack-level test:** in CI, after `pnpm -r pack`, untar both produced tarballs into a temp dir and assert (a) no remaining `workspace:` strings in the host's `package.json`, (b) the host's `dependencies["@sentry/dotagents-lib"]` matches the lib's published version, (c) `node packages/dotagents/dist/cli/index.js --help` still runs. This guards the release path against silent regressions in pnpm's workspace rewriting.

**Coverage floor:** the workspace `pnpm check` should not regress in test count or coverage versus pre-split `main`. Track this with a quick before/after diff during the move PR.

## Migration Plan

This is an internal restructure with no end-user behavior change, so "migration" here means the contributor- and release-side mechanics:

1. **Workspace bootstrap (PR 1):** create `pnpm-workspace.yaml`, root `package.json` becomes a workspace manifest, scripts proxy to packages. Add `packages/dotagents/` containing the current `src/`. Update CI to use `pnpm -r ...` invocations. Verify `pnpm check` is green with no functional changes.
2. **Lib package scaffold (PR 2 or same PR):** add `packages/dotagents-lib/` with its own `package.json` (`name: "@sentry/dotagents-lib"`, version matched to the host's current version, `private: false`, ESM), `tsconfig.json`, vitest config. Empty `src/index.ts`. Add the lib as a `workspace:^` dep of the host.
3. **Move modules (PR 3):** move `src/skills/`, `src/sources/`, `src/trust/`, `src/utils/exec.ts`, `src/utils/fs.ts` into the lib. Move `RepositorySource` definition into the lib. Co-located tests move too. Add `configureCache` and the `trust?` resolver opt. Host imports moved symbols from `@sentry/dotagents-lib`.
4. **Re-export shim (same PR 3 or PR 4):** the host's `src/index.ts` re-exports the moved symbols from the lib (with `@deprecated` JSDoc) so external consumers are unaffected.
5. **CI / release wiring (same PR 3 or PR 4):** update `.github/workflows/ci.yml` `build` job to pack both packages and upload both tarballs as `npm-package`. Update `.craft.yml` to publish both. Add the pack-level test described in Testing Strategy.
6. **Release validation (before merging the move PR):** locally run `pnpm -r pack` and inspect both tarballs by hand. On a release-rehearsal branch, manually trigger `release.yml` with a pre-release version (e.g. `1.14.0-rc.1`) and verify both packages land on npm with matching versions and a clean `dependencies` rewrite. Only after that, do the real release.
7. **Validate (any PR):** `pnpm check` is green. Run the CLI end-to-end against a real repo (`init`, `install`, `sync`, `list`). No semantic change should be observable.

**Rollback:** the change is a single restructuring PR (or a small chain). Reverting the merge restores the previous layout. The cache directory does not change in this work, so there is no on-disk state to roll back. If the *release* fails (mismatched pair on npm): immediately publish a patch that fixes the rewrite (or `npm deprecate` the bad version) — this is why we rehearse first.

## Open Questions

- **Lib npm name:** the proposal uses `@sentry/dotagents-lib` as the publishable placeholder. A future rename (e.g. `@sentry/skill-kit`) is non-trivial because npm package renames break installs — would need a deprecation period. Decide before we publish the first version: stick with `@sentry/dotagents-lib` long-term, or pick the final name now? *Tentative answer: ship as `@sentry/dotagents-lib` now; revisit naming only if we see a concrete reason to rebrand.*
- **Re-export shim scope:** do we mark re-exported symbols with a JSDoc `@deprecated` tag now to surface the migration in editors, even though the shim still works? *Tentative answer: yes, free signal.*
- **craft multi-package syntax:** does the version of `getsentry/craft` we pin support multiple npm targets (or one npm target with multiple package paths) cleanly? Verify against the craft docs at the pinned SHA before the move PR; if it doesn't, we either pin a newer craft or run a small custom pack/publish step.
- **Should `parseAgentsToml` ever live in the lib?** Confirmed in proposal that `agents.toml` parsing stays a host responsibility. Re-confirming for the record. Closed.
