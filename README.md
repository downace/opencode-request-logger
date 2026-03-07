# opencode-request-logger

An [OpenCode](https://opencode.ai) plugin that logs raw LLM request bodies to disk for debugging and analysis.

## What it does

Intercepts outgoing fetch calls to LLM providers (Anthropic, OpenAI, Google, Bedrock, etc.) and writes each request body as a timestamped JSON file. Logs are organized by session ID.

**Log location:** `~/.config/opencode/logs/request-logger/<sessionId>/<timestamp>_<seq>.json`

Each file contains:

```json
{
  "timestamp": "2026-03-04T12:00:00.000Z",
  "url": "https://api.anthropic.com/v1/messages",
  "body": { "...raw request body..." }
}
```

## How it works

Two interception layers ensure coverage across all providers:

1. **`globalThis.fetch` wrapper** -- catches most providers since the AI SDK routes through fetch
2. **`chat.params` hook** -- wraps the per-request fetch passed to `streamText`, catching providers that bypass `globalThis.fetch` (e.g. AWS Bedrock)

Only requests with an AI-shaped body (containing `messages`, `input`, or `contents` arrays) are logged.

## Installation

```bash
# From the plugin directory
bun install
bun run build
```

Then add to your OpenCode config (`~/.config/opencode/config.json`):

```json
{
  "plugin": [ "./plugin/opencode-request-logger" ]
}
```
