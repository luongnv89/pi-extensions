# timestamp-pi

Show timestamps on every message in Pi's chat UI with enable/disable toggle.

## What it does

Adds a timestamp display to Pi's footer/statusline showing:
- **User message time** — when the last user message was sent
- **AI response time** — when the last assistant message was completed
- **Tool call time** — when the last tool call completed
- **Relative times** — "5s ago", "2m ago", "now" for quick context
- **Message count** — total messages in the session

## Features

- **Auto-updating** — relative times refresh every 10 seconds
- **Compact mode** — automatically switches to minimal format on narrow terminals
- **Toggle on/off** — use `/timestamp-pi` to enable/disable
- **Session-aware** — timestamps reset when a new session starts

## Usage

After installation, timestamps appear automatically in the footer. Toggle with:

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

## Configuration

No configuration needed — timestamps are enabled by default.

## Commands

| Command | Description |
|---------|-------------|
| `/timestamp-pi` | Toggle timestamp display on/off |

## Example

```
User: 14:32:05 (2m ago)  │  AI: 14:32:08 (now)  │  Tool: 5s ago  │  42 msgs
```

## License

MIT
