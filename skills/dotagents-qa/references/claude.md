# Claude Code QA

Use this reference when changes affect Claude Code skill symlinks, `.claude/settings.json`, `.claude/agents/*.md`, hooks, MCP config, or user-scope Claude paths.

## File-Level Checks

The core agentic QA asserts:

- `.claude/skills` is a symlink to `.agents/skills`
- `.mcp.json` exists for Claude MCP config
- `.claude/settings.json` exists for hooks
- `.claude/agents/code-reviewer.md` exists
- generated Markdown contains the dotagents managed marker
- `sync` repairs deleted `.claude/skills` and `.claude/agents/code-reviewer.md`

For user scope, isolate both:

```bash
HOME="$TMP/home"
DOTAGENTS_HOME="$TMP/user-home"
```

Then assert Claude runtime files under `$HOME/.claude/agents/` and user skills under `$DOTAGENTS_HOME/skills/`.

## Runtime Proof

There is no cheap dry-run in this QA skill that proves Claude Code loads custom agents. Do not claim Claude runtime discovery from file-level checks alone.

For authenticated or OpenRouter-backed runtime proof, read
[runtime-auth.md](runtime-auth.md) first. Keep credentials in `.env.qa.local`,
pass only `OPENROUTER_API_KEY` or `ANTHROPIC_*` variables into Docker, and keep
`HOME` isolated to the temp container home.

If a branch specifically requires Claude runtime proof, run an explicit Claude Code invocation only when auth/model cost is acceptable, keep it isolated to a temp project, and report:

- exact command
- temp project path
- generated `.claude/agents/<name>.md`
- evidence that Claude invoked or surfaced the intended custom agent

If you skip this, say runtime proof was skipped and file-level wiring passed.
