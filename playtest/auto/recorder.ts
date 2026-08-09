/**
 * Automated playtest harness — run recorder (Concordia transfer #5).
 *
 * Buffers everything the engine surfaces during a headless run: bus events (deltas included — they
 * ride the bus as silent events), TurnTraces (via the engine's `onTurnTrace` dep), and a per-turn
 * state snapshot. Pure accumulation — the recorder never touches the engine beyond reads, so it can
 * never perturb the run it is measuring.
 *
 * @author Runkai Zhang
 */
import type { GameEngine } from "../../src/engine/engine.ts";
import type { GameEvent } from "../../src/events/types.ts";
import type { TurnTrace } from "../../src/logging/types.ts";
import type { RecordedRun, RecordedTurn, Scenario, StateSnapshot } from "./types.ts";

/** Reads the rubric-relevant slice of engine state. Defensive throughout — a missing field is null. */
export function snapshotOf(engine: GameEngine, characterId: string): StateSnapshot {
  const state = engine.getState();
  const pc = state.actors?.[characterId];
  const combat = state.modules?.combat as { active?: boolean } | undefined;
  const questStates: Record<string, string> = {};
  for (const [id, q] of Object.entries(state.quests ?? {})) {
    const s = (q as { state?: string })?.state;
    if (typeof s === "string") questStates[id] = s;
  }
  return {
    locationId: state.partyLocationId ?? null,
    hp: typeof pc?.currentHp === "number" ? pc.currentHp : null,
    coins: typeof pc?.coins === "number" ? pc.coins : null,
    clock: typeof state.clock === "number" ? state.clock : null,
    combatActive: combat?.active === true,
    questStates,
  };
}

export class RunRecorder {
  private events: GameEvent[] = [];
  private traces: TurnTrace[] = [];
  private turns: RecordedTurn[] = [];
  private turnStartedAt = 0;
  private currentInput: string | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly scenario: Scenario,
    private readonly engine: GameEngine,
  ) {}

  /** Wire into the engine constructor: `onTurnTrace: (t) => recorder.onTrace(t)`. */
  onTrace(trace: TurnTrace): void {
    this.traces.push(trace);
  }

  /** Wire into `engine.subscribe`. */
  onEvent(event: GameEvent): void {
    this.events.push(event);
  }

  beginTurn(input: string): void {
    this.currentInput = input;
    this.turnStartedAt = Date.now();
    this.events = [];
    this.traces = [];
  }

  endTurn(): void {
    if (this.currentInput === null) return;
    this.turns.push({
      turn: this.turns.length + 1,
      input: this.currentInput,
      ms: Date.now() - this.turnStartedAt,
      events: this.events,
      traces: this.traces,
      after: snapshotOf(this.engine, this.scenario.characterId),
    });
    this.currentInput = null;
    this.events = [];
    this.traces = [];
  }

  /** The turns recorded so far (live view — the driver's window reads this). */
  turnsSoFar(): readonly RecordedTurn[] {
    return this.turns;
  }

  finish(
    initial: StateSnapshot,
    stopped: RecordedRun["stopped"],
    extra?: { driverNote?: string; error?: string },
  ): RecordedRun {
    return {
      scenario: this.scenario,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      turns: this.turns,
      initial,
      stopped,
      ...(extra?.driverNote !== undefined ? { driverNote: extra.driverNote } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
    };
  }
}
