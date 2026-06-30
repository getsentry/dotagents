# Grok Build QA

Use this reference when changes affect Grok plugin projections, `.grok/`
runtime files, or claims that generated dotagents plugins load in Grok Build.

## File-Level Checks

The core agentic QA asserts:

- `.grok/plugins/<name>/.dotagents-managed` exists for each targeted plugin
- the projected plugin bundle contains the canonical plugin files
- `sync` repairs deleted `.grok/plugins/<name>` projections

These checks prove dotagents wrote the expected Grok plugin files. They do not
prove Grok loaded the plugin.

## Runtime Proof

This QA skill does not currently include an automated Grok runtime proof, and
the QA Docker image does not install `grok` yet. Do not claim Grok runtime
discovery from file-level checks alone.

For authenticated runtime proof, use a temp Grok config and run `grok inspect`
before any paid prompt to prove Grok discovered the temp project config, skills,
plugins, hooks, and MCP servers.

If a branch specifically requires Grok runtime proof, install or make `grok`
available inside the Docker container and report:

- exact command or interaction
- temp project path
- generated `.grok/plugins/<name>` path
- `grok inspect` evidence for discovered plugin paths
- evidence that Grok loaded or invoked the expected plugin/skill

Otherwise report file-level Grok wiring only.
