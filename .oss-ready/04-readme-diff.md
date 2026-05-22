--- README.md	2026-05-22 16:00:31
+++ .oss-ready/04-readme-draft.md	2026-05-22 16:09:11
@@ -1,18 +1,23 @@
 # Pi Extensions & Themes
 
+[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
+[![GitHub Release](https://img.shields.io/github/v/release/luongnv89/pi-extensions?logo=github)](https://github.com/luongnv89/pi-extensions/releases)
+[![Docs](https://img.shields.io/badge/docs-DEVELOPMENT.md-blue)](docs/DEVELOPMENT.md)
+
 A curated collection of extensions and themes for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Share your Pi setup across different environments with ease.
 
-## Contents
+## Key Features
 
-### Extensions
+- **statusline-pi** — Compact custom footer showing current directory, git branch, changed files, GitHub PR number, remaining context window (tokens + percentage), context zone, and active provider/model.
+- **Neon Green themes** — Futuristic dark (`neon-green`) and light (`neon-green-light`) themes with neon green, cyan, and magenta accents.
+- **One-command install** — Interactive or automated (`--auto`) installer via a single curl pipe.
+- **npm convenience scripts** — `install-all`, `install-extensions`, `install-themes` for local development.
+- **Auto-discovery** — Themes are automatically picked up from `~/.pi/agent/themes/`.
 
-- **statusline-pi** — Compact custom footer with current directory, git branch/change count/PR, remaining context window plus zone, and provider/model.
+## Screenshots
 
-### Themes
+> **Coming soon** — no screenshot assets are available yet. Contributions welcome!
 
-- **neon-green** — Futuristic neon green theme for Pi.
-- **neon-green-light** — Softer light variant of the neon green theme.
-
 ## Quick Start
 
 ### One-liner install (recommended)
@@ -34,64 +39,57 @@
 ~/.pi/pi-extensions/install.sh
 ```
 
-Then reload Pi → open Pi and type `/reload`
+Reload Pi after installation — open Pi and type `/reload`.
 
-## License statusline-pi
+## Usage
 
+### statusline-pi
+
 `statusline-pi` replaces Pi's default footer with a compact project statusline.
 
-Format:
-
-```text
+```
 current-dir │ branch [changed files] PR #x │ remaining context tokens (percentage) context zone │ provider/model
 ```
 
 Example:
 
-```text
+```
 pi-extensions │ main [2] PR #12 │ 840,037 (84.0%) Plan │ openai-codex/gpt-5.5
 ```
 
-### Git section
+**Git section** — groups all git-related status:
+- Current branch name
+- Number of changed files from `git status --porcelain`
+- Related GitHub PR number (when `gh pr view` resolves one)
 
-The git section groups all git-related status in one place:
+**Context section** — remaining context window as exact tokens plus percentage, followed by the active zone:
 
-- current branch
-- number of changed files from `git status --porcelain`
-- related GitHub PR number when `gh pr view` can resolve one for the branch
-
-### Context section
-
-The remaining context window is shown as exact tokens plus percentage, followed by a simple zone value:
-
-```text
+```
 840,037 (84.0%) Plan
 ```
 
-The entire context section is colored by the active zone:
-
+Zone coloring:
 - **Plan** / **Code** — success color
 - **Dump** — warning color
 - **ExDump** / **Dead** — error color
 
-### Commands
+**Commands:**
 
-```text
+```
 /statusline-pi       # Toggle the custom footer on/off
 /statusline-refresh  # Force refresh git and PR data
 ```
 
-## Themes
+### Themes
 
 Themes are automatically discovered from `~/.pi/agent/themes/`.
 
 Available themes:
+- `neon-green` — Futuristic dark theme
+- `neon-green-light` — Softer light variant
 
-- `neon-green`
-- `neon-green-light`
+Manual install:
 
-Install manually:
-
 ```bash
 cp ~/.pi/pi-extensions/themes/neon-green.json ~/.pi/agent/themes/
 cp ~/.pi/pi-extensions/themes/neon-green-light.json ~/.pi/agent/themes/
@@ -99,22 +97,37 @@
 
 Select a theme from Pi's `/settings`, then reload if needed.
 
-## Install Flags
+## Configuration
 
-| Flag        | Effect                                          |     |
-|-------------|-------------------------------------------------|-----|
-| `--auto`    | Skip prompts, install everything automatically  |     |
-| `--keep`    | Keep the cloned repo after installation         |
-| `--dry-run` | Show what would be installed without copying    |     |
-| `--repo-url URL` | Use a custom repo URL (default: GitHub)  |     |
-| `--branch BRANCH` | Use a custom branch (default: `main`)   |     |
+### Install Flags
 
-## Directory Structure
+| Flag              | Effect                                         |
+|-------------------|-------------------------------------------------|
+| `--auto`          | Skip prompts, install everything automatically  |
+| `--keep`          | Keep the cloned repo after installation         |
+| `--dry-run`       | Show what would be installed without copying    |
+| `--repo-url URL`  | Use a custom repo URL (default: GitHub)         |
+| `--branch BRANCH` | Use a custom branch (default: `main`)           |
 
+## Project Structure
+
 ```text
 pi-extensions/
 ├── README.md
+├── LICENSE
+├── CONTRIBUTING.md
+├── CODE_OF_CONDUCT.md
+├── SECURITY.md
 ├── install.sh
+├── package.json
+├── .github/
+│   ├── ISSUE_TEMPLATE/
+│   │   ├── bug_report.md
+│   │   └── feature_request.md
+│   └── PULL_REQUEST_TEMPLATE.md
+├── docs/
+│   ├── DEVELOPMENT.md
+│   └── CHANGELOG.md
 ├── extensions/
 │   └── statusline-pi/
 │       ├── package.json
@@ -135,13 +148,17 @@
 
 Then run `/reload` in Pi.
 
-## Contributing
+## Documentation
 
-1. Create a fork.
-2. Add your extension/theme to the appropriate directory.
-3. Update this README with documentation.
-4. Submit a pull request.
+- [Contributing Guide](CONTRIBUTING.md) — how to add extensions, themes, and submit changes
+- [Developer Guide](docs/DEVELOPMENT.md) — architecture, extension API, theme schema, npm scripts
+- [Changelog](docs/CHANGELOG.md) — release history and planned features
+- [Security Policy](SECURITY.md) — how to report vulnerabilities
 
+## Related Publications
+
+> Coming soon.
+
 ## License
 
-MIT — feel free to use and modify for your own setup.
+MIT — see [LICENSE](LICENSE) for details.
