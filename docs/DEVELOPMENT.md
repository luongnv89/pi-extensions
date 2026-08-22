# Developer Guide

## Architecture

Pi Extensions is a collection of side-loadable extensions and themes for Pi Coding Agent. Extensions hook into Pi's event system and UI rendering pipeline; themes provide color tokens consumed by the TUI renderer.

```
pi-extensions/
├── extensions/                     # one npm package per extension
│   ├── 9router-pi/                 # Dynamic 9router model discovery (src/index.ts)
│   ├── advisor-pi/                 # Advisor tool + /advisor-pi command (src/index.ts)
│   ├── agy-pi/                     # agy CLI provider bridge (src/index.ts)
│   ├── cache-warm/                 # prompt-cache keep-alive + savings metrics (src/index.ts)
│   ├── claude-code-pi/             # registerProvider + claude -p stream adapter (src/index.ts)
│   ├── grok-pi/                    # grok-cli provider bridge (src/index.ts)
│   ├── model-debugger/             # model request logging (index.ts)
│   ├── opencode-pi/                # registerProvider + CLI stream adapter (src/index.ts)
│   ├── statusline-pi/              # Default export → ExtensionAPI footer handler (src/index.ts)
│   ├── subagents-pi/               # subagent fleet metrics panel (src/index.ts)
│   └── timestamp-pi/               # message timestamps + cache countdown (src/index.ts)
├── themes/
│   ├── neon-green.json             # Dark theme
│   ├── neon-green-light.json       # Light variant
│   └── opencode.json               # OpenCode-branded theme
├── scripts/
│   ├── check-packaging.mjs         # pi.extensions vs files allowlist guard
│   └── publish-npm-extensions.sh   # publish all eleven npm extensions
├── install.sh                      # Interactive/automated installer
└── package.json                    # npm convenience scripts
```

## Extension API

Extensions export a default function receiving an `ExtensionAPI` instance:

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // ...
}
```

### Key Types

| Import                    | Description                            |
|---------------------------|----------------------------------------|
| `ExtensionAPI`            | API surface for registering commands, events |
| `ExtensionContext`        | Session context passed to event handlers     |

### ExtensionContext Properties

| Property       | Type   | Description                              |
|----------------|--------|------------------------------------------|
| `ctx.cwd`      | string | Current working directory                |
| `ctx.model`    | object | Current model info (id, provider, contextWindow, reasoning) |
| `ctx.hasUI`    | boolean | Whether TUI mode is active              |
| `ctx.ui.theme` | object | Theme token resolver (fg, bg methods)    |

### ExtensionContext Methods

| Method                          | Description                          |
|---------------------------------|--------------------------------------|
| `ctx.ui.setFooter(footer)`      | Register a custom footer renderer    |
| `ctx.ui.notify(msg, level)`     | Show a notification to the user      |
| `ctx.getContextUsage()`         | Returns `{ tokens }` usage info      |

### ExtensionAPI Methods

| Method                          | Description                          |
|---------------------------------|--------------------------------------|
| `pi.registerCommand(name, opts)` | Register a `/command`               |
| `pi.registerTool(def)`           | Register an LLM-callable custom tool |
| `pi.registerFlag(name, opts)`    | Register a CLI flag                  |
| `pi.appendEntry(type, data)`     | Persist extension state in sessions |
| `pi.getThinkingLevel()`          | Get current thinking level string    |

### Events

| Event               | Callback signature                          |
|----------------------|---------------------------------------------|
| `session_start`      | `(event, ctx: ExtensionContext) => void`    |
| `session_shutdown`   | `() => void`                                |
| `model_select`       | `(event, ctx: ExtensionContext) => void`    |
| `thinking_level_select` | `(event, ctx: ExtensionContext) => void` |
| `message_end`        | `(event, ctx: ExtensionContext) => void`    |
| `tool_result`        | `(event, ctx: ExtensionContext) => void`    |

### Footer Renderer

`ctx.ui.setFooter()` accepts a factory: `(tui, theme, footerData) => Footer`. Footers implement:

```ts
interface Footer {
  dispose(): void;
  invalidate(): void;
  render(width: number): string[];
}
```

Use `tui.requestRender()` to trigger a re-render. `theme.fg(colorName, text)` applies a color token to text.

## Theme Schema

Themes define a `colors` map and optional `vars`:

| Field         | Description                                |
|---------------|--------------------------------------------|
| `name`        | Unique theme identifier                    |
| `displayName` | Human-readable label                       |
| `colors`      | Token → color-value map                    |
| `vars`        | CSS-like variable definitions              |

### Color Tokens

Core tokens used by extensions:

| Token         | Example          |
|---------------|------------------|
| `accent`      | `"#5eeb8d"`      |
| `borderMuted` | `"#6b7280"`      |
| `error`       | `"#f06078"`      |
| `fg`          | `"#e8ecf2"`      |
| `mdHeading`   | `"#d48ee0"`      |
| `mdLink`      | `"#6fd4e0"`      |
| `success`     | `"#5eeb8d"`      |
| `warning`     | `"#e8a84c"`      |

### Vars

| Token               | Example            |
|----------------------|--------------------|
| `cursorColor`        | `"#5eeb8d"`        |
| `selectionBackground`| `"#1e3028"`        |

## Listing on [pi.dev/packages](https://pi.dev/packages)

The gallery is **not** a manual submission form. It indexes **public npm packages** that Pi recognizes as Pi packages.

### Requirements

1. **`keywords` includes `"pi-package"`** — required for gallery discoverability ([Pi packages docs](https://pi.dev/docs/latest/packages)).
2. **`pi` manifest in `package.json`** — at minimum `"pi": { "extensions": ["./src/index.ts"] }` (or skills/themes/prompts paths).
3. **`publishConfig.access": "public"`** and a successful `npm publish` from the extension directory.
4. **Useful `description`** — shown on the catalog card; keep it one clear sentence.
5. **`repository`** — gallery links to your GitHub repo when present.

### Optional gallery preview

Under the `pi` key you can add:

```json
"pi": {
  "extensions": ["./src/index.ts"],
  "image": "https://raw.githubusercontent.com/luongnv89/pi-extensions/main/assets/statusline-pi.png"
}
```

- **`image`**: PNG, JPEG, GIF, or WebP (static preview).
- **`video`**: MP4 URL (hover preview on desktop).

Use **stable raw GitHub URLs** on `main` (or a release asset), not repo-relative paths.

### After publish

- Verify on npm: `npm view <name> keywords` should list `pi-package`.
- Search the gallery: https://pi.dev/packages (filter **Recently published** or search by name).
- Indexing is automatic; new or updated packages usually appear after npm metadata propagates (often minutes, sometimes longer).

### Per-extension release

```bash
cd extensions/<name>
npm version patch   # or minor
npm publish --access public                # approve the browser 2FA link npm prints/opens
npm publish --access public --otp=123456   # legacy alternative
```

`prepublishOnly` runs `npm run build` where configured.

Before publishing, verify every extension's `pi.extensions` entries are actually
shipped by its `files` allowlist (a mismatch makes the extension silently fail to
load from the installed package — see issue #32):

```bash
node scripts/check-packaging.mjs   # also run automatically by publish-npm-extensions.sh
```

Publish all eleven npm extensions from repo root (approve the 2FA link in your browser):

```bash
chmod +x scripts/publish-npm-extensions.sh
./scripts/publish-npm-extensions.sh             # browser authorization per publish
./scripts/publish-npm-extensions.sh 123456      # legacy: pass OTP directly
# or: NPM_OTP=123456 ./scripts/publish-npm-extensions.sh
```

The extension list lives in `EXTENSIONS` at `scripts/publish-npm-extensions.sh:12`;
all listed extensions except `9router-pi`, `subagents-pi`, and `cache-warm` are published to npm —
the script's next run performs their initial publishes.

### Gallery `pi.image` URLs (npm metadata)

| Package | `pi.image` asset |
|---------|------------------|
| advisor-pi | `assets/advisor-pi.png` |
| agy-pi | (none — `pi.image` points to a missing asset) |
| grok-pi | `assets/composer-2.5-170-tok-s.png` |
| opencode-pi | `assets/pi-opencode-cli-model-list.png` |
| statusline-pi | `assets/statusline-pi-150toks-haiku-4.5.png` |
| timestamp-pi | (none — `pi.image` points to a missing asset) |
| claude-code-pi / subagents-pi / model-debugger / cache-warm | (none yet) |

<!-- FLAG: agy-pi and timestamp-pi pi.image URLs reference assets not present in assets/ — add the files or remove the pi.image field before the images can appear on pi.dev -->

Images must be reachable at `https://raw.githubusercontent.com/luongnv89/pi-extensions/main/...` on `main` before pi.dev can show them.

## npm Scripts

| Script                 | Effect                                              |
|------------------------|-----------------------------------------------------|
| `npm run install-all`  | Copy all extensions + themes + skills to Pi directories |
| `npm run install-extensions` | Copy only extensions                          |
| `npm run install-themes`     | Copy only themes                              |
| `npm run install-skills`     | Copy only skills                              |

All scripts copy artifacts to `~/.pi/agent/extensions/`, `~/.pi/agent/themes/`,
and `~/.pi/agent/skills/` (`package.json:25-28`).

## Install Script Flags

The `install.sh` script supports these flags:

| Flag              | Description                              |
|-------------------|------------------------------------------|
| `--auto`          | Skip prompts, install silently           |
| `--keep`          | Keep cloned repo after install           |
| `--dry-run`       | Show what would install without copying  |
| `--repo-url URL`  | Custom repository URL                    |
| `--branch BRANCH` | Custom branch (default: main)            |

## Included Extensions

### advisor-pi

`advisor-pi` registers an `advisor` tool that performs a nested model call through
`@earendil-works/pi-ai` and Pi's `ctx.modelRegistry`. It persists configuration
and use counts with custom session entries and tool result details so branch
state can be reconstructed after reloads.

Key implementation points:

- `pi.registerTool()` exposes the advisor to the executor model.
- `ctx.modelRegistry.find()` and `getApiKeyAndHeaders()` resolve the configured
  advisor model and auth.
- `buildSessionContext()`, `convertToLlm()`, and `serializeConversation()` build
  the transcript sent to the advisor.
- `/advisor-pi` manages enable/disable, model, max uses, cache preference, and
  use-count reset.

### subagents-pi

`subagents-pi` renders a below-editor fleet panel for subagents managed by
`@tintinweb/pi-subagents`. It subscribes to `pi.events` lifecycle channels
(`subagents:ready`, `subagents:created`, `subagents:started`, …) and reads
agent records from the `Symbol.for("pi-subagents:manager")` registry for live
context, TPS, model, and thinking labels.

### statusline-pi

`statusline-pi` replaces the footer with compact git, PR, context, and model
status.

### claude-code-pi

`claude-code-pi` registers a `claude-code-cli` provider with a custom
`streamSimple` implementation. Each model turn serializes Pi context into a text
prompt, then spawns the local Claude Code CLI strictly as `claude -p` with the
selected model alias.

Key implementation points:

- Static model aliases (`sonnet`, `opus`, `fable` by default) make Claude Code
  models selectable through `/model` and `--provider claude-code-cli`.
- `buildClaudeArgs()` always includes `-p`, `--model <id>`,
  `--no-session-persistence`, and `--tools ""` so Claude Code communication is
  non-interactive and its own tools are disabled.
- The extension emits Pi assistant text from stdout, and maps explicit
  `<pi_tool_call>{...}</pi_tool_call>` markers back into native Pi tool calls.
  Missing CLI, non-zero exit, abort, or timeout becomes a clear setup error
  instead of an SDK/API fallback.
- `/claude-code-pi` reports status, model aliases, smoke-test commands, and
  environment variable configuration.

### opencode-pi

`opencode-pi` registers an `opencode-cli` provider with a custom `streamSimple`
implementation. It discovers local free OpenCode models via `opencode models
opencode`, then delegates each turn to `opencode run --format json`.

Key implementation points:

- A temporary OpenCode project and locked-down `pi-model` agent are created for
  every turn so OpenCode's own tools are denied.
- Pi context and tool schemas are serialized into the prompt.
- `<pi_tool_call>{...}</pi_tool_call>` markers returned by the model are parsed
  into Pi `toolCall` content blocks so Pi, not OpenCode, executes tools.
- `/opencode-pi` reports status, model list, test commands, and environment
  variable configuration.

### agy-pi

`agy-pi` registers an `agy` provider whose models come from the `agy` CLI.
Bundled defaults are registered synchronously at startup (registering
asynchronously after session start makes Pi reject the provider as "stale"),
and `/agy-pi` triggers re-discovery via `agy models`
(`extensions/agy-pi/src/index.ts:469-508`). Effort variants
(`-high`/`-medium`/`-low`) collapse into one base model so Pi thinking levels
select the effort. `AGY_PI_BIN` overrides the binary (`index.ts:69`);
`AGY_PI_MODELS` pins specific model IDs (`index.ts:73`).

### timestamp-pi

`timestamp-pi` renders per-message timestamps via `pi.registerEntryRenderer()`
(`extensions/timestamp-pi/src/index.ts:172`) and adds a footer status element
counting down the 5-minute prompt-cache TTL (`CACHE_TTL_MS`, `index.ts:8`;
yellow under 60s, red once expired, `index.ts:11,223`). Entries are custom
session entries, so history survives reloads and never reaches the LLM.

### cache-warm

`cache-warm` is a separate keep-alive extension (not part of timestamp-pi).
Default is off: `/cache-warm on` starts a timer that may `pi.sendMessage()` a
hidden ping when remaining TTL is under 60s, the session is idle, and cache
activity has already been observed (`extensions/cache-warm/src/index.ts`).
Metrics (`attempts`, `refreshes`, `likelyAvoidedMisses`, estimated net USD)
live in `src/warm.ts` / `src/metrics.ts`; cost math is copied from
statusline-pi rather than imported. The 5-minute TTL is an Anthropic heuristic.

## Adding a New Extension

1. Create `extensions/<name>/package.json` with `pi.extensions` entry.
2. Create the entry file (e.g. `extensions/<name>/src/index.ts`) exporting a default function.
3. Wire into events and/or register commands using `pi.registerCommand()`.
4. Test with `npm run install-extensions && /reload` in Pi.
5. Update README.md with extension docs.

## Adding a New Theme

1. Create `themes/<name>.json` following the schema.
2. Define `name`, `colors`, and `vars`.
3. Test with `npm run install-themes && /reload` in Pi.
4. Theme appears in Pi's `/settings` theme picker.
