diff --git a/.github/ISSUE_TEMPLATE/bug_report.md b/.github/ISSUE_TEMPLATE/bug_report.md
new file mode 100644
index 0000000..cc5246f
--- /dev/null
+++ b/.github/ISSUE_TEMPLATE/bug_report.md
@@ -0,0 +1,36 @@
+---
+name: Bug Report
+about: Report a bug to help us improve
+title: '[Bug] '
+labels: bug
+assignees: ''
+---
+
+## Description
+
+A clear and concise description of the bug.
+
+## Steps to Reproduce
+
+1.
+2.
+3.
+
+## Expected Behavior
+
+What did you expect to happen?
+
+## Actual Behavior
+
+What actually happened?
+
+## Environment
+
+- Pi Version:
+- OS:
+- Extension/Theme:
+- Node.js Version:
+
+## Additional Context
+
+Add any other context, screenshots, or logs here.
diff --git a/.github/ISSUE_TEMPLATE/feature_request.md b/.github/ISSUE_TEMPLATE/feature_request.md
new file mode 100644
index 0000000..ea7e58a
--- /dev/null
+++ b/.github/ISSUE_TEMPLATE/feature_request.md
@@ -0,0 +1,23 @@
+---
+name: Feature Request
+about: Suggest an idea for this project
+title: '[Feature] '
+labels: enhancement
+assignees: ''
+---
+
+## Problem
+
+What problem does this feature solve?
+
+## Proposed Solution
+
+Describe the solution you'd like.
+
+## Alternatives
+
+Describe alternatives you've considered.
+
+## Additional Context
+
+Add any other context, screenshots, or references here.
diff --git a/.github/PULL_REQUEST_TEMPLATE.md b/.github/PULL_REQUEST_TEMPLATE.md
new file mode 100644
index 0000000..f228242
--- /dev/null
+++ b/.github/PULL_REQUEST_TEMPLATE.md
@@ -0,0 +1,21 @@
+## Description
+
+Please include a summary of the changes and the related issue.
+
+## Type of Change
+
+- [ ] New extension
+- [ ] New theme
+- [ ] Bug fix
+- [ ] Documentation update
+- [ ] Infrastructure / tooling
+
+## Checklist
+
+- [ ] `npm run install-all` completes without errors
+- [ ] Extensions load correctly in Pi (`/reload`)
+- [ ] Commands work as expected
+- [ ] New extensions include `package.json` with `pi.extensions` field
+- [ ] New themes follow the existing JSON schema
+- [ ] README.md is updated with relevant docs
+- [ ] Code follows existing patterns (error resilience, typed imports)
diff --git a/CODE_OF_CONDUCT.md b/CODE_OF_CONDUCT.md
new file mode 100644
index 0000000..940ab12
--- /dev/null
+++ b/CODE_OF_CONDUCT.md
@@ -0,0 +1,59 @@
+# Contributor Covenant Code of Conduct
+
+## Our Pledge
+
+We as members, contributors, and leaders pledge to make participation in our
+community a harassment-free experience for everyone, regardless of age, body
+size, visible or invisible disability, ethnicity, sex characteristics, gender
+identity and expression, level of experience, education, socio-economic status,
+nationality, personal appearance, race, religion, or sexual identity
+and orientation.
+
+We pledge to act and interact in ways that contribute to an open, welcoming,
+diverse, inclusive, and healthy community.
+
+## Our Standards
+
+Examples of behavior that contributes to a positive environment:
+
+* Demonstrating empathy and kindness toward other people
+* Being respectful of differing opinions, viewpoints, and experiences
+* Giving and gracefully accepting constructive feedback
+* Accepting responsibility and apologizing to those affected by our mistakes
+* Focusing on what is best for the overall community
+
+Examples of unacceptable behavior:
+
+* The use of sexualized language or imagery, and sexual attention or advances
+* Trolling, insulting or derogatory comments, and personal or political attacks
+* Public or private harassment
+* Publishing others' private information without explicit permission
+* Other conduct which could reasonably be considered inappropriate
+
+## Enforcement Responsibilities
+
+Community leaders are responsible for clarifying and enforcing our standards of
+acceptable behavior and will take appropriate and fair corrective action in
+response to any behavior that they deem inappropriate, threatening, offensive,
+or harmful.
+
+## Scope
+
+This Code of Conduct applies within all community spaces, and also applies when
+an individual is officially representing the community in public spaces.
+
+## Enforcement
+
+Instances of abusive, harassing, or otherwise unacceptable behavior may be
+reported to the community leaders responsible for enforcement at
+[INSERT CONTACT METHOD].
+
+All complaints will be reviewed and investigated promptly and fairly.
+
+## Attribution
+
+This Code of Conduct is adapted from the [Contributor Covenant][homepage],
+version 2.0, available at
+https://www.contributor-covenant.org/version/2/0/code_of_conduct.html.
+
+[homepage]: https://www.contributor-covenant.org
diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md
new file mode 100644
index 0000000..af7adfc
--- /dev/null
+++ b/CONTRIBUTING.md
@@ -0,0 +1,89 @@
+# Contributing to Pi Extensions
+
+## Getting Started
+
+1. Fork the repository.
+2. Clone your fork:
+   ```bash
+   git clone https://github.com/your-username/pi-extensions.git
+   cd pi-extensions
+   ```
+3. Create a branch for your changes:
+   ```bash
+   git checkout -b feature/my-extension
+   ```
+
+## Extension Structure
+
+Each extension lives in `extensions/<name>/` and requires:
+
+- `package.json` – must include a `"pi"` field with `"extensions"` array pointing to entry files:
+  ```json
+  {
+    "name": "my-extension",
+    "version": "1.0.0",
+    "type": "module",
+    "main": "./index.ts",
+    "pi": {
+      "extensions": ["./index.ts"]
+    }
+  }
+  ```
+- `index.ts` — default export function receiving an `ExtensionAPI` object. See `extensions/statusline-pi/index.ts` for reference.
+
+Key coding patterns:
+- Use `import type` for type-only imports (e.g., `ExtensionAPI`, `ExtensionContext`)
+- Use `node:` prefix for Node.js built-in modules
+- Wrap external calls (git, gh) in try/catch for error resilience
+- Use `ctx.ui.notify("message", "info")` for user-facing alerts
+- Expose commands via `pi.registerCommand(name, { description, handler })`
+
+## Theme Format
+
+Themes are JSON files in `themes/`. The schema:
+
+- `name` — unique theme identifier
+- `displayName` — human-readable label (optional)
+- `colors` — color token map (accent, borderMuted, error, fg, mdHeading, mdLink, success, warning, etc.)
+- `vars` — CSS-like variable definitions (cursorColor, selectionBackground, etc.)
+
+See `themes/neon-green.json` and `themes/neon-green-light.json` for complete examples.
+
+## Testing Your Changes
+
+1. Install your local copy:
+   ```bash
+   npm run install-all
+   ```
+   Or test individual components:
+   ```bash
+   npm run install-extensions
+   npm run install-themes
+   ```
+2. Reload Pi: type `/reload` in Pi.
+3. Verify extensions work: run `/statusline-pi` to toggle footer.
+4. Verify themes: select from Pi's `/settings`.
+
+## Pull Request Checklist
+
+Before submitting, ensure:
+
+- [ ] `npm run install-all` completes without errors
+- [ ] Extensions load correctly in Pi (`/reload`)
+- [ ] Commands work as expected (`/statusline-pi`, `/statusline-refresh`)
+- [ ] New extensions include a `package.json` with the `pi.extensions` field
+- [ ] New themes follow the existing JSON schema
+- [ ] README.md is updated with new extensions/themes and their usage
+- [ ] Code follows existing patterns (error resilience, `node:` prefix, typed imports)
+
+## Code Style
+
+- TypeScript with strict types
+- Use `import type` for type-only declarations
+- Prefer `node:` protocol for Node built-ins
+- Handle errors gracefully (try/catch, fallback values)
+- Use `ctx.ui.notify` for user feedback rather than console
+
+## License
+
+By contributing, you agree that your contributions will be licensed under the MIT License.
diff --git a/SECURITY.md b/SECURITY.md
new file mode 100644
index 0000000..c5f9543
--- /dev/null
+++ b/SECURITY.md
@@ -0,0 +1,43 @@
+# Security Policy
+
+## Supported Versions
+
+| Version | Supported          |
+| ------- | ------------------ |
+| latest  | :white_check_mark: |
+
+## Reporting a Vulnerability
+
+We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.
+
+### How to Report
+
+1. **Do NOT** open a public GitHub issue for security vulnerabilities
+2. Email your findings to [INSERT SECURITY EMAIL]
+3. Include detailed steps to reproduce the vulnerability
+4. Allow up to 48 hours for an initial response
+
+### What to Include
+
+- Type of vulnerability
+- Full paths of affected source files
+- Location of the affected source code (tag/branch/commit or direct URL)
+- Step-by-step instructions to reproduce
+- Proof-of-concept or exploit code (if possible)
+- Impact of the issue
+
+### What to Expect
+
+- Acknowledgment of your report within 48 hours
+- Regular updates on our progress
+- Credit in the security advisory (if desired)
+- Notification when the issue is fixed
+
+## Security Best Practices
+
+When contributing to this project:
+
+- Never commit secrets, API keys, or credentials
+- Use environment variables for sensitive configuration
+- Follow secure coding practices
+- Report any security concerns immediately
diff --git a/docs/CHANGELOG.md b/docs/CHANGELOG.md
new file mode 100644
index 0000000..2de1ccd
--- /dev/null
+++ b/docs/CHANGELOG.md
@@ -0,0 +1,17 @@
+# Changelog
+
+All notable changes to this project are documented in this file.
+
+The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
+and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
+
+## [1.0.0] — Unreleased
+
+### Added
+
+- **statusline-pi extension**: Compact custom footer with git branch, changed files count, PR number, context window usage, context zone, and provider/model display.
+- **statusline-pi commands**: `/statusline-pi` toggle and `/statusline-refresh` force-refresh.
+- **Neon Green theme**: Futuristic dark theme with neon green, cyan, and magenta accents.
+- **Neon Green Light theme**: Softer light variant of the neon green theme.
+- **Install script**: One-command `install.sh` with interactive and automated (`--auto`) modes, `--keep`, `--dry-run`, `--repo-url`, and `--branch` flags.
+- **npm convenience scripts**: `install-all`, `install-extensions`, `install-themes` for local development.
diff --git a/docs/DEVELOPMENT.md b/docs/DEVELOPMENT.md
new file mode 100644
index 0000000..04130b3
--- /dev/null
+++ b/docs/DEVELOPMENT.md
@@ -0,0 +1,156 @@
+# Developer Guide
+
+## Architecture
+
+Pi Extensions is a collection of side-loadable extensions and themes for Pi Coding Agent. Extensions hook into Pi's event system and UI rendering pipeline; themes provide color tokens consumed by the TUI renderer.
+
+```
+pi-extensions/
+├── extensions/
+│   └── statusline-pi/
+│       ├── package.json          # Extension metadata, pi entry point
+│       └── index.ts              # Default export → ExtensionAPI handler
+├── themes/
+│   ├── neon-green.json           # Dark theme
+│   └── neon-green-light.json     # Light variant
+├── install.sh                    # Interactive/automated installer
+└── package.json                  # npm convenience scripts
+```
+
+## Extension API
+
+Extensions export a default function receiving an `ExtensionAPI` instance:
+
+```ts
+import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
+
+export default function myExtension(pi: ExtensionAPI) {
+  // ...
+}
+```
+
+### Key Types
+
+| Import                    | Description                            |
+|---------------------------|----------------------------------------|
+| `ExtensionAPI`            | API surface for registering commands, events |
+| `ExtensionContext`        | Session context passed to event handlers     |
+
+### ExtensionContext Properties
+
+| Property       | Type   | Description                              |
+|----------------|--------|------------------------------------------|
+| `ctx.cwd`      | string | Current working directory                |
+| `ctx.model`    | object | Current model info (id, provider, contextWindow, reasoning) |
+| `ctx.hasUI`    | boolean | Whether TUI mode is active              |
+| `ctx.ui.theme` | object | Theme token resolver (fg, bg methods)    |
+
+### ExtensionContext Methods
+
+| Method                          | Description                          |
+|---------------------------------|--------------------------------------|
+| `ctx.ui.setFooter(footer)`      | Register a custom footer renderer    |
+| `ctx.ui.notify(msg, level)`     | Show a notification to the user      |
+| `ctx.getContextUsage()`         | Returns `{ tokens }` usage info      |
+
+### ExtensionAPI Methods
+
+| Method                          | Description                          |
+|---------------------------------|--------------------------------------|
+| `pi.registerCommand(name, opts)` | Register a `/command`               |
+| `pi.getThinkingLevel()`          | Get current thinking level string    |
+
+### Events
+
+| Event               | Callback signature                          |
+|----------------------|---------------------------------------------|
+| `session_start`      | `(event, ctx: ExtensionContext) => void`    |
+| `session_shutdown`   | `() => void`                                |
+| `model_select`       | `(event, ctx: ExtensionContext) => void`    |
+| `thinking_level_select` | `(event, ctx: ExtensionContext) => void` |
+| `message_end`        | `(event, ctx: ExtensionContext) => void`    |
+| `tool_result`        | `(event, ctx: ExtensionContext) => void`    |
+
+### Footer Renderer
+
+`ctx.ui.setFooter()` accepts a factory: `(tui, theme, footerData) => Footer`. Footers implement:
+
+```ts
+interface Footer {
+  dispose(): void;
+  invalidate(): void;
+  render(width: number): string[];
+}
+```
+
+Use `tui.requestRender()` to trigger a re-render. `theme.fg(colorName, text)` applies a color token to text.
+
+## Theme Schema
+
+Themes define a `colors` map and optional `vars`:
+
+| Field         | Description                                |
+|---------------|--------------------------------------------|
+| `name`        | Unique theme identifier                    |
+| `displayName` | Human-readable label                       |
+| `colors`      | Token → color-value map                    |
+| `vars`        | CSS-like variable definitions              |
+
+### Color Tokens
+
+Core tokens used by extensions:
+
+| Token         | Example          |
+|---------------|------------------|
+| `accent`      | `"#5eeb8d"`      |
+| `borderMuted` | `"#6b7280"`      |
+| `error`       | `"#f06078"`      |
+| `fg`          | `"#e8ecf2"`      |
+| `mdHeading`   | `"#d48ee0"`      |
+| `mdLink`      | `"#6fd4e0"`      |
+| `success`     | `"#5eeb8d"`      |
+| `warning`     | `"#e8a84c"`      |
+
+### Vars
+
+| Token               | Example            |
+|----------------------|--------------------|
+| `cursorColor`        | `"#5eeb8d"`        |
+| `selectionBackground`| `"#1e3028"`        |
+
+## npm Scripts
+
+| Script                 | Effect                                              |
+|------------------------|-----------------------------------------------------|
+| `npm run install-all`  | Copy all extensions + themes to Pi directories      |
+| `npm run install-extensions` | Copy only extensions                          |
+| `npm run install-themes`     | Copy only themes                              |
+
+All scripts copy artifacts to `~/.pi/agent/extensions/` and `~/.pi/agent/themes/`.
+
+## Install Script Flags
+
+The `install.sh` script supports these flags:
+
+| Flag              | Description                              |
+|-------------------|------------------------------------------|
+| `--auto`          | Skip prompts, install silently           |
+| `--keep`          | Keep cloned repo after install           |
+| `--dry-run`       | Show what would install without copying  |
+| `--repo-url URL`  | Custom repository URL                    |
+| `--branch BRANCH` | Custom branch (default: main)            |
+
+## Adding a New Extension
+
+1. Create `extensions/<name>/package.json` with `pi.extensions` entry.
+2. Create `extensions/<name>/index.ts` exporting a default function.
+3. Wire into events and/or register commands using `pi.registerCommand()`.
+4. Test with `npm run install-extensions && /reload` in Pi.
+5. Update README.md with extension docs.
+
+## Adding a New Theme
+
+1. Create `themes/<name>.json` following the schema.
+2. Define `name`, `colors`, and `vars`.
+3. Test with `npm run install-themes && /reload` in Pi.
+4. Theme appears in Pi's `/settings` theme picker.
