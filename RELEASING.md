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
4. Craft's `npm` target publishes every `*.tgz` in the artifact — both packages go up in a single release run.
5. Craft tags the commit and creates the GitHub release.

## Why lock-step?

A consumer running `npm install @sentry/dotagents` must install a published version of the lib. If the lib were unpublished or out-of-sync, the install would either fail or pull a mismatched pair. Lock-step avoids both failure modes:

- Same version on both packages on every release.
- Single CI run publishes both, so there is no window where one is on npm without the other.
- The pack-time invariant check (`scripts/verify-pack.mjs`) fails the build if `workspace:` references leak through or versions drift.

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
