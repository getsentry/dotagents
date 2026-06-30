# Plugin Runtime Verification

Use this reference when a branch changes plugin output and the goal is to make
manual QA easy. Keep automated checks narrow: prove deterministic files and
native management commands first, then leave UI/model-backed confirmation as a
small checklist for the user.

## Baseline Automated Proof

Inside Docker, always start with:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm qa:example
node skills/dotagents-qa/scripts/qa-example.mjs plugin-claude
node skills/dotagents-qa/scripts/qa-example.mjs plugin-codex
node skills/dotagents-qa/scripts/qa-example.mjs plugin-opencode
```

This proves install/sync/list/doctor behavior, generated plugin files, Claude
validation, Codex marketplace install, and OpenCode component projection. It
does not prove every runtime loaded and invoked every plugin component.

`pnpm qa:example` is the install/sync repair proof. It intentionally runs only
the `install-files` and `sync-repair` tasks. Run the separate `plugin-claude`,
`plugin-codex`, and `plugin-opencode` tasks when the branch needs native
plugin-management or runtime-projection evidence.

## Claude Code

Best automated proof in Docker:

```bash
claude plugin validate .agents/plugins/qa-tools
claude plugin validate .claude-plugin/marketplace.json
claude plugin marketplace add "$PROJECT" --scope local
claude plugin list --available --json
claude plugin install qa-tools@dotagents --scope local
claude plugin list --json
claude plugin details qa-tools
```

Expected evidence:

- `plugin list --available --json` includes `qa-tools@dotagents`
- `plugin install` succeeds at local scope
- `plugin list --json` shows `enabled: true`
- `plugin details qa-tools` lists the generated bundle's available components,
  such as plugin skills and commands in the checked-in fixture. Claude Code
  2.1.x rejects `agents` in plugin manifests, so dotagents does not project
  plugin agents into the Claude native manifest.

Manual final check when authenticated:

- Start Claude Code in the retained temp project
- Run `/reload-plugins`
- Check `/help` or plugin UI for `/qa-tools:plugin-qa`
- Invoke the plugin skill and confirm it returns `DOTAGENTS_PLUGIN_QA_FIXTURE`

## Codex

Best automated proof in Docker:

```bash
export CODEX_HOME="$TMP/codex-home"
mkdir -p "$CODEX_HOME"
codex plugin marketplace add "$PROJECT" --json
codex plugin list --available --json
codex plugin add qa-tools@dotagents-local --json
codex plugin list --json
```

Expected evidence:

- Marketplace add returns `dotagents-local`
- Available list includes `qa-tools@dotagents-local`
- Install returns `qa-tools@dotagents-local`
- Installed list shows the plugin enabled

Manual final check with model auth:

- Run a Codex prompt in the retained project after installing the plugin
- Ask Codex to use or summarize the installed plugin skill/component
- Inspect JSON/session events or final answer for `DOTAGENTS_PLUGIN_QA_FIXTURE`

Codex plugin install proof is strong; plugin component invocation still needs a
model-backed prompt because the plugin management CLI does not execute skills.

## OpenCode

Best automated proof in Docker:

`node skills/dotagents-qa/scripts/qa-example.mjs plugin-opencode` installs the
fixture, confirms `.opencode/skills/plugin-qa` and
`.opencode/agents/plugin-reviewer.md` are symlinks into the installed plugin
bundle, then runs:

```bash
opencode debug skill
opencode agent list
```

Expected evidence:

- `debug skill` includes `plugin-qa` and `DOTAGENTS_PLUGIN_QA_FIXTURE`
- `agent list` includes `plugin-reviewer`

Manual final check with model auth:

- Use a configured provider key
- Run `opencode run --model "$OPENCODE_QA_MODEL" --format json "<prompt>"`
- For generated subagents, ask the primary agent to call the `task` tool with
  `subagent_type = "code-reviewer"`; do not pass the subagent to `--agent`

## Cursor

Best current proof:

- File-level generated marketplace exists at `.cursor-plugin/marketplace.json`
- The marketplace points at `./.agents/plugins/<name>`
- Cursor-native manifest exists at
  `.agents/plugins/<name>/.cursor-plugin/plugin.json`
- Generated manifest carries `metadata.managedBy = "dotagents"` and lists the
  expected component paths such as `skills`, `commands`, `agents`, `rules`,
  `hooks`, or `mcpServers` when those files exist

Manual final check with the Cursor client:

```bash
mkdir -p ~/.cursor/plugins/local
ln -s "$PROJECT/.agents/plugins/qa-tools" ~/.cursor/plugins/local/qa-tools
```

Then restart Cursor or run **Developer: Reload Window**. Verify:

- plugin appears in Cursor settings/marketplace UI
- plugin rules/skills/agents/commands/MCP servers appear in their respective
  Cursor settings surfaces
- invoking the plugin skill or command yields `DOTAGENTS_PLUGIN_QA_FIXTURE`

## Grok Build

Best automated proof depends on the `grok` CLI, which is not installed in the
QA Docker image today.

With `grok` available in Docker or locally isolated:

```bash
grok inspect
grok -p "Use the qa-tools plugin skill and return DOTAGENTS_PLUGIN_QA_FIXTURE" \
  -m "$GROK_QA_MODEL" \
  --output-format streaming-json
```

Expected evidence:

- `grok inspect` lists `.grok/plugins/qa-tools`
- `grok inspect` or the TUI extensions modal lists plugin skills/components
- model-backed output returns `DOTAGENTS_PLUGIN_QA_FIXTURE`

Manual final check:

- Open the retained project in Grok
- Open the extensions modal with `/plugins`, `/hooks`, `/skills`, or `/mcps`
- Verify the generated plugin and its components are listed
- Invoke the plugin skill or command and check for `DOTAGENTS_PLUGIN_QA_FIXTURE`

## What Counts As Verified

- File generated: dotagents writer works, not runtime load.
- Native validate/list/install/details command passes: runtime can parse and
  register the plugin.
- Runtime debug config shows a plugin-injected value: plugin code loaded and
  executed.
- Model/UI invocation returns the sentinel: end-user behavior is verified.
