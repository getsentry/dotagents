# @sentry/dotagents-lib

Reusable core for [SKILL.md](https://www.anthropic.com/engineering/skills) loading, source resolution, and trust validation. This library powers the [`@sentry/dotagents`](https://www.npmjs.com/package/@sentry/dotagents) CLI. Depend on it directly when you want to consume agent skills from your own tooling without using `agents.toml`.

## What's in here

- **Source-string grammar** — `parseSource`, `applyDefaultRepositorySource`, `normalizeSource`, etc. The recognized forms are `owner/repo[@ref]`, GitHub/GitLab URLs (HTTPS and SSH), `git:<url>`, `path:<rel>`, and bare `https://` for well-known endpoints.
- **Resolution** — `resolveSkill(name, dep, opts?)` and `resolveWildcardSkills(dep, opts?)` clone/cache the source and return the on-disk skill directory plus a commit SHA for git sources. Both accept an optional `trust?: TrustPolicy` opt for opt-in trust enforcement at the resolver layer.
- **SKILL.md loading and discovery** — `loadSkillMd`, `discoverSkill`, `discoverAllSkills`.
- **Cache primitives** — `ensureCached`, `ensureWellKnownCached`. The lib has no default cache location; callers pass `stateDir` explicitly so hosts own their own conventions and env-var prefixes.
- **Trust** — `validateTrustedSource`, `extractDomain`, `TrustError`, `TrustPolicy`.
- **Source-host primitives** — `clone`, `fetchAndReset`, `fetchRef`, `headCommit`, `isGitRepo`, `GitError`, `exec`, `ExecError`.

See `src/index.ts` for the full public surface.

## Versioning

`@sentry/dotagents-lib` ships in lock-step with `@sentry/dotagents` — both packages always carry the same version, published from the same release run. See [`RELEASING.md`](../../RELEASING.md) at the repo root.

## License

MIT.
