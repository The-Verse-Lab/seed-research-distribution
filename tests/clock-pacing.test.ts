/**
 * Clock pacing (r4 playtest wave) — the two owner requirements as one permanent guard:
 *
 *  1. The clock moves when the player does: a session of pure conversation/investigation walks
 *     the authoritative day phase forward (run 4 sat ~30 turns inside `morning · day 1` while the prose
 *     rang noon and every NPC deadline was unreachable).
 *  2. Energy stays a SEPARATE meter: talking spends the day, never the body — a full afternoon
 *     of dialogue must not fire the exhaustion ladder.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { dayPhaseOf } from "../src/agents/context.ts";
import { DEFAULT_MAX_ENERGY, TURN_COSTS } from "../src/rules/costs.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

function mkPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.pace",
    name: "Paceworld",
    summary: "A town where talk takes time.",
    locations: [{ id: "loc.inn", name: "The Inn", description: "A low common room.", npcs: ["npc.keeper"] }],
    npcs: [{ id: "npc.keeper", name: "Keeper", summary: "the innkeeper", persona: "A patient innkeeper.", age: 50 }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.pace",
    name: "Pace Campaign",
    worldId: "w.pace",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.inn", clock: 480, party: ["pc.you"], companions: [] }, // 08:00, morning
  });
  return { world, campaign };
}

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

describe("clock pacing — investigation spends the day, not the body", () => {
  test("36 conversational turns walk morning → afternoon; the exhaustion ladder never fires", async () => {
    // Alternate spoken beats and freeform beats — the run-4 investigation loop, no work/travel/camp.
    const plans: TurnPlan[] = [];
    for (let i = 0; i < 36; i++) {
      plans.push(i % 2 === 0 ? planOf({ kind: "dialogueToNpc", targetId: "npc.keeper" }) : planOf({}));
    }
    let cursor = 0;
    const classifier: TurnClassifier = { classify: () => Promise.resolve(plans[Math.min(cursor++, plans.length - 1)]!) };
    const engine = new GameEngine({
      playset: mkPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier,
      rng: mulberry32(7),
    });
    await engine.start();

    expect(dayPhaseOf(engine.getState().clock)).toBe("morning");
    for (let i = 0; i < 36; i++) await engine.submitPlayerInput(i % 2 === 0 ? "Keeper, tell me more." : "I study the room.");
    engine.stop();

    const state = engine.getState();
    // 18 dialogue (10 min) + 18 freeform (10 min) = 360 minutes: 08:00 → 14:00, across the boundary.
    const expected = 480 + 18 * TURN_COSTS.dialogueToNpc.minutes + 18 * TURN_COSTS.freeformNarrative.minutes;
    expect(state.clock).toBe(expected);
    expect(dayPhaseOf(state.clock)).toBe("afternoon");

    // Energy: only the freeform beats spend (1 each) — talk never exhausts.
    const you = state.actors["pc.you"]!;
    expect(you.energy).toBe(DEFAULT_MAX_ENERGY - 18 * TURN_COSTS.freeformNarrative.energy);
    expect(you.exhaustion ?? 0).toBe(0);
  });
});
