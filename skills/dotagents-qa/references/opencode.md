# OpenCode QA

Use this reference when changes affect OpenCode config generation, `opencode.json`, `.opencode/agents/*.md`, or OpenCode user-scope paths.

## File-Level Checks

The core agentic QA asserts:

- `opencode.json` exists for OpenCode MCP config
- `.opencode/agents/code-reviewer.md` exists
- generated Markdown contains the dotagents managed marker

OpenCode does not support dotagents hooks in the current agent definition, so hook warnings for OpenCode are expected when the fixture includes hooks.

For user scope, isolate `HOME` and `DOTAGENTS_HOME`, then assert generated OpenCode subagents under `$HOME/.config/opencode/agents/`.

## Runtime Proof

This QA skill does not currently include an automated OpenCode runtime proof.
Do not claim OpenCode runtime discovery from file-level checks alone.

Manual Docker probes can prove more when the branch affects OpenCode output:

- `opencode agent list` should include the generated
  `code-reviewer (subagent)`
- `opencode debug agent code-reviewer` should resolve the generated prompt and
  `mode = "subagent"`
- `opencode debug config` should include the generated
  `.opencode/plugins/qa-tools.ts` plugin module
- `opencode debug skill` may show `.agents/skills/*` discovery; verify from
  raw output instead of assuming it is stable across OpenCode versions

For authenticated or OpenRouter-backed runtime proof, read
[runtime-auth.md](runtime-auth.md) first. Use a temp `opencode.json` provider
configuration with `@ai-sdk/openai-compatible`, `options.baseURL`, and
`options.apiKey` referencing `{env:OPENROUTER_API_KEY}`. Keep credentials in
the environment, not in retained fixture files.

With `OPENROUTER_API_KEY` forwarded into Docker, a minimal proof is:

- `opencode auth list` reports the OpenRouter environment credential
- `opencode models openrouter` lists the chosen model
- `opencode run --model <model> --format json "<sentinel prompt>"` returns the
  sentinel

This proves OpenCode can call the model provider. To prove generated subagent
invocation, do not pass the generated subagent to `--agent`; OpenCode rejects a
subagent there because `--agent` expects a primary agent. Instead, ask the
primary agent to use the `task` tool with `subagent_type = "code-reviewer"`:

```bash
opencode run \
  --model "$OPENCODE_QA_MODEL" \
  --format json \
  "Use the task tool to delegate to the code-reviewer subagent. Tell code-reviewer to return exactly DOTAGENTS_SUBAGENT_RUNTIME_PROOF_9b8e6f2c and nothing else. Wait for the subagent result, then return only the exact subagent result."
```

The JSON output should include a `tool_use` part with:

- `"tool":"task"`
- `"subagent_type":"code-reviewer"`
- `"status":"completed"`
- task output containing `DOTAGENTS_SUBAGENT_RUNTIME_PROOF_9b8e6f2c`

It should also end with a text part containing only the sentinel.

If a branch specifically requires OpenCode runtime proof, use the installed OpenCode CLI/app and report:

- exact command or interaction
- temp project path
- generated `.opencode/agents/<name>.md`
- evidence that OpenCode loaded or invoked the expected agent

Otherwise report file-level OpenCode wiring only.
