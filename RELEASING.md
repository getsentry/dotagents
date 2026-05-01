# Releasing

This repo publishes two packages to npm in lock-step:

- `@sentry/dotagents` — the CLI and host library (orchestrates `agents.toml`).
- `@sentry/dotagents-lib` — the reusable core (SKILL.md loading, source resolution, trust validation).

Both always carry the same version. `@sentry/dotagents` depends on `^X.Y.Z` of `@sentry/dotagents-lib`; pnpm rewrites the `workspace:^` reference to the concrete range at pack time.

## How releases are cut

Releases are driven by [getsentry/craft](https://github.com/getsentry/craft) via the `release.yml` workflow.

1. Trigger `Release` from the GitHub Actions tab. Pick a version (`auto`, `major`, `minor`, `patch`, or an explicit semver).
2. Craft runs `node scripts/bump-version.mjs <new-version>`, which updates the `version` field in all three `package.json` files (root, `packages/dotagents`, `packages/dotagents-lib`) so they stay in lock-step.
3. CI builds both packages, packs both tarballs into the `npm-package` artifact, and runs `scripts/verify-pack.mjs` to confirm:
   - The host's published `package.json` contains no `workspace:` references.
   - `dependencies["@sentry/dotagents-lib"]` is a concrete range matching the lib's actual version.
   - The unpacked CLI runs end-to-end against the unpacked lib.
4. Craft has two `npm` targets in `.craft.yml`, each filtered to one tarball via `includeNames`. Targets run in declared order: **`@sentry/dotagents-lib` first, then `@sentry/dotagents`**. By the time the host's publish starts, the lib is already on the registry, so an end-user `npm install @sentry/dotagents` mid-release will always resolve.
5. Craft tags the commit and creates the GitHub release.

## Why lock-step + ordered publish?

A consumer running `npm install @sentry/dotagents` must install a published version of the lib. If the lib were unpublished or out-of-sync, the install would either fail or pull a mismatched pair. Three guardrails:

- **Lock-step versions.** `bump-version.mjs` updates both `package.json`s atomically, so versions can't drift mid-bump.
- **Pack-time invariants.** `scripts/verify-pack.mjs` fails CI if the host's tarball still has `workspace:` references or if `dependencies["@sentry/dotagents-lib"]` doesn't match the lib's actual version.
- **Ordered publish.** Two filtered `npm` targets in `.craft.yml` (lib first, host second) eliminate the few-second window where one is on npm without the other. Pattern modeled on `getsentry/junior`.

## Manually bumping versions

```sh
node scripts/bump-version.mjs 1.14.0
```

Updates all three `package.json`s. Don't bump them by hand — the script is the source of truth.

## Recovering from a mismatched-pair release

If a release ever publishes the host without the lib (or vice versa), or with a stale `dependencies["@sentry/dotagents-lib"]` range:

1. Immediately publish a patch release that fixes the metadata. Both packages go up together.
2. If the bad host version is unusable for end-users, run `npm deprecate @sentry/dotagents@<bad-version> "use <new-version>"` so the npm install path warns.
3. Investigate whether `verify-pack.mjs` should have caught it — extend the script's invariants if not.

## Where things live

| File | Purpose |
| ---- | ------- |
| `.craft.yml` | Craft config: `preReleaseCommand` is the bump script; `npm` target picks up both tarballs. |
| `scripts/bump-version.mjs` | Lock-step version bumper. |
| `scripts/verify-pack.mjs` | Invariant check between pack and publish. |
| `.github/workflows/ci.yml` | Builds and packs both packages; runs the verify step on every PR. |
| `.github/workflows/release.yml` | Drives craft. |
