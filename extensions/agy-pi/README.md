# agy-pi

Bridge [agy](https://github.com/earendil-works/agy) CLI Gemini models into Pi Coding Agent.

![agy-pi — Gemini 3.7 Flash via agy CLI in a Pi session](../../assets/agy-pi.png)

## What it does

Registers an `agy` provider in Pi that exposes all models available through the `agy` CLI tool — Gemini flash/pro variants, Claude Sonnet, GPT OSS, and more.

## Prerequisites

- **agy** installed and available on `PATH`
  ```bash
  # Install agy
  pip install agy-cli
  # or: pipx install agy-cli
  ```
- agy configured with your API keys (Google, Anthropic, OpenAI, etc.)

## Configuration

| Environment Variable | Description |
|---------------------|-------------|
| `AGY_PI_BIN` | Override the agy binary path (default: `agy`) |
| `AGY_PI_MODELS` | Comma-separated list of model IDs to register (e.g. `gemini-3.7-flash-high,gpt-oss-120b-medium`) |

Effort variants (`-high`/`-medium`/`-low`) are grouped into a single base
model (e.g. `gemini-3.7-flash`); use Pi's thinking-level selector (`/thinking`)
to pick the effort level.

## Usage

After installation, select the `agy` provider from Pi's model selector (`/model` or `Ctrl+M`).

Models are auto-discovered from `agy models` output. To force re-discovery:

```
/agy-pi
```

> **Note:** agy's print mode requires `--model` to appear **before** `-p/--print`
> and the prompt to be passed as an argument — otherwise the flag is silently
> ignored and the CLI falls back to your default model (upstream issues
> [#83](https://github.com/google-antigravity/antigravity-cli/issues/83) and
> [#581](https://github.com/google-antigravity/antigravity-cli/issues/581)).
> This extension handles that automatically; just make sure `agy` is up to date (`agy update`).

## Commands

| Command | Description |
|---------|-------------|
| `/agy-pi` | Show provider status and registered models |

## Installation

```bash
# From npm
pi install npm:agy-pi

# From repo (local)
pi -e ./extensions/agy-pi
```

Reload Pi (`/reload`) after installing.

## License

MIT
