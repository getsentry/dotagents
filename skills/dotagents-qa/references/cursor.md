# Cursor QA

Use this reference when changes affect Cursor skill sharing, `.cursor/mcp.json`, `.cursor/hooks.json`, `.cursor/agents/*.md`, or Cursor user-scope paths.

## File-Level Checks

The core smoke asserts:

- Cursor shares Claude-compatible skills through `.claude/skills`
- `.cursor/mcp.json` exists for Cursor MCP config
- `.cursor/hooks.json` exists for Cursor hooks
- `.cursor/agents/code-reviewer.md` exists
- generated Markdown contains the dotagents managed marker

Cursor does not get its own `.cursor/skills` symlink in the current expected behavior; it uses Claude-compatible skill placement.

For user scope, isolate `HOME` and `DOTAGENTS_HOME`, then assert generated Cursor subagents under `$HOME/.cursor/agents/`.

## Runtime Proof

This QA skill does not currently include an automated Cursor desktop/runtime proof. Do not claim Cursor runtime discovery from file-level checks alone.

If a branch specifically requires Cursor runtime proof, use a real Cursor session or a documented headless path if one exists in the local environment. Report the exact interaction and evidence. Otherwise report file-level Cursor wiring only.
