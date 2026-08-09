/**
 * Automated playtest harness — shared types (Concordia transfer #5).
 *
 * A Scenario is one headless run: an LLM PC-driver plays toward a stated goal against the live
 * model, every turn is recorded (events, deltas, traces, state snapshots), and a rubric scores the
 * completed run against the failure classes `docs/PROSE-TO-CODE.md` names. The rubric reads the
 * TRACE and the DELTA LOG wherever a failure class has a mechanical signature; an LLM judge is only
 * for prose-quality questions (optional, `--judge`). Concordia's own warning is the design bar:
 * Seed is Dramatist — the harness scores the failure classes, never the fiction.
 *
 * @author Runkai Zhang
 */
import type { GameEvent } from "../../src/events/types.ts";
import type { TurnTrace } from "../../src/logging/types.ts";

/** One headless playtest run definition. */
export interface Scenario {
  id: string;
  /** World directory (absolute or repo-relative), as `bun src/cli/main.ts <dir>` takes. */
  worldDir: string;
  /** The PC the save is keyed on (must exist in the campaign roster). */
  characterId: string;
  /** What the driver is trying to accomplish, stated as the player would think it. */
  goal: string;
  /** Who the driver is playing — voice, temperament, risk appetite. */
  persona: string;
  /** Hard turn cap (live tokens are real money — keep modest). */
  maxTurns: number;
  /** Engine rng seed — mechanics reproduce run-to-run; the live model of course does not. */
  seed: number;
  /** Optional fixed opening lines submitted before the driver takes over (scene setup). */
  openers?: string[];
}

/** Everything one player turn produced, as the recorder saw it. */
export interface RecordedTurn {
  turn: number;
  input: string;
  /** Wall-clock ms for the whole submitPlayerInput round trip. */
  ms: number;
  /** Every bus event the turn emitted (narration, dialogue, dice, stateChanged, system, deltas). */
  events: GameEvent[];
  /** The TurnTraces emitted while this turn ran (player tick + any heartbeat that slipped in). */
  traces: TurnTrace[];
  /** Snapshot AFTER the turn committed. */
  after: StateSnapshot;
}

/** The rubric-relevant slice of engine state at a turn boundary. */
export interface StateSnapshot {
  locationId: string | null;
  hp: number | null;
  coins: number | null;
  clock: number | null;
  combatActive: boolean;
  questStates: Record<string, string>;
}

/** A completed run, ready for scoring. */
export interface RecordedRun {
  scenario: Scenario;
  startedAt: number;
  endedAt: number;
  turns: RecordedTurn[];
  /** Snapshot before turn 1 (the baseline the first turn's diffs read against). */
  initial: StateSnapshot;
  /** Why the loop stopped. */
  stopped: "maxTurns" | "driverDone" | "driverStuck" | "error";
  /** The driver's own `DONE:` note, if it declared the goal met/abandoned. */
  driverNote?: string;
  /** Fatal error text when stopped === "error". */
  error?: string;
}

/** One rubric finding — a concrete turn where a failure-class signature matched. */
export interface Finding {
  /** Failure class key (stable across runs, so reports stay comparable). */
  class: FailureClass;
  turn: number;
  /** One-line statement of what matched. */
  summary: string;
  /** Short excerpt (prose or trace field) as evidence. */
  evidence?: string;
  /**
   * The stable WITHIN-CLASS discriminator — the auditor kind, the grounding reason, the classifier
   * kind that relocated the party. Turn numbers and prose excerpts move run to run; this does not,
   * so `fingerprint()` can decide across rounds whether a finding is the SAME finding coming back
   * or a fresh one. Optional so reports recorded before the loop harness still fold in (the
   * fingerprinter falls back to a normalized summary).
   */
  key?: string;
  /**
   * `confirmed` = the mechanical signature is unambiguous; `review` = the signature is a strong
   * smell but needs a human (or judge) look — the rubric flags, it does not convict.
   */
  confidence: "confirmed" | "review";
}

export type FailureClass =
  | "swallowed-travel"
  | "involuntary-relocation"
  | "free-prose-payment"
  | "audit-violation"
  | "classifier-fallback"
  | "grounding-fallback"
  | "stranded-scene"
  | "npc-action-rejected"
  | "state-inert";

/** Aggregate numbers a wave can regress against. */
export interface RunStats {
  turns: number;
  wallMsTotal: number;
  wallMsMean: number;
  wallMsP90: number;
  classifierKinds: Record<string, number>;
  fallbackTurns: number;
  /** Module time totals (ms) summed over the run, descending — the prose-entities finding's view. */
  moduleCostMs: Record<string, number>;
  /**
   * Director acts HELD for the player's word this run, keyed `command/path` (r9 F-1's consent
   * gate, `src/modules/autonomy/consent.ts`). The complement of `involuntary-relocation`: that
   * scorer counts the times autonomy took a decision, this counts the times it wanted to and
   * waited. A run with zero of both means the Director never pushed; zero relocations with a
   * non-zero count here is the gate doing its job.
   */
  consentBlocks: Record<string, number>;
  findingsByClass: Record<string, number>;
}

/** The scored report for one run. */
export interface RubricReport {
  scenarioId: string;
  stats: RunStats;
  findings: Finding[];
  /** Optional LLM-judge section (prose quality; absent unless --judge). */
  judge?: JudgeReport;
}

/** The judge's dramatist scorecard — quality dimensions, 0–3 each, with quoted evidence. */
export interface JudgeReport {
  scores: Record<string, number>;
  notes: string[];
  worstMoment?: string;
}
