# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **subagents-pi**: New extension listing managed subagents with per-agent context usage, output TPS, model, and thinking level (companion to `@tintinweb/pi-subagents`).

### Changed

- **subagents-pi**: Fleet panel redesigned as a compact ops console (header counts, glyph status, metric cards) and hides terminal agents (`completed` / `error` / `aborted` / `stopped`) as soon as they finish.
- **README**: Document npm install via `pi install npm:<package>` and table of published extensions.
- **Extension READMEs** (npm packages): Unified install section — npm link, `pi install` / pin / `-l` / `-e`, `pi list` / `update` / `remove`, git fallback.
- **npm / pi.dev gallery**: `pi-package` keyword and `pi.image` on published extensions; DEVELOPMENT.md gallery checklist. Bump patch versions locally (publish with `npm publish --otp=…`).
- **README / assets**: Screenshot gallery on root README; richer images in extension READMEs; normalize `claude-code-cli.png` and `statusline-pi-2-lines.png` filenames.

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
