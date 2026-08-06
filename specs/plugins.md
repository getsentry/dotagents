# Plugin Support Specification

## Status

This document defines the target dotagents plugin model. It aligns the portable
plugin bundle with the public [Agent Plugins specification](https://agent-plugins.org/)
Working Draft v1.0.0 as reviewed on August 6, 2026.

The current implementation predates this design and still accepts a generalized
Codex-style manifest and marketplace as canonical input. The migration section
describes how to move from that implementation without breaking existing
projects.

## Design Principle

dotagents does not define another portable plugin format.

The portable source bundle is an Agent Plugin. dotagents is responsible for:

1. resolving and installing plugin sources,
2. validating and locking the installed bundle,
3. selecting configured target agents,
4. registering or projecting the bundle into each target's native locations,
5. translating portable MCP declarations into a target format when direct
   consumption is unavailable, and
6. preserving target-specific extension data without translating it into other
   clients' formats.

Marketplaces, source repositories, lockfiles, target selection, trust policy,
and generated runtime files remain dotagents concerns. They are not part of the
portable Agent Plugins bundle format.

## Canonical Bundle

The installed source of truth is a plugin directory under
`.agents/plugins/<name>/`:

```text
.agents/plugins/<name>/
|-- plugin.json       # Required portable metadata
|-- skills/           # Optional Agent Skills directories
|   `-- <skill>/
|       `-- SKILL.md
|-- mcp.json          # Optional portable MCP server declarations
`-- com.example.client/ # Optional reverse-domain client extension
```

The portable core has three parts:

- `plugin.json` for metadata and client extension namespaces,
- `skills/` for Agent Skills, and
- `mcp.json` for MCP servers.

There is no canonical dotagents `marketplace.json`. Any Claude, Cursor, Codex,
or other marketplace file is generated registration state, not plugin source
metadata.

## `plugin.json`

New plugins must follow the upstream Agent Plugins manifest schema.

Example:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "review-tools",
  "description": "Code review workflows and repository checks.",
  "version": "1.0.0",
  "author": {
    "name": "Sentry",
    "url": "https://sentry.io"
  },
  "license": "MIT",
  "keywords": ["review", "quality"],
  "extensions": {
    "com.example.client": {
      "setting": true
    }
  }
}
```

### Core fields

The upstream JSON Schema is authoritative. The portable metadata includes:

| Field | Required | dotagents behavior |
|-------|----------|--------------------|
| `$schema` | Yes | Must be a locally supported canonical Agent Plugins schema identifier. Clients must not fetch it while loading. |
| `name` | Yes | Must match the configured `[[plugins]].name`; 1-64 lowercase `a-z`, `0-9`, `-`, or `.`, with alphanumeric ends and no `--` or `..`. |
| `description` | No | Preserved and used in generated registration metadata. |
| `version` | No | Preserved. A SemVer warning does not block installation. |
| `author` | No | Preserved. |
| `homepage` | No | Preserved. |
| `repository` | No | Preserved. |
| `license` | No | Preserved. |
| `keywords` | No | Preserved. |

Portable components are discovered by convention. `skills`, `agents`,
`commands`, `rules`, `hooks`, and `mcpServers` are not portable top-level path
fields. Client-specific manifest data belongs under `extensions`, keyed by a
reverse-domain client namespace. Client-specific files belong under a top-level
directory with that exact namespace.

dotagents must validate new manifests against the upstream schema instead of a
Codex-derived union schema. Unknown top-level fields are reported and ignored
without invalidating an otherwise valid manifest. Other schema violations are
fatal. A non-object `extensions` field is reported and ignored. Valid extension
objects are preserved, and only the adapter registered for that namespace may
interpret them.

## Skills

Every direct child of `skills/` that contains a valid `SKILL.md` is a plugin
skill:

```text
skills/
|-- code-review/
|   `-- SKILL.md
`-- explain-failure/
    `-- SKILL.md
```

Rules:

1. Load skills with the existing Agent Skills parser.
2. Validate each skill independently.
3. Reject or warn on duplicate names according to the target adapter's
   collision policy.
4. Never follow a skill path or symlink outside the installed plugin root.
5. Do not require a `skills` field in `plugin.json`.
6. A missing `skills/` directory is valid. A present non-directory `skills`
   path disables skills only. An invalid skill is skipped without disabling
   valid sibling skills, MCP servers, or extensions.

## `mcp.json`

Portable MCP declarations follow the upstream v1 MCP schema:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "review-service": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server/index.js"],
      "env": {
        "CACHE_DIR": "${PLUGIN_DATA}/cache"
      },
      "cwd": "${PLUGIN_ROOT}"
    },
    "remote-review": {
      "type": "streamable-http",
      "url": "https://review.example.com/mcp",
      "headers": {
        "X-Tenant": "public-review"
      }
    }
  }
}
```

Rules:

1. `$schema` is required and must match the Agent Plugins version declared by
   `plugin.json`; a mismatch disables MCP for the plugin but does not invalidate
   its skills.
2. `mcpServers` is a required object. Its member names identify servers.
3. Each server has a required `type`: `stdio`, `streamable-http`, or `sse`.
4. A stdio `command` is one bare executable token or a plugin-relative path
   beginning with `./`. Placeholder expansion does not apply to `command`.
5. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the only portable placeholders.
   They expand only in stdio `args`, `env` values, and `cwd`.
6. dotagents or the target client provides both variables to launched stdio
   processes. `PLUGIN_DATA` is a writable, persistent, client-managed directory.
7. Unrecognized placeholder-like strings remain literal. There is no general
   environment-variable expansion, and portable `env` or `headers` are not a
   secret mechanism.
8. dotagents normalizes the file into its existing internal MCP declaration
   model, then either passes it through or writes the target's native format.
9. No plugin MCP process is started during install, sync, list, or doctor.
10. An invalid `mcp.json` disables MCP only; an invalid server entry is skipped
    without disabling other servers, skills, or extensions.

## Client Extensions

Client-specific behavior is namespaced under a reverse-domain identifier in the
`extensions` object in `plugin.json`, in a top-level directory with the same
name, or both.

Examples include Claude commands, agents, hooks, and LSP declarations; Cursor
rules and hooks; or future Codex/OpenCode resources.

Extension rules:

1. A client adapter registry maps dotagents target IDs to the reverse-domain
   namespaces that the client publishes and owns. dotagents must not invent a
   namespace when the client has not defined one.
2. An extension belongs only to its registered client adapter.
3. dotagents preserves extension data for clients it does not understand.
4. dotagents does not convert one client's extension into another client's
   format. Claude commands do not become Cursor rules, for example.
5. Every file accessed through an extension must remain inside the plugin root
   after filesystem resolution. Additional extension path syntax and validation
   are defined by that extension's owning client.
6. A target adapter may reject unsupported extension fields with a warning,
   but must not silently guess their meaning.

## `agents.toml`

dotagents operational configuration remains separate from the plugin bundle:

```toml
[[plugins]]
name = "review-tools"
source = "getsentry/agent-plugins"
path = "plugins/review-tools"
ref = "v1.0.0"
targets = ["claude", "cursor", "codex", "grok", "opencode", "pi"]
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Installed plugin name. Must match `plugin.json`. |
| `source` | Yes | Git or local source resolved by dotagents. |
| `ref` | No | Git ref override. |
| `path` | No | Plugin directory inside the source. |
| `targets` | No | Configured clients that receive registration or projections. Defaults to configured `agents`. |

`targets` controls deployment. It is not written into `plugin.json`.

## Discovery and Installation

For each `[[plugins]]` declaration:

1. Apply source trust and minimum-release-age policy.
2. Resolve the repository or local source.
3. Select the configured `path`, or discover a directory containing
   `plugin.json` using dotagents' conventional plugin search locations.
4. Validate `plugin.json` against the Agent Plugins schema.
5. Require the manifest name to match the configured name.
6. Validate `skills/`, `mcp.json`, and referenced extension paths.
7. Copy the complete bundle into `.agents/plugins/<name>/`.
8. Reject broken symlinks and symlinks that resolve outside the plugin root.
9. Write the plugin lock entry.
10. Run each selected target adapter.

The installed canonical bundle should remain a valid Agent Plugin. Generated
target artifacts should live in target-specific directories or in clearly
managed adapter directories inside the bundle. Adapters must not rewrite the
portable `plugin.json`, `skills/`, or `mcp.json` source files.

## Internal Normalization

Adapters should consume one normalized structure rather than each reparsing
files differently:

```ts
interface NormalizedPlugin {
  name: string;
  pluginDir: string;
  manifest: AgentPluginManifest;
  skills: AgentSkill[];
  mcpServers: McpDeclaration[];
  extensions: Record<string, Record<string, unknown>>;
  targets: string[];
}
```

This is an internal dotagents model, not a new on-disk plugin schema.

## Downstream Transformations

The transformation pipeline is:

```text
Agent Plugin bundle
  -> validate portable core
  -> normalize skills + MCP + extension namespaces
  -> select target adapters
  -> register, link, copy, or serialize native output
```

### Target matrix

| Target | Portable core | Target extension | Generated output |
|--------|---------------|------------------|------------------|
| Claude Code | Keep `plugin.json`, `skills/`, and `mcp.json` intact | Read only namespaces registered to the Claude adapter | Generate the project marketplace and, only when required by Claude's loader, a managed `.claude-plugin/plugin.json` adapter derived from core metadata plus its registered extension. |
| Cursor | Keep portable core intact | Read only namespaces registered to the Cursor adapter | Generate the project marketplace and, only when required, a managed `.cursor-plugin/plugin.json` adapter derived from core metadata plus its registered extension. |
| Codex | Keep portable core intact | Read only namespaces registered to the Codex adapter | Generate `.agents/plugins/marketplace.json` as registration state and a managed `.codex-plugin/plugin.json` adapter only for Codex-only metadata the portable manifest cannot express. |
| Grok Build | Copy the validated bundle without changing portable files | Read only namespaces registered to the Grok adapter | Generate `.grok/plugins/<name>/` as a managed copy until Grok can consume the canonical bundle directly. |
| OpenCode | Project plugin skills and merge normalized MCP servers into OpenCode config when needed | Read only namespaces registered to the OpenCode adapter | Symlink skills into `.opencode/skills/`; project explicitly declared OpenCode resources such as agents; do not generate JavaScript or TypeScript plugin modules. |
| Pi | Project supported skills | Read only namespaces registered to the Pi adapter | Symlink skills into `.agents/skills/`; ignore unsupported MCP or extension components with warnings. |

### Metadata

Core metadata is copied into generated native manifests only when the target
requires a separate manifest. Adapter ownership metadata such as
`metadata.managedBy = "dotagents"` belongs only in generated files, never in
the portable `plugin.json`.

### Skills

If a target can consume plugin skills directly, register the canonical bundle.
Otherwise, create managed links from the target's skill directory to the
canonical plugin skill directories. Collision handling must preserve
user-authored files.

### MCP

If a target supports Agent Plugins `mcp.json` directly, do not transform it.
Otherwise, convert normalized servers into the target's existing MCP writer:

- stdio servers map to command, args, and env,
- remote servers map to URL, transport, and headers,
- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded for target formats that do
  not support Agent Plugins runtime expansion, and
- all other placeholder-like text remains literal.

When dotagents must flatten plugin MCP into a native target configuration, it
acts as the installation adapter for the portable runtime contract. It uses the
installed bundle as `PLUGIN_ROOT` and a persistent managed directory such as
`.agents/plugin-data/<plugin-name>/` as `PLUGIN_DATA`. Plugin data is not
replaced during plugin upgrades and is removed only on explicit uninstall or
cleanup policy.

Plugin MCP server names share the target config namespace with top-level
`[[mcp]]` declarations only when the target flattens plugin MCP into one config.
The normalized identity is `plugin:<plugin-name>/<server-name>`. A flattened
adapter should serialize a deterministic managed key such as
`plugin.<plugin-name>.<server-name>` and document any target-required escaping.
A collision with an unmanaged declaration must produce a warning and must not
overwrite it.

### Client extensions

The selected adapter may serialize its namespace into a native manifest or
project referenced files. Unselected namespaces are preserved in the canonical
bundle and ignored. There is no cross-client conversion.

## Worked Example

Given this source bundle:

```text
review-tools/
|-- plugin.json
|-- mcp.json
|-- skills/
|   `-- review/
|       `-- SKILL.md
|-- com.vendor.claude/
|   `-- agents/
|       `-- reviewer.md
`-- com.vendor.cursor/
    `-- rules/
        `-- review.mdc
```

with `plugin.json` extension entries whose reverse-domain namespaces are
registered to Claude, Cursor, and OpenCode adapters, an install for
`targets = ["claude", "cursor", "codex", "opencode", "pi"]` produces:

```text
.agents/plugins/review-tools/              # unchanged validated Agent Plugin
.claude-plugin/marketplace.json             # generated registration
.agents/plugins/review-tools/.claude-plugin/plugin.json
.cursor-plugin/marketplace.json             # generated registration
.agents/plugins/review-tools/.cursor-plugin/plugin.json
.agents/plugins/marketplace.json             # generated Codex registration
.agents/plugins/review-tools/.codex-plugin/plugin.json
.opencode/skills/review                      # managed symlink
.opencode/agents/reviewer.md                  # only from its registered namespace
.opencode/opencode.jsonc                     # normalized plugin MCP if needed
.agents/skills/review                        # managed Pi skill symlink
```

Important consequences:

- The generated marketplaces do not become portable plugin metadata.
- Each client receives only extensions from namespaces registered to its
  adapter.
- The same portable skill can be linked into clients without copying or
  converting its `SKILL.md`.
- Portable MCP is parsed once and either consumed directly or serialized by the
  target's existing MCP writer.
- Codex does not inherit Claude commands or agents merely because those files
  exist in the bundle.

## Generated State

Generated state is deterministic and dotagents-managed:

1. JSON keys and plugin entries are sorted.
2. Generated files end in one newline.
3. Existing unmanaged files are never overwritten.
4. Managed registration, manifests, copies, links, and MCP entries are pruned
   when a plugin or target is removed.
5. `.agents/.gitignore` lists copied managed bundles and generated links without
   hiding project-authored plugin sources.

## Lockfile

Plugin lock entries continue to use dotagents source-resolution fields:

```toml
[plugins.review-tools]
source = "getsentry/agent-plugins"
resolved_url = "https://github.com/getsentry/agent-plugins.git"
resolved_path = "plugins/review-tools"
resolved_ref = "v1.0.0"
resolved_commit = "0123456789abcdef0123456789abcdef01234567"
```

The Agent Plugin `version` is bundle metadata. It does not replace the source
ref or resolved commit in `agents.lock`.

Plugin versions should use Semantic Versioning, but clients do not infer
compatibility from version numbers. Schema compatibility is determined by the
required canonical `$schema` identifiers.

## Security

Plugins may contain executable MCP servers and client-specific hooks or tools.

dotagents must:

1. validate source trust before network access,
2. keep every discovered and referenced path inside the plugin root,
3. reject escaping or broken symlinks,
4. avoid executing plugin code during management commands,
5. avoid resolving secret environment variables during install,
6. preserve native client trust and permission prompts, and
7. report executable components before a future policy layer approves them.

## Migration from the Current Model

Migration should happen in compatibility stages:

### Stage 1: dual reader

- Prefer an Agent Plugins-compliant `plugin.json`, `skills/`, and `mcp.json`.
- Continue reading legacy generalized fields (`skills`, `agents`, `commands`,
  `rules`, `hooks`, `mcpServers`, and similar) with deprecation warnings.
- Continue importing legacy marketplace files for source discovery, but never
  treat a marketplace as canonical installed plugin metadata.

### Stage 2: standard canonical install

- Normalize legacy input in memory.
- Install the original bundle plus generated adapter files without rewriting
  author-owned files.
- New docs, examples, and fixtures use the Agent Plugins layout only.

### Stage 3: strict authoring

- Reject legacy portable component fields for newly authored plugins.
- Keep an explicit compatibility importer for older third-party repositories
  until a documented major-version removal.

## Implementation Gaps

The current branch still needs follow-up implementation for:

1. replacing the generalized manifest schema with the upstream Agent Plugins
   schemas,
2. parsing `mcp.json` into the shared MCP declaration model,
3. moving `agents`, `commands`, `rules`, hooks, and other behavior into client
   namespaces,
4. removing canonical marketplace input assumptions,
5. teaching adapters to prefer direct portable-core consumption, and
6. adding migration warnings and fixtures for legacy plugin bundles.

## Non-goals

dotagents does not:

1. define plugin distribution or marketplace policy,
2. guarantee identical behavior across clients,
3. translate one client's extension into another client's format,
4. install applications or perform OAuth on a user's behalf,
5. bypass client trust or permission prompts, or
6. use `plugin.json` version ranges as a dependency solver.
