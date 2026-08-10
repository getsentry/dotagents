# Release and Real Plugin Matrix

Use this reference for release QA, plugin CLI changes, real plugin compatibility, or user/global plugin scope.

## Select current sources

Inspect manifests before testing; do not guess names or layouts. The default high-signal set is:

- `getsentry/agent-plugin` — standalone Agent Plugins v1 bundle
- `vercel/vercel-plugin` — large native Claude plugin with skills, hooks, MCP, commands, and agents
- `anthropics/claude-plugins-official` — select one high-signal plugin from its current nested marketplace after inspection

Confirm current manifests and repository activity with `gh api`, `gh search code`, or cloned files. Use fewer plugins only when a source is unavailable and report that limitation.

## Standard CLI lifecycle

Use a fresh git project per source and initialize every relevant full agent plus Pi:

```bash
mkdir -p /sandbox/cases/sentry
cd /sandbox/cases/sentry
git init -q
dotagents init --agents claude,codex,opencode,pi
dotagents add getsentry/agent-plugin
dotagents list --json
dotagents doctor
```

Inspect `agents.toml`, `agents.lock`, `.agents/.gitignore`, the canonical plugin bundle, generated marketplaces/manifests, and component links. Delete representative managed outputs, run `dotagents sync`, and verify repair. Run `dotagents remove <name>` and verify canonical files, marketplaces, markers, and links are pruned.

Also cover a skill-only source or fixture so plugin-first detection still falls back to skill behavior. Test `--all` with a small controlled catalog, not a hundreds-entry public marketplace.

## Isolate each harness

Do not put OpenCode and Pi in the same proof fixture: OpenCode can read `.agents/skills`, so Pi links could create a false OpenCode pass.

### Claude

```bash
claude plugin validate .agents/plugins/<name>/.claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
claude plugin marketplace add ./ --scope project
claude plugin install <name>@dotagents --scope project
claude plugin list
claude plugin details <name>@dotagents
```

Validation and component inventory are no-auth proof, not model invocation.

### Codex

```bash
export CODEX_HOME=/sandbox/codex-home
mkdir -p "$CODEX_HOME"
codex plugin marketplace add ./ --json
codex plugin list --marketplace dotagents-local --available --json
codex plugin add <name>@dotagents-local --json
codex plugin list --json
```

The local marketplace source must be the project directory, not the marketplace JSON file or its containing `.agents/plugins` directory.

### OpenCode

Use an OpenCode-only plugin target, then run:

```bash
opencode debug skill > /qa-out/opencode-skills.json
jq '[.[] | select(.location | contains("/.opencode/skills/"))] | map(.name)' \
  /qa-out/opencode-skills.json
opencode debug config > /qa-out/opencode-config.json
jq '.mcp | with_entries(select(.key | startswith("plugin.")))' \
  /qa-out/opencode-config.json
```

Assert exact projected locations and skill names. For standard Agent Plugins v1
bundles with `mcp.json`, also assert every flattened
`plugin.<plugin-name>.<server-name>` entry. Check remote URLs and headers; for
stdio servers, check the command, args, cwd, `${PLUGIN_ROOT}` and
`${PLUGIN_DATA}` expansion, literal environment values, and persistent managed
data directory.

### Pi

Use a Pi-only target and verify each managed link in `.agents/skills/` resolves to the canonical plugin skill and has its ownership marker. Pi has no equivalent no-auth skill inventory command, so do not claim model-backed loading from link proof alone.

## User and global scope

Test both flag spellings with isolated homes:

```bash
export HOME=/sandbox/home
export DOTAGENTS_HOME="$HOME/.agents"
dotagents --global init --agents claude,codex,opencode,pi
dotagents --user add getsentry/agent-plugin
dotagents --global list --json
dotagents --user doctor
```

Expected default-home outputs:

- canonical bundle: `$HOME/.agents/plugins/<name>/`
- Claude marketplace: `$HOME/.agents/.claude-plugin/marketplace.json`
- Codex marketplace: `$HOME/.agents/plugins/marketplace.json`
- OpenCode skills: `$HOME/.config/opencode/skills/<skill>`
- OpenCode MCP config: `$HOME/.config/opencode/opencode.json`
- OpenCode MCP ownership: `$DOTAGENTS_HOME/plugin-mcp/opencode.json`
- OpenCode plugin data: `$DOTAGENTS_HOME/plugin-data/<plugin>`
- Pi skills: `$HOME/.agents/skills/<skill>`

Native user proof:

```bash
cd "$DOTAGENTS_HOME"
claude plugin marketplace add ./ --scope user
claude plugin install <name>@dotagents --scope user

cd "$HOME"
codex plugin marketplace add ./ --json
codex plugin add <name>@dotagents-local --json

cd /sandbox/neutral-project
opencode debug skill
opencode debug config
```

When `DOTAGENTS_HOME` is not `$HOME/.agents`, add the Codex marketplace from `$DOTAGENTS_HOME`; dotagents emits its adapter catalog below `$DOTAGENTS_HOME/.agents/plugins/` so Codex can discover it. Assert user-scope plugin MCP from a neutral project so project config cannot supply a false pass.

Delete one marketplace, one component link, and one managed OpenCode MCP entry or ownership record; run `dotagents --user sync` and prove repair. Remove the plugin using the other flag spelling and prove all canonical and generated state is gone while unrelated OpenCode config remains.

## Reporting

Record exact dotagents and harness versions, source commits, commands, generated paths, native-client results, sync/remove results, skipped authenticated checks, and residual risk. Keep published-release failures separate from later packed-local-build passes.
