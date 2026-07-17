# OpenCode QA

Use this reference when changes affect OpenCode config generation, `.opencode/opencode.jsonc`, `.opencode/agents/*.md`, or OpenCode user-scope paths.

## File-Level Checks

The core agentic QA asserts:

- `.opencode/opencode.jsonc` exists for OpenCode MCP config
- `.opencode/agents/code-reviewer.md` exists
- generated Markdown contains the dotagents managed marker

For compatibility fixtures, pre-create a legacy root `opencode.json` and verify install and sync update that file instead of creating the nested default. For JSONC fixtures, include comments and trailing commas and verify they survive reconciliation.

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
