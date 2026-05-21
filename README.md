# Pi Extensions & Themes

A curated collection of extensions and themes for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Share your Pi setup across different environments with ease.

## Contents

### Extensions

- **statusline-pi** — Compact custom footer with current directory, git branch/change count/PR, remaining context window, provider/model, and context zone guidance.

### Themes

- **neon-green** — Futuristic neon green theme for Pi.
- **neon-green-light** — Softer light variant of the neon green theme.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/luongnv89/pi-extensions ~/.pi/pi-extensions

# Install all extensions and themes
~/.pi/pi-extensions/install.sh

# Reload Pi
# Open Pi and type: /reload
```

Manual install:

```bash
cp -r ~/.pi/pi-extensions/extensions/* ~/.pi/agent/extensions/
cp -r ~/.pi/pi-extensions/themes/* ~/.pi/agent/themes/
```

## Extension: statusline-pi

`statusline-pi` replaces Pi's default footer with a compact project statusline.

Format:

```text
current-dir │ branch [changed files] PR #x │ remaining context tokens (percentage) │ provider/model │ context zone
```

Example:

```text
pi-extensions │ main [2] PR #12 │ 840,037 (84.0%) │ openai-codex/gpt-5.5 │ 🟢 Plan Zone — Safe to plan and code
```

### Git section

The git section groups all git-related status in one place:

- current branch
- number of changed files from `git status --porcelain`
- related GitHub PR number when `gh pr view` can resolve one for the branch

### Context section

The remaining context window is shown as exact tokens plus percentage:

```text
840,037 (84.0%)
```

The context zone follows these thresholds and guidance:

- 🟢 **Plan Zone** — Safe to plan and code
- 🟡 **Code Zone** — Finish current task
- 🟠 **Dump Zone** — Consider `/compact` or subagent
- 🔴 **ExDump Zone** — Run `/compact` now
- ⚫ **Dead Zone** — Start new session with `/clear`

### Commands

```text
/statusline-pi       # Toggle the custom footer on/off
/statusline-refresh  # Force refresh git and PR data
```

## Themes

Themes are automatically discovered from `~/.pi/agent/themes/`.

Available themes:

- `neon-green`
- `neon-green-light`

Install manually:

```bash
cp ~/.pi/pi-extensions/themes/neon-green.json ~/.pi/agent/themes/
cp ~/.pi/pi-extensions/themes/neon-green-light.json ~/.pi/agent/themes/
```

Select a theme from Pi's `/settings`, then reload if needed.

## Directory Structure

```text
pi-extensions/
├── README.md
├── install.sh
├── extensions/
│   └── statusline-pi/
│       ├── package.json
│       ├── index.ts
│       └── README.md
└── themes/
    ├── neon-green.json
    └── neon-green-light.json
```

## Updating

```bash
cd ~/.pi/pi-extensions
git pull origin main
cp -r extensions/* ~/.pi/agent/extensions/
cp -r themes/* ~/.pi/agent/themes/
```

Then run `/reload` in Pi.

## Contributing

1. Create a fork.
2. Add your extension/theme to the appropriate directory.
3. Update this README with documentation.
4. Submit a pull request.

## License

MIT — feel free to use and modify for your own setup.
