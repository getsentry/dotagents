# Core Agentic QA

Use this reference for ordinary dotagents install/sync QA before drilling into a specific runtime.

## Checked-In Example

Run:

```bash
pnpm qa:example
```

This builds the local CLI, copies `examples/full/` to a temp project, and verifies:

- `install`, `list`, `doctor --fix`, and `doctor` complete successfully
- managed skills under `.agents/skills/`
- Claude/Cursor skill symlink behavior
- MCP files for Claude, Cursor, Codex, and OpenCode
- hook files for Claude and Cursor
- canonical installed subagent under `.agents/agents/`
- generated subagent runtime files for Claude, Cursor, Codex, and OpenCode
- `sync` repair after deleting representative generated files

Use `node skills/dotagents-qa/scripts/qa-example.mjs all --keep` to keep the
temp project for inspection. The script prints the project path.

## What This Proves

This proves dotagents local CLI behavior and generated file placement. It does not prove a third-party runtime actually discovers or executes those generated files unless the runtime-specific proof also runs.

## When To Customize

Start from `examples/full/` when a branch changes broad behavior. Create a custom temp fixture only when the example cannot express the changed surface, such as unusual source resolution, user scope, conflict handling, or packaging behavior.
