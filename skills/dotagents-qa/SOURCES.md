# dotagents QA Sources

## Source Inventory

| Source | Contribution |
|--------|--------------|
| `AGENTS.md` | pnpm and validation conventions |
| `package.json` | `pnpm build` and `pnpm check` scripts |
| `specs/SPEC.md` | canonical `.agents/skills/`, agent symlink, MCP, hook, install, sync, list, and doctor behavior |
| `packages/dotagents/src/agents/definitions/claude.ts` | Claude project skills and generated config paths |
| `packages/dotagents/src/agents/definitions/cursor.ts` | Cursor shares `.claude/skills` and writes Cursor-specific MCP/hook config |
| `packages/dotagents/src/cli/cache.ts` | `DOTAGENTS_STATE_DIR` cache isolation |
| `packages/dotagents/src/cli/update-notifier.ts` | `HOME` isolation for update-check cache |
| `skills/dotagents/SKILL.md` | sibling skill layout |
| local `codex debug prompt-input` probe | verifies Codex can expose `.agents/skills` metadata without a model call |

## Decisions

- Keep the runtime skill as an inline smoke-test guide rather than a broad QA matrix.
- Use local `path:` skills by default so the fixture tests dotagents wiring without network/trust noise.
- Build first and run `packages/dotagents/dist/cli/index.js` from inside the temp project.
- Include representative local skills, agents, MCP, and hooks because those cover the main generated outputs.
- Expose the skill through `.agents/skills/dotagents-qa` so existing Claude/Cursor symlinks discover it.
- Keep agent CLI registration and remote-source checks optional because they add auth, network, or tool-version variance.

## Trigger Notes

Should trigger for requests like "QA this dotagents install change", "test dotagents in a temp project", "verify skill placement", and "make sure sync still repairs generated files".

Should not trigger for general dotagents usage help or unrelated project QA.
