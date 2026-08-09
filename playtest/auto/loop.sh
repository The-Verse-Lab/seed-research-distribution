#!/usr/bin/env bash
#
# Automated playtest loop — sweep → triage → fix → sweep, unattended.
#
#   playtest/auto/loop.sh --rounds 3
#   playtest/auto/loop.sh --rounds 5 --scenarios "wakeward-cold-passage wakeward-second-bell" --turns 16
#   playtest/auto/loop.sh --rounds 1 --no-fix        # measure only, never edit code
#   playtest/auto/loop.sh --model claude-fable-5 --fix-effort max --ultracode   # pin the fixer
#
# Each round: run the live sweep, fold it into the standing ledger (which remembers every previous
# round, so a finding comes back labelled RECURRING or REGRESSED rather than as fresh news), hand the
# actionable set to a headless Claude Code fix agent under playtest/auto/FIX-AGENT.md, gate on
# typecheck + tests, and commit. Then sweep again — the next round's triage is the verdict on this
# round's fixes.
#
# The fixer's model, effort, and ultracode opt-in are chosen PER ROUND by routing.ts from the triage
# — two new confirmed findings in one scenario is Sonnet 5 at medium, a regression whose last two
# fixes both missed is Fable 5 at xhigh with ultracode. --model / --fix-effort / --ultracode /
# --no-ultracode pin it by hand when you want to override the round's own read of itself.
#
# A finding is only cleared by a run that went deep enough to have SEEN it — past its own evidence
# depth and past half the turn cap. A scenario stops early when the driver declares the goal met,
# and the better the engine gets the sooner that happens (the 2026-08-02 run finished fixture-work in 2
# turns of 20, honestly), so the old "did the scenario run at all" test was crediting clears to
# turns that never happened. Absence from a short run reports as UNMEASURED: still open, not
# actionable, and never counted as convergence. `triage.ts --recheck` re-folds every round on disk
# under the current rules when a fold rule changes beneath a ledger the old one wrote.
#
# Costs real tokens twice over: the sweep drives the live game model, the fixer is a coding agent.
# A five-scenario 20-turn sweep runs roughly 40 minutes on its own.
#
# What this script will never do: push, branch, stash, reset, or check out. It commits to the branch
# you start it on and stops on the first red gate, leaving the tree exactly as the fixer left it.
# Every exit that measured a round still commits ledger.json (even under --no-fix): the ledger is the
# loop's memory, and an uncommitted fold would fail the NEXT run's own dirty-tree preflight.
#
# @author Runkai Zhang
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REPORTS="$HERE/reports"
cd "$ROOT"

ROUNDS=3
SCENARIOS=""
TURNS=""
JUDGE="--judge"
DO_FIX=1
FIX_MODEL=""       # empty = take the tier triage routed for this round
FIX_EFFORT=""      # empty = ditto
FORCE_ULTRACODE="" # empty = ditto; "on"/"off" to pin
STOP_WHEN_CLEAN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rounds) ROUNDS="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --turns) TURNS="$2"; shift 2 ;;
    --no-judge) JUDGE=""; shift ;;
    --no-fix) DO_FIX=0; shift ;;
    --model) FIX_MODEL="$2"; shift 2 ;;
    --fix-effort) FIX_EFFORT="$2"; shift 2 ;;
    --ultracode) FORCE_ULTRACODE="on"; shift ;;
    --no-ultracode) FORCE_ULTRACODE="off"; shift ;;
    --keep-going) STOP_WHEN_CLEAN=0; shift ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$REPORTS"
LOOP_LOG="$REPORTS/loop-$(date +%Y-%m-%dT%H-%M-%S).log"
say() { printf '\n\033[1m[loop]\033[0m %s\n' "$*" | tee -a "$LOOP_LOG"; }
die() { printf '\n\033[1;31m[loop] %s\033[0m\n' "$*" | tee -a "$LOOP_LOG"; exit 1; }

# Every triage writes the ledger, but only the fix stage committed it. A round that ends without
# one — converged, not-converged-on-unmeasured, or --no-fix — used to leave that fold uncommitted,
# and the NEXT run died in its own dirty-tree preflight (the 2026-08-02 loop stopped this way and
# left round 2026-08-02T22-54-22 stranded). Stages the ledger and nothing else, so an unrelated
# edit is never swept into a loop commit. Not called on `die`: a red gate leaves the tree as-is.
commit_ledger() {
  [[ -n "$(git status --porcelain -- "$HERE/ledger.json")" ]] || return 0
  git add "$HERE/ledger.json"
  git commit -q -m "chore(playtest): ledger — round ${1:-unknown} measured, no fix stage" || true
  say "ledger committed for round ${1:-unknown} (no fix stage ran)"
}

# --- preflight ---------------------------------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" || "$BRANCH" == "master" ]] && die "refusing to run on $BRANCH — start a branch first"
[[ -n "$(git status --porcelain)" ]] && die "working tree is dirty — commit or set it aside so each round is one clean commit"
command -v claude >/dev/null || { [[ $DO_FIX -eq 1 ]] && die "claude CLI not found (needed for the fix stage; --no-fix to measure only)"; }
[[ -f "$ROOT/.env" ]] || die ".env missing — the sweep needs a reachable model endpoint"

say "branch $BRANCH · $ROUNDS round(s) · scenarios: ${SCENARIOS:-all} · fix stage: $([[ $DO_FIX -eq 1 ]] && echo on || echo off)"

for (( round=1; round<=ROUNDS; round++ )); do
  say "════ round $round/$ROUNDS · sweep ════"
  SWEEP_ARGS=()
  [[ -n "$JUDGE" ]] && SWEEP_ARGS+=("$JUDGE")
  [[ -n "$TURNS" ]] && SWEEP_ARGS+=(--turns "$TURNS")
  # shellcheck disable=SC2206  # deliberate word-split: --scenarios takes a space-separated list
  [[ -n "$SCENARIOS" ]] && SWEEP_ARGS+=($SCENARIOS)

  # `${a[@]+"${a[@]}"}` — bash 3.2 (what ships on macOS) treats an empty array as unset under `set -u`.
  if ! bun "$HERE/run.ts" ${SWEEP_ARGS[@]+"${SWEEP_ARGS[@]}"} 2>&1 | tee -a "$LOOP_LOG"; then
    die "sweep failed (endpoint unreachable, or the harness threw) — see $LOOP_LOG"
  fi

  say "════ round $round/$ROUNDS · triage ════"
  TRIAGE_OUT="$(bun "$HERE/triage.ts" 2>&1 | tee -a "$LOOP_LOG")"
  ROUND_ID="$(printf '%s\n' "$TRIAGE_OUT" | sed -n 's/^ROUND=//p' | tail -1)"
  ACTIONABLE="$(printf '%s\n' "$TRIAGE_OUT" | sed -n 's/^ACTIONABLE=//p' | tail -1)"
  # Findings whose scenario stopped before their own evidence depth. They are NOT cleared, so an
  # empty work order alongside them is a blind spot, not convergence.
  UNMEASURED="$(printf '%s\n' "$TRIAGE_OUT" | sed -n 's/^UNMEASURED=//p' | tail -1)"
  # The fix stage's tier is derived per round from the triage — a round of two confirmed auditor
  # findings and a round with a twice-failed regression are not the same amount of thinking.
  ROUND_MODEL="$(printf '%s\n' "$TRIAGE_OUT" | sed -n 's/^FIXMODEL=//p' | tail -1)"
  ROUND_EFFORT="$(printf '%s\n' "$TRIAGE_OUT" | sed -n 's/^FIXEFFORT=//p' | tail -1)"
  ROUND_ULTRA="$(printf '%s\n' "$TRIAGE_OUT" | sed -n 's/^ULTRACODE=//p' | tail -1)"
  [[ -n "$ROUND_ID" ]] || die "triage did not name a round — see $LOOP_LOG"
  TRIAGE_MD="$REPORTS/$ROUND_ID-triage.md"

  if [[ "${ACTIONABLE:-0}" -eq 0 ]]; then
    say "round $ROUND_ID: nothing actionable"
    if [[ "${UNMEASURED:-0}" -gt 0 ]]; then
      # Calling this convergence would be the same lie the coverage rule exists to stop.
      say "but $UNMEASURED finding(s) went UNMEASURED — the sweep did not run deep enough to clear them; NOT converged"
      say "see $REPORTS/$ROUND_ID-triage.md · deepen the scenario or raise --turns, then sweep again"
      break
    fi
    [[ $STOP_WHEN_CLEAN -eq 1 ]] && { say "converged — stopping (pass --keep-going to sweep anyway)"; break; }
    continue
  fi
  say "round $ROUND_ID: $ACTIONABLE actionable finding(s) → $TRIAGE_MD"

  if [[ $DO_FIX -eq 0 ]]; then
    say "fix stage off — stopping after triage"
    break
  fi

  # --- fix stage -------------------------------------------------------------------------------
  # Headless, so every permission prompt would hang the loop: permissions are skipped, and the
  # destructive git verbs are denied by name instead. The fixer can edit, test, and commit; it
  # cannot push, branch, stash, reset, or check out — a stash in this repo has wiped a tree before.
  say "════ round $round/$ROUNDS · fix ════"
  FIX_LOG="$REPORTS/$ROUND_ID-fix.log"
  USE_MODEL="${FIX_MODEL:-${ROUND_MODEL:-claude-opus-5}}"
  USE_EFFORT="${FIX_EFFORT:-${ROUND_EFFORT:-high}}"
  USE_ULTRA="${ROUND_ULTRA:-0}"
  [[ "$FORCE_ULTRACODE" == "on" ]] && USE_ULTRA=1
  [[ "$FORCE_ULTRACODE" == "off" ]] && USE_ULTRA=0
  say "fixer: $USE_MODEL @ $USE_EFFORT$([[ "$USE_ULTRA" == "1" ]] && echo ' +ultracode')"

  # `ultracode` is a standing opt-in the fixer's own session reads: it may fan work out to parallel
  # subagents and verify each diagnosis adversarially before committing. Only routed in where a
  # single pass has already been PROVEN wrong (a regression, or 2+ failed attempts) — everywhere
  # else it is a large bill for a conclusion one careful read would have reached.
  ULTRA_LINE=""
  [[ "$USE_ULTRA" == "1" ]] && ULTRA_LINE="
ultracode: this round has already defeated at least one fix attempt, so do not trust a single
reading of the trace. Fan the diagnosis out and have the candidates argue before you commit."

  # Built as a quoted string, not a heredoc: bash 3.2 cannot parse a heredoc inside `$(...)`.
  FIX_PROMPT="Read playtest/auto/FIX-AGENT.md — it is your brief, and it binds you.$ULTRA_LINE

Your work order for this round is $TRIAGE_MD. The per-scenario evidence is beside it:
$REPORTS/$ROUND_ID-<scenario>.json (every turn's events, TurnTrace, and state snapshot).

Close the actionable findings, add a regression test for each behavioural fix, keep
'bun run typecheck' and 'bun test' green, and commit once with a Conventional Commits message.
Then reply with the summary block FIX-AGENT.md specifies and nothing else."
  CLAUDE_ARGS=(-p "$FIX_PROMPT" --model "$USE_MODEL" --effort "$USE_EFFORT" --dangerously-skip-permissions)
  # Variadic — keep it last, or it swallows the flags after it.
  CLAUDE_ARGS+=(--disallowed-tools
    "Bash(git push:*)" "Bash(git stash:*)" "Bash(git reset:*)"
    "Bash(git checkout:*)" "Bash(git branch:*)" "Bash(git rebase:*)" "Bash(rm -rf:*)")

  BEFORE_SHA="$(git rev-parse --short HEAD)"
  if ! claude "${CLAUDE_ARGS[@]}" 2>&1 | tee "$FIX_LOG" | tee -a "$LOOP_LOG"; then
    die "fix agent exited non-zero — tree left as-is, see $FIX_LOG"
  fi
  # `claude -p` prints only the final assistant message, and FIX-AGENT.md asks for the summary in a
  # fenced block whose FIRST line is the headline. Two earlier passes at this both read from the
  # top: taking the first non-blank line stored the literal ```, and skipping fences and labels
  # stored whatever prose the fixer wrote ABOVE the block ("Committed f82e7d7. Only the loop-owned
  # ledger.json remains unstaged" — round 2026-08-02T17-14-58). Both blank the ledger's memory of
  # WHY a fix was attempted, which is exactly what the next round's "your predecessor's diagnosis
  # was wrong" rule reads. Anchor on the block instead: the headline is the last content line
  # ABOVE the first `closed:`/`left:`/`tests:` label, whatever preamble precedes the fence. No
  # label at all (a fixer that ignored the shape) falls back to the first content line.
  FIX_NOTE="$(awk '
    /^[[:space:]]*```/ { next }
    /^[[:space:]]*$/   { next }
    /^[[:space:]]*(closed|left|tests):/ {
      if (!emitted) { print (cand != "" ? cand : first); emitted = 1 }
      next
    }
    { if (first == "") first = $0; cand = $0 }
    END { if (!emitted) print first }
  ' "$FIX_LOG" | head -1 | cut -c1-160)"

  # --- gate ------------------------------------------------------------------------------------
  say "════ round $round/$ROUNDS · gate ════"
  if ! bun run typecheck 2>&1 | tee -a "$LOOP_LOG"; then
    die "typecheck RED after the fix stage — tree left as-is for you to inspect"
  fi
  if ! bun test 2>&1 | tail -30 | tee -a "$LOOP_LOG"; then
    die "bun test RED after the fix stage — tree left as-is for you to inspect"
  fi

  # --- commit ----------------------------------------------------------------------------------
  if [[ -n "$(git status --porcelain)" ]]; then
    say "fixer left changes uncommitted — committing them as the round's commit"
    git add -A
    git commit -q -m "fix(playtest): round $ROUND_ID — $ACTIONABLE finding(s) from the auto loop" \
      -m "${FIX_NOTE:-Automated fix round; see playtest/auto/reports/$ROUND_ID-triage.md}"
  fi
  AFTER_SHA="$(git rev-parse --short HEAD)"
  if [[ "$AFTER_SHA" == "$BEFORE_SHA" ]]; then
    say "fixer changed nothing this round"
  else
    # Recorded as its own commit, not an amend — amending would move the sha the ledger just wrote.
    bun "$HERE/triage.ts" --record-fix "$AFTER_SHA" --round "$ROUND_ID" --note "$FIX_NOTE" 2>&1 | tee -a "$LOOP_LOG"
    git add "$HERE/ledger.json"
    git commit -q -m "chore(playtest): ledger — round $ROUND_ID fixed at $AFTER_SHA" || true
    say "round $ROUND_ID committed as $AFTER_SHA"
  fi
done

# Reached by every `break` above as well as the natural end, so one call covers the converged,
# unmeasured, and --no-fix exits. A no-op when the fix stage already committed this round's fold.
commit_ledger "${ROUND_ID:-}"

say "done — ledger: $HERE/ledger.json · log: $LOOP_LOG"
bun "$HERE/triage.ts" --status | tee -a "$LOOP_LOG"
