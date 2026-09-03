# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **opencode-pi 1.3.0**: Prompt caching via OpenCode session reuse across turns (#69, #74, #75, #76). Each Pi session keeps one stable OpenCode project directory (removed at session teardown) and one continued OpenCode session: continuation turns pass `--session` and send only the transcript delta instead of the full transcript, so the provider serves cached prompt prefixes (measured on `mimo-v2.5-free`: 483 input tokens with zero cache read fresh vs 51 input with 1216 cached tokens continued). The session restarts fresh — full transcript, new OpenCode session — whenever the model, tool list, or system prompt changes, the transcript no longer extends the previously sent prefix, or any turn errors, times out, or aborts. Turns without a Pi session ID keep the previous isolated one-shot behavior.
- **opencode-pi 1.3.0**: Real model cost and status from discovery metadata (#77, #78, #79). Free models are selected by zero input/output cost instead of the `-free` name pattern (same seven models on current metadata; future free models without the suffix are picked up automatically), inactive-status models are skipped, and a paid model registered via `OPENCODE_PI_MODELS` now reports its real cost instead of zero.

### Changed

- **grok-pi**: Refreshed the bundled fallback catalog against an authenticated Grok CLI 1.0.14 listing. The CLI offered only `grok-4.6` and `grok-4.5`, so the retired Composer 2.5 and Grok Build defaults were removed (#99).

### Fixed

- **grok-pi**: Model registration now reads real input/output/cache rates from CLI metadata instead of always reporting zero, and `GROK_PI_MODELS` selections retain matching cached context and reasoning metadata (#97, #98).
- **opencode-pi 1.3.0**: Correctness and hygiene guards the session reuse depends on (#70, #71, #72, #73). The stale `DEFAULT_FREE_MODELS` fallback (dead `deepseek-v4-flash-free` / `nemotron-3-super-free` IDs) is replaced with live IDs (`mimo-v2.5-free`, `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`, `big-pickle`, all verified resolvable); every turn's OpenCode session record is captured from the JSON event stream and deleted fire-and-forget (one-shot turns after each turn, session turns at teardown or on restart, never failing the turn); the abort listener is detached on every exit path including error and timeout; and every turn is bounded by an unconditional 3-minute internal timeout even when Pi supplies no `timeoutMs`.

### Fixed

- **grok-pi 1.4.1**: Windows turns no longer pass Pi's full prompt as `grok --single` argv. CreateProcess caps the command line at ~32KB, so even a one-word message hit `spawn ENAMETOOLONG` and grok-pi misreported it as a missing Grok CLI. Turns now write the prompt to a temp file and invoke `grok --prompt-file`. Also treat `~/.grok/bin/grok.exe` as an installed CLI, and prefer that path when `GROK_PI_BIN` is unset on Windows.

### Added

- **grok-pi 1.4.2**: Deterministic lifecycle tests for the temporary prompt-file cleanup in `streamGrokCli` — success, CLI-failure, timeout, and in-flight abort cases all assert that prompt files and temporary directories are removed.

### Changed

- **grok-pi 1.3.0**: Rewritten as a strict CLI-subprocess bridge — every model turn now spawns the official `grok --single … --tools "" --disable-web-search --permission-mode dontAsk --output-format json` binary instead of calling xAI's CLI proxy over HTTP with tokens extracted from `~/.grok/auth.json`. The extension no longer reads, refreshes, or spoofs any credentials or client headers (removes `bin/grok-api-key`, `bin/grok-client-version`, `bin/grok-user-agent`, `bin/grok-usage` and the direct billing API `/grok-pi usage` command), resolving the Acceptable Use Policy bot-access and bypass-clause exposure; real token usage/cost is parsed from the CLI's JSON output, thinking levels map to `--effort`, and tool calls remain prompt-bridged `<pi_tool_call>` markers executed by Pi.

### Added

- **cursor-pi extension**: New Cursor CLI provider bridge (`cursor-cli`) that exposes Cursor model ids (`auto`, `composer-2.5`, `gpt-5.3-codex-high`, and any account id via `CURSOR_PI_MODELS`) in Pi while routing every request through local `cursor-agent -p --output-format text --mode ask` with no HTTP API or built-in provider fallback. Verifies the CLI installation (`cursor-agent --version`) and login (`cursor-agent status`) at session start and on demand via `/cursor-pi verify`, warning with install guidance (`curl https://cursor.com/install | sh` + `cursor-agent login`) when either check fails. Tool calling is prompt-bridged with `<pi_tool_call>` markers executed by Pi; `/cursor-pi models` lists both registered and account-available ids; `/cursor-pi usage` shows plan tier and account info from `cursor-agent about`.
- **Harness environment checks**: `agy-pi`, `opencode-pi`, and `grok-pi` now verify their required external CLI at session start and warn with install guidance naming the missing harness; missing-binary stream failures in agy-pi report actionable setup steps instead of "No response from agy.", opencode-pi flags a missing CLI even when the `OPENCODE_PI_MODELS` fast path skipped discovery, and grok-pi distinguishes an uninstalled Grok CLI from a missing `grok login`, with a combined `Ready:` line in `/grok-pi status` (#53).
- **9router-pi**: Dynamic `9router` provider discovery from the local OpenAI-compatible `/v1/models` endpoint, with manual refresh and offline fallback support.

## [advisor-pi 1.1.0] — 2026-09-03

### Added

- **advisor-pi**: Bound the transcript sent on each advisor call ([#96](https://github.com/luongnv89/pi-extensions/issues/96), via [#108](https://github.com/luongnv89/pi-extensions/pull/108), part of [#82](https://github.com/luongnv89/pi-extensions/issues/82)). A configurable `max-transcript-chars` limit (default 20000, `/advisor-pi max-transcript-chars <n>`) keeps the most recent context and marks truncated output, so per-call cost no longer grows with session length.
- **advisor-pi**: Runnable test suite matching sibling convention ([#95](https://github.com/luongnv89/pi-extensions/issues/95), via [#109](https://github.com/luongnv89/pi-extensions/pull/109), part of [#82](https://github.com/luongnv89/pi-extensions/issues/82)). `npm test` runs 32 tests covering model-spec parsing, config parsing, state persistence, the legacy migration, model fallback, and transcript truncation.

### Fixed

- **advisor-pi**: Validate the configured advisor model at load and fall back with a visible notice instead of failing every call with model-not-found on a default install ([#93](https://github.com/luongnv89/pi-extensions/issues/93), via [#107](https://github.com/luongnv89/pi-extensions/pull/107), part of [#82](https://github.com/luongnv89/pi-extensions/issues/82)).
- **advisor-pi**: Check the migration target against the registry before rewriting stored config, so a resolving stored model is never replaced by one that does not resolve ([#94](https://github.com/luongnv89/pi-extensions/issues/94), via [#107](https://github.com/luongnv89/pi-extensions/pull/107), part of [#82](https://github.com/luongnv89/pi-extensions/issues/82)).

## [timestamp-pi 0.2.1] — 2026-09-03

### Changed

- **timestamp-pi**: Pause the refresh interval while the cache status is idle ([#101](https://github.com/luongnv89/pi-extensions/issues/101), via [#105](https://github.com/luongnv89/pi-extensions/pull/105), part of [#85](https://github.com/luongnv89/pi-extensions/issues/85)). The one-second interval now runs only while there is something to display and resumes when cache activity starts; the timer is still cleared on unmount.
- **timestamp-pi**: Extend relative age formatting beyond hours to days ([#102](https://github.com/luongnv89/pi-extensions/issues/102), via [#106](https://github.com/luongnv89/pi-extensions/pull/106), part of [#85](https://github.com/luongnv89/pi-extensions/issues/85)). Ages of a day or more show as `Nd ago`; shorter formats are unchanged.

## [statusline-pi 1.3.1] — 2026-09-03

### Fixed

- **statusline-pi**: Price historical turns with the model that produced them ([#100](https://github.com/luongnv89/pi-extensions/issues/100), via [#104](https://github.com/luongnv89/pi-extensions/pull/104)). Re-aggregating the session on a model switch no longer reprices earlier turns at the newly selected model's rates, and the unpriced indicator reflects the models actually used instead of only the current one. Turns whose provider reported a cost were already protected; turns priced from registry rates now keep their originating model's rates.

## [cache-warm 0.2.0] — 2026-08-28

### Changed

- **cache-warm**: Keep-alive is opt-in again and starts off in every session. Each ping appends a unique `#w <iso>-<id>` suffix. An hourly send cap is on when warming is enabled (15/hour by default; `/cache-warm rate on|off`, `CACHE_WARM_RATE_LIMIT`, `CACHE_WARM_MAX_PER_HOUR`).

### Fixed

- **cache-warm**: The default rolling-hour cap now permits the full four-minute short-cache refresh cadence (15/hour instead of 12/hour), rather than eventually blocking long enough to force a cache miss.

## [statusline-pi 1.3.0] — 2026-08-28

### Added

- **statusline-pi**: Shows a one-time warning when an OpenAI GPT model reaches 272,000 context tokens, the reported OpenAI pricing breakpoint where the same token costs double. The warning can appear again after a later threshold crossing ([#62](https://github.com/luongnv89/pi-extensions/pull/62), closes [#61](https://github.com/luongnv89/pi-extensions/issues/61)).

## [cache-warm 0.1.1] — 2026-08-24

### Changed

- **cache-warm**: Keep-alive is enabled by default for new sessions. It now auto-stops after 30 minutes of idle time (configurable via `/cache-warm duration` or `CACHE_WARM_DURATION`); `/cache-warm duration` reports or sets the limit, and `/cache-warm on` clears a suppressed epoch (#55).

## [cache-warm 0.1.0] — 2026-08-23

### Added

- **cache-warm**: Prompt-cache keep-alive extension (`/cache-warm on`, `off`, `status`, `metrics`) with avoided-miss and estimated net USD-saved metrics, shipped as a separate package from timestamp-pi and disabled by default (#51).

## [0.2.0] — 2026-08-21

### Added

- **Packaging guard**: `scripts/check-packaging.mjs` verifies every extension's `pi.extensions` entries are covered by its npm `files` allowlist; wired into `publish-npm-extensions.sh` as a pre-publish gate.

### Added

- **npm releases**: `claude-code-pi` 1.0.0 and `subagents-pi` 1.0.0 published for the first time; `statusline-pi` 1.2.1 and `opencode-pi` 1.1.4 republished with the fixes below. `publish-npm-extensions.sh` now covers all nine extensions (`scripts/publish-npm-extensions.sh:12`).

### Changed

- **publish-npm-extensions.sh**: Covers all nine extensions — including npm-packaged but not-yet-published `agy-pi` and `timestamp-pi`, whose first script run performs their initial npm publish — and uses npm's browser-based 2FA authorization by default (open the printed `npmjs.com/auth/cli/…` link); the OTP argument remains as a legacy fallback.
- **README**: Document npm install via `pi install npm:<package>` and table of published extensions.
- **Extension READMEs** (npm packages): Unified install section — npm link, `pi install` / pin / `-l` / `-e`, `pi list` / `update` / `remove`, git fallback.
- **npm / pi.dev gallery**: `pi-package` keyword and `pi.image` on published extensions; DEVELOPMENT.md gallery checklist. Bump patch versions locally (publish with `npm publish --otp=…`).
- **README / assets**: Screenshot gallery on root README; richer images in extension READMEs; normalize `claude-code-cli.png` and `statusline-pi-2-lines.png` filenames.

### Removed

- **hermes-pi extension**: Removed from the repository along with its theme (`themes/hermes-agent.json`) and docs.
- **apple-fm-pi extension**: Removed from the repository along with its docs and vendored fm-proxy. To use Apple Foundation Models, run `fm serve` manually and register the model via `models.json`.

## [claude-code-pi 1.0.1] — 2026-08-21

### Changed

- **claude-code-pi**: Added the `pi-package` npm keyword so the package is discoverable on the pi.dev/packages gallery (`extensions/claude-code-pi/package.json`).

## [claude-code-pi 1.0.0] — 2026-08-21

### Added

- **claude-code-pi**: First npm release. Bridges Claude Code CLI model aliases into Pi through local `claude -p` calls, with no SDK/API fallback path.

## [subagents-pi 1.0.0] — 2026-08-21

### Added

- **subagents-pi**: First npm release. Fleet metrics panel for managed subagents — per-agent context usage, output TPS, model, and thinking level (companion to `@tintinweb/pi-subagents`); terminal agents hide as soon as they finish.

## [statusline-pi 1.2.1] — 2026-08-21

### Fixed

- **statusline-pi**: Published npm package omitted `src/` while `pi.extensions` pointed at `./src/index.ts`, so the extension silently failed to load from `pi install npm:statusline-pi`. `src` is now shipped in the tarball (#32).

## [opencode-pi 1.1.4] — 2026-08-21

### Fixed

- **opencode-pi**: Register the API handler for `opencode-cli-runner` so bridged requests resolve instead of failing with an unknown-handler error (#38).
- **opencode-pi**: Malformed `<pi_tool_call>` markers (truncated JSON, unclosed markers) no longer hard-fail the whole turn. Valid sibling tool calls still execute, unrecoverable marker text is stripped from the displayed response, and a corrective diagnostic is only raised when no payload can be salvaged (#39).

## [grok-pi 1.2.0] — 2026-08-13

### Added

- **grok-pi**: `/grok-pi usage` reads the live credits API (`/v1/billing?format=credits`) and shows the per-product reset-allowance bank (`GrokBuild`, `GrokChat`). Duplicate overall credit bars are omitted when they match a single product pool.

## [advisor-pi 1.0.3] — 2026-08-13

### Changed

- **advisor-pi**: Default advisor model is `openai-codex/gpt-5.6-sol` with configurable thinking; status shows the selected model and a higher default max-uses.

## [statusline-pi 1.2.0] — 2026-08-13

### Added

- **statusline-pi**: Pixel-art Pac-Man / native context-zone icons in the footer.

### Changed

- **statusline-pi**: Token speed label is `tps` instead of `tok/s`.

## [opencode-pi 1.1.3] — 2026-08-13

### Fixed

- **opencode-pi**: Recover valid tool calls when models JSON-quote the full marker, vary the closing tag, or omit the closing tag after a complete payload; truncated and ambiguous markers remain rejected. Preserve model capabilities across the tool-call bridge.

## [grok-pi 1.1.0] — 2026-08-13

### Added

- **grok-pi**: Thinking levels for Grok CLI reasoning models (`low` / `medium` / `high` / `xhigh` when advertised). Shift+Tab, `/settings`, and `--thinking` map to Grok `reasoning.effort`.
- **grok-pi**: `/grok-pi usage` subscription card and cache-driven model catalog (Grok 4.6 / 4.5).

## [npm extensions] — 2026-06-19

### Added

- **npm**: Published `advisor-pi@1.0.0`, `grok-pi@1.0.0`, `model-debugger@1.0.0`, `opencode-pi@1.1.0`.
- **model-debugger**: `pi` manifest, `publishConfig`, and repo metadata for npm.
- **grok-pi** / **opencode-pi**: `prepublishOnly` build script.

## [statusline-pi 1.1.0] — 2026-06-19

### Added

- **statusline-pi**: Host **CPU** and **MEM** utilization in the footer (`CPU 42% · MEM 68%`), refreshed every 5 seconds with threshold-based colors.
- **statusline-pi**: Estimated accumulated **session cost** (USD) from per-turn token usage and model catalog rates.
- **statusline-pi**: Average model **response speed** (`tok/s`), including in-progress streaming responses.

### Changed

- **statusline-pi**: Responsive multi-line footer layout for narrow terminals.

## [1.0.0] — 2026-05-22

### Added

- **apple-fm-pi extension**: Apple FM bridge with in-process fm-proxy tool-schema fix (default direct `fm serve` :1976); optional `APPLE_FM_PI_USE_PROXY` for full HTTP proxy; `/apple-fm-pi launch-terminal` for PCC.
- **advisor-pi extension**: Advisor-style strategic guidance tool that lets the executor consult a configured higher-capability model for planning, review, and course correction.
- **advisor-pi configuration**: `/advisor-pi` command plus CLI flags for advisor model, max uses, and cache preference.
- **claude-code-pi extension**: Claude Code CLI provider bridge that exposes Claude Code model aliases in Pi while strictly routing every request and response through local `claude -p` with no SDK/API fallback.
- **opencode-pi extension**: OpenCode CLI provider bridge for free OpenCode models without OpenCode login, with prompt-bridged Pi tool calls and OpenCode tools disabled.
- **statusline-pi extension**: Compact custom footer with git branch, changed files count, PR number, context window usage, context zone, and provider/model display.
- **statusline-pi commands**: `/statusline-pi` toggle and `/statusline-refresh` force-refresh.
- **Neon Green theme**: Futuristic dark theme with neon green, cyan, and magenta accents.
- **Neon Green Light theme**: Softer light variant of the neon green theme.
- **Install script**: One-command `install.sh` with interactive and automated (`--auto`) modes, `--keep`, `--dry-run`, `--repo-url`, and `--branch` flags.
- **npm convenience scripts**: `install-all`, `install-extensions`, `install-themes` for local development.
