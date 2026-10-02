# @sentry/dotagents-lib

Reusable core for [SKILL.md](https://www.anthropic.com/engineering/skills) loading, [Agent Plugins](https://agent-plugins.org/) resolution, source resolution, and trust validation. This library powers the [`@sentry/dotagents`](https://www.npmjs.com/package/@sentry/dotagents) CLI. Depend on it directly when you want to consume agent skills or plugins from your own tooling without using `agents.toml`.

## What's in here

- **Source-string grammar** — `parseSource`, `applyDefaultRepositorySource`, `normalizeSource`, etc. The recognized forms are `owner/repo[@ref]`, GitHub/GitLab URLs (HTTPS and SSH), `git:<url>`, `path:<rel>`, and bare `https://` for well-known endpoints.
- **Resolution** — `resolveSkill(name, dep, opts?)` and `resolveWildcardSkills(dep, opts?)` clone/cache the source and return the on-disk skill directory plus a commit SHA for git sources. Both accept an optional `trust?: TrustPolicy` opt for opt-in trust enforcement at the resolver layer.
- **Agent Plugins** — `resolvePlugin(dep, opts)` resolves a plugin from a local or git source and returns a validated `PluginBundle` (directory, effective manifest, authored native manifests). `discoverPlugins(sourceDir, names?)` lists plugins in a source (root manifest, marketplaces, `.agents/plugins/`, `plugins/`). With `names`, it returns only matching plugins; an empty result can also mean no name matched. `loadInstalledPluginBundle` reloads a bundle that a host installed. `parsePluginManifest`, `parsePluginMcp`, and `parsePluginMarketplace` validate `plugin.json`, `mcp.json`, and `marketplace.json`. Every path stays inside its source root. The lib does not install bundles or write client files; hosts own those steps.
- **SKILL.md loading and discovery** — `loadSkillMd`, `discoverSkill`, `discoverAllSkills`.
- **Cache primitives** — `ensureCached`, `ensureWellKnownCached`. The lib has no default cache location; callers pass `stateDir` explicitly so hosts own their own conventions and env-var prefixes.
- **Trust** — `validateTrustedSource`, `extractDomain`, `TrustError`, `TrustPolicy`.
- **Source-host primitives** — `clone`, `fetchAndReset`, `fetchRef`, `headCommit`, `isGitRepo`, `GitError`, `exec`, `ExecError`.
- **Serialized data** — `SerializedValue`, `SerializedObject`, `isSerializedValue`, and `isSerializedObject` define and validate recursive values that can safely cross configuration boundaries. Accepted values are strings, finite numbers, booleans, null, unmodified valid dates, dense arrays, and plain or null-prototype objects with enumerable data properties. Containers must be acyclic; object properties may be `undefined`.

See `src/index.ts` for the full public surface.

To load a skill-only Agent Plugin in another host, resolve the selected plugin and scan only its `skills/` directory:

```ts
import { join } from "node:path";
import { discoverAllSkills, resolvePlugin } from "@sentry/dotagents-lib";

const resolved = await resolvePlugin(
  { name: "review-tools", source: "path:./plugins/review-tools" },
  { projectRoot: workspaceRoot, stateDir: cacheDir, trust: trustPolicy },
);
const skills = (await discoverAllSkills(join(resolved.plugin.pluginDir, "skills"), { scanDirs: [] }))
  .filter(({ path }) => path !== "." && !path.includes("/"));
```

Agent Plugins discovers only immediate child directories of `skills/`. The empty
`scanDirs` keeps the generic skill resolver from recursing, and the path filter
excludes a `SKILL.md` at the `skills/` root or other discovery formats.

`resolved.plugin.pluginDir` points to the source. For git sources it is a mutable cache checkout, so the host must copy the selected bundle into its own durable store before another resolution of that source can move the checkout. Serialize resolution and copying when multiple plugins share a source. Record the source and resolved commit with that copy. The host decides when to install, update, and expose the skills. Resolution does not configure a client or enable MCP servers.

## Versioning

`@sentry/dotagents-lib` ships in lock-step with `@sentry/dotagents` — both packages always carry the same version, published from the same release run. See [`RELEASING.md`](../../RELEASING.md) at the repo root.

## License

MIT.
