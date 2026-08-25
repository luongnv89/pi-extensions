# claude-code-pi

![claude-code-pi — provider and session in Pi](../../assets/claude-code-pi.png)

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
| `CLAUDE_CODE_PI_CONTEXT_WINDOW` | Override the advertised context window in tokens. Defaults to 1000000 (current Claude aliases serve 1M-token context windows). |

Example:

```bash
CLAUDE_CODE_PI_MODELS="sonnet,opus,claude-fable-5" pi
```

## Thinking levels

Pi thinking levels map to Claude Code's `--effort` flag:

| Pi thinking level | Passed to Claude Code |
|-------------------|-----------------------|
| `off` / unset     | no `--effort` flag    |
| `minimal`, `low`  | `--effort low`        |
| `medium`          | `--effort medium`     |
| `high`            | `--effort high`       |
| `xhigh`           | `--effort xhigh`      |

## Images

Models advertise image input. When a turn contains images, the extension switches to the stream-json transport (`--input-format stream-json --output-format stream-json --verbose`) and sends images as base64 content blocks over stdin. Text-only turns keep the plain-text transport.

## How it works

For each Pi model turn, the extension:

1. Serializes Pi's system prompt, conversation transcript, and available tool schemas into one text prompt.
2. Spawns the local Claude Code CLI with `claude -p --model <selected> --no-session-persistence --tools "" --output-format text`, plus `--effort <level>` when a thinking level is set.
3. Writes the serialized prompt (or a stream-json user message with base64 image blocks) to Claude Code over stdin.
4. Converts Claude Code stdout into a Pi assistant text message, or converts `<pi_tool_call>{...}</pi_tool_call>` markers into native Pi tool calls.
5. Emits a clear assistant error if the CLI is missing, exits non-zero, is aborted, or times out.

The extension disables Claude Code's own tools with `--tools ""`. Pi tool schemas are included in the prompt, and explicit `<pi_tool_call>{...}</pi_tool_call>` markers are handed back to Pi so Pi executes tools through its normal pipeline.

## Notes and limitations

- This is slower than native HTTP providers because a `claude -p` process starts for each model turn.
- Tool calling is prompt-bridged with `<pi_tool_call>{...}</pi_tool_call>` markers, so it is less reliable than native provider tool calling but still keeps execution in Pi.
- Image input requires the stream-json transport and is supported for base64 image blocks; availability checks use `claude --version`, so real model calls may still fail if local Claude Code auth or account access is not configured.

## Anthropic terms of service analysis

A review of this extension's architecture against Anthropic's Consumer Terms of Service (§3.7), Commercial Terms of Service, and the Claude Code legal/compliance documentation (including the January–June 2026 enforcement wave and clarifications):

| Rule | How this extension relates |
|---|---|
| No third-party harness spoofing / OAuth token extraction | ✅ **Compliant** — spawns the genuine `claude` binary as a subprocess; never touches OAuth tokens, intercepts authentication, or impersonates the Claude Code harness |
| Binary must not be modified; built-in auth must not be disabled | ✅ Runs the unmodified, published `claude` binary |
| Subscription automation must go through official CLI surfaces | ⚠️ It *does* use the official CLI (`claude -p`), which Anthropic treats as first-party usage — but heavy headless/scripted `claude -p` on Pro/Max subscription auth is exactly the pattern Anthropic has flagged, and since June 2026 such usage draws from a dedicated Agent SDK credit pool rather than normal plan limits |
| Third-party products may not intermediate Claude for end users | ⚠️ Fine as a personal tool run by the account owner; risky if distributed so that other users route their own subscriptions through it |

### Conclusion

**Safe for personal use with your own credentials.** The architecture deliberately does the compliant thing: a real `claude -p` subprocess per turn, no token extraction, no API fallback. This is the pattern Anthropic treats as first-party usage.

**Residual risks:**

1. **Subscription auth + heavy automated/headless use** matches the traffic pattern that led to account bans in early 2026, and now consumes the separate Agent SDK credit. Using an **Anthropic API key** inside Claude Code removes all ambiguity.
2. **Distributing it to others** who route their Pro/Max subscriptions through it edges toward "third-party product intermediating Claude" — the line Anthropic actively enforces (see the OpenCode and OpenClaw enforcement actions).
3. `--permission-mode dontAsk` means tool calls requested by the model execute through Pi without prompting — an operational safety consideration independent of the terms of service.

**Verdict: safe for personal use with your own credentials; use an API key for heavy automation; do not ship it as a subscription-backed backend for other users.**

*Last reviewed against Anthropic's legal documentation published August 2026; terms and enforcement practices may change.*
