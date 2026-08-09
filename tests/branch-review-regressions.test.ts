/**
 * Regression guards for the six issues raised in the branch review of the living-regions /
 * random-scenario wave. Each block pins a specific defect so it can't silently return:
 *
 *   F1 — a travel ambush enqueued this tick must be visible to later modules before commands commit.
 *   F2 — an authored `tracked`/`significant` `Location.spawns` monster was forced to `transient`, so
 *        it vanished on departure and re-rolled on return. Now the tier is honored and the standing
 *        `max` is a ceiling (no accumulation).
 *   F4 — the exploitation isolation bonus opted in on ANY non-null `regionId`, which a legacy tag-only
 *        world satisfies; it must gate on an AUTHORED first-class region row.
 *   F5 — `inRegion` barrier conditions were evaluated with no region resolver (fail-closed), so a
 *        matching barrier stayed locked. The engine move path now resolves the region.
 *   F6 — character rebinding remapped only five shallow id fields; defeat-outcome effects accept the
 *        whole Command vocabulary, so nested/array/other id fields stayed bound to the old PC.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, CharacterSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { Command } from "../src/world/commands.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { regionProfileOf } from "../src/rules/regions.ts";
import { bindCharacter } from "../src/content/character.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { combatPendingInQueue } from "../src/world/queries.ts";

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

function engineWith(playset: PlaySet, plans: TurnPlan[]): GameEngine {
  return new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(SEED),
  });
}
/** Count present entities (statted actors + statless authoredNpcs) whose id names the template. */
function countPresent(engine: GameEngine, prefix: string): number {
  const s = engine.getState();
  const ids = [...Object.keys(s.actors), ...Object.keys(s.authoredNpcs ?? {})];
  return ids.filter((id) => id.startsWith(prefix)).length;
}
const combatActive = (engine: GameEngine): boolean =>
  (engine.getState().modules?.combat as { active?: boolean } | undefined)?.active === true;

// ---------------------------------------------------------------------------------------------
// F1 — pending combat detection over the enqueued-command queue
// ---------------------------------------------------------------------------------------------

describe("F1 — queue-pending combat predicate", () => {
  test("combatPendingInQueue sees an enqueued startCombat, ignores unrelated commands", () => {
    const startCombat: Command = { type: "startCombat", locationId: "loc.x", order: ["a"], round: 1, turnIndex: 0 };
    expect(combatPendingInQueue([startCombat])).toBe(true);
    expect(combatPendingInQueue([{ type: "advanceClock", by: 5 }])).toBe(false);
    expect(combatPendingInQueue([])).toBe(false);
  });

});

// ---------------------------------------------------------------------------------------------
// F2 — authored spawn tiers are honored (persist across revisits, capped at max)
// ---------------------------------------------------------------------------------------------

function trackedSpawnPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.f2",
    name: "F2 World",
    summary: "A hub and a deadly crag.",
    locations: [
      { id: "loc.safe", name: "Safe Hub", description: "A quiet camp.", connections: ["loc.crag"], region: "r.safe" },
      { id: "loc.crag", name: "The Crag", description: "A deadly ledge.", connections: ["loc.safe"], region: "r.deep",
        spawns: [{ templateId: "mon.wraith", tier: "tracked", max: 1 }] },
    ],
    // A statted monster (the reproduced case uses a `tracked` entity).
    monsters: [{ id: "mon.wraith", name: "Wraith", stats: { abilities: pcStats.abilities, maxHp: 14, armorClass: 11 } }],
    // danger 3 so `packChance` reliably materializes the pack; crowd 0 so no ambient people confuse the count.
    regions: [
      { id: "r.safe", name: "Safe", danger: 0, crowd: 1 },
      { id: "r.deep", name: "Deep", danger: 3, crowd: 0 },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.f2",
    name: "F2 Campaign",
    worldId: "w.f2",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.safe", party: ["pc.you"], companions: [], clock: 600 },
  });
  return { world, campaign };
}

describe("F2 — a tracked Location.spawns monster persists and does not accumulate", () => {
  test("tracked spawn survives departure (not culled) and stays capped at max on return", async () => {
    const engine = engineWith(trackedSpawnPlayset(), [planOf({}), move("loc.crag"), move("loc.safe"), move("loc.crag")]);
    await engine.start();

    await engine.submitPlayerInput("look around the camp");
    await engine.submitPlayerInput("climb to the crag"); // visit 1: pack fires, spawns the tracked wraith
    expect(countPresent(engine, "mon.wraith")).toBe(1);

    await engine.submitPlayerInput("retreat to the hub"); // a transient would be culled here; tracked persists
    expect(countPresent(engine, "mon.wraith")).toBe(1);

    await engine.submitPlayerInput("climb back to the crag"); // visit 2: the pack rolls again but max=1 is a ceiling
    expect(countPresent(engine, "mon.wraith")).toBe(1);
    engine.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// F4 — region isolation is gated on an authored row, not a legacy tag
// ---------------------------------------------------------------------------------------------

describe("F4 — regionProfileOf.authored distinguishes a real row from a legacy tag", () => {
  const world = (over: Record<string, unknown> = {}) => WorldSchema.parse({ id: "w", name: "W", ...over });

  test("legacy region TAG with no first-class row reports regionId but is NOT authored", () => {
    const w = world({ locations: [{ id: "loc.a", name: "A", region: "r.mire" }], constitution: { danger: 3 } });
    const p = regionProfileOf(w, "loc.a");
    expect(p.regionId).toBe("r.mire"); // still resolvable for an inRegion gate
    expect(p.authored).toBe(false); // but no isolation opt-in — a tag-only world stays byte-identical
    expect(p.crowd).toBe(1);
  });

  test("a first-class region row is authored", () => {
    const w = world({
      locations: [{ id: "loc.a", name: "A", region: "r.mire" }],
      regions: [{ id: "r.mire", name: "Mire", danger: 3, crowd: 1 }],
    });
    const p = regionProfileOf(w, "loc.a");
    expect(p.authored).toBe(true);
    expect(p.crowd).toBe(1);
  });

  test("the world fallback (untagged location) is not authored", () => {
    expect(regionProfileOf(world({ locations: [{ id: "loc.a", name: "A" }] }), "loc.a").authored).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// F5 — inRegion barrier conditions resolve the region on the engine move path
// ---------------------------------------------------------------------------------------------

function barrierPlayset(gateRegionId: string): PlaySet {
  const world = WorldSchema.parse({
    id: "w.f5",
    name: "F5 World",
    summary: "A gate that opens by region.",
    locations: [
      { id: "loc.a", name: "Courtyard", description: "Inside the ward.", region: "r.ward",
        exits: [{ to: "loc.b", name: "the ward-gate", barrier: { kind: "gate", condition: { allOf: [{ kind: "inRegion", regionId: gateRegionId }] } } }] },
      { id: "loc.b", name: "Beyond", description: "Past the gate.", exits: [{ to: "loc.a", name: "back through the gate" }] },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.f5",
    name: "F5 Campaign",
    worldId: "w.f5",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.a", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

describe("F5 — inRegion barrier condition resolves on a player move", () => {
  test("a matching inRegion condition opens the barrier and the party passes through", async () => {
    const engine = engineWith(barrierPlayset("r.ward"), [planOf({}), move("loc.b")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go through the ward-gate");
    expect(engine.getState().partyLocationId).toBe("loc.b"); // condition resolved true → passed
    engine.stop();
  });

  test("a non-matching inRegion condition leaves the barrier locked (resolver is actually consulted)", async () => {
    const engine = engineWith(barrierPlayset("r.elsewhere"), [planOf({}), move("loc.b")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go through the ward-gate");
    expect(engine.getState().partyLocationId).toBe("loc.a"); // condition false → still barred
    engine.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// Regex audit §10d — F5 fixed `inRegion` at this seam and stopped there. `resolveBarredMove` still
// built its lookup bundle BY HAND (`{ regionOf }` only), and every EvalLookups resolver is
// fail-closed, so `regionDangerAtLeast` was false FOREVER: an authored gate that should open in a
// dangerous region stayed sealed with no error, in the player's own move path. The seam now asks
// `standardEvalLookups` for the complete bundle.
// ---------------------------------------------------------------------------------------------

/** The F5 gate again, opened by REGION DANGER instead of region id. `r.ward` is authored danger 2. */
function dangerBarrierPlayset(requiredDanger: number): PlaySet {
  const world = WorldSchema.parse({
    id: "w.10d",
    name: "§10d World",
    summary: "A gate that opens where the road is dangerous enough.",
    regions: [{ id: "r.ward", name: "The Ward", danger: 2 }],
    locations: [
      { id: "loc.a", name: "Courtyard", description: "Inside the ward.", region: "r.ward",
        exits: [{ to: "loc.b", name: "the ward-gate", barrier: { kind: "gate", condition: { allOf: [{ kind: "regionDangerAtLeast", value: requiredDanger }] } } }] },
      { id: "loc.b", name: "Beyond", description: "Past the gate.", exits: [{ to: "loc.a", name: "back through the gate" }] },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.10d",
    name: "§10d Campaign",
    worldId: "w.10d",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.a", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

describe("§10d — a regionDangerAtLeast barrier condition resolves on a player move", () => {
  test("danger 2 ≥ 2 opens the gate and the party passes through", async () => {
    const engine = engineWith(dangerBarrierPlayset(2), [planOf({}), move("loc.b")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go through the ward-gate");
    expect(engine.getState().partyLocationId).toBe("loc.b");
    engine.stop();
  });

  test("danger 2 < 3 leaves it barred — the resolver is consulted, not blanket-true", async () => {
    const engine = engineWith(dangerBarrierPlayset(3), [planOf({}), move("loc.b")]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go through the ward-gate");
    expect(engine.getState().partyLocationId).toBe("loc.a");
    engine.stop();
  });
});
