/**
 * Heartbeat in-flight guard (2026-07-05 playtest: an NPC "pledged loyalty" BEFORE the player rolled).
 * A player turn that blocks on a pending click-to-roll gate keeps the engine's `ticking` flag set, so
 * a heartbeat firing in that window is a no-op — no autonomous line can reach the client ahead of the
 * roll. See src/engine/engine.ts (runTick wrapper + tickHeartbeat guard).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { loadExample } from "./support/harness.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { GameEvent } from "../src/events/types.ts";

const checkPlan: TurnPlan = {
  kind: "attemptRequiringCheck",
  targetId: null,
  destinationLocationId: null,
  check: { warranted: true, ability: "dex", skill: "Stealth", dc: 13, reason: "sneaking past" },
  confidence: 1,
};

describe("heartbeat in-flight guard", () => {
  test("a heartbeat fired while a turn blocks on a pending roll leaks nothing", async () => {
    let releaseRoll: () => void = () => {};
    const rollGate = new Promise<void>((r) => (releaseRoll = r));
    const engine = new GameEngine({
      playset: await loadExample(),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: { classify: async () => checkPlan } satisfies TurnClassifier,
      rng: mulberry32(1),
      client: {
        promptRoll: async () => {
          await rollGate;
          return { proceed: true };
        },
      },
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    events.length = 0;

    // Start a turn that blocks at promptRoll — do NOT await it yet.
    const turn = engine.submitPlayerInput("I sneak past the guard");
    await new Promise((r) => setTimeout(r, 10)); // let the turn reach and block on the roll gate
    const midCount = events.length;

    // Fire a heartbeat while the roll is pending: the guard skips it, so nothing streams to the
    // client ahead of the roll (no diceRolled has fired yet either).
    await engine.tickHeartbeat("npc.lyra");
    expect(events.length).toBe(midCount);
    expect(events.some((e) => e.kind === "diceRolled")).toBe(false);

    // Release the roll — the turn now completes and resolves the check.
    releaseRoll();
    await turn;
    expect(events.some((e) => e.kind === "diceRolled")).toBe(true);
  });
});
