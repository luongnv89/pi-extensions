# grok-pi

Use **Grok CLI session models** inside **Pi Coding Agent** — including **Composer 2.5** (`grok-composer-2.5-fast`) and **Grok Build** (`grok-build`).

This extension registers a Pi provider named `grok-cli` that talks to the same backend the Grok CLI uses (`cli-chat-proxy.grok.com`), reusing your existing `~/.grok/auth.json` login. It is **not** the official xAI API-key provider (`xai` / `XAI_API_KEY`).

## What you get

| Pi provider | Pi model id | Grok name (typical) |
|-------------|-------------|---------------------|
| `grok-cli` | `grok-composer-2.5-fast` | Composer 2.5 |
| `grok-cli` | `grok-build` | Grok Build |

Models are read from `~/.grok/models_cache.json` when present; otherwise the extension ships safe defaults matching a standard Grok CLI install.

## Prerequisites

1. **Pi Coding Agent** installed (`pi` on your `PATH`).
2. **Grok CLI** installed and on your `PATH` (`grok --version`).
3. Network access to `https://cli-chat-proxy.grok.com` and `https://auth.x.ai`.

## Step-by-step: install

### Option A — install with the pi-extensions repo (recommended)

From your machine:

```bash
# 1) Clone or update the extensions repo
git clone https://github.com/luongnv89/pi-extensions.git ~/.pi/pi-extensions
# or: cd ~/.pi/pi-extensions && git pull

# 2) Copy only grok-pi into Pi’s extension directory
mkdir -p ~/.pi/agent/extensions
cp -r ~/.pi/pi-extensions/extensions/grok-pi ~/.pi/agent/extensions/

# 3) Ensure helper scripts are executable
chmod 700 ~/.pi/agent/extensions/grok-pi/bin/*
```

### Option B — install everything from pi-extensions

```bash
curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash -s -- --auto
```

That installs **all** extensions in this repo (including `grok-pi` once it is merged/published).

### Option C — one-off test without copying

```bash
pi -e ~/.pi/pi-extensions/extensions/grok-pi/src/index.ts
```

### After install

1. Start Pi (or restart if it is already running).
2. Run **`/reload`** so Pi picks up the new extension.
3. Confirm models: `pi --list-models | rg grok-cli`

You should see at least:

```text
grok-cli        grok-composer-2.5-fast
grok-cli        grok-build
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
grok -m grok-composer-2.5-fast -p 'Reply with exactly: OK' --max-turns 1
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
| `grok-pi: no ~/.grok/auth.json` | Run `grok login`, then `/reload` |
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

3. Choose provider **`grok-cli`** and model **`grok-composer-2.5-fast`** (Composer 2.5).

4. Chat as usual; Pi tools (`read`, `bash`, `edit`, `write`, etc.) work with the selected model.

### Non-interactive one-shot

```bash
pi -p --provider grok-cli --model grok-composer-2.5-fast "Summarize this repo in 3 bullets"
```

### CLI flags on startup

```bash
pi --provider grok-cli --model grok-composer-2.5-fast
```

Provider-prefixed model shorthand also works:

```bash
pi --model grok-cli/grok-composer-2.5-fast
```

### Switch to Grok Build

```bash
pi --provider grok-cli --model grok-build
```

Or select `grok-build` in `/model`.

### Quick smoke test (minimal tools)

```bash
pi -p --no-session \
  --provider grok-cli \
  --model grok-composer-2.5-fast \
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

Composer 2.5 in Grok config is the model id **`grok-composer-2.5-fast`**, not `composer-2.5` alone.

## Files in this extension

```text
extensions/grok-pi/
├── bin/
│   ├── grok-api-key          # token + refresh for Pi apiKey command
│   ├── grok-client-version   # x-grok-client-version header value
│   └── grok-user-agent       # User-Agent header value
├── src/index.ts              # registers grok-cli provider + /grok-pi command
├── package.json
└── README.md
```

## Commands

| Command | Description |
|---------|-------------|
| `/grok-pi` or `/grok-pi status` | Provider URL, auth presence, model list |
| `/grok-pi models` | List models registered from cache/defaults |
| `/grok-pi test` | Print a one-line smoke-test command |
| `/grok-pi help` | Short usage |

## Official xAI API vs this bridge

| Approach | Provider in Pi | Auth |
|----------|----------------|------|
| **grok-pi (this extension)** | `grok-cli` | `grok login` → `~/.grok/auth.json` |
| **Built-in xAI** | `xai` | `XAI_API_KEY` or Pi `/login` for xAI |

Use **grok-pi** when you want the same **Composer 2.5 / Grok Build** models your Grok CLI already uses. Use **xAI** when you have a console API key and want Pi’s stock `grok-*` catalog from `api.x.ai`.

## License

MIT — same as [pi-extensions](https://github.com/luongnv89/pi-extensions).