# cache-warm

Opt-in keep-alive for Pi's prompt cache. When enabled, the extension sends a tiny hidden turn before the cache TTL expires so a later user message is more likely to hit cache instead of paying for a miss.

**Default is off.** Installing the extension or starting a session never bills a warm turn. Enable it with `/cache-warm on`.

This is a separate package from [timestamp-pi](../timestamp-pi/README.md). timestamp-pi only shows TUI timestamps and a countdown; it never sends keep-alive traffic. See [docs/DECISIONS.md](../../docs/DECISIONS.md).

## What it does

- **Keep-alive pings** — when the remaining 5-minute prompt-cache TTL drops under 60 seconds, and the session is idle with no queued messages, `cache-warm` injects a `display: false` custom message (`Reply "." only. Do not use tools.`) via `sendMessage`
- **Easy toggle** — `/cache-warm on`, `/cache-warm off`, or `/cache-warm` to toggle
- **Honest metrics** — attempts, successful refreshes, likely avoided misses, and estimated net USD saved

The 5-minute TTL is an Anthropic heuristic, not a universal provider guarantee.

Pings enter the LLM context. The assistant reply cannot be guaranteed invisible.

## Commands

| Command | Description |
|---------|-------------|
| `/cache-warm` | Toggle keep-alive on/off |
| `/cache-warm on` | Enable warming |
| `/cache-warm off` | Disable warming |
| `/cache-warm status` | Enabled state, cache countdown, and metrics |
| `/cache-warm metrics` | Attempts, refreshes, likely avoided misses, estimated net USD saved |

## Metrics

| Counter | Meaning |
|---------|---------|
| `attempts` | Warm pings sent |
| `refreshes` | Warm-triggered assistant turns that read cache (`cacheRead > 0`) |
| `likely avoided misses` | Later **non-warm** turns that still hit cache after the pre-warm cache would have expired. Counted once per warm chain. A cache read on the warm ping itself is a refresh, not an avoided miss. |
| `estimated net USD saved` | Gross cache discount of those avoided-miss turns minus warm-turn spend. Missing/invalid model rates report `N/A`, not `$0`. Net savings may be negative. |

While enabled, the footer shows a short `warm 4:32 · 2 hits · $0.041` line (countdown, avoided-miss hits, estimated net saved).

## Install from this repository

Not published to npm yet. From the repository root:

```bash
pi -e ./extensions/cache-warm
```

Or install it persistently:

```bash
pi install -l ./extensions/cache-warm
```

Then run `/reload` in Pi (or restart it). Warming stays **off** until `/cache-warm on`.

## Development

```bash
cd extensions/cache-warm
npm install
npm test
```

## License

MIT — same as [pi-extensions](https://github.com/luongnv89/pi-extensions).
