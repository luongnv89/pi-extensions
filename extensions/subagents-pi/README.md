# subagents-pi

Pi extension that shows a **fleet metrics panel** for every managed subagent: **context usage**, **output TPS**, and **thinking level with model name**.

Designed as a companion to [`@tintinweb/pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents), which handles spawning, FleetView, and the `Agent` tool. This extension listens to the `pi.events` lifecycle bus and reads the shared agent registry for live stats.

## Install

```bash
# Orchestration (required for subagents)
pi install npm:@tintinweb/pi-subagents

# Metrics panel (this extension)
pi install npm:subagents-pi
```

From this monorepo:

```bash
./install.sh --auto
```

Reload Pi: `/reload`

## Usage

- The panel appears **below the editor** when subagents are tracked.
- Each agent uses a compact identity line followed by width-safe metric lines.
- `/subagents-pi` — toggle the panel
- `/subagents-pi-refresh` — refresh metrics and discard records removed by the companion

## What each row shows

| Field | Source |
|-------|--------|
| Context | Current context tokens (or `—` when unavailable) + context-window % (when available) + compaction count |
| TPS | Output tokens ÷ elapsed time (approximate session average) |
| Thinking/model | Runtime session thinking level shown with runtime provider/model; invocation settings are used as fallback |

## Acceptance criteria (issue #29)

- Dedicated installable Pi extension — `subagents-pi` npm package / `extensions/subagents-pi/`
- View listing managed subagents — below-editor widget + status key `subagents-pi`
- Per-agent context, TPS, thinking level with model name — rendered on each row

## Development

```bash
cd extensions/subagents-pi
npm install
npm run build
npm test
```

## License

MIT