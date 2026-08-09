# Codex QA

Use this reference when changes affect Codex config generation, `.codex/agents/*.toml`, Codex MCP config, Codex user scope, or claims that generated Codex subagents work in Codex.

## File-Level Checks

The core agentic QA asserts:

- `.codex/config.toml` exists for MCP config
- `.codex/agents/code-reviewer.toml` exists
- the generated TOML contains the dotagents managed marker
- the generated TOML contains `name`, `description`, and `developer_instructions`
- `sync` repairs deleted `.codex/agents/code-reviewer.toml`

These checks prove dotagents wrote the expected files. They do not prove Codex loaded the agent.

## Runtime Proof

Run the paid runtime proof when the branch affects Codex custom agents or when reporting that Codex itself works:

```bash
node skills/dotagents-qa/scripts/qa-example.mjs codex-runtime --keep
```

The task:

- copies `examples/full/` to a temp project
- runs the built local dotagents CLI
- initializes the temp project as a git repo
- copies Codex auth/config into a temp `CODEX_HOME`
- marks only the temp project trusted in that temp config
- runs `codex exec`
- asks Codex to spawn `code-reviewer`
- asserts the final output includes `DOTAGENTS_SUBAGENT_RUNTIME_PROOF_9b8e6f2c`
- removes the temp `codex-home` even when `--keep` is set

With `--keep`, inspect:

- `codex-runtime.out` for the final message
- `codex-runtime.jsonl` for `spawn_agent`, `wait`, and child-agent response events
- `project/.codex/agents/code-reviewer.toml` for the generated file Codex loaded

For gateway-backed Codex proof, put provider config in the isolated
`CODEX_HOME/config.toml`; Codex ignores provider redirects in project
`.codex/config.toml`. Pass provider credentials into Docker only for the
runtime invocation.

## Important Caveats

Project-scoped `.codex/` layers load only when Codex trusts the project. A one-off `-c projects."<path>".trust_level="trusted"` override did not prove sufficient in local testing; the reliable path is a temp `CODEX_HOME/config.toml` with the canonical real project path marked trusted.

`codex debug prompt-input` is not enough for custom-agent proof unless it visibly includes the generated agent name or instructions. In local testing it did not expose the custom agent.

If Codex reports `unknown agent_type`, check project trust and the canonical path (`pwd -P`) before assuming the generated TOML schema is wrong.

Do not leave copied Codex auth in retained temp directories. The QA task scrubs its temp `codex-home`; if you run manual experiments, remove copied auth/config before reporting.
