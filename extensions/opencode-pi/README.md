# opencode-pi

`opencode-pi` registers an `opencode-cli` provider in Pi and delegates model calls to the local `opencode` CLI.

![opencode-pi screenshot](../../assets/opencode-pi.png)

![opencode-cli models in Pi model picker](../../assets/pi-opencode-cli-model-list.png)

![DeepSeek v4 flash free via opencode-cli](../../assets/pi-opencode-deepseek-4-flash.jpeg)

It is intended for the free OpenCode models that work without `opencode auth login`, such as:

- `opencode/deepseek-v4.1-flash-free`
- `opencode/glm-5.3-flash-free`
- `opencode/nemotron-3-ultra-free`
- `opencode/big-pickle`

The roster changes often — `/opencode-pi update` refreshes it from the running OpenCode CLI.

## Requirements

- Pi Coding Agent 0.75 or newer (including the 1.x line)
- OpenCode installed and available on the same machine:

```bash
opencode --version
opencode models
```

No OpenCode login is required for the bundled free OpenCode models.

When the extension loads it registers the models from the last discovery
(cached in Pi's agent directory under `cache/opencode-pi-models.json`) right
away, then probes `opencode --version` and refreshes the model list in the
background, so Pi's startup does not wait on OpenCode. Only the first start,
before any cache exists, waits for discovery. If the OpenCode CLI is missing,
Pi shows a warning naming the missing harness and the install steps
(https://opencode.ai). When `OPENCODE_PI_MODELS` is set, discovery is skipped
for speed — so a missing binary is only caught by this probe, and the warning
says so explicitly.

## Install

Published on npm: [`opencode-pi`](https://www.npmjs.com/package/opencode-pi). Use **Pi's package manager** (`pi install`), not `npm install` alone.

```bash
pi install npm:opencode-pi
pi install npm:opencode-pi@1.5.0   # pin version
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
pi --provider opencode-cli --model opencode/deepseek-v4.1-flash-free
```

Print-mode smoke test:

```bash
pi -p --provider opencode-cli --model opencode/deepseek-v4.1-flash-free "Reply with exactly OK"
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
| `OPENCODE_PI_STREAM` | Set to `0` to run OpenCode v1 turns through `opencode run` instead of streaming them through `opencode serve`. Has no effect on OpenCode v2, which never streams. |

Example:

```bash
OPENCODE_PI_MODELS="opencode/space-bunny-free,opencode/big-pickle" pi
```

## How it works

For each Pi model call, the extension:

1. Discovers model metadata from OpenCode's model API (`opencode api GET /api/model` on v2, `opencode models opencode --verbose` on v1, plain `opencode models` when no metadata is available). Free models are selected by zero input/output cost in that metadata (not by name), models whose status is not `active` are skipped, and each registered model reports its real cost.
2. Reuses one OpenCode project directory per Pi session (tracked by Pi's session ID) with a locked-down `pi-model` agent, instead of a fresh temporary directory per turn.
3. Denies OpenCode's own tools (`shell`, `edit`, web tools, subagents, etc.) in that agent, so file access and edits stay under Pi's tool pipeline.
4. Sends Pi's current prompt/context to OpenCode — the full transcript on the first turn, only the new transcript delta in the same OpenCode session on continuation turns so the provider serves cached prompt prefixes. On OpenCode v1 the turn goes to a shared `opencode serve` and streams (see [Streaming](#streaming-opencode-v1)); on OpenCode v2 it goes to `opencode run --format json` over stdin.
5. Writes user and tool-result images to temporary files and attaches them as file parts (one `--file` argument per image for `opencode run`) when the selected model advertises image input.
6. Enables `--thinking` for reasoning models, maps supported Pi reasoning levels to discovered OpenCode variants, and converts reasoning JSON events into Pi thinking blocks.
7. Converts marker-only `<pi_tool_call>{...}</pi_tool_call>` responses into real Pi tool calls, so Pi executes tools rather than OpenCode.

A continuation restarts as a fresh full-transcript session whenever the model, tool list, or system prompt changes, or the transcript no longer extends the previously sent prefix (for example after compaction). Any error, timeout, or abort also drops the session so the next turn starts fresh. Every turn is bounded by an unconditional internal timeout (3 minutes by default, or Pi's `timeoutMs` when supplied), and the abort listener is detached on every exit path.

### Streaming (OpenCode v1)

`opencode run --format json` only prints a text or reasoning part once that part is finished, so a long reply would appear in one piece at the end of the turn. On OpenCode v1 the extension instead starts one `opencode serve` per Pi process and streams OpenCode's `message.part.delta` events straight into Pi as text and thinking deltas.

- The server listens on `127.0.0.1` only, on a random port, behind a random per-process password. A small watchdog stops it when Pi's pipe closes, so a killed Pi does not leave it running, and it also stops after 10 idle minutes.
- Text that might start a `<pi_tool_call>` marker is held back until the marker is complete and parsed, so raw markers never stream into Pi. Plain prose streams as it arrives, and prose the model writes before a tool call stays visible ahead of the call.
- The bridge rejects OpenCode permission asks itself, exactly as a non-interactive `opencode run` does.
- If `opencode serve` cannot start, the turn (and later turns for that binary) falls back to `opencode run`. Set `OPENCODE_PI_STREAM=0` to always use `opencode run`.

OpenCode v2's server speaks a different API, and `opencode run` on v2 also buffers whole parts, so v2 turns do not stream.

The v1 bridge directories also disable OpenCode's `title` agent: OpenCode would otherwise spend a second request on the same model to title each new session, and on the free tier that request shares the rate limit with the turn.

### Pi 1.x transcripts

Pi 1.x hands providers a normalized transcript instead of the old context object: the system prompt and the tool declarations live in the transcript's leading system message, and `context.systemPrompt` / `context.tools` are empty. The extension reads both shapes, so the system prompt and the tool list reach the model on Pi 0.x and Pi 1.x alike, and the current-turn tool allowlist is the same set the model was shown. System messages are prompt scaffolding rather than conversation turns, so they are rendered as the `# Pi system prompt` section instead of being repeated in the transcript.

### OpenCode v2 agent rules

OpenCode v2 replaced the agent's `permission` map with an ordered `permissions` rule list, and the extension writes the matching definition for the installed CLI. Two details are deliberate:

- Normally every action is denied except an inert `read` rule, which keeps a tool declared for the free-tier gateway but is rejected non-interactively. When `MI_PI_ROLE` is `worker` or `ejecutor`, native OpenCode read, write, edit and shell plus external-directory access are allowed instead, so free-model executors can work with absolute paths. These native operations run inside OpenCode, **not** through Pi's tool pipeline or its tool hooks; other native actions remain denied. Pi tools can still be requested with markers. Use this mode only for trusted executor work.
- The child process receives `PWD` set to the project directory. OpenCode resolves its working directory from `PWD`, and spawning with a working directory alone does not update it, so without this the CLI loads the project config from the parent directory, never registers the bridge agent, and fails the turn with `Agent not found`.

Tool markers are treated as control syntax only inside `<pi_tool_call>` blocks. The parser accepts markers surrounded by model prose, whole-response JSON-quoted markers, common unambiguous closing-tag variants, and a complete JSON payload whose closing tag was omitted or garbled. Free models on OpenCode v2.1.1 often follow such a payload with an invented tool result, so everything after the payload up to the next marker is dropped from the display. It also narrowly repairs unescaped quotes inside JSON string values—a compatibility case seen when reasoning models generate shell commands—then applies the normal payload validation and current-tool allowlist. Truncated or ambiguous markers and other malformed arguments are never executed: valid sibling tool calls still run, unrecoverable marker text is stripped from the displayed response instead of failing the turn, and a corrective diagnostic is reported only when no marker payload could be salvaged or an unavailable tool was requested. Tool-call IDs are retained in the serialized transcript so later results can be matched correctly.

Outside executor mode, this keeps file access and edits under Pi's normal tool pipeline. Turns without a Pi session context run in an isolated temporary project whose directory and OpenCode session record are deleted when the turn finishes. Turns inside a Pi session share one project directory and OpenCode session until the session ends, when both are removed at teardown.

## Testing

Run the automated suite from this extension directory:

```bash
npm test
```

## Notes and limitations

- This is a CLI bridge, not a native provider API. On OpenCode v2 it is slower than direct HTTP providers because it starts `opencode run` for each model turn and replies arrive when each part finishes; OpenCode v1 turns stream through a shared `opencode serve` instead. Session reuse across turns keeps the provider's cached prompt prefix warm to reduce latency on free models.
- Tool calling is prompt-bridged. Marker payloads remain shape-validated and tool-allowlisted; the only leniency is prose extraction and narrow repair of unescaped quotes inside JSON strings. Native tool-call providers can still be more reliable.
- Image, reasoning, and cost support are advertised per model only when discovery reports those capabilities and cost. Models configured via `OPENCODE_PI_MODELS` start on conservative text-only, non-reasoning, zero-cost fallback metadata (no discovery call at startup) until `/opencode-pi update` runs discovery to enrich them; default (unconfigured) IDs fall back to the bundled free-model list the same way if discovery fails.
- OpenCode v2 removed the positional provider argument and the `--verbose` flag from `opencode models`, so discovery goes through the v2 HTTP API first and only falls back to the v1 calls for older installs. When only the plain ID list is available, models register with conservative fallback capabilities and are picked by the `-free` name pattern.
- OpenCode v2 renamed the agent's permission fields (`permission` → `permissions`, `bash` → `shell`, `task` → `subagent`), so the extension writes a dialect-specific definition. Non-executor definitions retain one inert `read` rule for the free-tier gateway; executor definitions allow native filesystem and shell tools as described above.
- A cold OpenCode service answers the first `opencode api` call with an empty model list while it warms up, so the API attempt retries once after a short delay before the extension falls back.
- Reasoning levels are exposed only for variants reported by OpenCode; models without variants do not claim selectable thinking levels.
- If OpenCode ever executes one of its own tools, the extension fails the turn instead of hiding it. A tool that OpenCode itself refused (the agent denies them, so they never run) is not a failure — the model gets the refusal and can retry with a Pi marker.
- Free-model access is an OpenCode-side policy: a model can be restricted (geo, account, or a paused free period) and then every request fails with OpenCode's own error. Pick another model from `/opencode-pi models` when that happens.

## Terms of service analysis

This extension uses the **subprocess-delegation pattern**: every model turn spawns the real `opencode` CLI binary (`opencode run`); it never reads OAuth tokens, session credentials, or auth files, and never calls any model backend over HTTP directly. The bundled default models are OpenCode's own **free models** that work without `opencode auth login` at all.

Checked against OpenCode's actual published terms ([Terms of Use](https://opencode.ai/legal/terms-of-service), eff. Aug 15, 2026, Anomaly Innovations):

| Provision | Source | How this extension relates |
|---|---|---|
| Open source CLI governed by its license, not these Terms | Terms of Use, preamble: "our open source software that is not provided to you on a hosted basis is subject to the open source license" | ✅ The `opencode` agent is MIT-licensed; running it as a subprocess of Pi is ordinary use of open-source software |
| No crawling/scraping the hosted Services | Terms of Use, restrictions §11 | ✅ Not applicable — the extension doesn't scrape anything |
| Third-Party Models carry their own terms | "What about Third Party Models?" section | ⚠️ If you configure authenticated providers inside OpenCode (Zen paid models, or BYO keys), those providers' own terms apply — API keys are unambiguous; routing consumer-subscription quotas through automated headless use is where providers draw the line |
| Free-model data collection | [OpenCode Zen docs](https://open-code.ai/en/docs/zen) | ℹ️ Not a compliance issue for the extension, but note: during their free period, Big Pickle, DeepSeek V4.1 Flash Free, GLM-5.3-Flash Free, MiMo-V2.6-Flash Free, Nemotron 3 Ultra Free and the other free models **may retain your prompts to improve the models** — don't send confidential data through them |

### Conclusion

**Safe — lowest-risk of the CLI-bridge extensions in this repo.** Real MIT-licensed binary subprocess, no credential extraction, no direct API calls, no subscription tokens involved. Two awareness items rather than risks: free Zen models may train on your inputs, and any *authenticated* provider configured inside OpenCode falls under that provider's terms instead.

*Last reviewed October 20, 2026 against opencode.ai/legal/terms-of-service (eff. Aug 15, 2026) and the OpenCode Console model catalog; terms may change.*
