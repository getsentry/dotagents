# Docker Sandbox Setup

Use this reference whenever starting dotagents QA.

## Build the image

Rebuild when the image is missing, the Dockerfile changed, the root pnpm version changed, or current harness CLIs matter:

```bash
docker build --pull \
  -f skills/dotagents-qa/Dockerfile \
  -t dotagents-qa:local \
  skills/dotagents-qa
```

The image includes Node, pnpm, Git, jq, ripgrep, Claude Code, Codex, OpenCode, and Pi. Record their versions before client-specific claims.

## Isolate the checkout and homes

Mount the host checkout read-only, copy it into the container, and run package commands as a non-root user. Keep every runtime home and cache inside Docker:

```bash
REPO="$(pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/dotagents-qa.XXXXXX")"
docker run --rm -it \
  -v "$REPO:/host-repo:ro" \
  -v "$OUT:/qa-out" \
  dotagents-qa:local
```

Inside the container:

```bash
set -euo pipefail
export CI=1
export HOME=/sandbox/home
export DOTAGENTS_STATE_DIR=/sandbox/state
export DOTAGENTS_HOME=/sandbox/user-agents
export CODEX_HOME=/sandbox/codex-home
export CLAUDE_CONFIG_DIR=/sandbox/claude-home

mkdir -p "$HOME" "$DOTAGENTS_STATE_DIR" "$DOTAGENTS_HOME" \
  "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" /sandbox/repo
tar -C /host-repo \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=.turbo \
  --exclude=coverage \
  --exclude=core \
  --exclude='*.tsbuildinfo' \
  --exclude='packages/*/dist' \
  -cf - . | tar -C /sandbox/repo -xf -

chown -R node:node /sandbox
su -s /bin/bash node
cd /sandbox/repo
pnpm install --frozen-lockfile
```

For non-TTY orchestration use `docker run -i`, not a detached shell with no stdin.

## Local build versus published release

For a local change, run the built CLI:

```bash
pnpm build
cli=(node /sandbox/repo/packages/dotagents/dist/cli/index.js)
```

For release QA, verify and install the exact registry version instead:

```bash
npm view @sentry/dotagents@2.0.0 version dist.tarball
npm install -g --no-audit --no-fund @sentry/dotagents@2.0.0
dotagents --version
```

Never silently substitute the local checkout for the published artifact. If a defect is fixed during QA, rerun the failing case with a packed local build and report the release result and fix result separately.

## Baseline

```bash
pnpm check
pnpm qa:example
pnpm qa:plugins
```

Run focused Vitest regression files as well when a logic bug was found. A skipped baseline command needs a concrete reason in the report.
