# statusline-pi

Compact project statusline footer for Pi.

Format:

```text
current-dir │ branch [changed files] PR #x │ remaining context tokens (percentage) │ provider/model │ context zone
```

Example:

```text
pi-extensions │ main [2] PR #12 │ 840,037 (84.0%) │ openai-codex/gpt-5.5 │ 🟢 Plan Zone — Safe to plan and code
```

## Behavior

- Installs as a Pi extension and enables automatically on session start.
- Replaces Pi's default footer with a single compact statusline.
- Refreshes git change count every 5 seconds.
- Checks for a GitHub PR associated with the current branch every 60 seconds using `gh pr view`.
- Omits the PR segment when `gh` is unavailable or the branch has no PR.

## Commands

- `/statusline-pi` — toggle the custom footer on/off.
- `/statusline-refresh` — force refresh git and PR data.

## Install

From the repo root:

```bash
cp -r extensions/statusline-pi ~/.pi/agent/extensions/
```

Then run `/reload` in Pi.
