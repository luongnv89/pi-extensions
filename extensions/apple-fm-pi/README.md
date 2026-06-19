# apple-fm-pi

Use **Apple Foundation Models** (`fm` CLI) in **Pi** — **`system`** and **`pcc`**.

## Default: absorbed fm-proxy (no extra Node server)

Pi tool schemas are **flattened inside the extension** (logic from [fm-proxy](https://github.com/gregbarbosa/fm-proxy), MIT) via `streamSimple` + `onPayload`. That fixes **400 Invalid tool definition** without running `fm-proxy.cjs`.

- Pi → **`http://127.0.0.1:1976/v1`** (`fm serve`) with in-process tool fix  
- Only **`fm serve`** is auto-started (background)

Optional **`APPLE_FM_PI_USE_PROXY=true`** restores the full HTTP proxy (`:1977` → `:1976`) for streaming retries, token repair, and CORS — not required for normal Pi agent use.

## PCC (503)

Background `fm serve` often breaks **PCC attribution**. For **`pcc`**:

```bash
/apple-fm-pi launch-terminal
```

Keep that Terminal open (foreground `fm serve` + optional proxy per `fm-launch.sh`).

## Install

```bash
cp -r extensions/apple-fm-pi ~/.pi/agent/extensions/
chmod +x ~/.pi/agent/extensions/apple-fm-pi/bin/fm-launch.sh
/reload
```

## Commands

| Command | Description |
|---------|-------------|
| `/apple-fm-pi start` | Start `fm serve` (and proxy only if `USE_PROXY=true`) |
| `/apple-fm-pi launch-terminal` | Foreground stack for PCC |
| `/apple-fm-pi test system` | Smoke test |
| `/apple-fm-pi status` | Ports and mode |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `APPLE_FM_PI_FM_PORT` | `1976` | `fm serve` |
| `APPLE_FM_PI_PROXY_PORT` | `1977` | Only when `USE_PROXY=true` |
| `APPLE_FM_PI_USE_PROXY` | `false` | Full HTTP fm-proxy instead of in-process fix |
| `APPLE_FM_PI_CONTEXT_WINDOW` | `131072` | Pi context budget |

## Verify

```bash
/apple-fm-pi start
pi -p --provider apple-fm --model system "Reply OK"
```

## Vendored proxy

`vendor/fm-proxy/fm-proxy.cjs` remains for `USE_PROXY=true` and `bin/fm-launch.sh`; default path does not run it.

MIT (extension). fm-proxy © Greg Barbosa — see `vendor/fm-proxy/LICENSE`.