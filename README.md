# opencode-request-logger

An [OpenCode](https://opencode.ai) plugin that logs raw LLM request bodies to disk for debugging and analysis.

Built for the **OpenCode V2 plugin API** (`@opencode/plugin`, `Plugin.define` + `setup(ctx)`).

## What it does

Intercepts outgoing requests to LLM providers (Anthropic, OpenAI, Google, Bedrock, Minimax, ...) and writes each raw request body as a timestamped JSON file. Logs are organized by session ID.

**Log location:** `~/.config/opencode/logs/request-logger/<sessionId>/<timestamp>_<seq>.json`

Each file contains:

```json
{
  "timestamp": "2026-03-04T12:00:00.000Z",
  "url": "https://api.anthropic.com/v1/messages",
  "source": "http",
  "kind": "primary",
  "agent": "build",
  "model": "anthropic/claude-sonnet-4-5",
  "body": { "...raw request body..." }
}
```

| Field | Meaning |
| --- | --- |
| `url` | Provider endpoint the request went to |
| `source` | `http` (native provider request), `fetch` (SDK-level fallback), `websocket` (streaming provider) |
| `kind` | `primary`, `compaction`, `title` or `generate` |
| `agent` / `model` | Agent and model that issued the request |

## How it works

Three interception layers cover every provider route:

1. **`http.request` hook** -- OpenCode's native protocol drivers issue a real `Request`, so the body here is the exact wire payload.
2. **`globalThis.fetch` wrapper** -- catches providers whose SDK performs its own HTTP call (AI SDK packages, `aisdk:` providers).
3. **`experimental.ws.send` hook** -- providers that stream over a WebSocket never reach the HTTP hooks.

Bodies are deduplicated by content hash, so a request seen by more than one layer is written once.

Only requests with an AI-shaped body (containing `messages`, `input`, or `contents`) are logged.

## Installation

```bash
npm install
npm run build
```

Register it in `opencode.json(c)` under `plugins` (V2 renamed the V1 `plugin` key):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/path/to/opencode-request-logger"]
}
```

The entry must point at the plugin **directory**. OpenCode resolves the entrypoint itself (`index.ts` in a source checkout, `dist/index.js` in a package); a path to a single `.ts` file is rejected with `configured plugin path must be a directory`.

Plugin directories under `~/.config/opencode/plugins/` and `<project>/.opencode/plugins/` are discovered automatically.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/opencode-request-logger",
      "options": {
        "enabled": true,
        "directory": "C:/logs/request-logger"
      }
    }
  ]
}
```

- `enabled` -- set to `false` to switch logging off (default `true`).
- `directory` -- custom log root (default `~/.config/opencode/logs/request-logger`).

## Notes

- The plugin patches `globalThis.fetch` in the OpenCode server process and restores the original when the plugin unloads.
- Requests are attributed to the session that issued them. The `fetch` fallback layer attributes a request to the most recently seen session, since the raw HTTP call carries no session ID.
- The plugin is a process-wide singleton: one log directory, one fetch wrapper, regardless of how many projects load it.
