# opencode-pi

`opencode-pi` registers an `opencode-cli` provider in Pi and delegates model calls to the local `opencode` CLI.

![opencode-pi screenshot](../../assets/opencode-pi.png)

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
opencode models opencode
```

No OpenCode login is required for the bundled free OpenCode models.

## Install

From this repository:

```bash
npm run install-extensions
```

Then restart Pi or run:

```text
/reload
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

This queries `opencode models opencode`, updates the provider's model list, and shows how many new models were added. The status command also displays the timestamp of the last discovery.

## Configuration

| Environment variable | Description                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `OPENCODE_PI_BIN`    | Override the OpenCode executable path. Defaults to `opencode`.                                      |
| `OPENCODE_PI_MODELS` | Comma- or space-separated model list to register. Values without `/` are prefixed with `opencode/`. |

Example:

```bash
OPENCODE_PI_MODELS="opencode/deepseek-v4-flash-free,opencode/mimo-v2.5-free" pi
```

## How it works

For each Pi model call, the extension:

1. Creates a temporary OpenCode project with a locked-down `pi-model` agent.
2. Denies OpenCode's own tools (`bash`, `edit`, `read`, web tools, subagents, etc.).
3. Sends Pi's current prompt/context to `opencode run --format json` over stdin.
4. Streams the final OpenCode text back into Pi.
5. Converts `<pi_tool_call>{...}</pi_tool_call>` markers into real Pi tool calls, so Pi executes tools rather than OpenCode.

This keeps file access and edits under Pi's normal tool pipeline.

## Notes and limitations

- This is a CLI bridge, not a native provider API. It is slower than direct HTTP providers because it starts `opencode run` for each model turn.
- Tool calling is prompt-bridged. It works for common cases, but native tool-call providers will be more reliable.
- Image input is not registered; these models are exposed as text-only in Pi.
- If OpenCode ever attempts to use its own tools, the extension fails the turn instead of hiding it.
