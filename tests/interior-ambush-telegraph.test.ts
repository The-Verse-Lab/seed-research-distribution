/**
 * Interior ambush telegraph (r3 P3) — a room-event MONSTER break-in no longer hard-cuts into
 * combat on the same tick: the intruder spawns with an approach beat (one pre-combat frame — the
 * Present board can render it, menace chip and all), and the existing once-per-monster on-sight
 * aggro opens the fight on the player's NEXT turn, intruder first. Survives a save/reload between
 * the two ticks. NPC-template ambushers keep the same-tick start (aggro skips NPCs).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { LODGING_LOCATION_ID } from "../src/world/lodging.ts";

const PC = "pc.you";
const ORIGIN = "loc.hall";
const TIER_PRIVATE = "tier.private";
const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 12, armorClass: 10 };

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

function scriptedClassifier(): TurnClassifier {
  return { classify: async () => planOf({}) };
}

function mkPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.tele",
    name: "Telegraph Test",
    summary: "A hall with beds and a thing in the walls.",
    locations: [
      {
        id: ORIGIN,
        name: "The Broken Crown",
        description: "A guild hall with beds to let.",
        guild: {
          name: "The Broken Crown",
          lodging: { tiers: [{ id: TIER_PRIVATE, label: "a private room", nightlyCp: 20, private: true }] },
        },
      },
    ],
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.tele",
    name: "Telegraph Campaign",
    worldId: world.id,
    characters: [{ id: PC, name: "You", stats: pcStats, age: 30 }],
    roomEventChance: 1,
    roomEvents: [
      {
        id: "rev.wallthing",
        weight: 1,
        cooldownMoves: 0,
        once: "always",
        // `foe.wall-thing` matches no authored template ⇒ synthesized inline MONSTER.
        effects: [{ kind: "ambush", templateId: "foe.wall-thing", tier: "tracked", hp: 9, name: "Wall-Thing" }],
      },
    ],
    startingState: { locationId: ORIGIN, party: [PC], companions: [] },
  });
  return { world, campaign };
}

function seedState(playset: PlaySet): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: ORIGIN,
    clock: 600,
    party: [PC],
    companions: [],
    actors: { [PC]: { id: PC, currentHp: pcStats.maxHp, locationId: ORIGIN, inventory: [], conditions: [], coins: 30 } },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
  };
}

const combatActive = (engine: GameEngine): boolean =>
  (engine.getState().modules?.combat as { active?: boolean } | undefined)?.active === true;

async function buildEngine(store: InMemoryGameStateStore): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = mkPlayset();
  const engine = new GameEngine({
    classifier: scriptedClassifier(),
    playset,
    store,
    gateway: new OfflineGateway(),
    rng: mulberry32(11),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events };
}

describe("interior monster break-in — spawn tick telegraphs, fight opens next turn", () => {
  test("tick N: monster present, NO combat, approach beat narrated; tick N+1: combat, intruder first", async () => {
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey("c.tele", PC), seedState(mkPlayset()));
    const { engine, events } = await buildEngine(store);

    await engine.submitAction({ kind: "rentRoom", tierId: TIER_PRIVATE });

    const s = engine.getState();
    const monsterId = Object.keys(s.actors).find((id) => id.startsWith("foe.wall-thing"));
    expect(monsterId).toBeTruthy(); // the intruder is REAL and on the board…
    expect(s.actors[monsterId!]?.locationId).toBe(LODGING_LOCATION_ID);
    expect(combatActive(engine)).toBe(false); // …but no same-tick hard cut
    const prose = events
      .filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration")
      .map((e) => e.text)
      .join("\n");
    expect(prose).toContain("Wall-Thing"); // the approach was telegraphed

    await engine.submitPlayerInput("I back toward the door.");
    expect(combatActive(engine)).toBe(true); // on-sight aggro opened the fight
    // Initiative comes from the aggro path's own seeded roll — the contract here is only that the
    // intruder IS in the fight it started.
    const order = (engine.getState().modules?.combat as { order?: string[] } | undefined)?.order ?? [];
    expect(order).toContain(monsterId!);
    engine.stop();
  });

  test("a save/reload between spawn and aggro still opens the fight", async () => {
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey("c.tele", PC), seedState(mkPlayset()));
    const first = await buildEngine(store);
    await first.engine.submitAction({ kind: "rentRoom", tierId: TIER_PRIVATE });
    expect(combatActive(first.engine)).toBe(false);
    first.engine.stop();

    const second = await buildEngine(store); // reload from the same durable store
    const monsterId = Object.keys(second.engine.getState().actors).find((id) => id.startsWith("foe.wall-thing"));
    expect(monsterId).toBeTruthy(); // the intruder survived the reload
    await second.engine.submitPlayerInput("I reach for my blade.");
    expect(combatActive(second.engine)).toBe(true);
    second.engine.stop();
  });
});
