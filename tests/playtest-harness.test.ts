/**
 * Auto-playtest harness — the run loop, offline. A ScriptDriver drives a real engine on the
 * deterministic test gateway; the spec pins that the loop records turns, traces ride the
 * `onTurnTrace` seam into the recorder, snapshots read real state, and the driver-view/prompt
 * builders hold their contract. No live model anywhere.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import {
  buildDriverMessages,
  DRIVER_DONE_PREFIX,
  driverViewOf,
  normalizeDriverLine,
  ScriptDriver,
} from "../playtest/auto/driver.ts";
import { buildRun, runScenario } from "../playtest/auto/harness.ts";
import { scoreRun } from "../playtest/auto/rubric.ts";
import type { Scenario } from "../playtest/auto/types.ts";

const EXAMPLE = fileURLToPath(new URL("fixtures/worlds/example", import.meta.url));

const scenario: Scenario = {
  id: "offline-smoke",
  worldDir: EXAMPLE,
  characterId: "pc.you",
  goal: "Look around and talk to someone.",
  persona: "A calm observer.",
  maxTurns: 5,
  seed: 7,
};

describe("auto-playtest harness (offline)", () => {
  test("a scripted run records every turn with traces and snapshots, then scores", async () => {
    const driver = new ScriptDriver(["I look around.", "I check my pack.", "I wait and listen."]);
    const run = await runScenario(scenario, driver, {
      playset: await loadPlaySetFromDir(EXAMPLE),
      gateway: new OfflineGateway(),
      classifier: heuristicClassifier,
    });
    expect(run.turns).toHaveLength(3);
    expect(run.stopped).toBe("driverStuck"); // a script running dry is not a declared DONE
    // Traces reached the recorder through the onTurnTrace seam.
    expect(run.turns[0]!.traces.length).toBeGreaterThan(0);
    expect(run.turns[0]!.traces[0]!.trigger).toBe("player");
    // Snapshots read real engine state.
    expect(run.turns[0]!.after.locationId).toBeTruthy();
    expect(typeof run.turns[0]!.after.combatActive).toBe("boolean");
    // Events were captured (the offline narrator echoes something every turn).
    expect(run.turns[0]!.events.some((e) => e.kind === "narration")).toBe(true);
    // The rubric runs over the recorded shape without throwing.
    const report = scoreRun(run);
    expect(report.stats.turns).toBe(3);
  });

  test("the harness composes the PRODUCT's judge, not a judge-less engine (r12)", async () => {
    // The r12 sweep ran without the Continuity Judge by omission, so every audit finding measured
    // a composition no player ever runs (the classifier doctrine in harness.ts, applied to the
    // judge). Pin the composition: the built engine must carry a judge.
    const { engine } = buildRun(scenario, {
      playset: await loadPlaySetFromDir(EXAMPLE),
      gateway: new OfflineGateway(),
      classifier: heuristicClassifier,
    });
    expect((engine as unknown as { judge?: object }).judge).toBeDefined();
  });

  test("maxTurns caps the loop even with an endless script", async () => {
    const driver = new ScriptDriver(Array.from({ length: 50 }, (_, i) => `I wait. (${i})`));
    const run = await runScenario({ ...scenario, maxTurns: 4 }, driver, {
      playset: await loadPlaySetFromDir(EXAMPLE),
      gateway: new OfflineGateway(),
      classifier: heuristicClassifier,
    });
    expect(run.turns).toHaveLength(4);
    expect(run.stopped).toBe("maxTurns");
  });

  test("openers run before the driver and count toward the cap", async () => {
    const driver = new ScriptDriver(["I nod."]);
    const run = await runScenario({ ...scenario, maxTurns: 3, openers: ["I stretch.", "I yawn."] }, driver, {
      playset: await loadPlaySetFromDir(EXAMPLE),
      gateway: new OfflineGateway(),
      classifier: heuristicClassifier,
    });
    expect(run.turns.map((t) => t.input)).toEqual(["I stretch.", "I yawn.", "I nod."]);
  });

  test("driver prompt carries goal, persona, recent play and the DONE affordance", () => {
    const view = driverViewOf([], { locationId: "loc.x", hp: 9, coins: 42, clock: 480, combatActive: true, questStates: {} }, 10);
    const msgs = buildDriverMessages(scenario, view);
    expect(msgs[0]!.content).toContain(scenario.goal);
    expect(msgs[0]!.content).toContain(scenario.persona);
    expect(msgs[0]!.content).toContain(DRIVER_DONE_PREFIX);
    expect(msgs[1]!.content).toContain("COMBAT IS ACTIVE");
    expect(msgs[1]!.content).toContain("opening turn");
  });

  test("normalizeDriverLine strips wrapping quotes and keeps one line", () => {
    expect(normalizeDriverLine('  "I ask about work."  ')).toBe("I ask about work.");
    expect(normalizeDriverLine("I nod.\nI also wave.")).toBe("I nod.");
    expect(normalizeDriverLine("“I pay the 2 gp.”")).toBe("I pay the 2 gp.");
  });

  // A finding is cleared only by a run past its own evidence depth AND past COVERAGE_FLOOR, and
  // the driver stops the moment it judges the goal met — so the BETTER the engine got, the less
  // each round measured. The 2026-08-02 loop ran fixture-social 4/20 and fixture-trade 5/16, went 13
  // findings UNMEASURED, and cleared nothing at full price. Past the goal the driver keeps playing.
  describe("coverage: a goal met early does not end the run", () => {
    /**
     * Declares DONE once it reaches `at`, then — like the real LlmDriver, which gets a prompt
     * telling it the goal is met and to keep playing — goes back to producing lines. With
     * `insist`, it never stops declaring, which is the case the harness must not fight forever.
     */
    class DoneAtDriver {
      note?: string;
      private declared = false;
      constructor(
        private readonly at: number,
        private readonly insist = false,
      ) {}
      next(view: { turn: number }): Promise<string | null> {
        if (view.turn >= this.at && (this.insist || !this.declared)) {
          this.declared = true;
          this.note = "goal reached";
          return Promise.resolve(null);
        }
        return Promise.resolve(`I keep going. (${view.turn})`);
      }
    }
    const deps = async () => ({
      playset: await loadPlaySetFromDir(EXAMPLE),
      gateway: new OfflineGateway(),
      classifier: heuristicClassifier,
    });

    test("DONE below the coverage floor keeps playing to the cap", async () => {
      // maxTurns 10 ⇒ floor 5. DONE on turn 3 must not end the run at 2 turns.
      const run = await runScenario({ ...scenario, maxTurns: 10 }, new DoneAtDriver(3), await deps());
      expect(run.turns.length).toBe(10);
      expect(run.stopped).toBe("maxTurns");
      // The goal-met moment is preserved, folded into the note (types.ts is a measurement file).
      expect(run.driverNote).toContain("goal met at t2");
      expect(run.driverNote).toContain("continued for coverage");
    });

    test("DONE at or past the coverage floor is honoured", async () => {
      const run = await runScenario({ ...scenario, maxTurns: 10 }, new DoneAtDriver(6), await deps());
      expect(run.turns.length).toBe(5);
      expect(run.stopped).toBe("driverDone");
      expect(run.driverNote).toBe("goal reached");
    });

    // The 2026-08-04 loop's real shape: fixture-combat capped at 20 pushed the driver only to the floor
    // (t10) and stopped at 11, while the fold needed 12/16/20 for the three findings it was holding
    // — unclearable by construction, twice running. The sweep now plays to the depth the ledger
    // will actually demand.
    test("DONE past the floor but short of the ledger's demand keeps playing", async () => {
      const run = await runScenario({ ...scenario, maxTurns: 10 }, new DoneAtDriver(6), {
        ...(await deps()),
        coverageTarget: 9,
      });
      expect(run.turns.length).toBe(10);
      expect(run.stopped).toBe("maxTurns");
      expect(run.driverNote).toContain("goal met at t5");
      expect(run.driverNote).toContain("continued for coverage");
    });

    test("a coverageTarget never lowers the floor, and DONE past it is still honoured", async () => {
      // Below the floor: the floor still governs, exactly as before.
      const shallow = await runScenario({ ...scenario, maxTurns: 10 }, new DoneAtDriver(6), {
        ...(await deps()),
        coverageTarget: 2,
      });
      expect(shallow.turns.length).toBe(5);
      expect(shallow.stopped).toBe("driverDone");

      // At the target: honoured, no filler turns bought.
      const met = await runScenario({ ...scenario, maxTurns: 10 }, new DoneAtDriver(8), {
        ...(await deps()),
        coverageTarget: 7,
      });
      expect(met.turns.length).toBe(7);
      expect(met.stopped).toBe("driverDone");
    });

    test("a driver that insists it is DONE twice is not fought further", async () => {
      const run = await runScenario({ ...scenario, maxTurns: 10 }, new DoneAtDriver(3, true), await deps());
      expect(run.stopped).toBe("driverDone");
      expect(run.turns.length).toBeLessThan(10);
    });

    test("a STUCK driver (no note) still stops immediately — no filler turns", async () => {
      const run = await runScenario({ ...scenario, maxTurns: 10 }, new ScriptDriver(["I look around."]), await deps());
      expect(run.stopped).toBe("driverStuck");
      expect(run.turns).toHaveLength(1);
    });

    test("past the goal the driver is told to keep playing, not to declare DONE again", () => {
      const view = driverViewOf([], { locationId: "l", hp: 9, coins: 1, clock: 480, combatActive: false, questStates: {} }, 10, undefined, undefined, "found the work");
      const msgs = buildDriverMessages(scenario, view);
      expect(msgs[0]!.content).toContain("GOAL IS ALREADY MET");
      expect(msgs[0]!.content).toContain("found the work");
      expect(msgs[0]!.content).toContain(`Do NOT reply ${DRIVER_DONE_PREFIX}`);
      // The scenario's own goal still rides along — the goal is NOT rewritten, only exhausted.
      expect(msgs[0]!.content).toContain(scenario.goal);
    });
  });
});
