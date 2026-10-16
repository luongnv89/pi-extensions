# opencode-pi

`opencode-pi` registers an `opencode-cli` provider in Pi and delegates model calls to the local `opencode` CLI.

![opencode-pi screenshot](../../assets/opencode-pi.png)

![opencode-cli models in Pi model picker](../../assets/pi-opencode-cli-model-list.png)

![DeepSeek v4 flash free via opencode-cli](../../assets/pi-opencode-deepseek-4-flash.jpeg)

It is intended for the free OpenCode models that work without `opencode auth login`, such as:

- `opencode/deepseek-v4-flash-free`
- `opencode/mimo-v2.5-free`
- `opencode/nemotron-3-super-free`
- `opencode/big-pickle`

## Requirements

- Pi Coding Agent 1.3 or newer
- OpenCode installed and available on the same machine:

```bash
opencode --version
opencode models
```

No OpenCode login is required for the bundled free OpenCode models.

At session start the extension probes `opencode --version`. If the OpenCode
CLI is missing, Pi shows a warning naming the missing harness and the install
steps (https://opencode.ai). When `OPENCODE_PI_MODELS` is set, discovery is
skipped for speed — so a missing binary is only caught by this probe, and the
warning says so explicitly. When the probe succeeds, models register as usual.

## Install

Published on npm: [`opencode-pi`](https://www.npmjs.com/package/opencode-pi). Use **Pi's package manager** (`pi install`), not `npm install` alone.

```bash
pi install npm:opencode-pi
pi install npm:opencode-pi@1.4.0   # pin version
pi install -l npm:opencode-pi      # project-local (.pi/settings.json)
pi -e npm:opencode-pi                # one session, no install
```

Then run `/reload` in Pi (or restart).

```bash
pi list
pi update npm:opencode-pi
pi remove npm:opencode-pi
```

**From [pi-extensions](https://github.com/luongnv89/pi-extensions) (git):**

```bash
cp -r extensions/opencode-pi ~/.pi/agent/extensions/
# or from repo root: npm run install-extensions
```

## Usage

Pick the provider from `/model`, or start Pi directly:

```bash
pi --provider opencode-cli --model opencode/deepseek-v4-flash-free
```

Print-mode smoke test:

```bash
pi -p --provider opencode-cli --model opencode/deepseek-v4-flash-free "Reply with exactly OK"
```

Commands:

```text
/opencode-pi            — read-only TUI status/config menu (TUI only)
/opencode-pi status
/opencode-pi models
/opencode-pi test
/opencode-pi update
/opencode-pi help
```

In the interactive TUI, bare `/opencode-pi` uses `ctx.ui.select` to show cached status, environment-variable presence, and registered model counts (IDs stay hidden). Detail views show one short display segment per page (long records continue without losing text); `Previous`/`Next` navigate between segments and `Back` returns to the sections. `Close` or cancellation performs no CLI calls, discovery, refresh, authentication, persistence, or writes. Environment values, paths, credentials, and unsafe model strings are not displayed. Credentials stay in the external CLI/environment, and model-file configuration stays external; this menu has no editable provider settings. Outside the TUI, bare `/opencode-pi` keeps the existing status behavior; `/opencode-pi update` remains the explicit model-refresh command.

### Refreshing the model list

OpenCode changes its free model roster frequently. Refresh the registered models at runtime:

```text
/opencode-pi update
```

This queries OpenCode for model metadata (`opencode api GET /api/model` on OpenCode v2, `opencode models opencode --verbose` on v1, plain `opencode models` as a last resort), parses each model's capabilities and limits, updates the provider's model list, and shows how many new models were added. Pi receives the discovered display name, reasoning and image capabilities, context window, and output limit. The status command also displays the timestamp of the last discovery.

## Configuration

| Environment variable | Description                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `OPENCODE_PI_BIN`    | Override the OpenCode executable path. Defaults to `opencode`.                                      |
| `OPENCODE_PI_MODELS` | Comma- or space-separated model list to register. Values without `/` are prefixed with `opencode/`. Registers immediately with conservative fallback metadata (skipping discovery so startup never pays a discovery timeout); run `/opencode-pi update` to enrich these models with real capabilities and cost from discovery. |

Example:

```bash
OPENCODE_PI_MODELS="opencode/space-bunny-free,opencode/big-pickle" pi
```

## How it works

For each Pi model call, the extension:

1. Discovers model metadata from OpenCode's model API (`opencode api GET /api/model` on v2, `opencode models opencode --verbose` on v1, plain `opencode models` when no metadata is available). Free models are selected by zero input/output cost in that metadata (not by name), models whose status is not `active` are skipped, and each registered model reports its real cost.
2. Reuses one OpenCode project directory per Pi session (tracked by Pi's session ID) with a locked-down `pi-model` agent, instead of a fresh temporary directory per turn.
3. Declares Pi's tools to OpenCode as custom tools in that directory's `.opencode/tools/`, with the same names, descriptions, and argument schemas. The model calls them through its native tool calling. Each one only asks for a permission that the extension rejects, which ends OpenCode's step without running anything, and the extension turns the finished tool call into a Pi tool call.
4. Sends Pi's current prompt/context to a shared `opencode serve` process that the extension starts on first use and stops after 10 idle minutes or when Pi exits. The first turn sends the full transcript; continuation turns send only the new transcript delta to the same OpenCode session so the provider serves cached prompt prefixes. Text and thinking stream into Pi as the model writes them. OpenCode v2 serves a different API, so on v2 each turn runs `opencode run --standalone --format json` instead, and replies arrive once each part is finished.
5. Writes user and tool-result images to temporary files and adds one `--file` argument per image when the selected model advertises image input.
6. Enables `--thinking` for reasoning models, maps supported Pi reasoning levels to discovered OpenCode variants, and converts reasoning JSON events into Pi thinking blocks.
7. Replaces every OpenCode built-in tool the agent can reach with a stub that only returns "unavailable". A `read` stub is always declared, because OpenCode's free tier rejects requests without a tool named `read`.

A continuation restarts as a fresh full-transcript session whenever the model, tool list, or system prompt changes, or the transcript no longer extends the previously sent prefix (for example after compaction). Any error, timeout, or abort also drops the session so the next turn starts fresh. Every turn is bounded by an unconditional internal timeout (3 minutes by default, or Pi's `timeoutMs` when supplied), and the abort listener is detached on every exit path.

This keeps file access and edits under Pi's normal tool pipeline. Turns without a Pi session context run in an isolated temporary project whose directory and OpenCode session record are deleted when the turn finishes. Turns inside a Pi session share one project directory and OpenCode session until the session ends, when both are removed at teardown.

## Testing

Run the automated suite from this extension directory:

```bash
npm test
```

## Notes and limitations

- This is a bridge to the local OpenCode server, not a native provider API. Session reuse across turns keeps the provider's cached prompt prefix warm to reduce latency on free models. On OpenCode v2, every turn starts `opencode run`, and replies do not stream.
- OpenCode marks every custom-tool argument as required, so optional Pi arguments are declared nullable and null values are dropped before Pi runs the tool.
- Image, reasoning, and cost support are advertised per model only when discovery reports those capabilities and cost. Models configured via `OPENCODE_PI_MODELS` start on conservative text-only, non-reasoning, zero-cost fallback metadata (no discovery call at startup) until `/opencode-pi update` runs discovery to enrich them; default (unconfigured) IDs fall back to the bundled free-model list the same way if discovery fails.
- OpenCode v2 removed the positional provider argument and the `--verbose` flag from `opencode models`, so discovery goes through the v2 HTTP API first and only falls back to the v1 calls for older installs. When only the plain ID list is available, models register with conservative fallback capabilities and are picked by the `-free` name pattern.
- OpenCode v2 does not load custom tools, so on v2 the model only sees OpenCode's built-in tools. The bridge makes every one of them ask for permission, so OpenCode runs none of them, and passes calls to `read`, `write`, and `shell` (as `bash`) on to Pi when Pi has that tool. Pi's other tools are not available on v2.
- A cold OpenCode service answers the first `opencode api` call with an empty model list while it warms up, so the API attempt retries once after a short delay before the extension falls back.
- Reasoning levels are exposed only for variants reported by OpenCode; models without variants do not claim selectable thinking levels.

## Terms of service analysis

This extension uses the **subprocess-delegation pattern**: every model turn goes through the real `opencode` CLI binary (a local `opencode serve`, or `opencode run` on v2); it never reads OAuth tokens, session credentials, or auth files, and never calls any model backend over HTTP directly. The bundled default models are OpenCode's own **free models** that work without `opencode auth login` at all.

Checked against OpenCode's actual published terms ([Terms of Use](https://opencode.ai/legal/terms-of-service), eff. Aug 15, 2026, Anomaly Innovations):

| Provision | Source | How this extension relates |
|---|---|---|
| Open source CLI governed by its license, not these Terms | Terms of Use, preamble: "our open source software that is not provided to you on a hosted basis is subject to the open source license" | ✅ The `opencode` agent is MIT-licensed; running it as a subprocess of Pi is ordinary use of open-source software |
| No crawling/scraping the hosted Services | Terms of Use, restrictions §11 | ✅ Not applicable — the extension doesn't scrape anything |
| Third-Party Models carry their own terms | "What about Third Party Models?" section | ⚠️ If you configure authenticated providers inside OpenCode (Zen paid models, or BYO keys), those providers' own terms apply — API keys are unambiguous; routing consumer-subscription quotas through automated headless use is where providers draw the line |
| Free-model data collection | [OpenCode Zen docs](https://open-code.ai/en/docs/zen) | ℹ️ Not a compliance issue for the extension, but note: during their free period, Big Pickle, DeepSeek V4 Flash Free, MiMo-V2.5 Free and North Mini Code Free **may retain your prompts to improve the models** — don't send confidential data through them |

### Conclusion

**Safe — lowest-risk of the CLI-bridge extensions in this repo.** Real MIT-licensed binary subprocess, no credential extraction, no direct API calls, no subscription tokens involved. Two awareness items rather than risks: free Zen models may train on your inputs, and any *authenticated* provider configured inside OpenCode falls under that provider's terms instead.

*Last reviewed August 25, 2026 against opencode.ai/legal/terms-of-service (eff. Aug 15, 2026); terms may change.*
