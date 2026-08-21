# hermes-pi

Bridge [Hermes Agent](https://github.com/NousResearch/hermes-agent) free models into Pi Coding Agent via the `hermes` CLI tool.

## What it does

Registers a `hermes` provider in Pi that exposes free inference models powered by Nous Portal. No API keys required — just authenticate with Nous Portal.

## Prerequisites

- **hermes** installed and available on `PATH`
  ```bash
  # Install hermes
  pip install hermes-agent
  # or: pipx install hermes-agent
  ```
- Nous Portal account (free) — authenticate with:
  ```bash
  hermes login
  ```

## Configuration

| Environment Variable | Description |
|---------------------|-------------|
| `HERMES_PI_BIN` | Override the hermes binary path (default: `hermes`) |
| `HERMES_PI_MODELS` | Comma-separated list of model IDs to register (e.g. `nousresearch/hermes3-llama-3.4-12b,meta-llama/llama-3.3-70b-instruct`) |

## Usage

After installation, select the `hermes` provider from Pi's model selector (`/model` or `Ctrl+M`).

Available models are loaded from bundled defaults and your hermes configuration. To force re-discovery:

```
/hermes-pi
```

## Commands

| Command | Description |
|---------|-------------|
| `/hermes-pi` | Show provider status and registered models |

## Bundled Models

| Model | Context | Description |
|-------|---------|-------------|
| `nousresearch/hermes3-llama-3.4-12b` | 128K | Hermes 3 with Llama 3.4 12B |
| `nousresearch/hermes3-llama-3.2-8b` | 128K | Hermes 3 with Llama 3.2 8B |
| `meta-llama/llama-3.3-70b-instruct` | 128K | Llama 3.3 70B Instruct |
| `qwen/qwen2.5-coder-32b-instruct` | 32K | Qwen 2.5 Coder 32B |
| `microsoft/phi-4` | 16K | Microsoft Phi-4 |
| `mistralai/mistral-large-2-instruct` | 128K | Mistral Large 2 |

## Installation

```bash
# From npm
pi install npm:hermes-pi

# From repo (local)
pi -e ./extensions/hermes-pi
```

Reload Pi (`/reload`) after installing.

## License

MIT
