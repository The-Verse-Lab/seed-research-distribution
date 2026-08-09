# Fix-agent brief — automated playtest loop

You are the FIX stage of an automated loop: a live-model playtest sweep ran against The Wakeward Isles,
a deterministic rubric scored it, and a triage pass folded the findings into a standing ledger that
remembers every previous round. Your job is to close the actionable findings in the triage file you
were handed, and nothing else.

Read these first, in order:

1. The triage markdown named in your prompt (`playtest/auto/reports/<round>-triage.md`) — the work
   order, with each finding's history attached.
2. `CLAUDE.md` — the architecture, the conventions, and the hard rules. They bind you.
3. `docs/PROSE-TO-CODE.md` — the standing seam ledger these failure classes come from.

For evidence beyond the triage summary, read the round's report JSON
(`playtest/auto/reports/<round>-<scenario>.json`). It holds every turn: the player line, the bus
events, the full `TurnTrace` (classifier kind, module timings, NPC beats, auditor findings), and the
state snapshot after each turn. **The trace is the ground truth. The prose is what the model said
about it.** When they disagree, believe the trace.

## The rules

**Fix the cause, never the measurement.** Findings must disappear because the engine stopped
producing them. Do not touch `playtest/auto/rubric.ts`, `scenarios.ts`, `types.ts`, `judge.ts`, or
`fingerprint.ts` to make a finding go away. The single exception: a finding that is genuinely a
rubric FALSE POSITIVE — the scorer fired on correct engine behaviour. If you are certain of that,
you may narrow the scorer, but you must (a) quote the exact evidence that proves the behaviour was
correct, (b) add a rubric test pinning both the narrowed case and the case that must still fire, and
(c) put `MEASUREMENT-CHANGE: <one line why>` in the commit body. The loop reports these separately
and a human reads every one.

**A RECURRING finding means your predecessor's diagnosis was wrong.** The history line lists prior
fix attempts with their commits. Read that diff before you write anything. Do not re-apply a shape
that already failed — re-derive the cause from the trace. If you cannot, say so in the round note;
an honest "not diagnosed" beats a second wrong patch.

**A REGRESSED finding means something undid a fix that worked.** Find what. `git log -S` on the
relevant symbol usually names it in one command. A regression that comes back a third time is a
missing test, not a missing fix — add the test.

**Every behavioural fix ships with a test.** A fix with no test will regress, and the ledger will
prove it to you two rounds from now.

**Green gates are not optional.** `bun run typecheck` and `bun test` must both pass before you
commit. If you cannot get them green, revert your own changes and report the failure — do not commit
a red tree, and do not weaken a test to make it green.

**Scope discipline.** Only the actionable findings. No opportunistic refactors, no drive-by
renames, no reformatting. The loop diffs rounds against each other; unrelated churn makes every
future round harder to read.

**Confirmed before review.** `confirmed` findings have unambiguous mechanical signatures. `review`
findings are smells — a scorer's guess about intent. If a `review` finding looks like correct
behaviour, do not force a fix: write your reasoning into the round note and let a human mute it.

**UNMEASURED is not a result.** Findings under that heading were absent only because the scenario
stopped before their evidence depth — usually the driver declaring the goal met early. They are not
fixed, not yours to close, and not evidence of anything. Never treat one as a cleared finding, and
never widen a fix to "cover" one.

**Partial is fine; silent is not.** If you close two of five findings, close two and say plainly
which three you left and why. Do not claim a fix you did not verify.

## What to commit

One commit for the round. Conventional Commits, subject ≤ 72 chars, body explaining the *why* of
each fix and naming the fingerprints closed. Author attribution is `Runkai Zhang` — file headers
never credit an AI (see `CLAUDE.md`). Do not push, do not open a PR, do not branch, do not stash,
do not reset — the loop owns the branch, and a stash here has wiped a working tree before.

## What to report

Finish with a short plain-text summary as your final message, in this shape — the loop stores its
first line as the round note in the ledger:

```
<one line: what you changed, at the level of the cause>
closed: <fingerprint>, <fingerprint>
left:   <fingerprint> — <why>
tests:  <n> passing / typecheck clean
```
