---
name: dotagents-qa
description: QA dotagents changes and published releases in Docker, including CLI lifecycles, user/global scope, real plugins, and Claude, Codex, OpenCode, or Pi projections. Use when behavior, packaging, scopes, or harness integration needs runtime proof.
spec_hash: 5ea75cc3362b
---

# dotagents QA

Prove the requested behavior in Docker without touching host agent homes, caches, plugin registries, or credentials. Treat Docker as the safety boundary and the changed or released behavior as the test plan.

## 1. Define the contract

Before commands, state:

- the exact subject: local checkout, packed local build, or published version;
- the commands and semantics at risk;
- project scope, user scope, or both;
- the harnesses involved;
- the fixture and evidence that constitute a pass.

For a published release, verify its registry metadata and install that exact version. Never silently test the local checkout instead. If you fix a discovered defect, report the release failure and packed-local-build pass separately.

Read the relevant references before acting:

- Docker, non-root setup, exact release installation, and baseline commands: [references/docker-sandbox.md](references/docker-sandbox.md)
- Ordinary install/sync behavior: [references/core-agentic-qa.md](references/core-agentic-qa.md)
- Real plugins, full lifecycle, native clients, and user/global scope: [references/release-plugin-matrix.md](references/release-plugin-matrix.md)
- Plugin adapters and automated proof: [references/plugin-runtime.md](references/plugin-runtime.md)
- Harness details: [Claude](references/claude.md), [Codex](references/codex.md), [OpenCode](references/opencode.md), [Pi](references/pi.md), [Cursor](references/cursor.md), [Grok](references/grok.md)

Planning is part of acting: read the relevant references before proposing a command sequence, not only before executing it.

## 2. Establish isolation

Use the repo QA image. Rebuild it when the Dockerfile, pnpm version, or required current harness versions changed.

Run package and runtime work as a non-root user. Keep these inside Docker or disposable directories:

```bash
export HOME=/sandbox/home
export DOTAGENTS_STATE_DIR=/sandbox/state
export DOTAGENTS_HOME=/sandbox/user-agents
export CODEX_HOME=/sandbox/codex-home
export CLAUDE_CONFIG_DIR=/sandbox/claude-home
```

Mount the host checkout read-only and copy it into the container without `.git`, `node_modules`, `dist`, coverage, or `*.tsbuildinfo`. Never point user-scope commands or client CLIs at the host's real home.

Do not forward auth for file, validation, marketplace, or resource-discovery checks. Copy credentials only for a separately authorized model-backed proof, scrub them afterward, and never retain them in `/qa-out`.

## 3. Run baseline validation

For a local plugin/runtime change, normally run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm qa:example
pnpm qa:plugins
```

Add focused regression tests for every confirmed logic bug. A failing baseline is a finding; do not bypass it silently. If a check is irrelevant or unavailable, record why.

## 4. Exercise complete lifecycles

Use the CLI from a fresh fixture and inspect output plus files:

```bash
dotagents init --agents claude,codex,opencode,pi
dotagents add <source> [name]
dotagents list --json
dotagents doctor
dotagents install
```

Inspect `agents.toml`, `agents.lock`, canonical skills/plugins, ownership markers, marketplaces, manifests, harness projections, and warnings. Delete representative managed artifacts, run `dotagents sync`, and prove exact repair. Run `dotagents remove <name>` and prove canonical and generated cleanup.

Invoke every lifecycle command named by the contract. In particular, run `dotagents install` explicitly even though `add` also installs, and assert the config and lockfile paths directly rather than inferring them from `list` output.

Cover an unambiguous skill source as well as plugins so plugin-first discovery still falls back correctly. Use `--all` only with a controlled small catalog.

For user plugins, test both `--user` and `--global`. Isolate `HOME` and `DOTAGENTS_HOME`; inspect global Claude, Codex, OpenCode, and Pi paths; repair with one flag spelling and remove with the other.

## 5. Test representative plugins

When plugin compatibility is in scope, inspect current manifests and test:

- `getsentry/agent-plugin`;
- `vercel/vercel-plugin`;
- one high-signal plugin selected from the current manifest in `anthropics/claude-plugins-official`.

In a proposed compatibility plan, name all three repositories but defer the Anthropic plugin selector until manifest inspection at execution time. Derive all selectors, versions, commits, and component counts from that inspection.

Use a fresh project per source. Record source commits. Do not guess repository names, selectors, versions, component counts, or layouts.

## 6. Prove harnesses independently

Keep per-harness fixtures isolated. In particular, do not enable Pi in the OpenCode proof: OpenCode can read Pi's shared `.agents/skills` links and create a false pass.

- Claude: validate generated plugin and marketplace manifests, then marketplace add, install, list, and details.
- Codex: add the project or user marketplace root, list available plugins, install, and list enabled plugins.
- OpenCode: run `opencode debug skill` and `opencode debug config`; assert exact projected skill names and locations plus every portable plugin MCP entry under `plugin.<plugin>.<server>` with expanded paths and environment.
- Pi: in a separate Pi-only fixture, verify expected skill links, resolved targets, and `.dotagents-managed/<skill>` ownership markers.

These no-auth checks prove validation, registration, installation, or resource discovery. They do not prove model-backed invocation. Never claim a plugin skill or subagent executed without a model interaction and visible evidence.

## 7. Report

Include:

- exact dotagents and harness versions;
- Docker image/setup and non-root user;
- fixture shapes and source commits;
- commands and inspected paths;
- assertions that passed;
- confirmed defects and their regression tests;
- release results versus local-fix results;
- skipped authenticated checks and residual risk;
- retained `/qa-out` location, if any.

Reporting is lossless. Enumerate every supplied command, version, source commit, and inspected path, even when repetitive. A category summary such as “state and marketplaces” is insufficient; do not invent missing values.

Keep the report candid: filesystem proof, native management proof, resource-discovery proof, and model-backed execution are different confidence levels.
