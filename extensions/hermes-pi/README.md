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
| `HERMES_PI_PROVIDER` | Provider passed to the hermes CLI (default: `nous`) |
| `HERMES_PI_MODELS` | Comma-separated list of model IDs to register (e.g. `tencent/hy3:free,stepfun/step-3.7-flash:free`) |

## Usage

After installation, select the `hermes` provider from Pi's model selector (`/model` or `Ctrl+M`).

Models are registered synchronously at startup from bundled defaults (or `HERMES_PI_MODELS`). To pick up the current free tier from the hermes CLI cache:

```
/hermes-pi update
/reload
```

## Commands

| Command | Description |
|---------|-------------|
| `/hermes-pi` | Show provider status and registered models |
| `/hermes-pi models` | List registered model IDs |
| `/hermes-pi test` | Print a ready-to-run smoke-test command |
| `/hermes-pi update` | Re-discover free models from the hermes CLI cache |
| `/hermes-pi help` | Show help |

## Bundled Models

Free-tier models on the Nous Portal. `/hermes-pi update` refreshes this list from `~/.hermes/provider_models_cache.json`.

| Model | Context |
|-------|---------|
| `upstage/solar-pro4:free` | 128K |
| `meituan/longcat-2.0:free` | 128K |
| `tencent/hy3:free` | 128K |
| `poolside/laguna-s-2.1:free` | 128K |
| `stepfun/step-3.7-flash:free` | 128K |
| `poolside/laguna-xs-2.1:free` | 128K |

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
