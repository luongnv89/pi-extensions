# cursor-pi

`cursor-pi` registers a `cursor-cli` provider in Pi and delegates every model call to the local Cursor CLI with `cursor-agent -p --mode ask --trust`.

This extension is intentionally a CLI bridge. It does **not** use Cursor's HTTP API or Pi's built-in providers as a fallback. If `cursor-agent` is missing, not logged in, or fails, the Pi model turn fails with setup guidance instead of silently using another transport.

## Requirements

- Pi Coding Agent
- Cursor CLI installed and available on the same machine:

```bash
cursor-agent --version
```

Install it if needed:

```bash
curl https://cursor.com/install | sh
```

- Logged in to your Cursor account:

```bash
cursor-agent login
```

## Install

From this repository:

```bash
npm run install-extensions
```

Then restart Pi or run:

```text
/reload
```

For one-off development testing without copying:

```bash
pi -e ./extensions/cursor-pi/src/index.ts
```

## Usage

Pick provider **`cursor-cli`** from `/model`, or start Pi directly:

```bash
pi --provider cursor-cli --model auto
```

Bundled model aliases mirror common `cursor-agent models` ids:

| Pi provider | Pi model id | Passed to Cursor CLI |
|-------------|-------------|----------------------|
| `cursor-cli` | `auto` | `cursor-agent -p --model auto --mode ask --trust` |
| `cursor-cli` | `composer-2.5` | `cursor-agent -p --model composer-2.5 --mode ask --trust` |
| `cursor-cli` | `gpt-5.3-codex-high` | `cursor-agent -p --model gpt-5.3-codex-high --mode ask --trust` |
| `cursor-cli` | `claude-sonnet-5-thinking-xhigh` | `cursor-agent -p --model claude-sonnet-5-thinking-xhigh --mode ask --trust` |
| `cursor-cli` | `gemini-3.7-flash-high` | `cursor-agent -p --model gemini-3.7-flash-high --mode ask --trust` |

Run `cursor-agent models` (or `/cursor-pi models`) to see every id available on your account; effort variants like `*-fast`, `*-xhigh` are separate model ids.

Print-mode smoke test:

```bash
pi -p --provider cursor-cli --model auto "Reply with exactly OK"
```

Direct Cursor CLI transport check:

```bash
echo "Reply with exactly OK" | cursor-agent -p --output-format text --mode ask
```

Commands:

```text
/cursor-pi status   — full status: binary version, auth, registered models
/cursor-pi verify   — installation + login verification with fix guidance
/cursor-pi usage    — current plan tier and account info from `cursor-agent about`
/cursor-pi models   — registered models plus account models from `cursor-agent models`
/cursor-pi test     — print smoke-test commands
/cursor-pi help
```

## Installation verification

On every `session_start` the extension verifies the local Cursor CLI before you can use it:

1. Runs `cursor-agent --version`. If the binary is missing or unusable, Pi shows a warning with install guidance (`curl https://cursor.com/install | sh`) instead of failing later mid-conversation.
2. Runs `cursor-agent status`. If you are not logged in, Pi warns you to run `cursor-agent login`.

The same checks run on demand via `/cursor-pi verify` and `/cursor-pi status`. Stream failures during a turn also include this setup guidance.

## Configuration

| Environment variable | Description |
| -------------------- | ----------- |
| `CURSOR_PI_BIN` | Override the Cursor CLI executable path. Defaults to `cursor-agent`. |
| `CURSOR_PI_MODELS` | Comma- or space-separated model ids to register. Defaults to `auto,composer-2.5,gpt-5.3-codex-high,claude-sonnet-5-thinking-xhigh,gemini-3.7-flash-high`. |
| `CURSOR_PI_TIMEOUT_MS` | Per-turn `cursor-agent -p` timeout in milliseconds. Defaults to 300000. |
| `CURSOR_PI_CONTEXT_WINDOW` | Override the advertised context window in tokens. Defaults to 272000. |

Example:

```bash
CURSOR_PI_MODELS="auto,gpt-5.3-codex-xhigh-fast" pi
```

## How it works

For each Pi model turn, the extension:

1. Serializes Pi's system prompt, conversation transcript, and available tool schemas into one text prompt.
2. Spawns the local Cursor CLI with `cursor-agent -p --output-format text --model <selected> --mode ask --trust`.
3. Writes the serialized prompt to Cursor over stdin.
4. Converts Cursor stdout into a Pi assistant text message, or converts `<pi_tool_call>{...}</pi_tool_call>` markers into native Pi tool calls.
5. Emits a clear assistant error if the CLI is missing, exits non-zero, is aborted, or times out.

Cursor runs in read-only `ask` mode so its own tools never edit files or run shell commands. Pi tool schemas are included in the prompt, and explicit `<pi_tool_call>{...}</pi_tool_call>` markers are handed back to Pi so Pi executes tools through its normal pipeline.

## Notes and limitations

- This is slower than native HTTP providers because a `cursor-agent -p` process starts for each model turn.
- Tool calling is prompt-bridged with `<pi_tool_call>{...}</pi_tool_call>` markers, so it is less reliable than native provider tool calling but still keeps execution in Pi.
- Text input only; image content is omitted from the serialized prompt.
- Usage/cost numbers are estimated from character counts because the text transport does not report token usage.
- The default model list is static; new Cursor model ids appear after setting `CURSOR_PI_MODELS` (see `/cursor-pi models` for available ids).
