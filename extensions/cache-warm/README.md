# cache-warm

Keep-alive for Pi's prompt cache. When enabled, the extension sends a tiny hidden turn before the cache TTL expires so a later user message is more likely to hit cache instead of paying for a miss.

**Default is on.** New sessions start keep-alive without `/cache-warm on`. Disable it with `/cache-warm off`. Keep-alive auto-stops after **30 minutes idle** (from the last user turn or `/cache-warm on`). Set any duration with `/cache-warm duration 1h` (or `30m`, `2h`, `forever`).

![Cache-warm footer counting down, before and after a warm ping](../../assets/cache-warm.png)

This is a separate package from [timestamp-pi](../timestamp-pi/README.md). timestamp-pi only shows TUI timestamps and a countdown; it never sends keep-alive traffic. See [docs/DECISIONS.md](../../docs/DECISIONS.md).

## What it does

- **Keep-alive pings** — when the remaining prompt-cache TTL drops under 60 seconds, and the session is idle with no queued messages, `cache-warm` injects a `display: false` custom message (`Reply "." only. Do not use tools. #w <iso>-<id>`) via `sendMessage`. The suffix is unique per send so providers do not see an identical prompt loop. A **rate limit is on by default** (12 pings per rolling hour). Toggle with `/cache-warm rate on|off` or `CACHE_WARM_RATE_LIMIT=off`. Cap size is `CACHE_WARM_MAX_PER_HOUR` (`0` or `forever` = unlimited while the limiter is on). Observed full one-hour Anthropic writes use a one-hour TTL; short and mixed writes schedule conservatively at five minutes. After 30 minutes with no user turn (configurable), keep-alive turns itself off so a forgotten session does not bill overnight.
- **Tool isolation** — once the hidden turn is confirmed, every hidden tool call is forcibly blocked, including retries, continuations, and interrupted work. If Pi drains queued user or foreign custom work before `agent_settled`, the guard is released at that message boundary so the external turn can use tools normally. The extension never changes the global active-tool list.
- **Easy toggle** — `/cache-warm on`, `/cache-warm off`, or `/cache-warm` to toggle
- **Honest metrics** — attempts, successful refreshes, likely avoided misses, and estimated net USD saved

The five-minute fallback is an Anthropic heuristic, not a universal provider guarantee. Cache reads without new write evidence retain the most recent observed retention for the model/session. An unconfirmed dispatch is never retried within the same cache-activity epoch because a late first dispatch could otherwise create duplicate billed turns. `/cache-warm on` clears that suppression even when keep-alive is already enabled.

Pings enter the LLM context. The assistant reply cannot be guaranteed invisible.

## Commands

| Command | Description |
|---------|-------------|
| `/cache-warm` | Toggle keep-alive on/off |
| `/cache-warm on` | Enable warming (restarts the idle window) |
| `/cache-warm off` | Disable warming |
| `/cache-warm duration` | Show the idle auto-stop limit |
| `/cache-warm duration 30m` | Set the idle auto-stop (`1h`, `2h`, `90`, `forever`; bare numbers are minutes) |
| `/cache-warm rate` | Show whether the hourly ping cap is on |
| `/cache-warm rate on` | Enable the hourly ping cap (default) |
| `/cache-warm rate off` | Disable the hourly ping cap |
| `/cache-warm status` | Enabled state, idle limit, rate limit, cache countdown, and metrics |
| `/cache-warm metrics` | Attempts, refreshes, likely avoided misses, estimated net USD saved |

## Metrics

| Counter | Meaning |
|---------|---------|
| `attempts` | Warm runs whose hidden message reached a confirmed lifecycle start. Merely requesting `sendMessage` does not count. |
| `refreshes` | Confirmed warm runs with cache activity (read or recreation), at most once per run. |
| `likely avoided misses` | Later **external non-warm** runs that still hit cache after the pre-warm cache would have expired. Counted once per warm chain from the external run's first request start. Warm retries and continuations never qualify. |
| `estimated net USD saved` | Pi-native actual-vs-counterfactual cost delta for eligible hits, minus all warm-run spend. Unknown pricing reports `N/A`, not `$0`. Net savings may be negative. |

Cost estimation uses `@earendil-works/pi-ai` pricing, including tiered rates and Anthropic one-hour cache writes. For OpenAI Responses requests, a validated reported/base cost ratio preserves flex or priority service-tier pricing in the counterfactual; unsafe or missing multiplier evidence reports `N/A`. The miss-billing heuristic is intentionally narrow: official OpenAI APIs are treated as ordinary uncached input; official Anthropic or explicit Anthropic-compatible cache control uses a five-minute cache write; a full observed `cacheWrite1h` uses a one-hour write. Mixed short/long writes are warmed on the shorter schedule but do not claim an avoided miss or estimated savings.

While enabled, the footer shows a short `warm 4:32 · 2 hits · $0.041` line (countdown, avoided-miss hits, estimated net saved).

## Install

Published on npm: [`cache-warm`](https://www.npmjs.com/package/cache-warm). Use Pi's package manager (`pi install`), not `npm install` alone.

```bash
pi install npm:cache-warm
pi install npm:cache-warm@0.1.1   # pin version
pi install -l npm:cache-warm      # project-local (.pi/settings.json)
pi -e npm:cache-warm              # one session, no install
```

Then run `/reload` in Pi (or restart it).

```bash
pi list
pi update npm:cache-warm
pi remove npm:cache-warm
```

**From this repository (git):**

```bash
pi -e ./extensions/cache-warm
pi install -l ./extensions/cache-warm
```

Keep-alive is **on** by default and auto-stops after 30 minutes idle; use `/cache-warm off` to disable, or `/cache-warm duration 2h` (or `CACHE_WARM_DURATION=2h`) for a longer window. The hourly ping cap is on by default (`/cache-warm rate off` or `CACHE_WARM_RATE_LIMIT=off` to disable; `CACHE_WARM_MAX_PER_HOUR` defaults to `12`).

## Development

```bash
cd extensions/cache-warm
npm install
npm test
```

## License

MIT — same as [pi-extensions](https://github.com/luongnv89/pi-extensions).
