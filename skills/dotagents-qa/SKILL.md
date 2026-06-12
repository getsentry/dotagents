---
name: dotagents-qa
description: QA dotagents behavior changes in a Docker sandbox. Use when changes may affect dotagents install, sync, list, doctor, skill placement, agent symlinks, MCP or hook config generation, user scope, or package/runtime behavior.
---

# dotagents QA

Do real QA for the change in front of you. Docker is the safety boundary, not
the test plan: use it so dotagents cannot write to host agent config, host home
directories, or host cache state while you build fixtures that prove the
changed behavior.

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
  MCP config, hook config, lockfile, gitignore, CLI output, or user scope.
- Which fixture shape proves it: local skills, nested skills, wildcard source,
  specific agents, MCP entries, hooks, existing broken state, or remote source.

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

Run `pnpm check` inside Docker unless the change requires a narrower
target or the check is already known to be unrelated. If `build` or `check`
fails, treat that as a QA finding and stop before fixture work unless you are
explicitly isolating the playbook mechanics. If skipped or bypassed, report why.

## 3. Build The Fixture

Create the smallest fixture that proves the changed behavior. Start from this
shape only when it fits; edit it aggressively for the diff you are testing.

```bash
fixture=/sandbox/fixture
mkdir -p "$fixture/local-skills/review" "$fixture/local-skills/commit"

cat > "$fixture/local-skills/review/SKILL.md" <<'SKILL'
---
name: review
description: Fixture review skill.
---

Review fixture.
SKILL

cat > "$fixture/local-skills/commit/SKILL.md" <<'SKILL'
---
name: commit
description: Fixture commit skill.
---

Commit fixture.
SKILL

cat > "$fixture/agents.toml" <<'TOML'
version = 1
agents = ["claude", "cursor"]

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
TOML
```

Useful fixture changes:
- Skill resolution: nested `skills/` layouts, wildcard sources, duplicate
  names, local paths outside `.agents`, or the exact `path:` shape touched.
- Agent placement: include only affected agents, or include all supported
  agents when shared config or registry behavior changed.
- MCP and hooks: use the exact command, URL, headers, env refs, hook event, or
  matcher affected by the diff.
- Sync and doctor: pre-create broken or legacy state, then prove repair and
  diagnostics.
- User scope: run from outside a project with `--user` and inspect
  `$DOTAGENTS_HOME`; never use the host home directory.
- Remote sources: use the real source and trust policy only when source,
  trust, git, well-known, or network behavior changed.

## 4. Exercise The CLI

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
test -f .agents/skills/review/SKILL.md
test -L .claude/skills
test -f .mcp.json
test -f .cursor/mcp.json
test -f .claude/settings.json
test -f .cursor/hooks.json
```

For `sync` changes, break the generated state in the way the diff claims to
repair, then verify the repair:

```bash
rm .mcp.json .claude/skills
"${cli[@]}" sync | tee /qa-out/sync.out
test -f .mcp.json
test -L .claude/skills
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

## 5. Real Agent Clients

Use real clients only when discovery or registration in Claude, Cursor, Codex,
VS Code, or OpenCode changed. Docker proves generated files and symlinks; it
does not prove an installed host client notices them.

Keep host-client checks isolated with explicit temp homes/config dirs where
the client supports it. If a client cannot run without reading host state, say
so and report the Docker-generated files you inspected instead.

## 6. Report Evidence

Report:
- the changed behavior you targeted
- Docker image and setup used
- fixture shape and why it matched the diff
- commands run
- generated files or command output inspected
- assertions that passed
- `/qa-out` host path if retained for debugging
- skipped checks and residual risk
