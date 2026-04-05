# GLM Tool Fix Proxy

This proxy forwards requests to `http://115.120.82.129:3000/v1` and exposes:

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/responses`

It is intended for local use with OpenAI-compatible clients, Claude Code, and
Codex.

## Start

```bash
cd /home/ahdai/Desktop/code/glm-tool-fix-proxy
PORT=3401 \
HOST=127.0.0.1 \
UPSTREAM_BASE_URL=http://115.120.82.129:3000/v1 \
UPSTREAM_MODEL=glm-5 \
node server.mjs
```

Or:

```bash
cd /home/ahdai/Desktop/code/glm-tool-fix-proxy
just start
```

`just start` defaults to `UPSTREAM_MODEL=glm-5`.

If needed, set a fixed upstream key:

```bash
export UPSTREAM_API_KEY=your_upstream_key
```

If the downstream client uses model names that the upstream does not provide,
force or map them in the proxy:

```bash
export UPSTREAM_MODEL=glm-5
```

Or:

```bash
export UPSTREAM_MODEL_MAP='{"claude-opus-4-6":"glm-5","gpt-5.4":"glm-5"}'
```

`UPSTREAM_MODEL` has higher priority than `UPSTREAM_MODEL_MAP`.

If you want to force a fixed upper bound, you can still clamp outgoing
`max_tokens` manually:

```bash
export UPSTREAM_MAX_TOKENS=32000
```

By default, the proxy does not force a fixed output cap. If the upstream
returns a context-length error such as:

- `You passed ... input tokens and requested ... output tokens`

the proxy parses that error, computes the maximum allowed output tokens for that
specific request, lowers `max_tokens`, and retries once automatically.

Detailed proxy logs are off by default. Enable them only when debugging:

```bash
export PROXY_LOG=1
```

## Logs

By default, the service only prints the startup line.

If `PROXY_LOG=1`, it also prints one JSON log line per request step. Useful
fields:

- `event`: current stage, such as `proxy_request_received`,
  `proxy_upstream_response`, `proxy_adapter_complete`, or
  `proxy_request_complete`
- `request_id`: one id for the full request path through the proxy
- `status_code`: final downstream status sent by the proxy
- `upstream_status`: status returned by `http://115.120.82.129:3000/v1`
- `response_id`: generated for `/v1/responses`
- `duration_ms`: total proxy handling time

If a request succeeds, you should normally see:

1. `proxy_request_received`
2. `proxy_upstream_request`
3. `proxy_upstream_response`
4. `proxy_adapter_complete` or `proxy_passthrough_complete`
5. `proxy_request_complete`

## Claude Code

Current Claude Code versions are more reliable when configured through
`settings.json` instead of temporary `export` commands.

User-wide config:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3401",
    "ANTHROPIC_AUTH_TOKEN": "dummy-key"
  }
}
```

Save that to:

```text
~/.claude/settings.json
```

Or use a project-local file:

```text
.claude/settings.local.json
```

The proxy accepts Claude-style traffic on `/v1/messages`.

## Codex

Current Codex versions are more reliable when configured through
`~/.codex/config.toml`.

Example:

```toml
model_provider = "glm_proxy"
model = "glm-5"

[model_providers.glm_proxy]
name = "GLM Proxy"
base_url = "http://127.0.0.1:3401/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

Then start Codex with:

```bash
export OPENAI_API_KEY=dummy-key
codex
```

The proxy accepts Codex-style traffic on `/v1/responses`.

## opencode

Point `baseURL` to the proxy:

```json
{
  "provider": {
    "gxy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3401/v1",
        "apiKey": "your_key_here"
      }
    }
  }
}
```

## Manual Checks

```bash
cd /home/ahdai/Desktop/code/glm-tool-fix-proxy
just curl-chat
just curl-stream
just curl-messages
just curl-responses
```

## Test

```bash
cd /home/ahdai/Desktop/code/glm-tool-fix-proxy
npm test
just check
```
