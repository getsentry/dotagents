# OpenCode QA

Use this reference when changes affect OpenCode config generation, `opencode.json`, `.opencode/agents/*.md`, or OpenCode user-scope paths.

## File-Level Checks

The core smoke asserts:

- `opencode.json` exists for OpenCode MCP config
- `.opencode/agents/code-reviewer.md` exists
- generated Markdown contains the dotagents managed marker

OpenCode does not support dotagents hooks in the current agent definition, so hook warnings for OpenCode are expected when the fixture includes hooks.

For user scope, isolate `HOME` and `DOTAGENTS_HOME`, then assert generated OpenCode subagents under `$HOME/.config/opencode/agents/`.

## Runtime Proof

This QA skill does not currently include an automated OpenCode runtime proof. Do not claim OpenCode runtime discovery from file-level checks alone.

If a branch specifically requires OpenCode runtime proof, use the installed OpenCode CLI/app and report:

- exact command or interaction
- temp project path
- generated `.opencode/agents/<name>.md`
- evidence that OpenCode loaded or invoked the expected agent

Otherwise report file-level OpenCode wiring only.
