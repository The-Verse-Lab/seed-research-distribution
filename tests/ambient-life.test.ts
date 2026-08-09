/**
 * Ambient-life module — engine-wired. Drives real movement so AmbientLifeModule fires on arrival and
 * proves the end-to-end behavior: a crowded region fills with transient extras on entry, those extras
 * are reaped when the party moves on (the existing cullTransients), and a world that authors no
 * `spawns` / region pools is fully INERT (no slice, no entities, byte-identical). All spawning is
 * seeded id-keyed, so the shared engine rng is irrelevant to the crowd (pinned anyway).
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

const SEED = 7;
const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 12, armorClass: 10 };

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
}
const move = (to: string): TurnPlan => planOf({ kind: "movement", destinationLocationId: to });

function engineWith(playset: PlaySet, plans: TurnPlan[]) {
  return new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(SEED),
  });
}

/** Count present entities (statted actors + statless authoredNpcs) whose id names the template. */
function countPresent(engine: GameEngine, templatePrefix: string): number {
  const s = engine.getState();
  const ids = [...Object.keys(s.actors), ...Object.keys(s.authoredNpcs ?? {})];
  return ids.filter((id) => id.startsWith(templatePrefix)).length;
}

// A quiet start (no spawns) linked to a thronged market region (crowd 3, a spawn rule). Midday clock
// (600 = morning) so the day-phase factor is 1 and the market fills.
function crowdPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.crowd",
    name: "Crowdworld",
    summary: "A test town.",
    locations: [
      { id: "loc.start", name: "The Gate", description: "A quiet gate.", connections: ["loc.market"], region: "r.quiet" },
      {
        id: "loc.market",
        name: "The Market",
        description: "A market square.",
        connections: ["loc.start"],
        region: "r.town",
      },
    ],
    npcs: [{ id: "npc.townsfolk", name: "Townsfolk", persona: "A local going about the day." }],
    regions: [
      { id: "r.quiet", name: "Quiet Ward", crowd: 1 },
      // Ambient PEOPLE live in the region pool (crowd-scaled), not location spawns (danger-scaled).
      { id: "r.town", name: "Town", crowd: 3, ambientPool: [{ templateId: "npc.townsfolk", max: 4 }] },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.crowd",
    name: "Crowd Campaign",
    worldId: "w.crowd",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: [], clock: 600 },
  });
  return { world, campaign };
}

describe("ambient life", () => {
  test("a crowded region fills with transient extras on arrival, culled on departure", async () => {
    const engine = engineWith(crowdPlayset(), [planOf({}), move("loc.market"), move("loc.start")]);
    await engine.start();

    await engine.submitPlayerInput("I look around the gate.");
    expect(countPresent(engine, "npc.townsfolk")).toBe(0); // quiet start (crowd 1, no spawns) stays empty

    await engine.submitPlayerInput("I walk into the market.");
    const crowd = countPresent(engine, "npc.townsfolk");
    expect(crowd).toBeGreaterThan(0); // the thronged market filled
    expect(crowd).toBeLessThanOrEqual(4); // capped by max / MAX_AMBIENT_PER_LOC

    await engine.submitPlayerInput("I head back to the gate.");
    expect(countPresent(engine, "npc.townsfolk")).toBe(0); // transients reaped once the party left
  });

  test("re-entering the market repopulates it", async () => {
    const engine = engineWith(crowdPlayset(), [planOf({}), move("loc.market"), move("loc.start"), move("loc.market")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go market");
    await engine.submitPlayerInput("go gate");
    await engine.submitPlayerInput("go market again");
    expect(countPresent(engine, "npc.townsfolk")).toBeGreaterThan(0);
  });

  test("monster-free arrivals accumulate a drought, and a spawn resets it (r5 P3)", async () => {
    // The counter behind packDroughtBonus: a player who walks a long way meeting nothing grows
    // likelier to meet something. The safe ward authors no spawns at all, so every hop is quiet.
    const engine = engineWith(crowdPlayset(), [
      planOf({}),
      move("loc.market"),
      move("loc.start"),
      move("loc.market"),
      move("loc.start"),
    ]);
    await engine.start();
    await engine.submitPlayerInput("look");
    const slice = () => engine.getState().modules?.ambientLife as { quietArrivals?: number } | undefined;

    expect(slice()?.quietArrivals).toBe(1); // the spawn-in itself counts as one quiet arrival

    await engine.submitPlayerInput("go market");
    expect(slice()?.quietArrivals).toBe(2);
    await engine.submitPlayerInput("go gate");
    await engine.submitPlayerInput("go market");
    await engine.submitPlayerInput("go gate");
    expect(slice()?.quietArrivals).toBe(5); // no authored pack anywhere here ⇒ every arrival is quiet
  });

  test("a world with no spawns and no region pools is fully inert (no slice, no extras)", async () => {
    const world = WorldSchema.parse({
      id: "w.bare",
      name: "Bareworld",
      summary: "Nothing lives here.",
      locations: [
        { id: "loc.a", name: "A", description: "A room.", connections: ["loc.b"] },
        { id: "loc.b", name: "B", description: "A room.", connections: ["loc.a"] },
      ],
    });
    const campaign = CampaignSchema.parse({
      id: "c.bare",
      name: "Bare Campaign",
      worldId: "w.bare",
      characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
      startingState: { locationId: "loc.a", party: ["pc.you"], companions: [], clock: 600 },
    });
    const engine = engineWith({ world, campaign }, [planOf({}), move("loc.b")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go b");
    // No ambient slice was ever written, and only the PC exists as an actor.
    expect(engine.getState().modules?.ambientLife).toBeUndefined();
    expect(Object.keys(engine.getState().authoredNpcs ?? {})).toHaveLength(0);
  });
});
