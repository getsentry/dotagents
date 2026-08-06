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

## Plugin Checks

Use these checks when a branch affects plugin output for Claude. Run them inside
the Docker QA container, against a retained QA project:

```bash
node skills/dotagents-qa/scripts/qa-example.mjs plugin-claude --keep
```

The task creates a fresh Claude-only fixture, validates the generated plugin and
marketplace, adds the marketplace, installs the plugin, and inspects the
installed plugin. It requires one plugin skill, zero leaked client-extension
agents, and both non-empty portable MCP servers.

Claude Code 2.1.x rejects an `agents` field in plugin manifests. dotagents
therefore omits plugin agents from the generated Claude manifest even when the
canonical bundle contains an `agents/` directory for other runtimes.

Validation should complete without warnings. Dotagents ownership is stored in
adjacent sidecar files rather than client-owned JSON fields.

If Claude reports `No manifest found in directory`, verify the plugin bundle
contains `.claude-plugin/plugin.json`; the marketplace alone is not enough. If
Claude reports `plugins.0.source: Invalid input`, verify marketplace entries
use relative string sources like `"./.agents/plugins/qa-tools"`.

## Runtime Proof

There is no cheap dry-run in this QA skill that proves Claude Code loads custom agents. Do not claim Claude runtime discovery from file-level checks alone.

For authenticated runtime proof, pass only the required provider variables into
Docker, keep credentials out of retained fixtures, and keep `HOME` isolated to
the temp container home.

If a branch specifically requires Claude runtime proof, run an explicit Claude Code invocation only when auth/model cost is acceptable, keep it isolated to a temp project, and report:

- exact command
- temp project path
- generated `.claude/agents/<name>.md`
- evidence that Claude invoked or surfaced the intended custom agent

If you skip this, say runtime proof was skipped and file-level wiring passed.
