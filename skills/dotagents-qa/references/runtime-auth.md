# Runtime Auth And Gateway QA

Use this reference when a dotagents change needs model-backed proof from a real
agent client, or when forwarding API keys into the Docker QA sandbox.

## Secret Handling

Keep runtime credentials in host `.env.qa.local`. The file is intentionally
gitignored and must stay out of copied fixtures, retained temp projects, and
`/qa-out` evidence.

Load secrets on the host, then pass only the specific variables needed for the
check into Docker:

```bash
set -a
source .env.qa.local
set +a

docker run --rm -i \
  -e OPENROUTER_API_KEY \
  -e ANTHROPIC_API_KEY \
  -e XAI_API_KEY \
  -e CURSOR_API_KEY \
  -v "$REPO:/host-repo:ro" \
  -v "$OUT:/qa-out" \
  dotagents-qa:local
```

A useful `.env.qa.local` template is:

```bash
# General gateway key used by OpenCode and optional Claude/Codex/Grok probes.
OPENROUTER_API_KEY=...

# Claude Code direct Anthropic auth or OpenRouter-over-Anthropic gateway.
ANTHROPIC_API_KEY=...
ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_MODEL=anthropic/claude-sonnet-4
ANTHROPIC_CUSTOM_MODEL_OPTION=anthropic/claude-sonnet-4
ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4

# Codex direct OpenAI auth or custom-provider experiments.
OPENAI_API_KEY=...
CODEX_API_KEY=...
CODEX_ACCESS_TOKEN=...

# Grok and Cursor runtime-specific auth.
XAI_API_KEY=...
CURSOR_API_KEY=...

# Optional model override for manual OpenCode runtime QA.
OPENCODE_QA_MODEL=openrouter/anthropic/claude-haiku-4.5
```

Only set aliases like `ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}` when you
intend that runtime to use the gateway. For first-party provider proof, set the
provider's real key instead and leave the gateway overrides unset.

Inside Docker, keep client state isolated with temp homes such as `HOME`,
`CODEX_HOME`, `DOTAGENTS_HOME`, and any runtime-specific config directory the
client supports. Do not use or mount host runtime homes for ordinary QA.

Report the provider config shape and model IDs, but redact tokens. If a check
requires network or paid model calls and is skipped, say exactly which runtime
was skipped and what file-level or dry-run proof was completed instead.

## Runtime Matrix

| Runtime | OpenRouter or custom gateway path | QA status |
| --- | --- | --- |
| Claude Code | Supported through Anthropic Messages gateways. Use `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and an explicit model override. | Good candidate for model-backed plugin/skill discovery proof. |
| Codex | Supported through user-level custom model providers in `CODEX_HOME/config.toml`. Use `base_url`, `env_key`, and a model that the gateway supports. | Good candidate, but provider config must live in isolated `CODEX_HOME`, not project `.codex/config.toml`. |
| Grok Build | Supported through custom model config with `model`, `base_url`, `name`, and `env_key`. | Candidate once the Grok CLI is available in the QA image or installed in the container. |
| OpenCode | Supported through custom providers using `@ai-sdk/openai-compatible`, `options.baseURL`, and `options.apiKey`. | Candidate once provider config is written to isolated `opencode.json`. |
| Cursor | Cursor CLI documents browser login, `CURSOR_API_KEY`, and `--endpoint`. Cursor BYOK docs cover named providers such as OpenAI, Anthropic, Google, Azure, and Bedrock, not arbitrary OpenRouter-compatible provider config. | Do not claim OpenRouter proof for Cursor unless a documented endpoint or local runtime behavior is verified. Use Cursor API-key/login proof separately. |

## OpenRouter Baseline

OpenRouter exposes an OpenAI-compatible chat endpoint at:

```text
https://openrouter.ai/api/v1/chat/completions
```

It also exposes an Anthropic Messages endpoint at:

```text
https://openrouter.ai/api/v1/messages
```

Use `OPENROUTER_API_KEY` as a bearer token. Model IDs include provider prefixes,
for example `anthropic/claude-sonnet-4` or `openai/gpt-5.2`. Pick a cheap,
tool-capable model for QA unless the runtime requires a particular family.

## Claude Code With OpenRouter

Claude Code supports LLM gateways that expose Anthropic Messages APIs and sends
`ANTHROPIC_AUTH_TOKEN` as a bearer token. A minimal OpenRouter probe should set:

```bash
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_MODEL="anthropic/claude-sonnet-4"
```

If the model is not available in the picker or aliases resolve incorrectly, add:

```bash
export ANTHROPIC_CUSTOM_MODEL_OPTION="anthropic/claude-sonnet-4"
export ANTHROPIC_DEFAULT_SONNET_MODEL="anthropic/claude-sonnet-4"
```

Keep `HOME` pointed at the container temp home. For plugin QA, install the
example, validate generated plugin files first, then run the smallest prompt
that can prove the desired skill/plugin behavior.

## Codex With OpenRouter

Codex custom provider settings must be in user-level `CODEX_HOME/config.toml`.
Project `.codex/config.toml` cannot set provider redirects such as
`model_provider`, `model_providers`, or `openai_base_url`.

For OpenRouter, use an isolated `CODEX_HOME` and write a provider config like:

```toml
model = "openai/gpt-5.2"
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
```

If the selected model requires the Responses API and the gateway supports it,
add:

```toml
wire_api = "responses"
```

Then run `codex exec` inside Docker with `CODEX_HOME` and
`OPENROUTER_API_KEY` set. Keep the existing `codex-runtime` task as the
reference pattern for trusting only the temp project and removing copied auth.

## Grok Build With OpenRouter

Grok Build documents custom models with `model`, `base_url`, `name`, and
`env_key`. An OpenRouter candidate config is:

```toml
[model.openrouter-claude]
model = "anthropic/claude-sonnet-4"
base_url = "https://openrouter.ai/api/v1"
name = "Claude via OpenRouter"
env_key = "OPENROUTER_API_KEY"

[models]
default = "openrouter-claude"
```

Run `grok inspect` before any paid prompt to confirm the config, skills,
plugins, hooks, and MCP servers discovered in the temp project. Use
`grok -p "..." -m openrouter-claude` for a model-backed proof. If `grok` is not
installed in the QA image, report Grok file-level plugin output plus the
missing CLI runtime proof.

## OpenCode With OpenRouter

OpenCode supports custom OpenAI-compatible providers through
`@ai-sdk/openai-compatible`, `options.baseURL`, model definitions, and env
interpolation in `options.apiKey`.

Use a temp project `opencode.json` or isolated config that includes:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      },
      "models": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet via OpenRouter"
        }
      }
    }
  }
}
```

Run `opencode auth list` or a cheap prompt from the temp project only after the
file-level plugin component projection passes. Report whether OpenCode sees
the generated `.opencode/skills/*` or `.opencode/agents/*` component separately
from whether the model call succeeded.

## Cursor

Cursor runtime QA is not the same as gateway QA. The CLI documents
`CURSOR_API_KEY` or browser login, and exposes `--endpoint` for endpoint issues.
The Cursor BYOK UI documents provider-specific API keys, but not arbitrary
OpenRouter-compatible provider configuration.

For now:

- Use file-level checks for `.cursor/mcp.json`, `.cursor/hooks.json`, and
  `.cursor/agents/*.md`.
- Use `CURSOR_API_KEY` only for Cursor CLI/headless proof when the test target
  is Cursor runtime behavior.
- Do not represent `OPENROUTER_API_KEY` as sufficient Cursor proof unless a
  current Cursor doc or an observed local command proves the endpoint shape.

## Sources

- Claude Code LLM gateway configuration: https://code.claude.com/docs/en/llm-gateway
- Claude Code model configuration: https://code.claude.com/docs/en/model-config
- Codex custom model providers and environment variables: https://developers.openai.com/codex/codex-manual.md
- Cursor CLI authentication: https://cursor.com/docs/cli/reference/authentication.md
- Cursor BYOK: https://cursor.com/help/models-and-usage/api-keys.md
- Grok Build getting started and custom models: https://docs.x.ai/build/overview
- OpenCode providers: https://opencode.ai/docs/providers/
- OpenRouter API overview: https://openrouter.ai/docs/api/reference/overview
- OpenRouter Anthropic Messages endpoint: https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages
