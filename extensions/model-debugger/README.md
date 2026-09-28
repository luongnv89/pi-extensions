# Model Debugger — Pi Extension

Logs all Pi model interactions to help debug silent failures, rate limiting, and model selection issues.

## Install

Published on npm: [`model-debugger`](https://www.npmjs.com/package/model-debugger). Use **Pi's package manager** (`pi install`), not `npm install` alone.

```bash
pi install npm:model-debugger
pi install npm:model-debugger@1.1.0   # pin version once published
pi install -l npm:model-debugger        # project-local (.pi/settings.json)
pi -e npm:model-debugger              # one session, no install
```

Then run `/reload` in Pi (or restart).

```bash
pi list
pi update npm:model-debugger
pi remove npm:model-debugger
```

**From [pi-extensions](https://github.com/luongnv89/pi-extensions) (git):**

```bash
cp -r extensions/model-debugger ~/.pi/agent/extensions/model-debugger
```

## Usage

Inside Pi TUI:

| Command                   | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `/model-debugger`         | Open a compact status/settings panel                  |
| `/debug-status`           | Show current debugger status                          |
| `/debug-toggle [on\|off]` | Enable or disable logging (persisted across restarts) |
| `/debug-logs [N]`         | Show last N log entries (default: 100)                |
| `/debug-clear`            | Clear the log file                                    |
| `/debug-help`             | Show all commands                                     |

`/model-debugger` shows whether logging is enabled, processing state, and a
read-only log count/size summary. Enable/disable and Close are the only actions;
Escape or Close leaves state and logs unchanged. If saving the toggle fails,
Pi warns that the change applies only to the current session. Outside the TUI,
the bare command reports status without opening a menu or toggling logging.

## Compatibility

The menu is shown only when Pi supplies an extension context with `mode === "tui"` and `hasUI`. Older host runtimes that omit `ctx.mode` use the non-TUI fallback instead of opening UI/RPC dialogs: the bare `/model-debugger` command reports read-only status.

## Log file

```
~/.pi/agent/logs/model-debugger.log
```

## Safety

- Logs **only** write to file, never to console (won't interfere with response streaming)
- Auto-trims at 5 MB / 10,000 lines on each Pi start
- Can be disabled at runtime with `/debug-toggle off` — model interactions are not logged while disabled; toggling still writes the small preference marker
- The `/model-debugger` panel never displays raw log lines, clears logs, or exposes credentials; use `/debug-logs` explicitly when raw entries are needed

## License

MIT
