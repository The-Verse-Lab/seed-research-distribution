# Run the loop — operator brief

The prompt to hand an agent when you want a playtest loop run, plus the standing rules that keep
the loop's memory honest. `loop.sh`'s header is the contract and `FIX-AGENT.md` binds the fixer;
this file is for the person (or agent) *starting* a round.

Paste the block below. Adjust `--rounds`. Everything after it is background you do not need to
paste — the agent should read this file.

---

## The prompt

```
Run the automated playtest loop in this repo.

Read playtest/auto/RUN-LOOP.md, playtest/auto/loop.sh's header, and
playtest/auto/FIX-AGENT.md first — they are the contract, and loop.sh does the
orchestration. You do not reimplement it.

Preflight, in order:
1. `git status --porcelain` must be empty. If it is not, show me what is there
   and ask — do not commit it yourself, and `git stash -u` is FORBIDDEN.
2. Confirm we are NOT on main. The loop refuses main by design.
3. `.env` must have a reachable endpoint — actually probe it with a real
   completion on the narrator AND utility roles, do not just check the file
   exists. SEED_RESCUE_BASE_URL/MODEL unset is a warning, not a blocker.

Then run:

    bun run playtest:loop -- --rounds 3

It takes hours: each round is a ~40min live sweep plus a headless fix agent plus
a full test gate. Launch it ONCE as a single detached run and let it finish — do
not chunk it, do not poll it turn by turn. If it DIES, the message says which
stage — report that and STOP; do not "fix" the tree it left behind without
telling me. If it stops early saying NOT converged, that is a clean stop
(exit 0), not a failure — report it as such.

When it finishes, report:
- `bun run playtest:triage -- --status` output
- per round: new / recurring / regressed / cleared / flaky / unmeasured counts
- any round flagged "measurement surface changed" — I read every one of those,
  they mean a FIXED verdict may be the scorer going blind rather than a bug dying
- anything reported UNMEASURED, and which scenario ran short. Those findings are
  still OPEN, not fixed — the sweep stopped before their evidence depth, so
  silence proves nothing. A fingerprint unmeasured two rounds running means the
  scenario is too shallow to test it, and that needs me.
- anything still RECURRING after 2+ fix attempts (the ledger lists the shas) —
  that is a wrong diagnosis repeating, and it needs me, not another round.

Do not deepen a scenario goal to fix a coverage problem: playtest/auto/scenarios.ts
is a measurement file, and editing it invalidates every FIXED verdict in the
ledger. Bring it to me instead.
```

---

## Operating notes

**Run it detached, in one piece.** The Bash tool caps a foreground call at 10 minutes and a run is
hours, so a foreground invocation gets killed mid-sweep. Launch once with `run_in_background` and
wait for the completion notification. Do not split it into chunks and do not poll between turns.

**A "waiting for interactive input" notification is a false alarm.** Turns take 30–240s of live
model time and stdout goes quiet between them, which trips the harness's idle heuristic. `loop.sh`
and `run.ts` have no interactive prompt, and the fix stage runs under
`--dangerously-skip-permissions` precisely so nothing can block. Confirm liveness instead:

```sh
pgrep -fl "loop.sh|playtest/auto/run.ts"
```

Two live PIDs means it is working. Killing it and "re-running with piped input" throws away the
round.

**Never `git stash`.** Not in the loop, not around it, not to clean a tree for preflight. A stash
in this repo has wiped a working tree before. `loop.sh` itself will never push, branch, stash,
reset, or check out, and the fixer is denied those verbs by name.

**A red gate leaves the tree as-is on purpose.** `loop.sh` stops on the first red typecheck or
test run and does not clean up, so you can inspect exactly what the fixer did. Report the stage;
do not repair it unasked.

## Measurement integrity — the part that actually matters

The loop's value is the verdict it puts on a finding. An automated fixer has every incentive to
make findings vanish by narrowing the scorer, so:

- **`MEASUREMENT_FILES` = `rubric.ts`, `scenarios.ts`, `types.ts`, `judge.ts`, `fingerprint.ts`.**
  Each round hashes them. If the hash moves, every FIXED verdict that round is stamped
  **unverified** and the triage prints a banner. Read every one.
- A fixer may only touch them for a *proven* rubric false positive, and must quote the evidence,
  pin both the narrowed case and the case that must still fire, and put `MEASUREMENT-CHANGE: <why>`
  in the commit body.
- **Never edit `scenarios.ts` to fix a coverage problem.** Deepening a goal invalidates the whole
  ledger. Coverage problems go to the owner.
- **Never hand-edit `ledger.json`.** `triage.ts --recheck` is the one repair path; it preserves fix
  attempts, notes and hand mutes. Note that `--recheck` re-folds under current *fold* rules — it
  reads each report's **stored** findings and does NOT re-score with the current rubric. It cannot
  retroactively clear anything, and that is correct: re-scoring old runs would manufacture FIXED
  verdicts for bugs nobody fixed.

**UNMEASURED is not a result.** A finding is cleared only by a run that got past its own evidence
depth AND past `COVERAGE_FLOOR` (half the turn cap). Absence from a short run proves nothing —
still open, never actionable, never convergence.

**A finding recurring after 2+ attempts is a wrong diagnosis repeating.** Stop and escalate rather
than spending another round. The ledger lists every prior attempt's sha; read those diffs before
anyone writes code.

## Testing a change to the loop without polluting the ledger

`run.ts` only writes to `reports/`. Nothing enters `ledger.json` until `triage.ts` folds it. So:

```sh
bun run playtest:sweep -- --turns 10 wakeward-cold-passage
# inspect the JSON directly, then:
rm playtest/auto/reports/<stamp>-wakeward-cold-passage.json \
   playtest/auto/reports/<stamp>-wakeward-cold-passage.md
```

Deleting reports that were never folded is safe. Deleting reports the ledger *does* record is not
— `--recheck` refuses that case rather than silently dropping their findings.

To exercise a code path a natural run will not reach, build a throwaway `Scenario` **inline in a
script** (`{...SCENARIOS[0], id: "probe-x", goal: "...", maxTurns: 6}`) and call `runScenario`
directly. Do not edit `scenarios.ts` to make a test easier.

## Cost

Real tokens twice over: the sweep drives the live game model, the fixer is a coding agent. A
six-scenario 20-turn sweep is a substantial live-model run. `--no-fix` measures without editing
code; `--scenarios "wakeward-cold-passage"` and `--turns N` narrow it.

`SEED_RESCUE_BASE_URL`/`MODEL` unset is not a blocker, but every sweep warns about it and it costs
you data: an empty narrator completion degrades to the deterministic trigger echo instead of
rerouting, which shows up as content-free turns in the report.
