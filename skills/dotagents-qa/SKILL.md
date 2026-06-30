---
name: dotagents-qa
description: QA dotagents behavior changes in a Docker sandbox. Use when changes may affect dotagents install, sync, list, doctor, skill placement, agent symlinks, MCP or hook config generation, user scope, subagent runtime files, or package/runtime behavior.
---

# dotagents QA

Do real QA for the change in front of you. Docker is the safety boundary, not
the test plan: use it so dotagents cannot write to host agent config, host home
directories, or host cache state while you build fixtures that prove the
changed behavior.

Answer the practical question: "With this local dotagents build, does the
changed behavior still install, sync, and wire the expected files?"

## 1. Understand The Change

Start from the diff and identify the behavior that could regress:

```bash
git status --short
git diff --stat
git diff -- <paths>
```

Write down the QA target before running commands:
- Which command path changed: `install`, `sync`, `list`, `doctor`, `add`,
  `remove`, `mcp`, `trust`, `init`, package runtime, or scope resolution.
- Which surfaces must be inspected: `.agents/skills`, agent skill symlinks,
  MCP config, hook config, subagent runtime files, lockfile, gitignore, CLI
  output, or user scope.
- Which fixture shape proves it: checked-in example, local skills, nested
  skills, wildcard source, specific agents, MCP entries, hooks, existing
  broken state, user-scope state, or remote source.

Read the targeted reference before running runtime-specific QA:
- Core install/sync example: [references/core-agentic-qa.md](references/core-agentic-qa.md)
- Codex custom agents and runtime caveats: [references/codex.md](references/codex.md)
- Claude Code files and runtime caveats: [references/claude.md](references/claude.md)
- Cursor files/runtime caveats: [references/cursor.md](references/cursor.md)
- OpenCode files/runtime caveats: [references/opencode.md](references/opencode.md)

Run focused Vitest coverage for logic bugs. Use this skill for end-to-end QA
evidence, not as a substitute for regression tests.

## 2. Enter A Docker Sandbox

Build the repo-local QA image when it is missing, when this Dockerfile changes,
or when the repo `packageManager` pnpm version changes:

```bash
docker build \
  -f skills/dotagents-qa/Dockerfile \
  -t dotagents-qa:local \
  skills/dotagents-qa
```

The image installs the latest npm-published Codex, Claude Code, and OpenCode
CLIs (`codex`, `claude`, `opencode`). Use them for version checks, help-output
checks, and optional isolated runtime probes. Their presence does not prove
runtime discovery by itself; authenticated model-backed checks are still
explicit opt-ins.

Use an interactive container so the QA steps stay change-specific:

```bash
REPO="$(pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/dotagents-qa.XXXXXX")"
docker run --rm -it \
  -v "$REPO:/host-repo:ro" \
  -v "$OUT:/qa-out" \
  dotagents-qa:local
```

If your tool environment is not attached to a TTY, use `-i` instead of `-it`
and feed the same commands with a here-doc. Keep `-i`; without stdin attached,
the container shell will receive no script.

Inside the container:

```bash
set -euo pipefail
export CI=1
export HOME=/sandbox/home
export DOTAGENTS_STATE_DIR=/sandbox/state
export DOTAGENTS_HOME=/sandbox/user-agents

mkdir -p "$HOME" "$DOTAGENTS_STATE_DIR" "$DOTAGENTS_HOME" /sandbox/repo
tar -C /host-repo \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=.turbo \
  --exclude=coverage \
  --exclude=core \
  --exclude='*.tsbuildinfo' \
  --exclude='packages/*/dist' \
  -cf - . | tar -C /sandbox/repo -xf -

cd /sandbox/repo
pnpm install --frozen-lockfile
pnpm build
```

Run package commands as the non-root `node` user. Root can bypass chmod-based
permission checks, which can mask or invert filesystem regression tests.

For non-interactive QA, copy as root, then hand the repo to `node` before
running package scripts:

```bash
chown -R node:node /sandbox
su -s /bin/bash node -c '
  set -euo pipefail
  export CI=1
  export HOME=/sandbox/home
  export DOTAGENTS_STATE_DIR=/sandbox/state
  export DOTAGENTS_HOME=/sandbox/user-agents
  cd /sandbox/repo
  pnpm install --frozen-lockfile
  pnpm build
  pnpm check
  pnpm qa:example
'
```

Run `pnpm check` inside Docker unless the change requires a narrower target or
the check is already known to be unrelated. If `build` or `check` fails, treat
that as a QA finding and stop before fixture work unless you are explicitly
isolating the playbook mechanics. If skipped or bypassed, report why.

## 3. Prefer The Checked-In Agentic QA

Use the checked-in example QA for ordinary install/sync QA:

```bash
pnpm qa:example
```

The QA runner builds the local CLI, copies `examples/full/` to a temp project, and
asserts:
- `install`, `list`, `doctor --fix`, and `doctor` complete successfully
- managed skills under `.agents/skills/`
- Claude/Cursor skill symlink behavior
- MCP files for Claude, Cursor, Codex, and OpenCode
- hook files for Claude and Cursor
- canonical installed subagent under `.agents/agents/`
- generated subagent runtime files for Claude, Cursor, Codex, and OpenCode
- canonical installed plugin bundle under `.agents/plugins/`
- generated plugin runtime files for Claude, Cursor, Codex, Grok, and OpenCode
- `sync` repair after deleting representative generated files

Use `node skills/dotagents-qa/scripts/qa-example.mjs all --keep` when you need
to inspect the temp project; the script prints the retained path.

For paid Codex runtime proof of generated custom agents, run the runtime proof
outside Docker only when the branch affects Codex custom agents or when
reporting that Codex itself works:

```bash
node skills/dotagents-qa/scripts/qa-example.mjs codex-runtime --keep
```

That mode copies Codex auth/config into a temp `CODEX_HOME`, marks only the
temp example project trusted, and asserts that Codex can spawn the generated
`.codex/agents/code-reviewer.toml` agent. See
[references/codex.md](references/codex.md) before changing or running this
path.

## 4. Build A Manual Fixture Only When Needed

Create a temp project manually only when the checked-in example does not cover
the changed behavior. Start from this shape and add only what the diff needs.

```bash
fixture=/sandbox/fixture
mkdir -p "$fixture/local-skills" "$fixture/local-agents/agents"
for skill in review commit; do
  mkdir -p "$fixture/local-skills/$skill"
  printf -- "---\nname: %s\ndescription: Fixture %s skill.\n---\n\n%s fixture.\n" \
    "$skill" "$skill" "$skill" > "$fixture/local-skills/$skill/SKILL.md"
done

cat > "$fixture/local-agents/agents/code-reviewer.md" <<'EOF'
---
name: code-reviewer
description: Review code for correctness.
---

Review the current diff and return findings with file references.
EOF

cat > "$fixture/agents.toml" <<'EOF'
version = 1
agents = ["claude", "cursor", "codex", "opencode"]

[[skills]]
name = "review"
source = "path:./local-skills/review"

[[skills]]
name = "commit"
source = "path:./local-skills/commit"

[[mcp]]
name = "fixture"
command = "node"
args = ["-e", "process.exit(0)"]

[[hooks]]
event = "Stop"
command = "echo fixture"

[[subagents]]
name = "code-reviewer"
source = "path:./local-agents"
EOF
```

Useful fixture changes:
- Skill resolution: nested `skills/` layouts, wildcard sources, duplicate
  names, local paths outside `.agents`, or the exact `path:` shape touched.
- Agent placement: include only affected agents, or include all supported
  agents when shared config or registry behavior changed.
- MCP and hooks: use the exact command, URL, headers, env refs, hook event, or
  matcher affected by the diff.
- Subagents: include a portable Markdown fixture under `agents/`, assert the
  installed canonical file in `.agents/agents/`, assert generated runtime files
  for Claude/Cursor/Codex/OpenCode, and inspect `agents.lock`.
- Plugins: include a local plugin fixture with representative components,
  assert the installed canonical bundle in `.agents/plugins/`, assert generated
  runtime files for Claude/Cursor/Codex/Grok/OpenCode, and inspect `agents.lock`.
- Sync and doctor: pre-create broken or legacy state, then prove repair and
  diagnostics.
- User scope: set both `HOME` and `DOTAGENTS_HOME`, pass `--user`, and inspect
  generated files under those temp directories; never use the host home
  directory.
- Package/runtime: run the built CLI as above, or pack/install the package only
  when the packaging path itself changed.
- Remote sources: use `getsentry/skills`; avoid remotes for ordinary
  install-location checks.

## 5. Exercise The CLI

Run the built local CLI from the fixture. Capture output and inspect generated
files, not just exit codes.

```bash
cli=(node /sandbox/repo/packages/dotagents/dist/cli/index.js)
cd "$fixture"

"${cli[@]}" install | tee /qa-out/install.out
"${cli[@]}" list | tee /qa-out/list.out
"${cli[@]}" doctor --fix | tee /qa-out/doctor-fix.out
"${cli[@]}" doctor | tee /qa-out/doctor.out
```

Assert what matters for this change. Examples:

```bash
grep -q "review" /qa-out/list.out
grep -q "commit" /qa-out/list.out
test -f .agents/skills/review/SKILL.md
test -f .agents/skills/commit/SKILL.md
test -L .claude/skills
test -f .mcp.json
test -f .cursor/mcp.json
test -f .codex/config.toml
test -f opencode.json
test -f .claude/settings.json
test -f .cursor/hooks.json
test -f .agents/agents/code-reviewer.md
test -f .claude/agents/code-reviewer.md
test -f .cursor/agents/code-reviewer.md
test -f .codex/agents/code-reviewer.toml
test -f .opencode/agents/code-reviewer.md
test -f .agents/plugins/qa-tools/plugin.json
test -f .claude-plugin/marketplace.json
test -f .cursor-plugin/marketplace.json
test -f .agents/plugins/qa-tools/.claude-plugin/plugin.json
test -f .agents/plugins/qa-tools/.codex-plugin/plugin.json
test -f .grok/plugins/qa-tools/.dotagents-managed
test -f .opencode/plugins/qa-tools.ts
grep -q "code-reviewer" agents.lock
grep -q "qa-tools" agents.lock
grep -q "Generated by dotagents" .claude/agents/code-reviewer.md
grep -q "Generated by dotagents" .codex/agents/code-reviewer.toml
```

For `sync` or subagent writer changes, break the generated state in the way the
diff claims to repair, then verify the repair:

```bash
rm .mcp.json .claude/skills .claude/agents/code-reviewer.md .codex/agents/code-reviewer.toml
rm .claude-plugin/marketplace.json .agents/plugins/qa-tools/.claude-plugin/plugin.json
rm .agents/plugins/qa-tools/.codex-plugin/plugin.json
rm -rf .grok/plugins/qa-tools
rm .opencode/plugins/qa-tools.ts
"${cli[@]}" sync | tee /qa-out/sync.out
test -f .mcp.json
test -L .claude/skills
test -f .claude/agents/code-reviewer.md
test -f .codex/agents/code-reviewer.toml
test -f .claude-plugin/marketplace.json
test -f .agents/plugins/qa-tools/.claude-plugin/plugin.json
test -f .agents/plugins/qa-tools/.codex-plugin/plugin.json
test -f .grok/plugins/qa-tools/.dotagents-managed
test -f .opencode/plugins/qa-tools.ts
```

For user-scope changes:

```bash
cd /sandbox
"${cli[@]}" --user install | tee /qa-out/user-install.out
test -f "$DOTAGENTS_HOME/agents.toml"
test -d "$DOTAGENTS_HOME/skills"
```

Copy useful evidence before leaving the container:

```bash
cp -a "$fixture" /qa-out/fixture
cp -a "$DOTAGENTS_HOME" /qa-out/user-agents 2>/dev/null || true
```

## 6. Real Agent Clients

Use real clients only when discovery or registration in Claude, Cursor, Codex,
VS Code, or OpenCode changed. Docker proves generated files and symlinks; it
does not prove an installed host client notices them.

Keep host-client checks isolated with explicit temp homes/config dirs where
the client supports it. If a client cannot run without reading host state, say
so and report the Docker-generated files you inspected instead.

Inside the QA image, start with cheap client availability checks:

```bash
codex --version
claude --version
opencode --version
```

Codex subagents need real runtime proof before claiming Codex loaded them. Use
`node skills/dotagents-qa/scripts/qa-example.mjs codex-runtime --keep`;
`codex debug prompt-input` is not enough unless it visibly includes the
generated agent name or instructions. Project-scoped `.codex/agents/` load only
when Codex trusts the project. See [references/codex.md](references/codex.md).

Claude has no cheap dry-run skill list. If auth/network/model cost is
acceptable, run a minimal non-interactive prompt from the temp project;
otherwise report it as skipped.

## 7. Report Evidence

Report:
- the changed behavior you targeted
- Docker image and setup used
- fixture shape and why it matched the diff
- commands run
- generated files or command output inspected
- assertions that passed
- `/qa-out` host path if retained for debugging
- skipped checks and residual risk
