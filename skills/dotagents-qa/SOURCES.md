# dotagents QA Sources

## Source Inventory

| Source | Contribution |
|--------|--------------|
| `AGENTS.md` | pnpm and validation conventions |
| `package.json` | `pnpm build` and `pnpm check` scripts |
| `specs/SPEC.md` | canonical `.agents/skills/`, agent symlink, MCP, hook, install, sync, list, and doctor behavior |
| `packages/dotagents/src/agents/definitions/claude.ts` | Claude project skills and generated config paths |
| `packages/dotagents/src/agents/definitions/cursor.ts` | Cursor shares `.claude/skills` and writes Cursor-specific MCP/hook config |
| `packages/dotagents/src/agents/definitions/vscode.ts` | VS Code reads `.agents/skills` natively and writes `.vscode/mcp.json` plus shared Claude-style hooks |
| `packages/dotagents/src/agents/definitions/codex.ts` | Codex reads `.agents/skills` natively and writes `.codex/config.toml` |
| `packages/dotagents/src/agents/definitions/opencode.ts` | OpenCode reads `.agents/skills` natively and writes `opencode.json` |
| `packages/dotagents/src/cli/cache.ts` | `DOTAGENTS_STATE_DIR` cache isolation |
| `packages/dotagents/src/cli/update-notifier.ts` | `HOME` isolation for update-check cache |
| `skills/dotagents/SKILL.md` | sibling skill layout |
| `/Users/dcramer/src/sentry-mcp/.agents/skills/mcp-qa/SKILL.md` | Numbered QA flow, primary path guidance, optional client checks, and pass criteria structure |
| local `codex debug prompt-input` probe | verifies Codex can expose `.agents/skills` metadata without a model call |

## Decisions

- Keep the runtime skill as a guided QA playbook rather than a broad QA matrix or fixed all-in-one harness.
- Provide a repo-local Dockerfile for the sandbox/toolchain only; keep fixture design and assertions manual.
- Keep the Dockerfile's prepared pnpm version aligned with the root `packageManager`.
- Mount the host checkout read-only and do dependency install/build inside Docker to avoid host system-file writes and host binary assumptions.
- Exclude `*.tsbuildinfo` with `dist` so TypeScript project references rebuild cleanly instead of reusing stale host incremental state.
- Document `-i` for non-TTY Docker runs because stdin must stay attached when an agent feeds commands through a here-doc.
- Make agents derive the fixture from the diff first, then use local `path:` skills, specific agents, MCP entries, hooks, broken state, user scope, or remote sources as needed.
- Run `pnpm check` and `pnpm build` inside Docker when appropriate, then run `packages/dotagents/dist/cli/index.js` from inside the fixture project.
- Require inspection of generated files and command output that demonstrate the changed behavior, not only exit codes.
- Expose the skill through `.agents/skills/dotagents-qa` so existing Claude/Cursor symlinks discover it.
- Keep agent CLI registration and remote-source checks optional because they add auth, network, or tool-version variance.

## Trigger Notes

Should trigger for requests like "QA this dotagents install change", "test dotagents in a temp project", "verify skill placement", and "make sure sync still repairs generated files".

Should not trigger for general dotagents usage help or unrelated project QA.
