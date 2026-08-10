# dotagents QA

## Intent

Provide change-specific and release-specific QA for dotagents inside an isolated Docker environment. The skill produces evidence that CLI lifecycle operations and generated harness integrations work without reading or writing the host's agent homes, credentials, or caches.

## Triggers

- **SHOULD** apply when a dotagents change or release may affect install, add, remove, sync, list, doctor, scope resolution, package behavior, skills, plugins, MCP, hooks, subagents, or harness projections.
- **SHOULD** apply when the user asks for Docker QA, real plugin compatibility, published-package verification, or native Claude, Codex, OpenCode, or Pi proof.
- **SHOULD NOT** apply to ordinary dotagents usage questions, architecture explanation without runtime validation, or unrelated repository QA.

## Behaviors

### Behavior: Define the QA contract

The agent SHALL identify the exact build or published version under test, the behavior at risk, the fixture shape, the harnesses and scopes involved, and the evidence required before running runtime commands.

#### Scenario: Published release request

- **WHEN** the user asks to test `@sentry/dotagents@2.0.0`
- **THEN** the agent verifies and installs that registry version in Docker and distinguishes its results from any later packed-local-build fix validation

### Behavior: Enforce Docker isolation

The agent SHALL run package and runtime QA as a non-root user with `HOME`, `DOTAGENTS_STATE_DIR`, `DOTAGENTS_HOME`, and harness-specific config homes contained in Docker or disposable directories.

#### Scenario: User scope plugin QA

- **WHEN** testing `dotagents --user` or `dotagents --global`
- **THEN** the agent proves the resolved paths are inside the sandbox and does not copy host authentication unless a separately authorized model-backed proof requires it

### Behavior: Run proportionate baseline validation

The agent SHALL run the repository checks and checked-in QA tasks relevant to the changed surface, and SHALL treat a failure as a finding rather than bypassing it silently.

#### Scenario: Plugin runtime change

- **WHEN** plugin installation or projection code changed
- **THEN** the agent runs focused regression tests plus `pnpm check`, `pnpm qa:example`, and `pnpm qa:plugins`, or reports a concrete reason for each skipped check

### Behavior: Exercise complete CLI lifecycles

The agent SHALL use CLI commands to cover initialization, add or declaration, install, list, doctor, sync repair, and remove cleanup for each relevant scope, while inspecting config, lockfile, canonical artifacts, and generated outputs.

#### Scenario: Global plugin lifecycle

- **WHEN** validating user-scope plugin support
- **THEN** the agent tests both `--user` and `--global`, verifies global harness paths, deletes representative managed outputs, proves `sync` repairs them, and proves `remove` cleans them up

### Behavior: Test representative real plugins

The agent SHALL validate canonical Sentry and Vercel plugins plus one high-signal marketplace-style source when plugin compatibility is in scope, resolving current repositories and plugin names from their manifests rather than guessing.

#### Scenario: Major plugin compatibility pass

- **WHEN** the user asks whether popular plugins work
- **THEN** the agent tests `getsentry/agent-plugin`, `vercel/vercel-plugin`, and a selected plugin from `anthropics/claude-plugins-official`, unless a source is unavailable and that limitation is reported

### Behavior: Prove each harness independently

The agent SHALL isolate Claude, Codex, OpenCode, and Pi evidence so one harness's shared skill projection cannot make another harness appear to pass, and SHALL use no-auth native management or debug commands when available.

#### Scenario: Four-harness plugin matrix

- **WHEN** a plugin targets Claude, Codex, OpenCode, and Pi
- **THEN** Claude validates and installs its generated marketplace, Codex adds and installs its generated marketplace, OpenCode reports projected skills through `opencode debug skill` and flattened portable plugin MCP through `opencode debug config`, and Pi receives separately verified skill links without claiming model invocation

### Behavior: Report evidence and limits

The agent SHALL report commands, versions, inspected paths, passed assertions, confirmed defects, skipped authenticated checks, and residual risk, clearly separating published-release findings from local fixes.

#### Scenario: Release reveals defects

- **WHEN** published-package QA fails but a local change later passes
- **THEN** the report identifies the release failure and the local fix validation as separate results

## Constraints

### Constraint: No host state leakage

The agent MUST NOT run user-scope or harness QA against the host's real home, config, cache, plugin registry, or credentials.

### Constraint: No false runtime claims

The agent MUST NOT claim model-backed plugin or subagent execution from filesystem checks, schema validation, marketplace installation, or resource listing alone.

### Constraint: No fixed-source guessing

The agent MUST NOT invent plugin repository names, marketplace selectors, or component counts when current manifests can be inspected.

<!-- skillet-version: 1.7.0 -->
