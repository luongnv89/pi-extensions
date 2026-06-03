# statusline-pi

![statusline-pi screenshot](../../assets/statusline-pi.png)

Compact project statusline footer for Pi.

Format:

```text
current-dir │ branch [changed files] PR #x │ remaining context tokens (percentage) context zone │ average response speed │ provider/model
```

Example:

```text
pi-extensions │ main [2] PR #12 │ 840,037 (84.0%) Plan │ 42.5 tok/s │ openai-codex/gpt-5.5
```

## Behavior

- Installs as a Pi extension and enables automatically on session start.
- Replaces Pi's default footer with a single compact statusline.
- Refreshes git change count every 5 seconds.
- Shows average model response speed as output tokens per second (`tok/s`) across completed assistant responses.
- Includes the active assistant response in the average while it is streaming, then keeps the completed average visible while idle.
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
