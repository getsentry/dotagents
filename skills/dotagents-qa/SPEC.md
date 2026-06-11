# dotagents QA Specification

## Intent

Provide a concise workflow for proving that local dotagents changes still install a representative `agents.toml` setup into the expected project locations.

## Scope

In scope:
- building and running the local dotagents CLI
- creating disposable project fixtures with local skill sources
- verifying `.agents/skills/`, agent skills symlinks, MCP configs, hook configs, `list`, `doctor`, and `sync`
- optionally checking agent CLI registration when discovery paths changed
- optionally using `getsentry/skills` for remote source behavior
- isolating home and cache state during smoke tests

Out of scope:
- release publishing
- network-backed source testing for ordinary install-location changes
- replacing focused Vitest regression coverage for logic bugs

## Runtime Contract

- Start from the changed dotagents behavior and customize the fixture only as needed.
- Run the built CLI from inside the temp project so project scope resolves correctly.
- Isolate `HOME`, `DOTAGENTS_STATE_DIR`, and `DOTAGENTS_HOME` for user-scope checks.
- Report fixture shape, commands, assertions, skipped checks, and residual risk.

## Maintenance

- Keep `SKILL.md` focused on temp-project smoke testing.
- Update the fixture when dotagents changes config fields, generated file locations, or supported agents.
- Add scripts only if the same fixture becomes stable enough to automate.
