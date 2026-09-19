# pi-fusion

A two-agent harness for Pi Coding Agent, modelled on
[Devin Fusion](https://cognition.com/blog/devin-fusion).

Your frontier model stays in charge of the plan, the ambiguous calls, and the
review. A cheaper **sidekick agent** — a real agent with its own tools and its
own context — does the execution. The sidekick is created once per session and
reused, so its context stays warm and later delegations cost less than the first.

## Why not just ask a second model for advice?

That is the pattern [advisor-pi](../advisor-pi/README.md) implements, and it is
a different trade. An advisor tool ships the task context to another model on
every call, uncached, and pays full price each time. pi-fusion instead keeps a
second *agent* alive with a context of its own, so the sidekick remembers what it
already learned and never re-reads the repository to answer a follow-up.

The two compose: use `advisor` when you want a stronger model's judgment,
`delegate` when you want cheaper hands.

## Behavior

- Registers a `delegate` tool. The main agent passes a `task`, optional
  `context` (what the sidekick cannot see from your conversation), and optional
  `expect` (what to report back).
- Runs the sidekick as a nested Pi agent session: real tools, its own working
  context, in your project directory.
- Reuses that session across delegations. A second delegation on the same model
  and tool mode answers from what it already knows.
- Appends guidance to the main agent's system prompt: delegate and monitor, take
  minimal actions, and keep the plan, the interpretation of ambiguity, and the
  final review. Cognition's own benchmark found delegation backfires badly when
  the judgment *is* the deliverable, so the guidance says so explicitly.
- Instructs the sidekick to flag any ambiguity it had to resolve, rather than
  silently guessing — that is the failure this design is most exposed to.
- Tracks tokens and cost per delegation and estimates what the same tokens would
  have cost on your main model.
- Optional compaction-boundary routing: steps the sidekick up to a stronger
  model, and the main agent up to a frontier model, when delegations keep
  failing — then steps back down once things are running clean again.
- Names the model that is executing, live. While a delegation runs, the working
  row reads `Sidekick <provider>/<model> · delegation 2/25 · 12s` and the footer
  shows `fusion ▸ <model> <n>s`; otherwise the footer shows
  `fusion sk:<model> <used>/<max> ~$<saved>`, prefixed `↑<model>` when routing
  has escalated the main agent. `/fusion status` names whichever agent is
  running right now.

## The sidekick is read-only by default

The nested session has no TUI, so it has no approval prompts: anything it runs,
runs unattended. The default tool set is therefore `read, grep, find, ls` — the
sidekick investigates and verifies, you apply the changes.

`/fusion tools coding` adds `edit`, `write`, and `bash`. That is what makes the
headline case work (hand off the slow test suite, hand off a mechanical sweep),
and it means the sidekick edits files and runs commands without asking you
first. Turn it on deliberately, in a repository you can `git diff`.

## Commands

`/fusion` with no arguments opens an interactive config panel (interactive
sessions only; it prints the text status where there is no UI):

```text
Sidekick model         openai-codex/gpt-5.6-luna
Stronger sidekick      unset
Frontier (escalation)  unset
Sidekick tools         readonly (read, grep, find, ls)
Sidekick thinking      max
Max delegations        0/25 used
Compaction routing     off
pi-fusion              enabled
Restart sidekick context
Reset counters and context
Close
```

Model rows open a provider list, then that provider's models **sorted by price
with the price shown** - cheapest first for the sidekick slots, priciest first
for the frontier slot, since that is the question being asked in each case. Both
pickers offer manual entry, and the optional slots offer `Clear (none)`.
Switching the sidekick to `coding` asks for confirmation first, because that
grants unattended write and shell access. Edits apply immediately; there is no
separate save step.

Every setting is also available as a subcommand, unchanged:

```text
/fusion status
/fusion enable
/fusion disable
/fusion sidekick <provider>/<model>
/fusion upgrade <provider>/<model>|none     # stronger sidekick, tried before escalating
/fusion frontier <provider>/<model>|none    # main-agent escalation target
/fusion tools <readonly|coding>
/fusion thinking <off|minimal|low|medium|high|xhigh|max>
/fusion max-delegations <n>
/fusion routing <on|off>
/fusion restart                             # drop the sidekick's context, keep the config
/fusion reset                               # clear counters and context
```

## Flags

```text
--fusion-enabled                 # default true
--fusion-sidekick <provider>/<model>
--fusion-sidekick-upgrade <provider>/<model>
--fusion-frontier <provider>/<model>
--fusion-tools <readonly|coding>
--fusion-thinking <level>
--fusion-max-delegations <n>
--fusion-routing                 # default false
```

## Dynamic mid-session routing

Off by default. With `/fusion routing on`, pi-fusion re-evaluates the model
assignment **at every compaction**, because compaction already invalidates the
prompt cache — switching models there costs nothing extra.

It steps up one rung at a time:

| Signal | Action |
| --- | --- |
| 2 consecutive failed delegations | upgrade the sidekick (if one is configured) |
| still failing with no sidekick headroom | escalate the main agent to the frontier model |
| 3 clean delegations after escalating | return the main agent to its baseline model |

The baseline is whichever model was active when the session started. Every
switch is announced in the UI. The decision is a pure heuristic, not another
model call — spending a model call to decide how to save model calls defeats the
purpose.

## Cost reporting

Each delegation reports the sidekick's tokens and actual cost, alongside what
those same tokens would have cost at your main model's rates:

```text
[sidekick groq/openai/gpt-oss-20b · readonly · 2.2k tok · $0.00 vs $0.01 on main · 1/25]
```

**The comparison is an estimate.** The main agent would not have spent an
identical token mix on the same work; this prices the sidekick's actual usage at
the rates of the model the session started on. That baseline is deliberately
fixed: quoting against the live model would inflate the saving the moment routing
escalates the main agent. It is the only counterfactual available short of
running every task twice. `/fusion status` shows the running total.

## Does it actually save money?

Measured, not claimed — see [`bench/`](bench/README.md) and
[`bench/results/SUMMARY.md`](bench/results/SUMMARY.md). On `gpt-5.6-sol` main
with a `gpt-5.6-luna` sidekick (25× price gap), 3 reps per cell:

| Task | Baseline | Fusion | Δ | Score |
| --- | --- | --- | --- | --- |
| report failures in ~1000 lines of suite output | $0.0681 | **$0.0243** | **−64%** | 100% → 100% |
| name a file and a constant (trivial lookup) | $0.0158 | $0.0130 | parity | 100% → 100% |

These are the two tasks re-measured against the current guidance. The suite's
other two tasks (a mechanical sweep and an ambiguous feature) were measured
against an earlier version and scored 100% on both arms at roughly equal cost;
`SUMMARY.md` has the full table and says which figures are stale.

The first row is the mechanism working: 33KB of test output lands in the
sidekick's context instead of the main model's, so main-agent tokens drop from
13,484 to 3,492. The second row is the limit: a lookup answered in a line or two
has no work to amortise, and the best fusion can do is get out of the way.

Fusion pays ~316 extra input tokens per turn to carry the tool, and delegations
run sequentially, so wall-clock is longer. It is a lever for bulky mechanical
work, not a global discount.

## Cache expiry

Most providers expire a cached prefix after about five minutes. A sidekick that
sits idle between delegations keeps its context but loses the cache discount on
the next one. [cache-warm](../cache-warm/README.md) addresses exactly this for
Pi's main session; pi-fusion deliberately does not duplicate it.

## Install

```bash
pi install npm:pi-fusion   # then /reload in Pi
```

Or for a single session:

```bash
pi -e npm:pi-fusion
```

## Development

```bash
npm install
npm run build
npm test
```

## Requirements

- Node.js >= 18
- `@earendil-works/pi-coding-agent` >= 0.84.2 as a peer dependency
- An API key for whichever model you configure as the sidekick
