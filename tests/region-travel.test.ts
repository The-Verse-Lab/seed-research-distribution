/**
 * Per-region travel behavior — engine-wired. Proves the two Phase-1 seams: the `inRegion` trigger
 * condition (a travel event fires only when the party arrives in the named region), and the region
 * `eventRate` multiplier reshaping the campaign fire threshold (eventRate 0 suppresses arrivals in a
 * region entirely; 1 is unchanged). `travelEventChance: 1` makes each eligible fire deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";

const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 12, armorClass: 10 };
const planOf = (partial: Partial<TurnPlan>): TurnPlan => ({
  kind: "freeformNarrative",
  targetId: null,
  destinationLocationId: null,
  check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
  confidence: 1,
  ...partial,
});
const scriptedClassifier = (plans: TurnPlan[]): TurnClassifier => {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
};
const move = (to: string): TurnPlan => planOf({ kind: "movement", destinationLocationId: to });
const flag = (engine: GameEngine, key: string): unknown => engine.getState().flags?.[key];

function engineWith(playset: PlaySet, plans: TurnPlan[]) {
  return new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
}

// hub (safe) ↔ marsh (eventRate 1) and ↔ dead (eventRate 0). One event per scenario keeps the
// weighted pick deterministic.
function playset(events: unknown[]): PlaySet {
  const world = WorldSchema.parse({
    id: "w.reg",
    name: "Regionworld",
    summary: "Test regions.",
    locations: [
      { id: "loc.hub", name: "Hub", description: "A crossroads.", connections: ["loc.marsh", "loc.dead"], region: "r.safe" },
      { id: "loc.marsh", name: "Marsh", description: "A fen.", connections: ["loc.hub"], region: "r.marsh" },
      { id: "loc.dead", name: "Deadflat", description: "Silent flats.", connections: ["loc.hub"], region: "r.dead" },
    ],
    regions: [
      { id: "r.safe", name: "Safe", eventRate: 1 },
      { id: "r.marsh", name: "Marsh", eventRate: 1 },
      { id: "r.dead", name: "Dead", eventRate: 0 },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.reg",
    name: "Region Campaign",
    worldId: "w.reg",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    travelEventChance: 1,
    travelEvents: events,
    startingState: { locationId: "loc.hub", party: ["pc.you"], companions: [], clock: 600 },
  });
  return { world, campaign };
}

describe("inRegion travel-event gating", () => {
  const marshEvent = {
    id: "tev.marsh",
    once: "campaign",
    trigger: { allOf: [{ kind: "inRegion", regionId: "r.marsh" }] },
    effects: [{ kind: "setFlag", key: "sawMarsh", value: true }],
  };

  test("fires when the party arrives IN the named region", async () => {
    const engine = engineWith(playset([marshEvent]), [planOf({}), move("loc.marsh")]);
    await engine.start();
    await engine.submitPlayerInput("look"); // seed cursor at the hub, no fire
    await engine.submitPlayerInput("go to the marsh");
    expect(flag(engine, "sawMarsh")).toBe(true);
  });

  test("does NOT fire when arriving in a different region", async () => {
    // Same event, but the party walks into r.dead (eventRate 1 would let the roll fire, but the
    // inRegion gate makes tev.marsh ineligible there). Bump r.dead's rate so the roll itself fires.
    const p = playset([marshEvent]);
    p.world.regions = p.world.regions.map((r) => (r.id === "r.dead" ? { ...r, eventRate: 1 } : r));
    const engine = engineWith(p, [planOf({}), move("loc.dead")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go to the flats");
    expect(flag(engine, "sawMarsh")).toBeUndefined();
  });
});

describe("region eventRate multiplier", () => {
  const anyEvent = {
    id: "tev.any",
    once: "campaign",
    effects: [{ kind: "setFlag", key: "fired", value: true }],
  };

  test("eventRate 0 suppresses arrivals in that region entirely", async () => {
    const engine = engineWith(playset([anyEvent]), [planOf({}), move("loc.dead")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go to the flats"); // r.dead eventRate 0 ⇒ chance 0 ⇒ never fires
    expect(flag(engine, "fired")).toBeUndefined();
  });

  test("eventRate 1 fires as normal (multiplier is inert)", async () => {
    const engine = engineWith(playset([anyEvent]), [planOf({}), move("loc.marsh")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go to the marsh");
    expect(flag(engine, "fired")).toBe(true);
  });
});
