/**
 * Automated playtest harness — the run loop (Concordia transfer #5).
 *
 * `runScenario` drives one headless run: driver → `engine.submitPlayerInput` → recorder, until the
 * driver declares done, goes stuck, or the turn cap lands. Engine composition is the caller's
 * (live gateway for real runs, the deterministic test gateway for specs) — the loop itself is
 * model-agnostic and never reads the clock beyond wall-time bookkeeping.
 *
 * @author Runkai Zhang
 */
import { GameEngine } from "../../src/engine/engine.ts";
import type { LlmGateway } from "../../src/llm/gateway.ts";
import { makeLlmClassifier, type TurnClassifier } from "../../src/engine/classify.ts";
import type { PlaySet } from "../../src/content/schema.ts";
import { mulberry32 } from "../../src/rules/dice.ts";
import { InMemoryGameStateStore } from "../../tests/support/memory-store.ts";
import { RunRecorder, snapshotOf } from "./recorder.ts";
import type { Driver } from "./driver.ts";
import { driverViewOf } from "./driver.ts";
import { COVERAGE_FLOOR } from "./ledger.ts";
import type { RecordedRun, Scenario } from "./types.ts";

export interface HarnessDeps {
  playset: PlaySet;
  gateway: LlmGateway;
  /** Omit for the product LLM classifier; tests inject the deterministic DSL classifier. */
  classifier?: TurnClassifier;
  systemPrefix?: string;
  /** Progress hook (CLI prints a line per turn). */
  onTurn?: (turn: number, input: string, ms: number) => void;
  /**
   * How deep this run must go before a driver "done" is honoured — `coverageTargetFor` over the
   * standing ledger. Omitted (specs, ad-hoc probes) ⇒ the blunt `COVERAGE_FLOOR`, as before.
   */
  coverageTarget?: number;
}

/** Build the engine + recorder pair for a scenario. Exported so specs can compose it directly. */
export function buildRun(scenario: Scenario, deps: HarnessDeps): { engine: GameEngine; recorder: RunRecorder } {
  let recorderRef: RunRecorder | undefined;
  // The product's classifier composition (cli/main.ts, web/session.ts): the LLM classifier over
  // the same gateway, fallback → console. The engine's OWN default is freeform-only — the first
  // two live harness runs ran on it by omission, which read as "every line classified freeform"
  // (0 fallbacks) and hid the real classifier from the measurement entirely. A harness that does
  // not classify like the product does not measure the product.
  const classifier =
    deps.classifier ??
    makeLlmClassifier(deps.gateway, (reason) => console.error(`[classifier fallback] ${reason}`));
  const engine = new GameEngine({
    playset: deps.playset,
    store: new InMemoryGameStateStore(),
    gateway: deps.gateway,
    classifier,
    rng: mulberry32(scenario.seed),
    // The product's judge composition (cli/main.ts, web/session.ts): the Continuity Judge is
    // default-ON in every shipped composition, and it is the enforcement layer for the exact
    // classes the rubric scores (castPresence, journeyFabrication, verbatimRepeat, phantomState).
    // The r12 sweep ran WITHOUT it by omission, so every turn shipped unadjudicated Tier-1 prose —
    // the audit findings measured a composition no player ever runs. A harness that does not
    // judge like the product does not measure the product (the classifier doctrine above).
    continuityJudge: true,
    ...(deps.systemPrefix ? { systemPrefix: deps.systemPrefix } : {}),
    onTurnTrace: (trace) => recorderRef?.onTrace(trace),
  });
  const recorder = new RunRecorder(scenario, engine);
  recorderRef = recorder;
  engine.subscribe((e) => recorder.onEvent(e));
  return { engine, recorder };
}

export async function runScenario(scenario: Scenario, driver: Driver, deps: HarnessDeps): Promise<RecordedRun> {
  const { engine, recorder } = buildRun(scenario, deps);
  await engine.start();
  const initial = snapshotOf(engine, scenario.characterId);
  let stopped: RecordedRun["stopped"] = "maxTurns";
  let error: string | undefined;

  const playTurn = async (line: string): Promise<void> => {
    recorder.beginTurn(line);
    const t0 = Date.now();
    await engine.submitPlayerInput(line);
    recorder.endTurn();
    deps.onTurn?.(recorder.turnsSoFar().length, line, Date.now() - t0);
  };

  // A finding is cleared only by a run that reached past its own evidence depth AND past half the
  // turn cap (COVERAGE_FLOOR) — anything shallower reports UNMEASURED. The driver stops the moment
  // it judges the goal met, and the BETTER the engine gets the sooner that happens, so rounds were
  // measuring less as the engine improved: the 2026-08-02 loop ran fixture-social 4/20 and fixture-trade
  // 5/16, went 13 findings unmeasured, and cleared nothing at full price. Past the goal the driver
  // keeps playing, in character, to the cap. This changes COVERAGE, not scoring: the scenario's
  // goal is untouched (scenarios.ts is a measurement file) and no verdict rule moves.
  //
  // The floor alone was not enough. The FOLD clears a finding only past `coverageNeededFor` — the
  // deeper of the floor and the finding's own evidence depth — so anything ever seen past half the
  // cap could never be cleared however well the engine behaved: the 2026-08-04 loop stopped
  // fixture-combat at 11/20 needing 12/16/20 and fixture-social at 12/20 needing 16. `coverageTarget` is what
  // the ledger will actually demand of this scenario; the floor is the default when nobody says.
  const coverageFloorTurns = Math.ceil(COVERAGE_FLOOR * scenario.maxTurns);
  const coverageTarget = Math.min(scenario.maxTurns, Math.max(coverageFloorTurns, deps.coverageTarget ?? 0));
  let goalMetNote: string | undefined;
  let goalMetAtTurn = 0;
  // Bounded: a driver that insists it is done twice running has genuinely nothing left, and
  // fighting it further would only feed the engine filler.
  let doneInsistences = 0;

  try {
    for (const opener of scenario.openers ?? []) await playTurn(opener);
    while (recorder.turnsSoFar().length < scenario.maxTurns) {
      const played = recorder.turnsSoFar().length;
      const view = driverViewOf(
        [...recorder.turnsSoFar()],
        snapshotOf(engine, scenario.characterId),
        scenario.maxTurns,
        undefined,
        undefined,
        goalMetNote,
      );
      const line = await driver.next(view);
      if (line === null) {
        // A stuck driver (no note) is producing nothing usable — stop, as before.
        if (driver.note === undefined) {
          stopped = "driverStuck";
          break;
        }
        if (played >= coverageTarget || doneInsistences >= 1) {
          stopped = "driverDone";
          break;
        }
        doneInsistences += 1;
        goalMetNote = driver.note;
        goalMetAtTurn = played;
        continue;
      }
      doneInsistences = 0;
      await playTurn(line);
    }
  } catch (err) {
    stopped = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  // Fold the goal-met moment into the note rather than adding a field: `types.ts` is a measurement
  // file, and this is a coverage change that must not move the measurement hash.
  const note =
    goalMetNote !== undefined
      ? `goal met at t${goalMetAtTurn} ("${goalMetNote}") — play continued for coverage${driver.note !== undefined && driver.note !== goalMetNote ? `; later: ${driver.note}` : ""}`
      : driver.note;

  return recorder.finish(initial, stopped, {
    ...(note !== undefined ? { driverNote: note } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}
