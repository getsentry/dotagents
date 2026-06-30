# Plugin Support Specification

Plugin support lets teams declare reusable agent extensions once, preserve native plugin artifacts where they already exist, and generate deterministic runtime outputs for supported tools.

This is not a universal plugin behavior schema. Runtime-specific behavior such as app authentication, hook trust prompts, LSP lifecycle, JavaScript plugin APIs, marketplace review, managed policy, UI presentation, and telemetry belongs in each runtime's native plugin format.

## Core Model

dotagents has one canonical plugin source of truth:

```text
.agents/plugins/
|-- marketplace.json
`-- <plugin-name>/
    |-- plugin.json
    `-- ...
```

The canonical catalog and plugin manifests should use a generalized Codex-compatible format. Codex compatibility is the baseline because Codex already reads `.agents/plugins/marketplace.json` for repo-scoped marketplaces, but dotagents treats the schema as portable project metadata rather than Codex-only configuration.

Every other runtime output is generated from `.agents/plugins/` when that runtime does not directly consume the canonical path or schema. Generated artifacts may include `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.agents/plugins/<name>/.claude-plugin/plugin.json`, `.agents/plugins/<name>/.cursor-plugin/plugin.json`, `.agents/plugins/<name>/.codex-plugin/plugin.json`, `.grok/` plugin files, `.opencode/skills/` links, `.opencode/agents/` links, or Pi skill links in `.agents/skills/`. These generated artifacts are runtime projections, not the source of truth, except that `.agents/plugins/marketplace.json` is also Codex's documented repo-scoped marketplace location.

## Input and Output Contract

The canonical inputs are tightly defined but forward-compatible:

1. `agents.toml` `[[plugins]]` declarations are strict operational config. Unknown fields are rejected.
2. `.agents/plugins/marketplace.json` must be a JSON object with `name` and `plugins[]`. Each plugin entry must have `name` and `source`. dotagents resolves local plugin selectors only when `source` is a relative path string or `{ "source": "local", "path": "<relative>" }`. Runtime extension source objects may be accepted when their known path fields are safe, but dotagents must report them as unsupported instead of guessing how to resolve them.
3. `.agents/plugins/<name>/plugin.json` must be a JSON object. Known component path fields are validated as relative filesystem paths without `..` or URL/scheme prefixes when present. Unknown fields are allowed and preserved so native runtimes and future dotagents versions can add metadata without breaking older installs.
4. All component paths in canonical manifests and marketplaces must be relative filesystem paths and must not contain `..`, URL/scheme prefixes, absolute POSIX paths, absolute Windows paths, or backslash-rooted paths.
5. The portable plugin `name` in `agents.toml` is authoritative. If a discovered manifest also declares `name`, it must match the configured name.

Generated outputs are deterministic:

1. JSON output is pretty-printed with two-space indentation, sorted object keys, sorted plugin entries by name, and exactly one trailing newline.
2. Runtime marketplace outputs are overwritten only when they carry `metadata.managedBy = "dotagents"`. Hand-written runtime marketplaces are left untouched and reported as warnings.
3. Managed generated marketplace files are pruned when no configured plugin targets that runtime anymore.
4. Remote or copied plugin bundles under `.agents/plugins/<name>/` are treated as dotagents-managed and are listed in `.agents/.gitignore`.
5. Plugin sources that resolve to the same project's `.agents/plugins/<name>/` install destination are rejected. dotagents must not install a same-repo plugin onto itself.

## Documentation Sources

This design is based on the public plugin documentation current as of 2026-06-12:

| Runtime | Documentation |
|---------|---------------|
| Claude Code | https://code.claude.com/docs/en/plugins, https://code.claude.com/docs/en/plugins-reference.md, and https://code.claude.com/docs/en/plugin-marketplaces |
| Cursor | https://cursor.com/docs/plugins.md and https://cursor.com/docs/reference/plugins.md |
| Codex | https://developers.openai.com/codex/plugins and https://developers.openai.com/codex/plugins/build |
| Grok Build | https://docs.x.ai/build/features/skills-plugins-marketplaces and https://docs.x.ai/build/overview |
| OpenCode | https://opencode.ai/docs/plugins |
| `plugins` npm package | https://www.npmjs.com/package/plugins and https://github.com/vercel-labs/plugins |

The npm `plugins` package is an interoperability reference, not a proposed dotagents dependency. Its public metadata describes an "open-plugin format" installer for agent tools, and its current package scans `.plugin/`, `.claude-plugin/`, `.cursor-plugin/`, and `.codex-plugin/` manifests. `.plugin/` is not a native directory for the runtimes dotagents targets, so dotagents should support it only as an import compatibility format, not as the canonical authoring or install location.

## Configuration

Plugins should be declared in `agents.toml`:

```toml
[[plugins]]
name = "sentry-tools"
source = "getsentry/agent-plugins"
ref = "v1.2.0"
path = "plugins/sentry-tools"
targets = ["claude", "cursor", "codex", "grok"]
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Portable dotagents ID. Must start with lowercase `a-z`, end with lowercase `a-z` or `0-9`, and contain only lowercase letters, numbers, hyphens, and dots. |
| `source` | Yes | Source repository or local directory. Supports GitHub/GitLab shorthands, git URLs, and `path:` sources. HTTPS well-known skill indexes are not supported for plugins. |
| `ref` | No | Optional git ref override. |
| `path` | No | Optional explicit plugin directory path inside the source. |
| `targets` | No | Optional subset of configured agent IDs. When absent or empty, defaults to every configured agent in `agents`; targets not listed in top-level `agents` and unsupported configured agents produce warnings. |

Wildcard plugin installs can be added later if needed:

```toml
[[plugins]]
name = "*"
source = "getsentry/agent-plugins"
exclude = ["deprecated-plugin"]
```

## Portable Projection

Every imported plugin should produce this portable shape:

| Field | Meaning |
|-------|---------|
| `name` | dotagents portable ID from `agents.toml`, a marketplace entry, a manifest, or the plugin directory name |
| `version` | optional version from native or portable manifest metadata |
| `description` | optional short description |
| `metadata` | portable package metadata: author, homepage, repository, license, keywords, category, and logo paths |
| `components` | discovered component paths for skills, agents, commands, rules, hooks, MCP servers, LSP servers, apps/connectors, monitors, binaries, and settings |
| `native` | optional raw native plugin metadata keyed by runtime |

Only metadata and component locations are portable. Component semantics remain native unless they are already modeled by dotagents elsewhere, such as skills, MCP servers, hooks, and subagents.

## Dotagents Plugin Layout

The canonical dotagents plugin layout should live under `.agents/plugins/`, matching `.agents/skills/` and `.agents/agents/`. The canonical marketplace catalog is `.agents/plugins/marketplace.json`, using the generalized Codex-compatible marketplace shape described in Core Model.

Local project-authored plugins may be committed under `.agents/plugins/<name>/` as source files, but they must not be declared as same-project `[[plugins]]` dependencies because installing them would overwrite the source with itself. To consume a local plugin, reference a path outside this project's `.agents/plugins/` directory or consume it from a separate repository.

```toml
[[plugins]]
name = "my-plugin"
source = "path:../shared-plugins/my-plugin"
```

Remote plugins should install into the same canonical directory during `install`:

```text
.agents/plugins/my-plugin/
|-- plugin.json
|-- skills/
|   `-- code-review/
|       `-- SKILL.md
|-- agents/
|   `-- verifier.md
|-- commands/
|   `-- release.md
|-- rules/
|   `-- typescript.mdc
|-- hooks/
|   `-- hooks.json
|-- .mcp.json
|-- .lsp.json
`-- bin/
```

Example canonical marketplace:

```json
{
  "name": "dotagents-local",
  "interface": {
    "displayName": "Dotagents Plugins"
  },
  "owner": {
    "name": "dotagents"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "source": {
        "source": "local",
        "path": "./.agents/plugins/my-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

The canonical catalog may include vendor-specific extension fields, but dotagents should keep the required core small: marketplace `name`, optional display metadata, and `plugins[]` entries with `name` and `source`. Writers may emit simpler relative string sources for runtimes that prefer them, such as Claude and Cursor.

Example dotagents manifest:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Shared agent workflows",
  "author": { "name": "Sentry" },
  "skills": "./skills",
  "agents": "./agents",
  "commands": "./commands",
  "rules": "./rules",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "lspServers": "./.lsp.json"
}
```

Path fields must be relative to the plugin root and must not contain `..`. Generated native manifests may add a leading `./` when the target runtime requires it.

dotagents may also import plugin sources that already use native runtime manifests such as `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, or `.codex-plugin/plugin.json`. It may import `.plugin/plugin.json` for compatibility with the npm `plugins` package, but it should normalize that input into `.agents/plugins/<name>/plugin.json` on install.

## Native Formats

Input and matching-runtime output should use the same native format where possible. dotagents should preserve component files for matching runtimes. Generated native manifests project the portable fields each runtime needs to discover the plugin; the Codex manifest additionally preserves unknown manifest extensions from the canonical bundle.

| Runtime | Native Manifest | Native Plugin Roots | Components from Docs | Notes |
|---------|-----------------|---------------------|----------------------|-------|
| Claude Code | `.claude-plugin/plugin.json` | marketplace installs, `--plugin-dir`, and skills-directory plugins | skills, commands, hooks, `.mcp.json`, `.lsp.json`, monitors, `bin/`, `settings.json` | Plugin skills are namespaced as `/plugin-name:skill-name`; components live at plugin root, not under `.claude-plugin/`. The current Claude Code validator rejects `agents` in plugin manifests, so dotagents does not project plugin agents into Claude manifests. |
| Cursor | `.cursor-plugin/plugin.json` | marketplace installs and `~/.cursor/plugins/local/<name>` for local testing | rules, skills, agents, commands, hooks, `mcp.json`, assets, scripts | Manifest component paths replace default discovery for that component. Multi-plugin repos use `.cursor-plugin/marketplace.json`. |
| Codex | `.codex-plugin/plugin.json` | repo/user marketplaces under `.agents/plugins/marketplace.json` and plugin cache installs | skills, hooks, `.app.json`, `.mcp.json`, assets | Published plugins commonly need rich `interface` metadata. Codex sets `PLUGIN_ROOT` and `PLUGIN_DATA`, plus Claude-compatible plugin env vars. |
| Grok Build | Claude-compatible plugin directories plus `.grok/plugins/` and marketplaces | `./.grok/plugins/`, `~/.grok/plugins/`, marketplace installs, configured plugin paths, `--plugin-dir` | skills, agents, hooks, MCP servers, LSP servers | Docs state Grok automatically reads Claude Code marketplaces, plugins, skills, MCPs, agents, hooks, and `.claude/rules/` alongside `.grok/`. |
| OpenCode | No bundle manifest | `.opencode/skills/`, `.agents/skills/`, `.opencode/agents/`, `opencode.json` | skills, agents, MCP servers; JS/TS plugin modules separately support hooks/tools | dotagents projects plugin `skills/` and Markdown `agents/` into OpenCode's native component directories. It does not turn dotagents plugin bundles into OpenCode JS plugins. |

## Discovery

Without an explicit `path`, dotagents should scan source directories in this order:

1. dotagents plugin directories at `.agents/plugins/<name>/plugin.json`
2. Marketplace manifests at `.agents/plugins/marketplace.json`, `marketplace.json`, `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, and `.codex-plugin/marketplace.json`
3. Root native plugin manifests at `plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, and `.codex-plugin/plugin.json`
4. Root plugin component directories such as `skills/`, `commands/`, `agents/`, `rules/`, `hooks/`, `.mcp.json`, `.lsp.json`, `.app.json`, `monitors/`, `bin/`, or root `SKILL.md`
5. Recursive plugin scan under common collection directories such as `plugins/*`, limited to two levels by default
6. Compatibility manifests at `.plugin/marketplace.json` and `.plugin/plugin.json`

Directory-name matches for `agents.toml` `name` take precedence over manifest-name matches. Multiple matches in one source are rejected as ambiguous unless a marketplace manifest explicitly selects a path.

Marketplace entries should be treated as plugin selectors. If a marketplace entry points at a local path, dotagents resolves it relative to the marketplace root, optionally applying the marketplace's `metadata.pluginRoot` prefix when present. If a marketplace entry points at a remote source object that dotagents cannot resolve yet, it should produce an unsupported-source warning rather than guessing.

## Component Handling

dotagents should handle plugin components in three buckets:

| Bucket | Components | Behavior |
|--------|------------|----------|
| Portable existing dotagents concepts | skills, MCP servers, hooks, subagents/agents | Load through existing parsers where possible and generate runtime configs using existing agent writers. Preserve native plugin copies for matching runtimes. |
| Runtime-specific files | Cursor rules, Claude/Codex/Grok LSP servers, Codex apps, Claude monitors, Claude settings, binaries | Copy or expose only for runtimes that natively understand them. Do not attempt cross-runtime conversion. |
| Metadata and marketplace files | plugin manifests, marketplace manifests, icons, screenshots, README | Preserve and regenerate native manifests/marketplaces from normalized metadata when needed. |

Plugin skills should not be flattened into `.agents/skills/` by default. Native plugin systems namespace plugin skills and avoid conflicts. Flattening may be offered later as an explicit compatibility mode for runtimes without bundle support.

Plugin subagents should use the subagent importer only when the runtime stores them in a compatible file format. The plugin spec should not expand subagent behavior beyond the rules in `subagents.md`.

## Plugin Root Variables

Portable plugin-authored config should use `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` when referring to files or writable state inside the plugin. Runtime writers translate these where needed:

| Runtime | Root Variable | Data Variable |
|---------|---------------|---------------|
| Claude Code | `${CLAUDE_PLUGIN_ROOT}` | `${CLAUDE_PLUGIN_DATA}` |
| Codex | `${PLUGIN_ROOT}` | `${PLUGIN_DATA}` |
| Grok Build | `${GROK_PLUGIN_ROOT}` | `${GROK_PLUGIN_DATA}` |
| Cursor | Target-specific support to verify before implementation | Target-specific support to verify before implementation |
| OpenCode | Not applicable to projected skills and agents | Not applicable |

Codex also sets Claude-compatible plugin variables for compatibility. For generated Codex output, dotagents can leave `${PLUGIN_ROOT}` intact. The current implementation does not rewrite Claude or Grok hook, MCP, or LSP config files; portable variable rewriting is reserved for a later projection pass.

## Install and Sync

Install should write two layers:

1. Canonical installed plugin bundle in `.agents/plugins/<name>/`
2. Runtime-specific generated plugin registrations for each configured target

Generated project-scope outputs should be:

| Agent | Project Scope Output | User Scope Output | Notes |
|-------|----------------------|-------------------|-------|
| Claude Code | `.claude-plugin/marketplace.json` and `.agents/plugins/<name>/.claude-plugin/plugin.json` | Not generated yet | Generated marketplace uses deterministic `./.agents/plugins/<name>` sources and each targeted plugin gets a Claude-native manifest. |
| Cursor | `.cursor-plugin/marketplace.json` and `.agents/plugins/<name>/.cursor-plugin/plugin.json` | Not generated yet | Generated marketplace uses deterministic `./.agents/plugins/<name>` sources and each targeted plugin gets a Cursor-native manifest. |
| Codex | `.agents/plugins/marketplace.json` and generated `.codex-plugin/plugin.json` in installed bundle | Not generated yet | Generated marketplace uses deterministic `{ "source": "local", "path": "./.agents/plugins/<name>" }` entries relative to the project root. |
| Grok Build | `.grok/plugins/<name>` for targeted plugins | Not generated yet | The projection is a managed copy of the canonical plugin bundle with a `.dotagents-managed` marker. |
| OpenCode | Plugin `skills/` symlinked into `.opencode/skills/`; plugin Markdown `agents/` symlinked into `.opencode/agents/` | Not generated yet | dotagents exposes bundle components through OpenCode's native resource directories and skips collisions with user-authored files. |
| Pi | Plugin `skills/` symlinked into `.agents/skills/` when `pi` is a configured plugin target | Not generated yet | Pi reads agentskills from `.agents/skills/`; only plugin skills are projected. |

Installed and generated files are dotagents-managed. `install` and `sync` may overwrite stale managed files and prune removed managed files, but they must not overwrite hand-written plugin files without a generated marker or a canonical installed bundle path owned by dotagents. Generated Claude, Cursor, and Codex manifests carry `metadata.managedBy = "dotagents"` so target removal can prune them without deleting user-authored native plugin manifests.

User-scope plugin declarations are not supported yet. `install --user` rejects `[[plugins]]` entries, and `sync --user` reports them as unsupported, because the current runtime projections are defined only for project scope.

## Lockfile

Plugin lock entries should use the same source-resolution fields as subagents:

```toml
[plugins.sentry-tools]
source = "getsentry/agent-plugins"
resolved_url = "https://github.com/getsentry/agent-plugins.git"
resolved_path = "plugins/sentry-tools"
resolved_commit = "0123456789abcdef0123456789abcdef01234567"
```

| Field | Present For | Description |
|-------|-------------|-------------|
| `source` | All | Original source specifier from `agents.toml`. |
| `resolved_url` | Git sources | Resolved clone URL. |
| `resolved_path` | Git sources | Directory path within the repo where the plugin was discovered or loaded from. |
| `resolved_ref` | Git sources (optional) | Ref that was resolved. Omitted when using the default branch. |
| `resolved_commit` | Git sources (optional) | Full 40-char commit SHA that was installed. Informational only. |

## Security and Trust

Plugins are a higher-risk dependency class than plain skills because they may bundle executable hooks, MCP servers, LSP servers, or binaries.

dotagents should:

1. Apply existing trust policy before network access.
2. Reserve executable-component warnings for a later policy pass; current installs rely on source trust validation plus runtime-native trust prompts.
3. Preserve runtime-native trust flows instead of bypassing them. For example, Codex plugin hooks still require the user's runtime trust review.
4. Avoid executing plugin code during install except for normal git/source resolution.
5. Treat local `path:` plugins as allowed by source trust policy without bypassing runtime-native trust prompts.

## Non-goals

dotagents should not:

1. Standardize a universal hook event model across all runtimes.
2. Generate or install OpenCode JavaScript/TypeScript plugins from dotagents plugin bundles.
3. Convert Cursor rules into Claude, Codex, Grok, or OpenCode instructions by default.
4. Install app integrations or perform OAuth/authentication for users.
5. Bypass native marketplace review, policy, or trust prompts.
6. Promise identical plugin behavior across runtimes.

## Open Questions

1. Whether Claude and Cursor should gain additional native install/config outputs beyond the deterministic marketplace and plugin manifest projections dotagents writes today.
2. Grok's exact native manifest shape is not fully documented publicly; current support uses native `.grok/plugins/<name>` placement with the canonical bundle.
3. Whether `[[plugins]]` should allow remote marketplace source objects directly, or only concrete plugin directories resolved from repositories.
4. Whether plugin-contained skills should optionally expose short aliases in `.agents/skills/` for runtimes without native plugin namespaces.
