# Model Debugger — Pi Extension

Logs all Pi model interactions to help debug silent failures, rate limiting, and model selection issues.

## Installation

```bash
cp -r extensions/model-debugger ~/.pi/agent/extensions/model-debugger
```

Then restart Pi.

## Usage

Inside Pi TUI:

| Command                   | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `/debug-status`           | Show current debugger status                          |
| `/debug-toggle [on\|off]` | Enable or disable logging (persisted across restarts) |
| `/debug-logs [N]`         | Show last N log entries (default: 100)                |
| `/debug-clear`            | Clear the log file                                    |
| `/debug-help`             | Show all commands                                     |

## Log file

```
~/.pi/agent/logs/model-debugger.log
```

## Safety

- Logs **only** write to file, never to console (won't interfere with response streaming)
- Auto-trims at 5 MB / 10,000 lines on each Pi start
- Can be fully disabled at runtime with `/debug-toggle off` — zero file writes when disabled

## License

MIT
