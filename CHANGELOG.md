# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **grok-pi** — Thinking levels for Grok CLI reasoning models (`low` / `medium` / `high` / `xhigh` when advertised)
- **statusline-pi** — Pixel-art Pac-Man faces for context zones (Plan=grin, Code=smile, Dump=flat, ExDump=frown, Dead=X-eyes) in the context segment

## [0.1.0] — 2026-06-15

### Added

- **statusline-pi** — Compact custom footer showing current directory, git branch, changed files, GitHub PR number, remaining context window (tokens + percentage), context zone, average model response speed, and active provider/model
- **advisor-pi** — Advisor-style strategic guidance tool that lets the executor consult a higher-capability model during complex workflows
- **grok-pi** — Bridge Grok CLI session models (Composer 2.5, Grok Build) into Pi via `grok-cli` and `~/.grok/auth.json`
- **opencode-pi** — Bridge local OpenCode CLI free models into Pi without OpenCode login, with tools disabled and Pi tool calls prompt-bridged back
- **pi-delegator** — Agent skill for delegating approved tasks to a monitored Pi subprocess using free `opencode-cli` models
- **Neon Green themes** — Futuristic dark (`neon-green`) and light (`neon-green-light`) themes with neon green, cyan, and magenta accents
- **opencode theme** — Theme for OpenCode CLI
- One-command install script with `--auto`, `--keep`, `--dry-run` support
- npm convenience scripts: `install-all`, `install-extensions`, `install-themes`, `install-skills`
- OSS-ready setup: README, CONTRIBUTING, LICENSE, CODE_OF_CONDUCT, SECURITY, GitHub templates
- Context window / zone status monitoring
- Response speed tracking in statusline
- OpenAI Codex/GPT-5.5 as default advisor model

### Fixed

- **statusline** — Wrap narrow terminal layout for small terminals
- **advisor-pi** — Normalize pi-ai bin path for reliable execution
- **opencode** — Make code-block text readable in terminal
- Show actual thinking level from Pi API, add reasoning support indicator
