# OpenCode QA

Use this reference when changes affect OpenCode config generation,
`.opencode/opencode.jsonc`, `.opencode/agents/*.md`, `.opencode/skills/*`, or
OpenCode user-scope paths.

## File-Level Checks

The core agentic QA asserts:

- `.opencode/opencode.jsonc` exists for OpenCode MCP config
- `.opencode/agents/code-reviewer.md` exists
- generated Markdown contains the dotagents managed marker
- plugin skills selected for OpenCode are symlinked into `.opencode/skills/`
  with ownership markers under `.opencode/skills/.dotagents-managed/`
- standard plugin `mcp.json` servers are flattened under
  `plugin.<plugin-name>.<server-name>` in `.opencode/opencode.jsonc`
- project MCP ownership is recorded in `.agents/plugin-mcp/opencode.json`, and
  stdio data is stored under `.agents/plugin-data/<plugin>/`

OpenCode does not support dotagents hooks in the current agent definition, so hook warnings for OpenCode are expected when the fixture includes hooks.

For compatibility fixtures, pre-create a legacy root `opencode.json` and verify install and sync update that file instead of creating the nested default. JSONC fixtures should keep comments and trailing commas after reconciliation.

For user scope, isolate `HOME` and `DOTAGENTS_HOME`, then assert generated
OpenCode subagents under `$HOME/.config/opencode/agents/`, plugin MCP in
`$HOME/.config/opencode/opencode.json`, ownership under
`$DOTAGENTS_HOME/plugin-mcp/opencode.json`, and stdio data under
`$DOTAGENTS_HOME/plugin-data/<plugin>/`.

## Plugin Component Proof

For generated plugin component projections, the QA skill has a cheap Docker proof:

```bash
node skills/dotagents-qa/scripts/qa-example.mjs opencode-projections --keep
```

This installs the checked-in example, asserts the generated
`.opencode/skills/plugin-qa` symlink, runs `opencode debug skill`, and checks
for the fixture skill sentinel. It also runs `opencode debug config` and checks
the flattened remote and stdio plugin MCP entries, including expanded plugin
root, persistent data path, cwd, and environment. This is resource-discovery
evidence, not native Agent Plugins installation or model-backed invocation.

## Runtime Proof

OpenCode subagent invocation and model-backed skill/plugin use still require an
authenticated runtime proof. Do not claim those from file-level checks alone.

Manual Docker probes can prove more when the branch affects OpenCode output:

- `opencode agent list` should include the generated
  `code-reviewer (subagent)`
- `opencode debug agent code-reviewer` should resolve the generated prompt and
  `mode = "subagent"`
- `opencode debug skill` should include projected plugin skills under
  `.opencode/skills/*`; verify from raw output instead of assuming it is
  stable across OpenCode versions
- `opencode debug config` should include portable plugin MCP under exact
  `plugin.<plugin>.<server>` keys; verify remote fields and fully expanded
  stdio command, args, cwd, and environment

For lifecycle proof, preserve an unrelated MCP entry, damage a managed plugin
MCP entry or its ownership state, run `dotagents sync`, and verify repair.
Then remove the plugin and verify only its managed MCP entries, ownership state,
and managed data directory are pruned.

For authenticated runtime proof, use a temp `opencode.json` provider
configuration and keep credentials in the environment, not in retained fixture
files.

With provider credentials forwarded into Docker, a minimal proof is:

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
