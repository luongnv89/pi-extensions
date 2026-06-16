# claude-code-pi

`claude-code-pi` registers a `claude-code-cli` provider in Pi and delegates every model call to the local Claude Code CLI with `claude -p` / `--print`.

This extension is intentionally a CLI bridge. It does **not** use the Anthropic SDK, direct HTTP APIs, or Pi's built-in Claude provider as a fallback. If `claude -p` is unavailable or fails, the Pi model turn fails with setup guidance instead of silently using another transport.

## Requirements

- Pi Coding Agent
- Claude Code CLI installed and available on the same machine:

```bash
claude --version
```

- Claude Code authenticated/configured according to your local Claude Code setup.

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
pi -e ./extensions/claude-code-pi/src/index.ts
```

## Usage

Pick provider **`claude-code-cli`** from `/model`, or start Pi directly:

```bash
pi --provider claude-code-cli --model sonnet
```

Bundled model aliases mirror common Claude Code CLI `--model` aliases:

| Pi provider | Pi model id | Passed to Claude Code |
|-------------|-------------|-----------------------|
| `claude-code-cli` | `sonnet` | `claude -p --model sonnet` |
| `claude-code-cli` | `opus` | `claude -p --model opus` |
| `claude-code-cli` | `fable` | `claude -p --model fable` |

Print-mode smoke test:

```bash
pi -p --provider claude-code-cli --model sonnet "Reply with exactly OK"
```

Direct Claude Code transport check:

```bash
claude -p --model sonnet --no-session-persistence --tools "" "Reply with exactly OK"
```

Commands:

```text
/claude-code-pi status
/claude-code-pi models
/claude-code-pi test
/claude-code-pi help
```

## Configuration

| Environment variable | Description |
| -------------------- | ----------- |
| `CLAUDE_CODE_PI_BIN` | Override the Claude Code executable path. Defaults to `claude`. |
| `CLAUDE_CODE_PI_MODELS` | Comma- or space-separated model aliases to register. Defaults to `sonnet,opus,fable`. |
| `CLAUDE_CODE_PI_TIMEOUT_MS` | Per-turn `claude -p` timeout in milliseconds. Defaults to 300000. |

Example:

```bash
CLAUDE_CODE_PI_MODELS="sonnet,opus,claude-fable-5" pi
```

## How it works

For each Pi model turn, the extension:

1. Serializes Pi's system prompt, conversation transcript, and available tool schemas into one text prompt.
2. Spawns the local Claude Code CLI with `claude -p --model <selected> --no-session-persistence --tools "" --output-format text`.
3. Writes the serialized prompt to Claude Code over stdin.
4. Converts Claude Code stdout into a Pi assistant text message, or converts `<pi_tool_call>{...}</pi_tool_call>` markers into native Pi tool calls.
5. Emits a clear assistant error if the CLI is missing, exits non-zero, is aborted, or times out.

The extension disables Claude Code's own tools with `--tools ""`. Pi tool schemas are included in the prompt, and explicit `<pi_tool_call>{...}</pi_tool_call>` markers are handed back to Pi so Pi executes tools through its normal pipeline.

## Notes and limitations

- This is slower than native HTTP providers because a `claude -p` process starts for each model turn.
- Tool calling is prompt-bridged with `<pi_tool_call>{...}</pi_tool_call>` markers, so it is less reliable than native provider tool calling but still keeps execution in Pi.
- Image input is serialized as an omitted-image placeholder and the registered models are text-only.
- Availability checks use `claude --version`; real model calls may still fail if local Claude Code auth or account access is not configured.
