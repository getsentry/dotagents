# GitHub Copilot QA

Use this reference for Copilot skill, MCP, or plugin adapter changes. Keep
`COPILOT_HOME` inside the disposable Docker filesystem and run Copilot as the
non-root QA user.

## Version and isolation

```bash
copilot --version
export COPILOT_HOME=/sandbox/copilot-home
export COPILOT_ALLOW_ALL=true
mkdir -p "$COPILOT_HOME"
```

Do not reuse the host Copilot home or credentials. The checks below require no
model authentication. `COPILOT_ALLOW_ALL=true` is only for the disposable QA
container; it makes headless inventory commands include workspace MCP sources
without an interactive folder-trust prompt.

## Project skills and MCP

Run a Copilot-only project install, then use native inventory commands:

```bash
dotagents --project install
copilot skill list --json
copilot mcp list --json
```

Assert that project skills resolve from `.agents/skills/`. Test both rooted
`{"mcpServers": {...}}` and bare `{...}` project MCP files. A Copilot-only
reconcile preserves the existing form; sharing `.mcp.json` with Claude promotes
a bare map under `mcpServers` so neither client hides unmanaged servers.

## Global skills and MCP

Use an isolated global config and verify:

- `$COPILOT_HOME/skills` links to the selected dotagents global skills directory;
- `$COPILOT_HOME/mcp-config.json` preserves unmanaged entries;
- the MCP file has mode `0600` on POSIX; and
- an empty `COPILOT_HOME` falls back to `~/.copilot` for MCP, while native skill
  inventory demonstrates why global skill users must unset the variable instead.

## Plugins

```bash
node skills/dotagents-qa/scripts/qa-example.mjs plugin-copilot
```

This adds the generated local marketplace, browses it, installs the plugin,
and verifies the live plugin skill and MCP inventory. It is native management
and resource-discovery proof, not model-backed invocation.

Copilot prefers `marketplace.json` and `.plugin/marketplace.json` over
`.github/plugin/marketplace.json`; include a conflict case that proves dotagents
warns and removes stale managed output. Copilot resolves plugin manifests in
`.plugin`, root, `.github/plugin`, then `.claude-plugin` order. Sources with
only a `.plugin` or `.github/plugin` manifest are canonicalized to the portable
root. Conflicting locators must fail preflight when they would hide the
canonical source or make dotagents and Copilot select different manifests. In
legacy manifests, allow skills, MCP servers, and
cross-client fields Copilot leaves inert. Reject native agent, command, hook,
LSP, and executable-extension fields, plus active conventional paths even when
the manifest does not declare them.
For standard manifests, preserve arbitrary `extensions` data but reject a
physical top-level `com.github.copilot/` namespace. Copilot 1.0.83 loads agents,
commands, hooks, rules, LSP, and executable extensions from that namespace even
without a matching manifest entry.
