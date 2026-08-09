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

When the `grok` CLI is installed, run:

```bash
node skills/dotagents-qa/scripts/qa-example.mjs plugin-grok
```

The task runs `grok plugin list` and `grok plugin details qa-tools` from the
isolated fixture project. This proves Grok discovered the generated project
plugin metadata. It does not invoke a plugin skill or start a model session.

The QA Docker image and this development machine do not currently include the
`grok` CLI, so automated client discovery is skipped here rather than claimed
from file-level checks.

For authenticated runtime proof, use a temp Grok config after the no-auth
`plugin list/details` proof, then invoke the fixture skill and check its sentinel.

If a branch specifically requires Grok runtime proof, install or make `grok`
available inside the Docker container and report:

- exact command or interaction
- temp project path
- generated `.grok/plugins/<name>` path
- `grok inspect` evidence for discovered plugin paths
- evidence that Grok loaded or invoked the expected plugin/skill

Otherwise report file-level Grok wiring only.
