# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — Unreleased

### Added

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
