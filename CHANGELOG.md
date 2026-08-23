# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Harness environment checks**: `agy-pi`, `opencode-pi`, and `grok-pi` now verify their required external CLI at session start and warn with install guidance naming the missing harness; missing-binary stream failures in agy-pi report actionable setup steps instead of "No response from agy.", opencode-pi flags a missing CLI even when the `OPENCODE_PI_MODELS` fast path skipped discovery, and grok-pi distinguishes an uninstalled Grok CLI from a missing `grok login`, with a combined `Ready:` line in `/grok-pi status` (#53).
- **cache-warm**: Opt-in prompt-cache keep-alive extension (`/cache-warm on`, `off`, `status`, `metrics`) with avoided-miss and estimated net USD-saved metrics. Separate package from timestamp-pi; default off so install/session start never bills a warm turn (#51).
- **9router-pi**: Dynamic `9router` provider discovery from the local OpenAI-compatible `/v1/models` endpoint, with manual refresh and offline fallback support.

### Changed

- **cache-warm**: Keep-alive is now enabled by default on new sessions; `/cache-warm off`, `/cache-warm on`, and `/cache-warm` still disable, re-enable, and toggle it (#55).

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
