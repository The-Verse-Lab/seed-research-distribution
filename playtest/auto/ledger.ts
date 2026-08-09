/**
 * Automated playtest loop — the standing findings ledger (the loop's memory).
 *
 * A sweep report is a photograph; the ledger is the film. It carries, per fingerprint, when the
 * finding was first seen, every round it appeared or was clear, every fix attempt aimed at it, and
 * whether it has come back after being called fixed. That history is what lets round N+1 say
 * something round N could not:
 *
 *   - NEW         — never seen before this round.
 *   - RECURRING   — open, and the last round saw it too. A fix aimed at it did not take.
 *   - REGRESSED   — was clear at the end of a previous round and is back. Something undid it.
 *   - FIXED       — was open, the scenario ran, and it did not appear. Provisional, not proven.
 *   - FLAKY       — has oscillated clear/present 3+ times. The live model is the variable, not the
 *                   code; chasing these burns rounds. Reported apart and never handed to the fixer.
 *
 * The FIXED verdict is deliberately weak-worded. One live run is one sample against a nondeterministic
 * model, so absence is evidence, not proof — the ledger records `clearedRounds` so a fix that holds
 * over three rounds is visibly stronger than one that held over one.
 *
 * Measurement-integrity guard: every round records a hash of the SCORING surface (rubric, scenarios,
 * types, judge). If it moved between rounds, the round's FIXED verdicts are stamped unverified —
 * findings can vanish because the bug went away or because the scorer stopped looking, and an
 * automated loop with a fixer in it has every incentive to confuse the two.
 *
 * Pure data in, pure data out (`foldRound`), so the whole loop's bookkeeping is unit-testable
 * without a model, a gateway, or a clock.
 *
 * @author Runkai Zhang
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fingerprint, groupByFingerprint } from "./fingerprint.ts";
import type { FailureClass, Finding, RubricReport } from "./types.ts";

export const LEDGER_PATH = fileURLToPath(new URL("ledger.json", import.meta.url));

/** Files whose content defines what "a finding" means. A change here invalidates FIXED verdicts. */
export const MEASUREMENT_FILES = ["rubric.ts", "scenarios.ts", "types.ts", "judge.ts", "fingerprint.ts"];

export type EntryStatus = "open" | "fixed" | "muted";

/** One fix attempt the loop aimed at a fingerprint (whether or not it worked). */
export interface FixAttempt {
  round: string;
  commit: string;
  /** The fixer's own one-line account of what it changed, when it left one. */
  note?: string;
}

/** The standing record for one failure mode in one scenario. */
export interface LedgerEntry {
  fp: string;
  scenarioId: string;
  class: FailureClass;
  status: EntryStatus;
  firstRound: string;
  /** Last round in which the finding appeared. */
  lastSeenRound: string;
  /** Last round in which the scenario ran and the finding did NOT appear. */
  lastClearRound?: string;
  /** Rounds seen / rounds run-clean — a fix that has held three rounds reads stronger than one. */
  seenRounds: number;
  clearedRounds: number;
  /** Times it came back after being marked fixed. */
  regressions: number;
  /** Present→clear→present transitions. 3+ means the live model is the variable, not the code. */
  oscillations: number;
  /** Occurrences in the most recent round that saw it. */
  lastCount: number;
  fixAttempts: FixAttempt[];
  /** Most recent exemplar — what the fixer reads. */
  exampleSummary: string;
  exampleEvidence?: string;
  exampleTurns: number[];
  confidence: Finding["confidence"];
  /** Free-text human note (why muted, what the real cause is, a link to a doc section). */
  note?: string;
}

/** Compact per-scenario numbers, kept per round so the loop can plot drift without the JSON blobs. */
export interface RoundScenarioStats {
  scenarioId: string;
  turns: number;
  maxTurns: number;
  stopped: string;
  fallbackTurns: number;
  wallMsMean: number;
  findings: number;
  judge?: Record<string, number>;
}

export interface RoundRecord {
  round: string;
  /** HEAD when the sweep started — the tree the findings describe. */
  commit: string;
  /** Hash of the scoring surface at sweep time. */
  measurementHash: string;
  scenarios: RoundScenarioStats[];
  /** Fingerprints handed to the fixer this round (so `recordFix` knows what a commit was aiming at). */
  actionable: string[];
  /** The fix commit the loop made after this round's triage, once it exists. */
  fixCommit?: string;
}

export interface Ledger {
  version: 1;
  rounds: RoundRecord[];
  entries: Record<string, LedgerEntry>;
}

export function emptyLedger(): Ledger {
  return { version: 1, rounds: [], entries: {} };
}

export function loadLedger(path = LEDGER_PATH): Ledger {
  if (!existsSync(path)) return emptyLedger();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Ledger;
    if (raw.version !== 1 || typeof raw.entries !== "object") return emptyLedger();
    return { version: 1, rounds: raw.rounds ?? [], entries: raw.entries ?? {} };
  } catch {
    // A corrupt ledger must not stop a sweep; the loop reports it and starts a fresh film.
    return emptyLedger();
  }
}

export function saveLedger(ledger: Ledger, path = LEDGER_PATH): void {
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Hash the scoring surface. Pure over the file contents the caller reads. */
export function measurementHashOf(contents: string[]): string {
  const h = createHash("sha256");
  for (const c of contents) h.update(c);
  return h.digest("hex").slice(0, 12);
}

/** One scenario's contribution to a round. */
export interface RoundInput {
  round: string;
  commit: string;
  measurementHash: string;
  reports: Array<{ report: RubricReport; turns: number; maxTurns: number; stopped: string }>;
}

export type Verdict = "new" | "recurring" | "regressed" | "fixed" | "flaky" | "unmeasured";

/** Why a run was too shallow to clear a finding — attached to an `unmeasured` verdict. */
export interface CoverageGap {
  turns: number;
  maxTurns: number;
  /** Turns the run had to reach before its silence meant anything. */
  needed: number;
}

export interface TriageItem {
  verdict: Verdict;
  entry: LedgerEntry;
  /** Occurrences this round (0 for a `fixed` or `unmeasured` verdict). */
  count: number;
  /** Set only on `unmeasured` — how far short the run fell. */
  coverage?: CoverageGap;
}

export interface TriageResult {
  round: string;
  ledger: Ledger;
  items: TriageItem[];
  /** The subset the fixer should work: new + recurring + regressed, confirmed first, flaky excluded. */
  actionable: TriageItem[];
  /** True when the scoring surface moved since the previous round — FIXED verdicts are unverified. */
  measurementChanged: boolean;
  previousRound?: RoundRecord;
  scenarioStats: RoundScenarioStats[];
}

/** Findings the fixer should never chase: model-variance oscillators and anything muted by hand. */
const FLAKY_OSCILLATIONS = 3;

/**
 * Fraction of a scenario's turn cap a run must reach before its SILENCE counts as evidence.
 *
 * A scenario stops early when the driver declares the goal met, and the engine getting better makes
 * that happen sooner — the 2026-08-02 loop finished `fixture-work` in 2 turns of 20 (the work was really
 * taken and really paid). The old rule asked only "did the scenario run", so those 2 turns cleared
 * four findings that never had a turn to fire in. A finding is not fixed because nobody looked.
 */
export const COVERAGE_FLOOR = 0.5;

/**
 * How deep a run must go before this entry's absence means anything: past the deepest turn the
 * finding has ever been seen at, and past the blunt floor. Self-calibrating — a finding that only
 * ever fires at t13 is not cleared by a run that stopped at t8.
 */
export function coverageNeededFor(entry: LedgerEntry, maxTurns: number): number {
  const deepestEvidence = entry.exampleTurns.length > 0 ? Math.max(...entry.exampleTurns) : 0;
  return Math.max(deepestEvidence, Math.ceil(COVERAGE_FLOOR * maxTurns));
}

/**
 * How deep a run of `scenarioId` must go for its silence to clear everything the ledger is holding
 * against it — the deepest `coverageNeededFor` over that scenario's live entries.
 *
 * The harness used to push the driver past the goal only as far as `COVERAGE_FLOOR`, while this is
 * the depth the fold actually demands. Anything whose evidence sat deeper than half the cap was
 * therefore UNCLEARABLE no matter how well the engine behaved: the 2026-08-04 loop stopped fixture-combat
 * at 11/20 needing 12/16/20 and fixture-social at 12/20 needing 16, and reported four findings unmeasured
 * two rounds running. Coverage, not scoring — no verdict rule moves, and a scenario whose entries
 * are all shallow still stops at the floor.
 *
 * Muted entries are excluded: nobody is waiting on their verdict, so they must not buy turns.
 */
export function coverageTargetFor(ledger: Ledger, scenarioId: string, maxTurns: number): number {
  const live = Object.values(ledger.entries).filter((e) => e.scenarioId === scenarioId && e.status !== "muted");
  const deepest = live.reduce((acc, e) => Math.max(acc, coverageNeededFor(e, maxTurns)), 0);
  return Math.min(maxTurns, Math.max(Math.ceil(COVERAGE_FLOOR * maxTurns), deepest));
}

/**
 * Fold one round of reports into the ledger and classify every fingerprint it touched.
 *
 * Pure: returns a NEW ledger object; the caller decides whether to persist it. `previous` is read
 * only for the measurement-hash comparison and the "was it in the last round" recurring/returned
 * distinction.
 */
export function foldRound(prior: Ledger, input: RoundInput): TriageResult {
  const ledger: Ledger = {
    version: 1,
    rounds: [...prior.rounds],
    entries: Object.fromEntries(Object.entries(prior.entries).map(([k, v]) => [k, { ...v, fixAttempts: [...v.fixAttempts] }])),
  };
  const previousRound = ledger.rounds[ledger.rounds.length - 1];
  const measurementChanged = previousRound !== undefined && previousRound.measurementHash !== input.measurementHash;
  const runByScenario = new Map(input.reports.map((r) => [r.report.scenarioId, { turns: r.turns, maxTurns: r.maxTurns }]));
  const items: TriageItem[] = [];

  for (const { report } of input.reports) {
    const grouped = groupByFingerprint(report.scenarioId, report.findings);
    for (const [fp, g] of grouped) {
      const existing = ledger.entries[fp];
      if (!existing) {
        const entry: LedgerEntry = {
          fp,
          scenarioId: report.scenarioId,
          class: g.exemplar.class,
          status: "open",
          firstRound: input.round,
          lastSeenRound: input.round,
          seenRounds: 1,
          clearedRounds: 0,
          regressions: 0,
          oscillations: 0,
          lastCount: g.count,
          fixAttempts: [],
          exampleSummary: g.exemplar.summary,
          ...(g.exemplar.evidence !== undefined ? { exampleEvidence: g.exemplar.evidence } : {}),
          exampleTurns: g.turns,
          confidence: g.exemplar.confidence,
        };
        ledger.entries[fp] = entry;
        items.push({ verdict: "new", entry, count: g.count });
        continue;
      }

      const wasFixed = existing.status === "fixed";
      const entry: LedgerEntry = {
        ...existing,
        status: existing.status === "muted" ? "muted" : "open",
        lastSeenRound: input.round,
        seenRounds: existing.seenRounds + 1,
        lastCount: g.count,
        regressions: existing.regressions + (wasFixed ? 1 : 0),
        oscillations: existing.oscillations + (wasFixed ? 1 : 0),
        exampleSummary: g.exemplar.summary,
        exampleTurns: g.turns,
        confidence: g.exemplar.confidence,
      };
      if (g.exemplar.evidence !== undefined) entry.exampleEvidence = g.exemplar.evidence;
      ledger.entries[fp] = entry;
      const flaky = entry.oscillations >= FLAKY_OSCILLATIONS;
      items.push({ verdict: flaky ? "flaky" : wasFixed ? "regressed" : "recurring", entry, count: g.count });
    }
  }

  // Anything open whose scenario ran clean this round — and ran FAR ENOUGH for that to mean anything.
  const seenThisRound = new Set(items.map((i) => i.entry.fp));
  for (const entry of Object.values(ledger.entries)) {
    if (seenThisRound.has(entry.fp)) continue;
    const run = runByScenario.get(entry.scenarioId);
    if (!run) continue; // scenario skipped — no evidence either way
    const needed = coverageNeededFor(entry, run.maxTurns);
    if (run.turns < needed) {
      // The run ended before this finding's own evidence depth. Silence here is absence of
      // measurement, not absence of the bug: no clear credited, no oscillation counted, no verdict.
      items.push({ verdict: "unmeasured", entry, count: 0, coverage: { turns: run.turns, maxTurns: run.maxTurns, needed } });
      continue;
    }
    if (entry.status !== "open") {
      // Already fixed or muted, still clear: strengthen the record, stay quiet.
      ledger.entries[entry.fp] = { ...entry, clearedRounds: entry.clearedRounds + 1, lastClearRound: input.round };
      continue;
    }
    const cleared: LedgerEntry = {
      ...entry,
      status: "fixed",
      lastClearRound: input.round,
      clearedRounds: entry.clearedRounds + 1,
      oscillations: entry.oscillations + (entry.seenRounds > 0 ? 1 : 0),
    };
    ledger.entries[entry.fp] = cleared;
    items.push({ verdict: "fixed", entry: cleared, count: 0 });
  }

  const scenarioStats: RoundScenarioStats[] = input.reports.map(({ report, turns, maxTurns, stopped }) => ({
    scenarioId: report.scenarioId,
    turns,
    maxTurns,
    stopped,
    fallbackTurns: report.stats.fallbackTurns,
    wallMsMean: report.stats.wallMsMean,
    findings: report.findings.length,
    ...(report.judge ? { judge: report.judge.scores } : {}),
  }));

  const actionable = items
    .filter((i) => i.verdict === "new" || i.verdict === "recurring" || i.verdict === "regressed")
    .filter((i) => i.entry.status !== "muted")
    .sort(rankActionable);

  ledger.rounds.push({
    round: input.round,
    commit: input.commit,
    measurementHash: input.measurementHash,
    scenarios: scenarioStats,
    actionable: actionable.map((i) => i.entry.fp),
  });

  return {
    round: input.round,
    ledger,
    items,
    actionable,
    measurementChanged,
    ...(previousRound ? { previousRound } : {}),
    scenarioStats,
  };
}

/**
 * Rebuild the whole ledger from every round's reports under the CURRENT rules, preserving the
 * history a rebuild cannot re-derive: which commit was aimed at which round, the fixer's note, and
 * any hand mutes.
 *
 * Needed whenever a fold rule changes underneath a ledger that was written by the old one. The
 * coverage rule is the case in point: rounds already on disk recorded FIXED verdicts earned by runs
 * that stopped before the finding's own evidence depth, and those entries stay wrong forever
 * otherwise — worse, a reappearance would be labelled REGRESSED, escalating the fixer over a
 * regression that never happened.
 *
 * `actionable` is unaffected by the coverage rule (an absent finding was never actionable), so fix
 * attempts re-attach to exactly the fingerprints they were originally aimed at.
 */
export function recheckLedger(prior: Ledger, rounds: RoundInput[]): Ledger {
  const noteFor = new Map<string, string>();
  for (const e of Object.values(prior.entries)) {
    for (const a of e.fixAttempts) if (a.note !== undefined && !noteFor.has(a.round)) noteFor.set(a.round, a.note);
  }
  const mutes = Object.values(prior.entries)
    .filter((e) => e.status === "muted")
    .map((e) => [e.fp, e.note ?? "muted (reason not recorded)"] as const);

  let rebuilt = emptyLedger();
  for (const input of rounds) {
    rebuilt = foldRound(rebuilt, input).ledger;
    const fixCommit = prior.rounds.find((r) => r.round === input.round)?.fixCommit;
    if (fixCommit) rebuilt = recordFix(rebuilt, input.round, fixCommit, noteFor.get(input.round));
  }
  for (const [fp, note] of mutes) rebuilt = mute(rebuilt, fp, note);
  return rebuilt;
}

/** Status transitions a recheck produced — what the caller prints so the change is auditable. */
export function ledgerDiff(before: Ledger, after: Ledger): Array<{ fp: string; from: EntryStatus | "absent"; to: EntryStatus | "absent" }> {
  const fps = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  const out: Array<{ fp: string; from: EntryStatus | "absent"; to: EntryStatus | "absent" }> = [];
  for (const fp of [...fps].sort()) {
    const from = before.entries[fp]?.status ?? "absent";
    const to = after.entries[fp]?.status ?? "absent";
    if (from !== to) out.push({ fp, from, to });
  }
  return out;
}

/** Work order: regressions first (something broke), then confirmed, then volume. */
function rankActionable(a: TriageItem, b: TriageItem): number {
  const verdictRank: Record<Verdict, number> = { regressed: 0, new: 1, recurring: 2, fixed: 3, flaky: 4, unmeasured: 5 };
  if (a.verdict !== b.verdict) return verdictRank[a.verdict] - verdictRank[b.verdict];
  const conf = (i: TriageItem) => (i.entry.confidence === "confirmed" ? 0 : 1);
  if (conf(a) !== conf(b)) return conf(a) - conf(b);
  return b.count - a.count;
}

/**
 * Attach a fix attempt to every fingerprint a round handed the fixer. Called after the fix stage
 * commits, so the NEXT round's `recurring` verdict can say "you already tried this, at that sha".
 */
export function recordFix(ledger: Ledger, round: string, commit: string, note?: string): Ledger {
  const rec = ledger.rounds.find((r) => r.round === round);
  if (!rec) return ledger;
  const entries = { ...ledger.entries };
  for (const fp of rec.actionable) {
    const e = entries[fp];
    if (!e) continue;
    entries[fp] = { ...e, fixAttempts: [...e.fixAttempts, { round, commit, ...(note ? { note } : {}) }] };
  }
  const rounds = ledger.rounds.map((r) => (r.round === round ? { ...r, fixCommit: commit } : r));
  return { version: 1, rounds, entries };
}

/** Mute a fingerprint by hand — accepted noise, a known false positive, an out-of-scope class. */
export function mute(ledger: Ledger, fp: string, note: string): Ledger {
  const e = ledger.entries[fp];
  if (!e) return ledger;
  return { ...ledger, entries: { ...ledger.entries, [fp]: { ...e, status: "muted", note } } };
}
