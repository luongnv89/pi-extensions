# timestamp-pi

Show a timestamp under every message in Pi's chat, plus a prompt-cache countdown in the footer.

## What it does

- **Per-message timestamps with context** — a dim line like `⏱ HH:MM:SS (2m ago) · user message` appears directly under each message, labeled as `user message`, `ai response`, or `tool call`
- **Cache miss countdown** — a footer status element shows `⏳ cache 4:32`, counting down the 5-minute prompt-cache TTL after each response; turns green while warm, yellow under 1 minute, red (`cache expired`) once the next request will be a cache miss

Timestamps are stored as custom session entries: they persist across reloads and are rendered TUI-only — they are never sent to the LLM.

## Features

- **Zero context pollution** — timestamps never reach the model
- **Session-persistent** — historical timestamps re-render when you resume a session
- **Live countdown** — countdown refreshes every second while the cache is warm
- **Coexists with other footers** — adds its own status element instead of replacing Pi's footer (same approach as subagents-pi)
- **Toggle on/off** — use `/timestamp-pi` to enable/disable

## Usage

After installation, timestamps appear automatically. Toggle with:

```
/timestamp-pi
```

## Installation

```bash
# From npm
pi install npm:timestamp-pi

# From repo (local)
pi -e ./extensions/timestamp-pi
```

Reload Pi (`/reload`) after installing.

## Requirements

Requires `@earendil-works/pi-coding-agent` >= 0.84 (uses `registerEntryRenderer`).

## Commands

| Command | Description |
|---------|-------------|
| `/timestamp-pi` | Toggle message timestamps and cache countdown on/off |

## Example

Chat:

```
You
Fix the failing test in auth.spec.ts
⏱ 14:32:05 (2m ago) · user message

Assistant
Fixed — running the tests now.
⏱ 14:32:08 (now) · ai response

Assistant
⏱ 14:32:10 (now) · tool call
```

Status element (in the footer):

```
⏳ cache 4:12
```

## License

MIT
