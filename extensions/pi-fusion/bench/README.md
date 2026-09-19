# pi-fusion benchmark

Does the sidekick actually save money, and at what cost to quality? This harness
answers that with real pi sessions rather than a claim.

## Method

Every task runs twice on a fresh copy of `fixture/`:

| Arm | Command |
| --- | --- |
| `baseline` | plain pi on the main model |
| `fusion` | same, plus `-e ../src/index.ts` with `--fusion-tools coding` |

Both arms run with `--no-extensions --no-skills --no-context-files`, so the only
difference between them is pi-fusion. Without that, the globally installed
extensions — `advisor-pi` among them — would give the baseline arm a second-model
tool of its own and make the comparison meaningless.

**Prompts are identical across arms and never mention delegation.** The question
is whether the harness helps on its own. A fusion run that delegates nothing is a
real result, and the report calls those out separately rather than averaging them
away.

**Cost is the provider-recorded per-message total**, summed from the session
JSONL, plus the sidekick's cost read from each `delegate` tool result (the
sidekick runs in its own session, so it is not in the main file). Nothing is
recomputed from a price table, which keeps tier boundaries — both models price
input above 272k tokens at 2× — correct for free.

## Tasks

| Task | Kind | Graded on |
| --- | --- | --- |
| `t1-verify` | verification | names all 3 failing tests in ~1000 lines of suite output |
| `t2-sweep` | mechanical | module deleted, no references left, smoke passes, CLI output unchanged |
| `t3-investigate` | investigation | names `pricing.js` and the `0.87` multiplier |
| `t4-judgment` | judgment | default output unchanged, `--json` emits parseable JSON, payload correct |

`t4` is deliberately underspecified, to probe Cognition's own finding that
delegation backfires when the judgment is the deliverable. "Scripts will parse
stdout directly" implies stdout must carry nothing but JSON — which the existing
progress lines break — and nothing says the default output may change, so
changing it is a regression. Graders were written before the first run and are
not adjusted afterwards; unanticipated failures are recorded as notes.

## Run it

```bash
node run.mjs                                  # 4 tasks × 2 arms × 3 reps
node run.mjs --reps 1 --tasks t1-verify       # one cell
node run.mjs --main <provider>/<model> --sidekick <provider>/<model>
node run.mjs --keep                           # leave work directories for inspection
```

Results land in `results/<timestamp>.json` (every run) and
`results/<timestamp>.md` (the table).

## What it cannot tell you

- **n is small.** Three reps per cell is enough to see past a single bad roll,
  not enough for a confidence interval. The report shows min–max per cell so the
  spread stays visible.
- **Four tasks are not a benchmark suite.** They are four shapes of work chosen
  to match the categories in Cognition's post.
- **Graders are mechanical.** They check invariants, not whether a human would
  merge the diff.
