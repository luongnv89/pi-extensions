# Pi Extensions & Themes

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/luongnv89/pi-extensions?logo=github)](https://github.com/luongnv89/pi-extensions/releases)
[![Docs](https://img.shields.io/badge/docs-DEVELOPMENT.md-blue)](docs/DEVELOPMENT.md)

A curated collection of extensions and themes for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Share your Pi setup across different environments with ease.

## Screenshots

| | |
|:---:|:---:|
| **statusline-pi** — git, cost, CPU/MEM, context zone, tok/s | **statusline-pi** — wrapped footer on a narrow terminal |
| ![statusline-pi](assets/statusline-pi-150toks-haiku-4.5.png) | ![statusline-pi two lines](assets/statusline-pi-2-lines.png) |
| **grok-pi** — Composer 2.5 via `grok-cli` | **opencode-pi** — free OpenCode models in `/model` |
| ![grok-pi](assets/composer-2.5-170-tok-s.png) | ![opencode model list](assets/pi-opencode-cli-model-list.png) |
| **opencode-pi** — DeepSeek flash in session | **claude-code-pi** — `claude-code-cli` provider |
| ![opencode deepseek](assets/pi-opencode-deepseek-4-flash.jpeg) | ![claude code cli](assets/claude-code-cli.png) |
| **advisor-pi** — strategic `advisor` tool | **Codex** — example Pi session (built-in provider) |
| ![advisor-pi](assets/advisor-pi.png) | ![pi codex](assets/pi-codex-gpt-5.5.png) |

More assets live in [`assets/`](assets/) (e.g. `statusline-pi-gpt-5-mini-195toks.png`, `pi-nvidia-kimi-2.6.png`).

## Key Features

- **statusline-pi** — Compact custom footer showing current directory, git branch, changed files, GitHub PR number, remaining context window (tokens + percentage), context zone, average model response speed, and active provider/model.
- **advisor-pi** — Advisor-style strategic guidance tool that lets the executor consult a configured higher-capability model during complex workflows.
- **claude-code-pi** — Bridge Claude Code CLI model aliases into Pi strictly through local `claude -p` calls, with no SDK/API fallback path.
- **grok-pi** — Bridge Grok CLI session models (Grok 4.6/4.5, Composer 2.5, Grok Build) into Pi via `grok-cli` and `~/.grok/auth.json`, with Pi thinking levels on reasoning models.
- **opencode-pi** — Bridge local OpenCode CLI free models into Pi without OpenCode login, with OpenCode tools disabled and Pi tool calls prompt-bridged back into Pi.
- **agy-pi** — Bridge `agy` CLI models (Gemini flash/pro variants, Claude Sonnet, GPT OSS) into Pi via an `agy` provider, with auto-discovery from `agy models` output (`extensions/agy-pi/src/index.ts`).
- **timestamp-pi** — Per-message timestamps with age labels plus a prompt-cache countdown in the footer, stored as session entries so they persist across reloads without reaching the LLM (`extensions/timestamp-pi/src/index.ts`).
- **subagents-pi** — Fleet metrics panel for managed subagents (context, TPS, model, thinking); works with `@tintinweb/pi-subagents`.
- **pi-delegator** — Agent skill for delegating approved tasks to a monitored Pi subprocess, preferring free `opencode-cli` models and reporting session metrics.
- **Themes** — `neon-green` / `neon-green-light` (futuristic dark/light pair) and `opencode` (`themes/neon-green.json`, `themes/neon-green-light.json`, `themes/opencode.json`).
- **npm packages** — Several extensions publish to npm; install with Pi’s package manager (`pi install npm:<name>`).
- **One-command install** — Interactive or automated (`--auto`) installer via a single curl pipe (full repo: all extensions, themes, skills).
- **npm convenience scripts** — `install-all`, `install-extensions`, `install-themes`, `install-skills` for local development from a clone.
- **Auto-discovery** — Themes and skills are automatically picked up from Pi's agent directories.

## Quick Start

Use **npm packages** when you only need specific extensions. Use the **repo installer** for everything (themes, skills, extensions not on npm, or a full mirror of this repo).

### Install extensions from npm (recommended for individual packages)

Pi registers npm packages in `~/.pi/agent/settings.json` and installs them under `~/.pi/agent/npm/`. Use `pi install`, not plain `npm install`.

```bash
# One extension
pi install npm:statusline-pi
pi install npm:advisor-pi
pi install npm:grok-pi
pi install npm:opencode-pi
pi install npm:model-debugger
pi install npm:claude-code-pi
pi install npm:subagents-pi

# Pin a version
pi install npm:opencode-pi@1.1.0

# Project-local (writes to .pi/settings.json in the current project)
pi install -l npm:statusline-pi
```

| npm package | What it provides |
|-------------|------------------|
| [`statusline-pi`](https://www.npmjs.com/package/statusline-pi) | Custom footer (git, PR, context, speed, cost, CPU/MEM) |
| [`advisor-pi`](https://www.npmjs.com/package/advisor-pi) | `advisor` tool + `/advisor-pi` |
| [`grok-pi`](https://www.npmjs.com/package/grok-pi) | `grok-cli` provider |
| [`opencode-pi`](https://www.npmjs.com/package/opencode-pi) | `opencode-cli` free models |
| [`model-debugger`](https://www.npmjs.com/package/model-debugger) | Model request logging to `~/.pi/agent/logs/` |
| [`claude-code-pi`](https://www.npmjs.com/package/claude-code-pi) | `claude` CLI provider via local `claude -p` |
| [`subagents-pi`](https://www.npmjs.com/package/subagents-pi) | Subagent fleet metrics panel |

Try without installing (current session only):

```bash
pi -e npm:advisor-pi
```

**Not on npm yet:** `agy-pi` and `timestamp-pi` are packaged for npm but not yet
published. Install them from a clone (`pi -e ./extensions/agy-pi`) or via the
repo installer below.

List and update installed packages:

```bash
pi list
pi update --extensions
pi remove npm:advisor-pi
```

Reload Pi after changes — type `/reload` (or restart Pi).

**Gallery:** Published packages with the `pi-package` keyword appear on [pi.dev/packages](https://pi.dev/packages). See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#listing-on-pidevpackages) for metadata (`pi.image`, republish checklist).

### One-liner install (full collection from GitHub)

```bash
curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash -s -- --auto
```

### From cloned repo

```bash
git clone https://github.com/luongnv89/pi-extensions ~/.pi/pi-extensions
~/.pi/pi-extensions/install.sh --auto
```

### Interactive install (legacy)

```bash
~/.pi/pi-extensions/install.sh
```

Reload Pi after installation — open Pi and type `/reload`.

## Usage

### statusline-pi

`statusline-pi` replaces Pi's default footer with a compact project statusline.

![statusline-pi — single-line footer](assets/statusline-pi-150toks-haiku-4.5.png)

![statusline-pi — responsive two-line layout](assets/statusline-pi-2-lines.png)

```
current-dir │ branch [changed files] PR #x │ remaining context tokens (percentage) context zone │ average response speed │ provider/model
```

Example:

```
pi-extensions │ main [2] PR #12 │ 840,037 (84.0%) Plan │ 42.5 tok/s │ openai-codex/gpt-5.5
```

**Git section** — groups all git-related status:
- Current branch name
- Number of changed files from `git status --porcelain`
- Related GitHub PR number (when `gh pr view` resolves one)

**Context section** — remaining context window as exact tokens plus percentage, followed by the active zone:

```
840,037 (84.0%) Plan
```

Zone coloring:
- **Plan** / **Code** — success color
- **Dump** — warning color
- **ExDump** / **Dead** — error color

**Average response speed** — approximate model output speed for the current model/thinking context:

```
42.5 tok/s
```

The value averages completed assistant responses, includes the active response while streaming, and remains visible while idle.

**Commands:**

```
/statusline-pi       # Toggle the custom footer on/off
/statusline-refresh  # Force refresh git and PR data
```

### claude-code-pi

`claude-code-pi` registers the **`claude-code-cli`** provider so Pi can use Claude Code CLI model aliases such as `sonnet`, `opus`, and `fable`. Every model turn spawns the local `claude -p` command with the selected model; there is no Anthropic SDK, HTTP API, or built-in provider fallback.

![claude-code-pi — Claude Code CLI in Pi](assets/claude-code-cli.png)

Full setup: [extensions/claude-code-pi/README.md](extensions/claude-code-pi/README.md)

```bash
pi --provider claude-code-cli --model sonnet
```

**Commands:** `/claude-code-pi status`, `/claude-code-pi models`, `/claude-code-pi test`, `/claude-code-pi help`

### grok-pi

`grok-pi` registers the **`grok-cli`** provider so Pi can use the same models as the Grok CLI (including **Grok 4.6** / **4.5** and **Composer 2.5**). Authenticate with `grok login`, then pick `grok-cli` in `/model`. Reasoning models honor Pi thinking levels (`Shift+Tab`, `/settings`, `--thinking`).

![grok-pi — Grok CLI models in Pi](assets/grok-pi.png)

![Composer 2.5 — ~170 tok/s in footer](assets/composer-2.5-170-tok-s.png)

Full setup: [extensions/grok-pi/README.md](extensions/grok-pi/README.md)

```bash
pi --provider grok-cli --model grok-4.6 --thinking high
```

**Commands:** `/grok-pi status`, `/grok-pi help`

### opencode-pi

`opencode-pi` registers the **`opencode-cli`** provider so Pi can use free models exposed by the local OpenCode CLI, without `opencode auth login`.

![opencode-pi — OpenCode CLI free models in Pi](assets/opencode-pi.png)

![OpenCode model picker in Pi](assets/pi-opencode-cli-model-list.png)

![DeepSeek v4 flash free session](assets/pi-opencode-deepseek-4-flash.jpeg)

Full setup: [extensions/opencode-pi/README.md](extensions/opencode-pi/README.md)

```bash
pi --provider opencode-cli --model opencode/deepseek-v4-flash-free
```

**Commands:** `/opencode-pi status`, `/opencode-pi models`, `/opencode-pi test`, `/opencode-pi help`

### advisor-pi

`advisor-pi` registers an `advisor` tool for strategic planning and course correction.
The executor model can ask a configured advisor model for guidance while keeping
file changes under the executor's control.

![advisor-pi — strategic guidance from a higher-capability model](assets/advisor-pi.png)

**Commands:**

```
/advisor-pi status
/advisor-pi enable
/advisor-pi disable
/advisor-pi model <provider>/<model>
/advisor-pi max-uses <number>
/advisor-pi cache <none|short|long>
/advisor-pi reset
```

**Operational notes:**

- Each advisor consultation is a separate model call and may add cost.
- Executor streaming pauses while the advisor model responds.
- Cache preferences are passed through where providers support them.
- The advisor has no tools; it only returns strategic guidance.

### agy-pi

`agy-pi` registers an **`agy`** provider so Pi can use models exposed by the
[agy](https://github.com/earendil-works/agy) CLI — Gemini flash/pro variants,
Claude Sonnet, GPT OSS, and more (`extensions/agy-pi/src/index.ts`). Models are
auto-discovered from `agy models` output; effort variants (`-high`/`-medium`/`-low`)
collapse into a single base model, with effort chosen via Pi's thinking-level selector.

Requires the `agy` CLI on `PATH` (`pip install agy-cli`) configured with your API keys.
Environment overrides: `AGY_PI_BIN` (binary path) and `AGY_PI_MODELS`
(comma-separated model IDs) (`extensions/agy-pi/src/index.ts:508`).

```bash
pi -e ./extensions/agy-pi   # repo install (not yet on npm)
```

**Commands:** `/agy-pi` — show provider status and registered models

### timestamp-pi

`timestamp-pi` adds a dim timestamp line (with age and message type: `user
message`, `ai response`, `tool call`) under every chat message, plus a footer
countdown of the 5-minute prompt-cache TTL (`⏳ cache 4:32`) that turns green
while warm, yellow under 1 minute, and red once expired
(`extensions/timestamp-pi/src/index.ts:177`).

Timestamps are stored as custom session entries, so they survive reloads and
are rendered TUI-only — never sent to the LLM. Requires Pi >= 0.84.

```bash
pi -e ./extensions/timestamp-pi   # repo install (not yet on npm)
```

**Commands:** `/timestamp-pi` — toggle timestamps and cache countdown

### pi-delegator

`pi-delegator` is an agent skill that lets a main AI agent delegate a clear,
approved task to a separate Pi process. It starts by checking available Pi models,
prefers free `opencode-cli` models by default, saves a reusable default model,
streams progress, and reports duration/token/cost metrics when Pi exposes them.

```bash
python3 ~/.pi/agent/skills/pi-delegator/scripts/pi_delegate.py models --prefer-free
```

Use the skill from Pi as `/skill:pi-delegator`, or let Pi auto-load it when you
ask to delegate work to a separate Pi instance.

### Themes

Themes are automatically discovered from `~/.pi/agent/themes/`.

Available themes:
- `neon-green` — Futuristic dark theme
- `neon-green-light` — Softer light variant
- `opencode` — OpenCode-branded theme

Manual install:

```bash
cp ~/.pi/pi-extensions/themes/*.json ~/.pi/agent/themes/
```

Select a theme from Pi's `/settings`, then reload if needed.

## Configuration

### Install Flags

| Flag              | Effect                                         |
|-------------------|-------------------------------------------------|
| `--auto`          | Skip prompts, install everything automatically  |
| `--keep`          | Keep the cloned repo after installation         |
| `--dry-run`       | Show what would be installed without copying    |
| `--repo-url URL`  | Use a custom repo URL (default: GitHub)         |
| `--branch BRANCH` | Use a custom branch (default: `main`)           |

## Project Structure

```text
pi-extensions/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── install.sh
├── package.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── PULL_REQUEST_TEMPLATE.md
├── docs/
│   ├── DEVELOPMENT.md
│   ├── CHANGELOG.md
│   └── DECISIONS.md
├── extensions/                  # one package per extension, each with
│   ├── advisor-pi/              # package.json + src/index.ts + README.md
│   ├── agy-pi/
│   ├── claude-code-pi/
│   ├── grok-pi/
│   ├── model-debugger/
│   ├── opencode-pi/
│   ├── statusline-pi/
│   ├── subagents-pi/
│   └── timestamp-pi/
├── scripts/
│   ├── check-packaging.mjs      # npm files vs pi.extensions guard
│   └── publish-npm-extensions.sh
├── skills/
│   └── pi-delegator/
│       ├── SKILL.md
│       ├── scripts/pi_delegate.py
│       └── references/
└── themes/
    ├── neon-green.json
    ├── neon-green-light.json
    └── opencode.json
```

## Updating

```bash
cd ~/.pi/pi-extensions
git pull origin main
~/.pi/pi-extensions/install.sh --auto
```

Then run `/reload` in Pi.

## Documentation

- [Contributing Guide](CONTRIBUTING.md) — how to add extensions, themes, and submit changes
- [Developer Guide](docs/DEVELOPMENT.md) — architecture, extension API, theme schema, npm scripts
- [Changelog](docs/CHANGELOG.md) — release history and planned features
- [Decisions Log](docs/DECISIONS.md) — resolved documentation ambiguities
- [Security Policy](SECURITY.md) — how to report vulnerabilities

## Related Publications

> Coming soon.

## License

MIT — see [LICENSE](LICENSE) for details.
