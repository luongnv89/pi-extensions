# pi-fusion benchmark — results

Run 2026-09-18. 24 pi sessions, plus a 6-session t2 re-run after a grader fix (see below).
The t1/t3/t4 figures come from the original 24-session run; the t2 row comes from
the separate re-run taken ~6 minutes later on the same models.

- main model: `openai-codex/gpt-5.6-sol` ($5 / $30 per Mtok)
- sidekick model: `openai-codex/gpt-5.6-luna` ($0.20 / $1.20 per Mtok) — a 25× price gap
- 3 reps per cell, both arms with `--no-extensions --no-skills --no-context-files`
- cost = provider-recorded per-message totals, summed, plus sidekick cost from each delegate result
- total spend for the whole benchmark: ~$1.80

## Per task

| Task | Kind | Baseline | Fusion | Δ cost | Score | Deleg |
| --- | --- | --- | --- | --- | --- | --- |
| t1-verify | verification | $0.0681 | **$0.0262** | **−61.5%** | 100% → 100% | 1.0 |
| t2-sweep | mechanical | $0.1036 | $0.0917 | −11.6% | 100% → 100% | 1.7 |
| t3-investigate | investigation | $0.0158 | $0.0255 | **+61.7%** | 100% → 100% | 1.0 |
| t4-judgment | judgment | $0.1365 | $0.1329 | −2.7% | 100% → 100% | 1.7 |
| **mean** | | **$0.0810** | **$0.0691** | **−14.7%** | 100% → 100% | 1.3 |

Per-cell spread (min–max), which the means hide:

| Task | Baseline | Fusion |
| --- | --- | --- |
| t1-verify | $0.0659–$0.0708 | $0.0237–$0.0299 |
| t2-sweep | $0.0815–$0.1277 | $0.0760–$0.1099 |
| t3-investigate | $0.0121–$0.0189 | $0.0210–$0.0281 |
| t4-judgment | $0.1186–$0.1582 | $0.0858–$0.2162 |

## What this shows

**The mechanism works where the blog says it works.** t1 — report which tests
failed in ~1000 lines of suite output — came in at **−61.5% at identical
quality**. Cognition's equivalent example (offload a slow test run) reports −62%.
The reason is the same in both: the cost sits in *reading* the output, not in the
thinking, so handing the read to a 25×-cheaper model is nearly free.

**It costs money where there is no work to amortise.** t3 — name the file and the
constant — is **+61.7% more expensive** under fusion. A one-file lookup cannot
repay a delegation round trip, and fusion pays for the framing twice. This is the
honest counter-result: pi-fusion is a lever for expensive mechanical work, not a
global discount.

**Quality did not move.** Every task scored 100% on both arms across all reps.

**The judgment trap did not fire, and the delegate calls show why.** t4 is
deliberately underspecified, built to reproduce the blog's −27-point failure
where delegating the judgment loses the intent. Every fusion run preserved the
default output and emitted clean JSON while still delegating 1.7 times on
average. Reading the actual hand-offs from a kept session, the division of labour
is the one the harness asks for: the first delegation is investigation only
(*"Do not edit files yet"*), and the second carries the decisions already made —

> The JSON representation is the existing report/summary object
> `{ orders, subtotal, total }` [...] Scripts parse stdout directly, so stdout
> must contain no status prose in JSON mode.

and *"Preserve current output exactly when the flag is absent."* The main agent
resolved both ambiguities itself and delegated the typing. One task at n=3 does
not establish that fusion is safe on judgment work, but the mechanism behaved as
designed rather than passing by luck.

## Caveats

- **The −14.7% aggregate is the least meaningful number here.** It is an average
  over a task mix chosen by hand; the per-task range runs from −61.5% to +61.7%.
  Change the mix and the headline changes with it.
- **Fusion pays a fixed overhead of ~490 first-turn input tokens** (1614 vs 1124)
  for the delegate tool schema and guidance, on every turn. On short tasks that
  overhead *is* the result.
- **Fusion is roughly 2× slower in wall-clock** (e.g. t2: 82.8s vs 40.8s). The
  sidekick runs sequentially after the main agent asks, not in parallel.
- **n = 3.** Enough to see past one bad roll, not enough for a confidence
  interval. t4's fusion spread ($0.0858–$0.2162) is wider than its mean delta.
- **Four tasks are not a suite**, and the graders check invariants, not whether a
  human would merge the diff.

## Grader correction

The first t2 run scored 0.75 on both arms. The failing invariant was
"no references to `oldLog` remain" — which was matching pi's own session
transcript, because the session directory was written inside the work directory
and a transcript quotes the code it edited. Sessions now go to a separate temp
directory and t2 scores 100% on both arms, with every other invariant unchanged.

The fix changed the measurement, not the result. The original runs' recorded
`detail` objects already show `moduleGone`, `smokeOk`, and `cliOk` all true in
all six — so those sessions would have scored 100% under the corrected grader
too. The re-run confirmed that rather than discovering it.

This was an instrument fix, not a rubric change: the pass condition was not
touched, and the other three tasks' graders were not revisited. Every original
figure is preserved in `2026-09-18T22-39-24-038Z.json`.


---

# Tuning round (2026-09-18, after the run above)

The first run's `t3` regression (+61.7%) was traced to fixed per-turn overhead,
not to the delegation itself:

| t3-investigate | Baseline | Fusion (original) |
| --- | --- | --- |
| main-agent tokens | 2,875 | 5,718 |
| assistant turns | 2.0 | 3.0 |
| sidekick cost | — | $0.0013 |
| total | $0.0158 | $0.0242 |

The sidekick's work cost $0.0013; the regression was $0.0084. Three turns × 490
extra input tokens × $5/Mtok = $0.0074 — **88% of the gap was the cost of
carrying the delegate tool, paid whether or not it was used.**

## Changes

1. Trimmed the per-turn overhead: shorter system-prompt guidance, terser tool
   and parameter descriptions, and the telemetry-only `kind` parameter removed.
   The two sentences the judgment task depends on were left untouched.
2. Added a delegation floor to the guidance.

## Attempt 1 — over-corrected

The first floor rule was *"do not delegate what you could finish in one or two
tool calls."* Running a test suite **is** one tool call, so the rule forbade the
case where delegation wins most:

| Task | Before | After attempt 1 | Effect |
| --- | --- | --- | --- |
| t1-verify | $0.0262, 1.0 deleg | $0.0555, **0.3 deleg** | saving collapsed −61.5% → −18.5% |
| t3-investigate | $0.0242, 1.0 deleg | $0.0143, 0.0 deleg | fixed |

t1's cost went bimodal ($0.0228–$0.0748): still a large win when it delegated,
baseline-like when it did not.

## Attempt 2 — floor by output volume

Re-stated as *"delegate by how much output the work produces, not how many steps
it takes: one command printing hundreds of lines belongs with the sidekick; a
lookup answered in a line or two does not."*

| Task | Baseline | Fusion (tuned) | Δ | Delegations | Score |
| --- | --- | --- | --- | --- | --- |
| t1-verify | $0.0681 | **$0.0243** | **−64.3%** | 3/3 runs delegated | 100% |
| t3-investigate | $0.0158 | $0.0130 | −17.7% | 0/3 runs delegated | 100% |

Both pre-registered targets met (t3 under +20%, t1 at −60% or better), and the
rule now discriminates consistently rather than on a coin flip: every t1 run
delegated, no t3 run did.

**Do not read t3 as a win.** Fusion still pays ~316 extra input tokens per turn
(1432 vs 1116 first-turn), and $0.0130 sits inside the baseline's own spread
($0.0121–$0.0189). The honest claim is parity: the regression is gone, not
reversed. Fusion's spread is tighter ($0.0128–$0.0134), which is what removing a
round trip does.

Per-turn overhead fell from ~490 to ~316 input tokens.

## Not re-measured

`t2-sweep` and `t4-judgment` were not re-run against the final rule, so the
aggregate figure in the table above is stale — it mixes tuned t1/t3 with untuned
t2/t4. A full 24-session re-run would be needed to quote a new headline number.
