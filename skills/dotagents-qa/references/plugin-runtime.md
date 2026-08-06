# Plugin Runtime Verification

Use this reference when a branch changes plugin output and the goal is to make
manual QA easy. Keep automated checks narrow: prove deterministic files and
native management commands first, then leave UI/model-backed confirmation as a
small checklist for the user.

## Baseline Automated Proof

Inside Docker, always start with:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm qa:example
pnpm qa:plugins
```

`pnpm qa:example` proves the dotagents install/sync filesystem contract. It runs
`install`, `list`, `doctor --fix`, `doctor`, and `sync`, then checks generated
files and repair behavior.

`pnpm qa:plugins` runs installed no-auth client proofs:

- Claude validates the generated plugin and marketplace.
- Codex adds the marketplace, lists the plugin as available, installs it, and
  lists it as enabled.
- Grok Build runs `plugin list` and `plugin details` when its CLI is installed.

Cursor remains covered by the all-target integration contract because its
desktop CLI has no plugin validation or marketplace command. OpenCode resource
projection has a separate task, but it is not plugin E2E evidence.

## Claude Code

Automated proof:

```bash
node skills/dotagents-qa/scripts/qa-example.mjs plugin-claude
```

This runs `claude plugin validate` against the generated native manifest and
marketplace. Validation warnings about dotagents ownership metadata are allowed;
validation errors fail the task. It does not install or invoke the plugin.

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

## OpenCode projection (not plugin E2E)

```bash
node skills/dotagents-qa/scripts/qa-example.mjs opencode-projections
```

This confirms OpenCode discovers the generated plugin skill symlink. It does
not prove OpenCode consumes the Agent Plugins bundle or installs a plugin.
