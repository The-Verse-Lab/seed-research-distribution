/**
 * Settle-then-move (§2.4 / r11 F-11) — the secondary move honours the settle contract.
 *
 * The tail move runs "after the settle has committed" (engine.ts). r12 (fixture-trade t11) caught the
 * gap in that promise: "buy my boots for 6 sp… then I'm off to the docks" moved the party after
 * the sale FAILED — an involuntary relocation off a deal that never closed. A TRADE settle is the
 * one whitelisted kind with a mechanical commit signal, so the engine now holds it to it; an
 * INQUIRY (answered, nothing to commit) and the spoken kinds keep their tail move.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { byKind, makeEngine } from "./support/harness.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  } as TurnPlan;
}

const scripted = (plan: TurnPlan): TurnClassifier => ({ classify: () => Promise.resolve(plan) });

const TAIL = { destinationLocationId: "loc.square", destinationName: "the square" };

describe("secondaryMove — the settle-committed gate (r12)", () => {
  test("a trade that never committed keeps the party where the deal died", async () => {
    const { engine, events } = await makeEngine({
      classifier: scripted(
        planOf({
          kind: "trade",
          targetId: "npc.brann",
          trade: { direction: "sell", itemId: null, vendorId: null, itemWords: "boots" },
          secondaryMove: TAIL,
        }),
      ),
    });
    await engine.submitPlayerInput("Brann, buy my boots for six silver — then I'm off to the square.");

    const changes = byKind(events, "stateChanged");
    // No relocation happened…
    expect(changes.some((c) => (c.changes as { partyLocationId?: string })?.partyLocationId === "loc.square")).toBe(
      false,
    );
    // …and the player is told the tail move was not honoured, not left to infer it.
    expect(changes.some((c) => c.summary.includes("One thing at a time"))).toBe(true);
  });

  test("an INQUIRY settles by being answered — its tail move still runs", async () => {
    const { engine, events } = await makeEngine({
      classifier: scripted(
        planOf({
          kind: "trade",
          targetId: "npc.brann",
          trade: { direction: "buy", itemId: null, vendorId: null, inquiry: true, itemWords: "a knife" },
          secondaryMove: TAIL,
        }),
      ),
    });
    await engine.submitPlayerInput("What would a knife cost? Then I'm off to the square.");

    const changes = byKind(events, "stateChanged");
    expect(changes.some((c) => (c.changes as { partyLocationId?: string })?.partyLocationId === "loc.square")).toBe(
      true,
    );
  });

  test("a spoken settle (dialogueToNpc) is unaffected — saying it IS settling it", async () => {
    const { engine, events } = await makeEngine({
      classifier: scripted(
        planOf({ kind: "dialogueToNpc", targetId: "npc.brann", secondaryMove: TAIL }),
      ),
    });
    await engine.submitPlayerInput("Thanks for the warning, Brann — I'm off to the square.");

    const changes = byKind(events, "stateChanged");
    expect(changes.some((c) => (c.changes as { partyLocationId?: string })?.partyLocationId === "loc.square")).toBe(
      true,
    );
  });
});
