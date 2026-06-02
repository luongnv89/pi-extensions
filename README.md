# Pi Extensions & Themes

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/luongnv89/pi-extensions?logo=github)](https://github.com/luongnv89/pi-extensions/releases)
[![Docs](https://img.shields.io/badge/docs-DEVELOPMENT.md-blue)](docs/DEVELOPMENT.md)

A curated collection of extensions and themes for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Share your Pi setup across different environments with ease.

## Key Features

- **statusline-pi** — Compact custom footer showing current directory, git branch, changed files, GitHub PR number, remaining context window (tokens + percentage), context zone, and active provider/model.
- **advisor-pi** — Advisor-style strategic guidance tool that lets the executor consult a configured higher-capability model during complex workflows.
- **grok-pi** — Bridge Grok CLI session models (Composer 2.5, Grok Build) into Pi via `grok-cli` and `~/.grok/auth.json`.
- **Neon Green themes** — Futuristic dark (`neon-green`) and light (`neon-green-light`) themes with neon green, cyan, and magenta accents.
- **One-command install** — Interactive or automated (`--auto`) installer via a single curl pipe.
- **npm convenience scripts** — `install-all`, `install-extensions`, `install-themes` for local development.
- **Auto-discovery** — Themes are automatically picked up from `~/.pi/agent/themes/`.

## Screenshots

![statusline-pi screenshot](statusline-pi.png)

## Quick Start

### One-liner install (recommended)

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

```
current-dir │ branch [changed files] PR #x │ remaining context tokens (percentage) context zone │ provider/model
```

Example:

```
pi-extensions │ main [2] PR #12 │ 840,037 (84.0%) Plan │ openai-codex/gpt-5.5
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

**Commands:**

```
/statusline-pi       # Toggle the custom footer on/off
/statusline-refresh  # Force refresh git and PR data
```

### grok-pi

`grok-pi` registers the **`grok-cli`** provider so Pi can use the same models as the Grok CLI (including **Composer 2.5** as `grok-composer-2.5-fast`). Authenticate with `grok login`, then pick `grok-cli` in `/model`.

Full setup: [extensions/grok-pi/README.md](extensions/grok-pi/README.md)

```bash
pi --provider grok-cli --model grok-composer-2.5-fast
```

**Commands:** `/grok-pi status`, `/grok-pi help`

### advisor-pi

`advisor-pi` registers an `advisor` tool for strategic planning and course correction.
The executor model can ask a configured advisor model for guidance while keeping
file changes under the executor's control.

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

### Themes

Themes are automatically discovered from `~/.pi/agent/themes/`.

Available themes:
- `neon-green` — Futuristic dark theme
- `neon-green-light` — Softer light variant

Manual install:

```bash
cp ~/.pi/pi-extensions/themes/neon-green.json ~/.pi/agent/themes/
cp ~/.pi/pi-extensions/themes/neon-green-light.json ~/.pi/agent/themes/
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
│   └── CHANGELOG.md
├── extensions/
│   ├── advisor-pi/
│   │   ├── package.json
│   │   ├── src/index.ts
│   │   └── README.md
│   └── statusline-pi/
│       ├── package.json
│       ├── src/index.ts
│       └── README.md
└── themes/
    ├── neon-green.json
    └── neon-green-light.json
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
- [Security Policy](SECURITY.md) — how to report vulnerabilities

## Related Publications

> Coming soon.

## License

MIT — see [LICENSE](LICENSE) for details.
