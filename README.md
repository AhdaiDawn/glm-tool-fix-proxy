# GLM Tool Fix Proxy

This project is a small OpenAI-compatible proxy for `GLM-5 + one-api`.

It solves one specific bug: in streaming tool calls, the upstream first sends
`tool_calls[].function.arguments` as incremental fragments, then sends the full
JSON object again in the final chunk. Clients such as `opencode` append both
parts and end up with invalid JSON.

This proxy repairs that stream before it reaches the client.

## What It Fixes

Broken upstream stream:

```text
... "arguments":"{\"filePath\":\""
... "arguments":"/home/ahdai/.config/opencode/opencode.json"
... "arguments":"\""
... "arguments":"{\"filePath\": \"/home/ahdai/.config/opencode/opencode.json\"}"
```

Expected downstream effect:

```text
... "arguments":"{\"filePath\":\""
... "arguments":"/home/ahdai/.config/opencode/opencode.json"
... "arguments":"\""
... "arguments":"}"
```

The repair logic is in [`repair.mjs`](./repair.mjs). The HTTP proxy entrypoint
is [`server.mjs`](./server.mjs).

## Requirements

- Node.js 20 or newer
- An OpenAI-compatible upstream endpoint
- A valid API key for that upstream, unless the caller already sends one

## Files

- `server.mjs`: HTTP proxy server
- `repair.mjs`: streaming `tool_calls.arguments` repair logic
- `test/repair.test.mjs`: minimal regression tests
- `justfile`: common commands

## Environment Variables

- `PORT`: local listen port. Default: `3401`
- `HOST`: local listen host. Default: `127.0.0.1`
- `UPSTREAM_BASE_URL`: upstream base URL. Default: `http://127.0.0.1:3000/v1`
- `UPSTREAM_API_KEY`: optional fixed upstream key

If `UPSTREAM_API_KEY` is not set, the proxy forwards the incoming
`Authorization` header unchanged.

## Start

Directly with Node:

```bash
cd /home/ahdai/glm-tool-fix-proxy
PORT=3401 \
HOST=127.0.0.1 \
UPSTREAM_BASE_URL=http://115.120.82.129:3000/v1 \
node server.mjs
```

Or with `just`:

```bash
cd /home/ahdai/glm-tool-fix-proxy
just start
```

## opencode Configuration

Point `baseURL` to the proxy instead of your one-api endpoint:

```json
{
  "provider": {
    "gxy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3401/v1",
        "apiKey": "your_key_here"
      },
      "models": {
        "glm-5": {
          "name": "GLM-5"
        }
      }
    }
  }
}
```

## Test

Run unit tests:

```bash
cd /home/ahdai/glm-tool-fix-proxy
npm test
```

Or:

```bash
cd /home/ahdai/glm-tool-fix-proxy
just test
```

## Manual Checks

Non-streaming request:

```bash
cd /home/ahdai/glm-tool-fix-proxy
just curl-chat
```

Streaming request:

```bash
cd /home/ahdai/glm-tool-fix-proxy
just curl-stream
```

These commands hit the local proxy, not the upstream directly.

## Notes

- The proxy only rewrites streaming `/chat/completions` responses with
  `stream: true`.
- Non-streaming responses are passed through unchanged.
- Other OpenAI-compatible endpoints are also passed through unchanged.
