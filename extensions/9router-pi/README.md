# 9router-pi

Use models exposed by a local **9router** OpenAI-compatible gateway in Pi Coding Agent. The extension discovers the gateway's current model list from `/v1/models`, including model limits, vision support, and reasoning capability.

## What it provides

- Pi provider: `9router`
- Dynamic discovery at startup
- `/9router-pi refresh` to fetch the latest catalog without restarting Pi
- `/9router-pi status` and `/9router-pi help`
- Static `models.json` entries remain usable when startup discovery is unavailable or `PI_OFFLINE` is set

## Prerequisites

1. A 9router instance running at `http://localhost:20128/v1` (or another configured URL).
2. Pi API-key configuration for provider `9router`.

The discovery endpoint is currently queried without authentication. The API key is used for model requests through Pi.

## Configuration

Add the provider credentials to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "9router": {
      "baseUrl": "http://localhost:20128/v1",
      "api": "openai-completions",
      "apiKey": "$NINE_ROUTER_API_KEY"
    }
  }
}
```

Pi also supports a literal `apiKey`. Do not commit real keys to this repository.

Optional environment variables:

- `PI_9ROUTER_BASE_URL` — overrides the `models.json` gateway URL and default.
- `NINE_ROUTER_API_KEY` — supplies the request key and overrides the `models.json` key when set.

## Install from this repository

From the repository root:

```bash
pi -e ./extensions/9router-pi
```

Or install it persistently:

```bash
pi install -l ./extensions/9router-pi
```

Then run `/reload` in Pi (or restart it).

## Usage

List discovered models:

```bash
pi --list-models 9router
```

Select a model:

```bash
pi --provider 9router --model openrouter/stealth/ox-alpha
```

Refresh after changing the models enabled by 9router:

```text
/9router-pi refresh
```

Use `/9router-pi status` to see the discovery count and last error, if any.

## Development

```bash
cd extensions/9router-pi
npm install
npm test
```

The extension uses Pi's `openai-completions` API adapter and registers models returned by the gateway. The repository intentionally contains no API keys.

## License

MIT — same as [pi-extensions](https://github.com/luongnv89/pi-extensions).
