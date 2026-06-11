---
name: dotagents-qa
description: QA dotagents behavior changes with a local fixture project. Use when changes may affect dotagents install, sync, list, doctor, skill placement, agent symlinks, MCP or hook config generation, user scope, or package/runtime behavior and an agent needs to prove a representative agents.toml setup still installs correctly.
---

# dotagents QA

Answer the practical question: "With this local dotagents build, does a representative `agents.toml` still install and wire the expected files?"

## Workflow

1. Inspect the changed surface:
   - `git status --short`
   - `git diff --stat`
   - `git diff -- <paths>`
2. Build the local CLI before smoke testing:

```bash
pnpm build
```

3. Create a temp project that exercises the changed behavior. Start here and add only what the change needs.

```bash
set -euo pipefail
REPO="$(pwd)"
TMP="$(mktemp -d)"
mkdir -p "$TMP/local-skills" "$TMP/home" "$TMP/state"
for skill in review commit; do
  mkdir -p "$TMP/local-skills/$skill"
  printf -- "---\nname: %s\ndescription: Fixture %s skill.\n---\n\n%s fixture.\n" \
    "$skill" "$skill" "$skill" > "$TMP/local-skills/$skill/SKILL.md"
done

cat > "$TMP/agents.toml" <<'EOF'
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
EOF
```

4. Run the local CLI from inside the temp project, with home/cache isolated:

```bash
set -euo pipefail
export HOME="$TMP/home" DOTAGENTS_STATE_DIR="$TMP/state"
cd "$TMP"
node "$REPO/packages/dotagents/dist/cli/index.js" install
node "$REPO/packages/dotagents/dist/cli/index.js" list > "$TMP/list.out"
node "$REPO/packages/dotagents/dist/cli/index.js" doctor --fix
node "$REPO/packages/dotagents/dist/cli/index.js" doctor
```

5. Assert the behavior that matters:

```bash
set -euo pipefail
grep -q "review" "$TMP/list.out" && grep -q "commit" "$TMP/list.out"
test -f .agents/skills/review/SKILL.md && test -f .agents/skills/commit/SKILL.md
test -L .claude/skills
test -f .mcp.json
test -f .cursor/mcp.json
test -f .claude/settings.json
test -f .cursor/hooks.json
```

For `sync` changes, break generated state and assert repair:

```bash
set -euo pipefail
rm .mcp.json .claude/skills
node "$REPO/packages/dotagents/dist/cli/index.js" sync
test -f .mcp.json
test -L .claude/skills
```

## Adjust The Fixture

- Skill resolution changes: use multiple local skills, nested `skills/` directories, or the exact `path:` layout touched by the change.
- Agent placement changes: edit `agents = [...]` and assert expected symlinks/config files.
- MCP or hook changes: include representative `[[mcp]]` or `[[hooks]]` entries and inspect generated JSON/TOML.
- User-scope changes: set `DOTAGENTS_HOME="$TMP/user-home"` and pass `--user`; never write to the real home directory.
- Package/runtime changes: run the built CLI as above, or pack/install the package only when the packaging path itself changed.
- Remote source changes: use `getsentry/skills`; avoid remotes for ordinary install-location checks.

## Optional Agent CLI Checks

Use only when discovery/registration changed.

```bash
set -euo pipefail
mkdir -p "$TMP/codex-home"
CODEX_HOME="$TMP/codex-home" codex debug prompt-input "probe skills" > "$TMP/codex-prompt.json"
grep -q "review" "$TMP/codex-prompt.json"
```

Claude: no cheap dry-run skill list. If auth/network/model cost is acceptable, run a minimal non-interactive `/skill-name` prompt from `$TMP`; otherwise report skipped.

## Optional Remote Check

Use only when source resolution, trust, git, well-known, or network behavior changed.

```toml
[[skills]]
name = "code-review"
source = "getsentry/skills"
```

Run `pnpm check` after the smoke test unless there is a concrete reason to run only a targeted package check.

## Report

Include the temp path if it remains for debugging, the exact fixture shape, commands run, assertions made, and any skipped checks.
