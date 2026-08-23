# grok-pi

Use **Grok CLI session models** inside **Pi Coding Agent** — including **Grok 4.6**, **Grok 4.5**, **Composer 2.5** (`grok-composer-2.5-fast`), and **Grok Build** (`grok-build`). Reasoning models expose Pi thinking levels (`Shift+Tab`, `/settings`, `--thinking`).

![grok-pi screenshot](../../assets/grok-pi.png)

![Composer 2.5 fast — response speed in footer](../../assets/composer-2.5-170-tok-s.png)

This extension registers a Pi provider named `grok-cli` that talks to the same backend the Grok CLI uses (`cli-chat-proxy.grok.com`), reusing your existing `~/.grok/auth.json` login. It is **not** the official xAI API-key provider (`xai` / `XAI_API_KEY`).

## What you get

| Pi provider | Pi model id | Grok name (typical) | Thinking levels |
|-------------|-------------|---------------------|-----------------|
| `grok-cli` | `grok-4.6` | Grok 4.6 | `low`, `medium`, `high`, `xhigh` |
| `grok-cli` | `grok-4.5` | Grok 4.5 | `low`, `medium`, `high` |
| `grok-cli` | `grok-composer-2.5-fast` | Composer 2.5 | off (no reasoning menu) |
| `grok-cli` | `grok-build` | Grok Build | off unless the CLI cache advertises efforts |

Models are read from `~/.grok/models_cache.json` when present; otherwise the extension ships safe defaults. Thinking levels come from each cache entry's `reasoning_efforts` (same menu as Grok `/effort`).

## Prerequisites

1. **Pi Coding Agent** installed (`pi` on your `PATH`).
2. **Grok CLI** installed and on your `PATH` (`grok --version`).
3. Network access to `https://cli-chat-proxy.grok.com` and `https://auth.x.ai`.

At session start the extension checks both prerequisites and tells you which
one is missing: a warning naming the **Grok CLI install** (with
https://x.ai/grok) when `~/.grok` does not exist, or a warning to run
**`grok login`** when only auth is missing. `/grok-pi status` shows a combined
`Ready:` line reflecting both checks. When everything is present, models
register normally.

## Install

Published on npm: [`grok-pi`](https://www.npmjs.com/package/grok-pi). Use **Pi's package manager** (`pi install`), not `npm install` alone.

```bash
pi install npm:grok-pi
pi install npm:grok-pi@1.0.0   # pin version
pi install -l npm:grok-pi      # project-local (.pi/settings.json)
pi -e npm:grok-pi              # one session, no install
```

Then run `/reload` in Pi (or restart).

```bash
pi list
pi update npm:grok-pi
pi remove npm:grok-pi
```

**From [pi-extensions](https://github.com/luongnv89/pi-extensions) (git):**

```bash
git clone https://github.com/luongnv89/pi-extensions.git ~/.pi/pi-extensions
cp -r ~/.pi/pi-extensions/extensions/grok-pi ~/.pi/agent/extensions/
chmod 700 ~/.pi/agent/extensions/grok-pi/bin/*
```

Full collection:

```bash
curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash -s -- --auto
```

**After install**

1. Run **`/reload`** (or restart Pi).
2. Confirm models: `pi --list-models | rg grok-cli`

You should see the models from your Grok CLI cache, typically:

```text
grok-cli        grok-4.6
grok-cli        grok-4.5
```

## Step-by-step: authenticate

Authentication is **Grok CLI’s** session, not a separate Pi API key.

### 1. Log in with Grok CLI (first time or expired token)

```bash
grok login
```

This opens the browser (or your configured auth flow) and writes credentials to:

```text
~/.grok/auth.json
```

Tokens are refreshed automatically by the extension’s `bin/grok-api-key` helper when Pi needs them.

### 2. Verify Grok CLI works

```bash
grok -m grok-4.6 -p 'Reply with exactly: OK' --max-turns 1
```

Expected: `OK`

### 3. Verify auth file exists

```bash
test -f ~/.grok/auth.json && echo "auth ok"
```

### 4. Start Pi and check extension notice

```bash
pi
```

On session start you should see an info notification that `grok-cli` was registered. If auth is missing, you get a warning to run `grok login`.

### Troubleshooting auth

| Symptom | What to do |
|---------|------------|
| `grok-pi: Grok CLI not found (~/.grok missing)` | Install Grok CLI (https://x.ai/grok), then `/reload` |
| `grok-pi: Grok CLI is installed but ~/.grok/auth.json is missing` | Run `grok login`, then `/reload` |
| Proxy says CLI version outdated | Update Grok: `grok update` or reinstall Grok CLI |
| `grok-api-key: ... run grok login` | Re-authenticate with `grok login` |
| Models missing in Pi | `/reload`, then `pi --list-models grok` |

Inside Pi:

```text
/grok-pi status
/grok-pi help
```

## Step-by-step: use Grok models in Pi

### Interactive Pi (TUI)

1. Start Pi in your project:

   ```bash
   cd /path/to/your/repo
   pi
   ```

2. Open the model picker: **`Ctrl+L`** or type **`/model`**.

3. Choose provider **`grok-cli`** and a model such as **`grok-4.6`**.

4. Chat as usual; Pi tools (`read`, `bash`, `edit`, `write`, etc.) work with the selected model.

### Non-interactive one-shot

```bash
pi -p --provider grok-cli --model grok-4.6 "Summarize this repo in 3 bullets"
```

### CLI flags on startup

```bash
pi --provider grok-cli --model grok-4.6
```

Provider-prefixed model shorthand also works:

```bash
pi --model grok-cli/grok-4.6
```

### Thinking levels

For Grok models that advertise `supports_reasoning_effort`, Pi’s thinking selector is enabled. Cycle with **`Shift+Tab`**, pick a level in **`/settings`**, or start with `--thinking`:

```bash
pi --provider grok-cli --model grok-4.6 --thinking high
pi --model grok-cli/grok-4.6:high
```

| Pi thinking | Sent to Grok CLI proxy |
|-------------|------------------------|
| `low` / `medium` / `high` | same effort id |
| `xhigh` | `xhigh` when the model lists it (Grok 4.6) |
| `off` / `minimal` / `max` | hidden unless the CLI cache advertises them |

The extension maps Grok’s `reasoning_efforts` into Pi `thinkingLevelMap`. Levels the current model does not list are hidden, matching `/effort` in Grok CLI.

### Switch to Grok Build

```bash
pi --provider grok-cli --model grok-build
```

Or select `grok-build` in `/model`.

### Quick smoke test (minimal tools)

```bash
pi -p --no-session \
  --provider grok-cli \
  --model grok-4.6 \
  --thinking medium \
  "Reply with exactly OK"
```

## How it works (technical)

The extension calls `pi.registerProvider("grok-cli", …)` with:

- **API:** `openai-responses` (matches Grok’s `api_backend: responses` for these models)
- **Base URL:** `https://cli-chat-proxy.grok.com/v1`
- **API key:** shell command `!…/grok-api-key` (reads/refreshes `~/.grok/auth.json`)
- **Required proxy headers** (same family as Grok CLI):
  - `Authorization: Bearer <token>`
  - `X-XAI-Token-Auth: xai-grok-cli`
  - `x-grok-client-version: <from ~/.grok/version.json>`
  - `User-Agent: xai-grok-workspace/<version>`
  - Per model: `x-grok-model-override: <model-id>`

Grok 4.6 / 4.5 register with `reasoning: true` and a per-model `thinkingLevelMap` so Pi can send `reasoning.effort` on the Responses API. Composer 2.5 in older Grok configs is the model id **`grok-composer-2.5-fast`**, not `composer-2.5` alone.

## Files in this extension

```text
extensions/grok-pi/
├── bin/
│   ├── grok-api-key          # token + refresh for Pi apiKey command
│   ├── grok-client-version   # x-grok-client-version header value
│   ├── grok-user-agent       # User-Agent header value
│   └── grok-usage            # JSON subscription usage helper
├── src/index.ts              # registers grok-cli provider + /grok-pi command
├── src/models.ts             # cache catalog + thinking-level mapping
├── src/usage.ts              # /grok-pi usage card (product allowance bank)
├── package.json
└── README.md
```

## Commands

| Command | Description |
|---------|-------------|
| `/grok-pi` or `/grok-pi status` | Provider URL, auth presence, model list |
| `/grok-pi models` | List models registered from cache/defaults |
| `/grok-pi test` | Print a one-line smoke-test command |
| `/grok-pi usage` | Show a compact terminal usage card: fetched time, subscription tier, credit usage, per-product reset allowances, and period |
| `/grok-pi help` | Short usage |

The usage command delegates to the standalone helper:

```bash
extensions/grok-pi/bin/grok-usage --pretty
```

It fetches `https://cli-chat-proxy.grok.com/v1/billing?format=credits` (same session as Grok CLI) so the card can show the product allowance bank (`GrokBuild`, `GrokChat`, …). If that API is unavailable, it falls back to starting Grok in a pseudo-terminal and reading `~/.grok/logs/unified.jsonl`. Run the helper directly when you need the raw JSON.

## Official xAI API vs this bridge

| Approach | Provider in Pi | Auth |
|----------|----------------|------|
| **grok-pi (this extension)** | `grok-cli` | `grok login` → `~/.grok/auth.json` |
| **Built-in xAI** | `xai` | `XAI_API_KEY` or Pi `/login` for xAI |

Use **grok-pi** when you want the same **Grok 4.6 / 4.5 / Composer / Build** session models your Grok CLI already uses, including `/effort` thinking levels. Use **xAI** when you have a console API key and want Pi’s stock `grok-*` catalog from `api.x.ai`.

## License

MIT — same as [pi-extensions](https://github.com/luongnv89/pi-extensions).