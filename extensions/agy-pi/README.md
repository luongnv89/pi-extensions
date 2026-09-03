# agy-pi

Bridge [agy](https://github.com/google-antigravity/antigravity-cli) CLI Gemini models into Pi Coding Agent.

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

At session start the extension probes `agy --version`. If the agy CLI is
missing or unusable, Pi shows a warning telling you exactly which harness is
missing and how to install it; when the probe succeeds, models register as
usual. Set `AGY_PI_BIN` to point the probe at a non-`PATH` binary.

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

Every turn is bounded by a per-turn timeout: Pi's provided timeout is honored
when positive, otherwise an internal 180s bound applies so a turn never hangs
forever. A non-zero agy exit surfaces its stderr as an error; aborts and
timeouts stop with the corresponding stop reason.

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

## Terms of service analysis

This extension uses the **subprocess-delegation pattern**: every model turn spawns the real `agy` CLI binary (`agy --model <id> -p <prompt>`); it never reads OAuth tokens or session credentials itself, and never talks to any model backend over HTTP directly.

Checked against Google's actual published terms for Antigravity (the product behind the `agy` CLI):

| Provision | Source | How this extension relates |
|---|---|---|
| "Using third party software, tools, or services to access the Service … is a breach of this Agreement" | [Google Antigravity Additional Terms of Service](https://antigravity.google/terms), §6 — explicitly citing "using OpenClaw with Antigravity OAuth" as a breach | ⚠️ **Nuanced.** The extension itself is third-party software, but it does *not* use Antigravity OAuth tokens outside the CLI — it invokes the official `agy` binary, so authentication and all API access stay inside Google's own client. This is materially different from the OpenClaw example Google names. Still, Pi driving `agy` headlessly per turn is automated use of the Service through a wrapper, and Google's clause is written broadly enough that enforcement discretion is Google's. |
| Interaction data recording / training use | Same terms, §3 & §5 | ℹ️ Not a compliance issue for the extension, but your prompts sent through `agy` may be recorded and used by Google unless you change the data-use preference in settings. |
| Third-party/open-source models (incl. Anthropic) | Same terms, §8 — binds you to [Anthropic's Commercial Terms](https://www.anthropic.com/legal/commercial-terms) when selecting Claude models | ⚠️ If you pick Claude Sonnet through `agy`, Anthropic's commercial terms apply to that usage; ensure the credential behind it is an **API key**, not a consumer-subscription token routed outside its intended surface. |
| No abuse/interference with the Service | Same terms, §6 opening clause | ✅ The extension runs the unmodified binary with normal print mode; no spoofing, no credential extraction. |

### Conclusion

**Low risk for personal use, but not zero-risk.** Unlike token-extraction bridges, agy-pi keeps authentication inside Google's official binary — the pattern Google's §6 targets is reusing Antigravity OAuth in non-Google clients, which this extension does not do. However, Google's "third-party tools accessing the Service" language is broad, and scripted/headless `agy -p` driven by an external agent could still fall under it if Google chooses to enforce strictly. Safer paths for heavy automation: authenticate `agy` with an **API key** (Gemini Enterprise Agent Platform) rather than personal-account OAuth, and be aware prompts may be logged/trained on unless opted out.

*Last reviewed August 25, 2026 against antigravity.google/terms; terms may change.*

## License

MIT
