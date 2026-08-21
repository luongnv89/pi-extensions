# agy-pi

Bridge [agy](https://github.com/earendil-works/agy) CLI Gemini models into Pi Coding Agent.

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
| `AGY_PI_MODELS` | Comma-separated list of model IDs to register (e.g. `gemini-3.6-flash-high,gpt-oss-120b-medium`) |

## Usage

After installation, select the `agy` provider from Pi's model selector (`/model` or `Ctrl+M`).

Models are auto-discovered from `agy models` output. To force re-discovery:

```
/agy-pi
```

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
