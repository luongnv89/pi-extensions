# Model Selection

Use this rubric after running `scripts/pi_delegate.py models --prefer-free`.

## Default policy

Prefer free models from the `opencode-cli` provider whenever available. This is
the default even when a paid default model is saved in config. Use paid providers
only when the user explicitly selects or approves them for the current run.

## Complexity levels

### Simple

Use for small edits, file lookups, formatting, simple scripts, or straightforward
bug fixes with a known location.

- Provider/model: fastest free `opencode-cli` model available.
- Thinking: `off` for non-reasoning models, `minimal` for reasoning models.
- Tools: keep narrow; use read-only tools for inspection tasks.

Preferred names when present: `deepseek-v4-flash-free`, `mimo-v2.5-free`,
`flash`, `mini`, `nano`.

### Medium

Use for multi-file changes, test fixes, small feature implementation, dependency
configuration, or tasks that require reading several files.

- Provider/model: capable free `opencode-cli` model, or saved default if no free
  model exists.
- Thinking: `low` or `medium`.
- Tools: allow write/edit only if the approval preview says so.

Preferred names when present: `big-pickle`, `nemotron-3-ultra-free`, `deepseek`.

### Complex or risky

Use for architecture changes, migrations, security-sensitive work, broad
refactors, unclear bugs, or tasks where a bad patch is expensive.

- First choice: strongest free `opencode-cli` model available.
- If no suitable free model is available, recommend a stronger paid model but
  require explicit user approval before using it.
- Thinking: `medium` or `high`; `xhigh` only for models known to support it.

Strong-model name signals: `opus`, `gpt-5`, `pro`, `ultra`, `nemotron`, large
context window, high max output.

## Fallback order

1. User-specified model for this run.
2. Free `opencode-cli` model if available.
3. Saved default from `~/.pi/agent/skills/pi-delegator/config.json`.
4. Best available model from Pi's model list, after user approval.

## Approval wording for paid fallback

When selecting a non-`opencode-cli` model while free models exist, include this
in the preview:

```text
⚠ Non-free model selected while free opencode-cli models are available.
  Continue with <provider/model>? [y/N]
```

## Thinking compatibility

If a model does not support reasoning, use `off` even if the complexity rubric
suggests a higher thinking level. Do not force unsupported levels.
