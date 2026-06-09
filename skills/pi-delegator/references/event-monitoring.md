# Event Monitoring

The helper streams Pi RPC events as concise progress lines. Keep default output
compact; use verbose mode only when the user asks for raw event detail.

## Progress mapping

| RPC event | Progress line |
| --- | --- |
| `session` | `● Pi session started — <id>` |
| `agent_start` | `● Pi agent started` |
| `turn_start` | `● Turn <n> started` |
| `tool_execution_start` | `● Tool started: <toolName>` |
| `tool_execution_update` | Verbose only; show accumulated tool output preview |
| `tool_execution_end` | `✓ Tool complete: <toolName>` or `✗ Tool failed: <toolName>` |
| `compaction_start` | `● Compaction started — <reason>` |
| `compaction_end` | `✓ Compaction complete` or `⚠ Compaction failed` |
| `auto_retry_start` | `⚠ Retry <attempt>/<max> after transient error` |
| `auto_retry_end` | `✓ Retry recovered` or `✗ Retry failed` |
| `agent_end` | `✓ Pi agent finished` |
| failed command response | `✗ Pi command failed: <error>` |

## Metrics to collect

At the end of the run, call RPC `get_session_stats` and report:

- duration wall time
- model and thinking level used for the run
- session file and session id when available
- message counts
- tool call count
- input, output, cache read, cache write, and total tokens
- estimated cost when Pi reports it
- context usage when Pi reports it
- retry and compaction counts observed from events

If a field is missing, write `not reported`.

## What not to stream by default

Do not print every assistant text delta by default. It makes the main agent's
conversation noisy and can bury important progress. At the end, fetch the final
assistant text and summarize it for the user.
