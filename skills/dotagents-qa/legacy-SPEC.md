# dotagents QA Specification

## Intent

Provide a concise, Docker-sandboxed playbook for performing change-specific dotagents QA without writing to host agent config or host home directories.

## Scope

In scope:
- building and running the local dotagents CLI
- designing disposable project fixtures inside Docker based on the changed behavior
- verifying `.agents/skills/`, agent skills symlinks, MCP configs, hook configs, `list`, `doctor`, and `sync`
- verifying `--user` behavior with `DOTAGENTS_HOME` inside Docker
- optionally checking agent CLI registration when discovery paths changed
- optionally using `getsentry/skills` for remote source behavior
- isolating home and cache state from the host

Out of scope:
- release publishing
- network-backed source testing for ordinary install-location changes
- replacing focused Vitest regression coverage for logic bugs
- treating a fixed all-in-one QA task as sufficient for behavior-specific changes

## Runtime Contract

- Start from the changed dotagents behavior and state the behavior being proved before running commands.
- Use the repo-local QA Dockerfile for a stable Node/pnpm/system-tool baseline.
- Mount the host checkout read-only and copy it into a throwaway container before installing dependencies or building.
- Exclude host build artifacts and TypeScript build-info files from the container copy.
- Support both interactive Docker sessions and stdin-attached non-TTY runs.
- Run the built CLI from inside the container fixture project so project scope resolves correctly.
- Inspect generated files and command output that demonstrate the changed behavior, not just exit codes.
- Keep `HOME`, `DOTAGENTS_STATE_DIR`, and `DOTAGENTS_HOME` inside Docker for user-scope checks.
- Report fixture shape, commands, assertions, skipped checks, and residual risk.

## Maintenance

- Keep `SKILL.md` focused on guided, change-specific Docker QA.
- Keep examples editable and illustrative; do not turn the skill into a fixed all-in-one harness.
- Keep the Dockerfile pnpm version aligned with the root `packageManager`.
- Update examples when dotagents changes config fields, generated file locations, or supported agents.
