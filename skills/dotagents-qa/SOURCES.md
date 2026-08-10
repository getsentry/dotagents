# dotagents QA Sources

## Source Inventory

| Source | Contribution |
|--------|--------------|
| `AGENTS.md` | pnpm and validation conventions |
| `package.json` | `pnpm check`, `pnpm qa:example`, and `pnpm qa:plugins` scripts |
| `specs/SPEC.md` | canonical skills, scopes, lifecycle commands, and generated harness behavior |
| `specs/plugins.md` | plugin discovery, storage, targeting, projection, and CLI semantics |
| `packages/dotagents/src/scope.ts` | project and user root/path resolution, including `DOTAGENTS_HOME` |
| `packages/dotagents/src/cli/main.ts` | global `--user` and `--global` flag parsing |
| `packages/dotagents/src/cli/commands/{add,install,sync,remove,doctor}.ts` | complete plugin lifecycle behavior and repair surfaces |
| `packages/dotagents/src/plugins/store.ts` | plugin discovery, source resolution, canonical install, and installed-bundle loading |
| `packages/dotagents/src/plugins/runtime/layout.ts` | project versus user/global runtime destinations |
| `packages/dotagents/src/plugins/runtime/{marketplace,opencode-mcp,writer}.ts` | generated marketplaces, manifests, OpenCode MCP projection, verification, and pruning |
| `skills/dotagents-qa/Dockerfile` | non-root QA image and installed Claude, Codex, OpenCode, and Pi CLIs |
| `skills/dotagents-qa/scripts/qa-example.mjs` | checked-in deterministic example and plugin harness assertions |

## Decisions

- Keep the runtime skill as a guided QA playbook, with a representative release-plugin matrix rather than an exhaustive catalog.
- Use the repo-local Dockerfile as the isolation boundary and install all four primary harness CLIs in it.
- Keep the Dockerfile's prepared pnpm version aligned with the root `packageManager`.
- Mount the host checkout read-only and do dependency install/build inside Docker to avoid host system-file writes and host binary assumptions.
- Exclude `*.tsbuildinfo` with `dist` so TypeScript project references rebuild cleanly instead of reusing stale host incremental state.
- Document `-i` for non-TTY Docker runs because stdin must stay attached when an agent feeds commands through a here-doc.
- Distinguish exact published-package evidence from a later packed-local-build fix.
- Require project and user/global lifecycle coverage when plugin scope behavior changes, including both flag spellings.
- Test Sentry, Vercel, and one selected Anthropic marketplace plugin as the high-signal compatibility set.
- Keep OpenCode and Pi proofs isolated because both can observe `.agents/skills` and contaminate one another.
- Use native no-auth Claude/Codex management commands, OpenCode skill and MCP resource discovery, and Pi link inspection without claiming model invocation.
- Run focused regressions plus `pnpm check`, `pnpm qa:example`, and `pnpm qa:plugins` for plugin/runtime changes.
- Require inspection of generated files and command output that demonstrate the changed behavior, not only exit codes.
- Keep authentication out of ordinary QA; model-backed invocation is a separate, explicitly authorized layer.

## Trigger Notes

Should trigger for requests like "QA this dotagents install change", "test the published release in Docker", "verify global plugins", and "prove the plugin works in Claude, Codex, OpenCode, and Pi".

Should not trigger for general dotagents usage help or unrelated project QA.
