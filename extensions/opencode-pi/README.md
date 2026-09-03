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

- Pi Coding Agent
- OpenCode installed and available on the same machine:

```bash
opencode --version
opencode models opencode --verbose
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
pi install npm:opencode-pi@1.1.0   # pin version
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
/opencode-pi status
/opencode-pi models
/opencode-pi test
/opencode-pi update
/opencode-pi help
```

### Refreshing the model list

OpenCode changes its free model roster frequently. Refresh the registered models at runtime:

```text
/opencode-pi update
```

This queries `opencode models opencode --verbose`, parses each model's capabilities and limits, updates the provider's model list, and shows how many new models were added. Pi receives the discovered display name, reasoning and image capabilities, context window, and output limit. The status command also displays the timestamp of the last discovery.

## Configuration

| Environment variable | Description                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `OPENCODE_PI_BIN`    | Override the OpenCode executable path. Defaults to `opencode`.                                      |
| `OPENCODE_PI_MODELS` | Comma- or space-separated model list to register. Values without `/` are prefixed with `opencode/`. Registers immediately with conservative fallback metadata (skipping verbose discovery so startup never pays a discovery timeout); run `/opencode-pi update` to enrich these models with real capabilities and cost from verbose discovery. |

Example:

```bash
OPENCODE_PI_MODELS="opencode/mimo-v2.5-free,opencode/big-pickle" pi
```

## How it works

For each Pi model call, the extension:

1. Discovers model metadata from the ID/JSON pairs printed by `opencode models opencode --verbose`. Free models are selected by zero input/output cost in that metadata (not by name), models whose status is not `active` are skipped, and each registered model reports its real cost.
2. Reuses one OpenCode project directory per Pi session (tracked by Pi's session ID) with a locked-down `pi-model` agent, instead of a fresh temporary directory per turn.
3. Denies OpenCode's own tools (`bash`, `edit`, `read`, web tools, subagents, etc.).
4. Sends Pi's current prompt/context to `opencode run --format json` over stdin — the full transcript on the first turn, only the new transcript delta with `--session` on continuation turns so the provider serves cached prompt prefixes.
5. Writes user and tool-result images to temporary files and adds one `--file` argument per image when the selected model advertises image input.
6. Enables `--thinking` for reasoning models, maps supported Pi reasoning levels to discovered OpenCode variants, and converts reasoning JSON events into Pi thinking blocks.
7. Converts marker-only `<pi_tool_call>{...}</pi_tool_call>` responses into real Pi tool calls, so Pi executes tools rather than OpenCode.

A continuation restarts as a fresh full-transcript session whenever the model, tool list, or system prompt changes, or the transcript no longer extends the previously sent prefix (for example after compaction). Any error, timeout, or abort also drops the session so the next turn starts fresh. Every turn is bounded by an unconditional internal timeout (3 minutes by default, or Pi's `timeoutMs` when supplied), and the abort listener is detached on every exit path.

Tool markers are treated as control syntax only inside `<pi_tool_call>` blocks. The parser accepts markers surrounded by model prose, whole-response JSON-quoted markers, common unambiguous closing-tag variants, and a complete JSON payload whose closing tag was omitted. It also narrowly repairs unescaped quotes inside JSON string values—a compatibility case seen when reasoning models generate shell commands—then applies the normal payload validation and current-tool allowlist. Truncated or ambiguous markers and other malformed arguments are never executed: valid sibling tool calls still run, unrecoverable marker text is stripped from the displayed response instead of failing the turn, and a corrective diagnostic is reported only when no marker payload could be salvaged or an unavailable tool was requested. Tool-call IDs are retained in the serialized transcript so later results can be matched correctly.

This keeps file access and edits under Pi's normal tool pipeline. Turns without a Pi session context run in an isolated temporary project whose directory and OpenCode session record are deleted when the turn finishes. Turns inside a Pi session share one project directory and OpenCode session until the session ends, when both are removed at teardown.

## Testing

Run the automated suite from this extension directory:

```bash
npm test
```

## Notes and limitations

- This is a CLI bridge, not a native provider API. It is slower than direct HTTP providers because it starts `opencode run` for each model turn; session reuse across turns keeps the provider's cached prompt prefix warm to reduce latency on free models.
- Tool calling is prompt-bridged. Marker payloads remain shape-validated and tool-allowlisted; the only leniency is prose extraction and narrow repair of unescaped quotes inside JSON strings. Native tool-call providers can still be more reliable.
- Image, reasoning, and cost support are advertised per model only when verbose discovery reports those capabilities and cost. Models configured via `OPENCODE_PI_MODELS` start on conservative text-only, non-reasoning, zero-cost fallback metadata (no discovery call at startup) until `/opencode-pi update` runs discovery to enrich them; default (unconfigured) IDs fall back to the bundled free-model list the same way if discovery fails.
- Reasoning levels are exposed only for variants reported by OpenCode; models without variants do not claim selectable thinking levels.
- If OpenCode ever attempts to use its own tools, the extension fails the turn instead of hiding it.

## Terms of service analysis

This extension uses the **subprocess-delegation pattern**: every model turn spawns the real `opencode` CLI binary (`opencode run`); it never reads OAuth tokens, session credentials, or auth files, and never calls any model backend over HTTP directly. The bundled default models are OpenCode's own **free models** that work without `opencode auth login` at all.

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
