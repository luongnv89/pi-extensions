---
name: "pi-delegator"
description: "Delegate approved coding tasks to Pi subprocesses with free opencode defaults, model setup, live progress, and metrics. Don't use for direct edits, CI, or non-Pi agents."
license: "MIT"
effort: "high"
metadata:
  version: "1.0.0"
  author: "Luong NGUYEN <luongnv89@gmail.com>"
---

# Pi Delegator

Use this skill when another AI agent should delegate a clearly scoped task to a
separate Pi instance, monitor Pi while it works, and report exact session metrics.
The main agent stays the orchestrator: it captures intent, gets user approval,
selects a model, runs Pi, and summarizes the result.

## Repo Sync Before Edits (mandatory)

If the delegated Pi task may modify a git repository, sync the target repo before
starting Pi so the delegated work begins from current code:

```bash
branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch origin
git pull --rebase origin "$branch"
```

If the working tree is dirty, stash first, sync, then pop. If `origin` is missing
or conflicts occur, stop and ask the user before continuing.

## Safety contract

- Never start Pi until the user approves the exact run preview.
- Prefer free `opencode-cli` models whenever that provider is available.
- Do not hide that a non-free model will be used; ask for explicit approval.
- Do not invent token, cost, or duration metrics. Report only collected values.
- Keep Pi's task prompt clear and bounded; Pi should know what to do, where to
  work, what tools are allowed, and what output is expected.

## Prerequisites

Before any delegation, verify:

```bash
which pi
python3 --version
```

If either command fails, stop and tell the user what to install. Resolve the
bundled helper relative to this skill directory, then use it for model discovery,
config persistence, execution, event monitoring, and metrics collection:

```bash
helper="<absolute-path-to-this-skill>/scripts/pi_delegate.py"
```

## Step 1 — Check models and configure default

Run model discovery first on every skill invocation:

```bash
python3 "$helper" models --prefer-free
```

The helper reads Pi's available models and highlights free `opencode-cli` models.
Configuration is stored in:

```text
~/.pi/agent/skills/pi-delegator/config.json
```

If no config exists, or the configured model is no longer available:

1. Show the model list or the helper's recommended free default.
2. Ask the user to select a default model and thinking level.
3. Save it with:

```bash
python3 "$helper" configure \
  --model "provider/model" \
  --thinking "low"
```

Default policy: if `opencode-cli` is available, recommend and use an
`opencode-cli` model unless the user explicitly chooses another provider.

## Step 2 — Capture clear input

Build a delegation brief before asking for approval:

- Task: the exact work Pi should perform.
- Target cwd: absolute path where Pi will run.
- Permissions: read-only, edit files, run tests, install deps, or other limits.
- Tools: allowed Pi tools, such as `read,bash,edit,write` or read-only tools.
- Constraints: files to avoid, coding standards, time limits, expected tests.
- Expected output: summary only, changed files, patch, report path, etc.
- Complexity: `simple`, `medium`, or `complex`.

If any field is unclear, ask a concise clarifying question before continuing.

## Step 3 — Select model and thinking

Read `references/model-selection.md` when choosing a model. In short:

- Simple tasks: free `opencode-cli` if available, thinking `off` or `minimal`.
- Medium tasks: free capable model if available, thinking `low` or `medium`.
- Complex/risky tasks: strongest available free model first; if a paid model is
  recommended, ask the user to approve the paid model explicitly.

Respect user overrides. If the run will use a non-free provider while
`opencode-cli` is available, include that warning in the approval preview.

## Step 4 — Approval gate

Show this preview and wait for explicit approval:

```text
◆ Pi Delegation Preview
┄┄┄┄┄┄┄┄┄┄┄┄┄
  Task:       <one sentence>
  Cwd:        <absolute path>
  Model:      <provider/model>
  Thinking:   <off|minimal|low|medium|high|xhigh>
  Tools:      <tool allowlist>
  Permissions:<read-only|can edit|can run tests|...>
  Complexity: <simple|medium|complex>

Run Pi with this task? [y/N]
```

Default to **No**. If the user declines, stop without launching Pi.

## Step 5 — Run and monitor Pi

After approval, write the delegation prompt to a temporary file and run:

```bash
python3 "$helper" run \
  --approved \
  --task-file /tmp/pi-task.md \
  --cwd "<target-cwd>" \
  --model "<provider/model>" \
  --thinking "<level>" \
  --tools "read,bash,edit,write" \
  --approve-project \
  --session-name "pi-delegated-task"
```

The helper uses Pi RPC mode, streams progress events, and requests final session
stats. Read `references/event-monitoring.md` for the event-to-progress mapping.
Use `--verbose` only when the user asks for raw streaming detail.

## Step 6 — Report result and metrics

Return a compact report:

```text
◆ Pi Delegation Complete
┄┄┄┄┄┄┄┄┄┄┄┄┄
  Result:       DONE | FAILED | ABORTED
  Duration:     <seconds>
  Model:        <provider/model>
  Thinking:     <level>
  Tokens:       input <n>, output <n>, cache read <n>, cache write <n>
  Cost:         <amount or not reported>
  Tool calls:   <n>
  Session:      <session file or not persisted>

  Summary:
  <Pi's final answer or concise synthesis>
```

If Pi changed files, list them from `git status --short` after the run. Do not
claim tests passed unless Pi or the main agent actually ran them.

## Error handling

- Missing `pi`: ask the user to install Pi and stop.
- No models available: ask the user to authenticate Pi or configure providers.
- Configured model unavailable: rerun model selection and update config.
- User declines approval: stop cleanly.
- Pi process fails: show stderr, partial progress, and any collected metrics.
- Metrics unavailable: write `not reported` instead of guessing.

## Step Completion Reports

After each major phase, print a compact status block:

```text
◆ <Phase> ([step N of 6])
┄┄┄┄┄┄┄┄┄┄┄
  Models checked:    ✓ pass
  Free default:      ✓ pass (opencode-cli available)
  User approval:     ✓ approved
  Result:            PASS
```
