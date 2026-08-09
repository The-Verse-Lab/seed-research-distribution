/**
 * Energy + action costs (Workstream H) — the cost table, the `adjustEnergy` reducer contract
 * (absolute deltas, [0, max] clamp, absent-means-full old-save tolerance), the replay fold, and
 * the engine-level spend: a priced turn debits the PC through the one commit chokepoint, the
 * depletion gate refuses exertion at zero, and a long rest restores to full while advancing the
 * clock to the next day's wake hour. Deterministic throughout (offline gateway + scripted classifier).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { applyCommand } from "../src/world/reducer.ts";
import { applyDelta } from "./support/replay.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import {
  TURN_COSTS,
  DEFAULT_MAX_ENERGY,
  DEFAULT_TURN_MINUTES,
  costOf,
  energyOf,
  maxEnergyOf,
} from "../src/rules/costs.ts";
import {
  exhaustionCheckMods,
  exhaustionMoveFactor,
  exhaustionOf,
  workingCap,
} from "../src/rules/exhaustion.ts";
import { TurnKindSchema, type TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { GameEngine, REST_WAKE_MINUTE, restAdvanceMinutes } from "../src/engine/engine.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import type { PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { loadExample, makeEngine, byKind } from "./support/harness.ts";

/** A started engine's projected state → a fresh model seeded from the example world. */
async function exampleModel(): Promise<{ model: WorldModel; playset: PlaySet }> {
  const playset = await loadExample();
  const engine = new GameEngine({
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  return { model: fromGameState(engine.getState(), playset.world, playset.campaign), playset };
}

/** Stamp a pre-delta with the id/at/seq the bus assigns, yielding a full DeltaEvent. */
const stamp = (pre: EmittedDelta, seq: number): DeltaEvent =>
  ({ ...pre, id: `d${seq}`, at: 0, seq }) as DeltaEvent;

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

/** Classifier scripted per-call — each submitted input consumes the next plan. */
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return {
    classify: async () => {
      const plan = plans[Math.min(i, plans.length - 1)] ?? planOf({});
      i += 1;
      return plan;
    },
  };
}

/** A crafted save with the PC's energy pre-seeded (the seededState pattern) — no drain grinding. */
function drainedState(playset: PlaySet, energy: number): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.lyra"],
    actors: {
      "pc.you": {
        id: "pc.you",
        currentHp: 24,
        locationId: "loc.tavern",
        inventory: ["item.lantern"],
        conditions: [],
        energy,
      },
      "npc.lyra": {
        id: "npc.lyra",
        currentHp: 28,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
  };
}

describe("costs — pure helpers", () => {
  test("energyOf/maxEnergyOf default absent fields to full (pre-energy saves wake rested)", () => {
    expect(maxEnergyOf({})).toBe(DEFAULT_MAX_ENERGY);
    expect(energyOf({})).toBe(DEFAULT_MAX_ENERGY);
    expect(energyOf({ maxEnergy: 50 })).toBe(50); // absent energy = that entity's own full
    expect(energyOf({ energy: 30 })).toBe(30);
    expect(maxEnergyOf({ maxEnergy: 50 })).toBe(50);
  });

  test("costOf has a row for every TurnKind", () => {
    for (const kind of TurnKindSchema.options) {
      const cost = costOf(kind);
      expect(cost).toBeDefined();
      expect(cost.minutes).toBeGreaterThanOrEqual(0);
      expect(cost.energy).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(TURN_COSTS).sort()).toEqual([...TurnKindSchema.options].sort());
  });

  test("the cost contracts other tests rely on: freeform {10,1}, rest {0,0}, metaOOC {0,0}", () => {
    // r4 clock repricing: a freeform beat is a 10-minute scene, not the historic 1-minute tick —
    // the clock must move on every prompt or thirty turns of talk fit inside one morning.
    expect(costOf("freeformNarrative")).toEqual({ minutes: 10, energy: 1 });
    expect(costOf("rest")).toEqual({ minutes: 0, energy: 0 }); // the rest resolver advances its own clock
    expect(costOf("metaOOC")).toEqual({ minutes: 0, energy: 0 }); // never reaches the clock
  });

  test("the default beat is pinned to dialogue", () => {
    expect(DEFAULT_TURN_MINUTES).toBe(costOf("dialogueToNpc").minutes);
  });

  test("exhaustion helpers default absent to fresh and expose table values", () => {
    expect(exhaustionOf(undefined)).toBe(0);
    expect(exhaustionOf({})).toBe(0);
    expect(exhaustionOf({ exhaustion: 4 })).toBe(4);
    expect(exhaustionCheckMods(2)).toEqual({ dcAdjustment: 2, disadvantage: false });
    expect(exhaustionCheckMods(3)).toEqual({ dcAdjustment: 0, disadvantage: true });
    expect(workingCap(4, DEFAULT_MAX_ENERGY)).toBe(50);
    expect(Math.round(TURN_COSTS.movement.minutes * exhaustionMoveFactor(4))).toBe(45);
  });
});

describe("reducer — adjustEnergy", () => {
  test("spending from an absent field starts at full and emits the absolute post-value", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustEnergy", entityId: "pc.you", by: -30 });
    expect(res.mutated).toBe(true);
    expect(res.deltas).toHaveLength(1);
    expect(res.deltas[0]).toMatchObject({ kind: "energyChanged", entityId: "pc.you", energy: 70 });
    expect(model.entities.get("pc.you")?.stats?.energy).toBe(70);
  });

  test("clamps at 0 on a huge spend", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustEnergy", entityId: "pc.you", by: -100000 });
    expect(res.deltas[0]).toMatchObject({ kind: "energyChanged", energy: 0 });
    expect(model.entities.get("pc.you")?.stats?.energy).toBe(0);
  });

  test("clamps at max on a huge raise after a spend", async () => {
    const { model } = await exampleModel();
    applyCommand(model, { type: "adjustEnergy", entityId: "pc.you", by: -30 });
    const res = applyCommand(model, { type: "adjustEnergy", entityId: "pc.you", by: 100000 });
    expect(res.deltas[0]).toMatchObject({ kind: "energyChanged", energy: DEFAULT_MAX_ENERGY });
    expect(model.entities.get("pc.you")?.stats?.energy).toBe(DEFAULT_MAX_ENERGY);
  });

  test("by: 0 is a noop", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustEnergy", entityId: "pc.you", by: 0 });
    expect(res.mutated).toBe(false);
    expect(res.deltas).toHaveLength(0);
  });

  test("a raise while the field is absent is a noop — the key stays absent (old saves never materialize)", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustEnergy", entityId: "pc.you", by: 10 });
    expect(res.mutated).toBe(false);
    expect(res.deltas).toHaveLength(0);
    const stats = model.entities.get("pc.you")?.stats;
    expect(stats).toBeDefined();
    expect("energy" in (stats ?? {})).toBe(false); // absent means full — a noop must not write it
  });

  test("a statless entity is rejected with 'no stats'", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustEnergy", entityId: "npc.brann", by: -5 });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("no stats");
  });

  test("a non-integer adjustment is rejected", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustEnergy", entityId: "pc.you", by: 1.5 });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("integer");
  });
});

describe("reducer — adjustExhaustion", () => {
  test("raises from absent 0, clamps at 6, and emits the absolute post-level", async () => {
    const { model } = await exampleModel();
    const first = applyCommand(model, { type: "adjustExhaustion", entityId: "pc.you", by: 2 });
    expect(first.deltas[0]).toMatchObject({ kind: "exhaustionChanged", entityId: "pc.you", exhaustion: 2 });
    const capped = applyCommand(model, { type: "adjustExhaustion", entityId: "pc.you", by: 100 });
    expect(capped.deltas[0]).toMatchObject({ kind: "exhaustionChanged", exhaustion: 6 });
    expect(model.entities.get("pc.you")?.stats?.exhaustion).toBe(6);
  });

  test("a drop at absent 0 is a noop and never materializes old saves", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustExhaustion", entityId: "pc.you", by: -1 });
    expect(res.mutated).toBe(false);
    expect("exhaustion" in (model.entities.get("pc.you")?.stats ?? {})).toBe(false);
  });

  test("rejects non-integer adjustments", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "adjustExhaustion", entityId: "pc.you", by: 0.5 });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("integer");
  });
});

describe("old-save tolerance — absent energy keys", () => {
  test("pre-energy snapshots carry no keys, read as full, accept commands, then persist losslessly", async () => {
    const { model, playset } = await exampleModel();

    // The "old save": a snapshot minted before energy existed carries neither key.
    // JSON round-trip stands in for the sqlite store (which is JSON.parse without a schema).
    const oldJson = JSON.parse(JSON.stringify(toGameState(model))) as ReturnType<typeof toGameState>;
    expect("energy" in (oldJson.actors["pc.you"] ?? {})).toBe(false);
    expect("maxEnergy" in (oldJson.actors["pc.you"] ?? {})).toBe(false);
    expect("exhaustion" in (oldJson.actors["pc.you"] ?? {})).toBe(false);
    expect("energy" in (oldJson.actors["npc.lyra"] ?? {})).toBe(false);

    // Reload reads as FULL...
    const reloaded = fromGameState(oldJson, playset.world, playset.campaign);
    const stats = reloaded.entities.get("pc.you")?.stats;
    expect(stats).toBeDefined();
    expect(energyOf(stats ?? {})).toBe(DEFAULT_MAX_ENERGY);

    // ...and accepts energy commands immediately (100 − 10 = 90, absolute in the delta).
    const res = applyCommand(reloaded, { type: "adjustEnergy", entityId: "pc.you", by: -10 });
    expect(res.deltas[0]).toMatchObject({ kind: "energyChanged", energy: 90 });

    // The "new save": the materialized value projects, serializes, and reloads losslessly.
    const newJson = JSON.parse(JSON.stringify(toGameState(reloaded))) as ReturnType<typeof toGameState>;
    expect(newJson.actors["pc.you"]?.energy).toBe(90);
    expect("maxEnergy" in (newJson.actors["pc.you"] ?? {})).toBe(false); // never written, still absent
    const again = fromGameState(newJson, playset.world, playset.campaign);
    expect(again.entities.get("pc.you")?.stats?.energy).toBe(90);
    expect(toGameState(again)).toEqual(toGameState(reloaded));
  });
});

describe("replay — energyChanged folds by absolute overwrite", () => {
  test("the delta reconstructs the live projection on a fresh clone, idempotently", async () => {
    const { model: live } = await exampleModel();
    const seed = structuredClone(live); // the fold target: the very same pre-command seed

    const pre = applyCommand(live, { type: "adjustEnergy", entityId: "pc.you", by: -25 }).deltas[0] as EmittedDelta;
    const delta = stamp(pre, 0);
    applyDelta(seed, delta);
    applyDelta(seed, delta); // idempotent: re-applying the same absolute delta changes nothing
    expect(seed.entities.get("pc.you")?.stats?.energy).toBe(75);
    expect(toGameState(seed)).toEqual(toGameState(live));
  });

  test("exhaustionChanged folds by absolute overwrite without disturbing absent energy defaults", async () => {
    const { model: live } = await exampleModel();
    const seed = structuredClone(live);

    const pre = applyCommand(live, { type: "adjustExhaustion", entityId: "pc.you", by: 3 }).deltas[0] as EmittedDelta;
    const delta = stamp(pre, 0);
    applyDelta(seed, delta);
    applyDelta(seed, delta);
    expect(seed.entities.get("pc.you")?.stats?.exhaustion).toBe(3);
    expect(toGameState(seed)).toEqual(toGameState(live));
  });
});

describe("engine — the per-turn cost chokepoint", () => {
  test("a movement turn advances the clock and debits the PC from the cost table", async () => {
    const { engine } = await makeEngine({
      classifier: scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
    });
    const clock0 = engine.getState().clock;
    await engine.submitPlayerInput("head to the square");
    const s = engine.getState();
    expect(s.partyLocationId).toBe("loc.square");
    expect(s.clock - clock0).toBe(TURN_COSTS.movement.minutes);
    expect(s.actors["pc.you"]?.energy).toBe(DEFAULT_MAX_ENERGY - TURN_COSTS.movement.energy);
  });

  test("at zero energy, low exhaustion movement overflows into the ladder instead of refusing", async () => {
    const playset = await loadExample();
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), drainedState(playset, 0));
    const { engine, events } = await makeEngine({
      playset,
      store,
      classifier: scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }),
        planOf({ kind: "freeformNarrative" }),
      ]),
    });
    expect(engine.getState().actors["pc.you"]?.energy).toBe(0);
    const clock0 = engine.getState().clock;

    await engine.submitPlayerInput("march to the square");
    expect(engine.getState().partyLocationId).toBe("loc.square");
    expect(engine.getState().actors["pc.you"]?.exhaustion).toBe(1);
    expect(engine.getState().actors["pc.you"]?.energy).toBe(
      workingCap(1, DEFAULT_MAX_ENERGY) - TURN_COSTS.movement.energy,
    );

    // A freeform turn still works: the freeform beat lands, nothing traps the player.
    const narrations1 = byKind(events, "narration").length;
    await engine.submitPlayerInput("catch my breath and look around");
    expect(byKind(events, "narration").length).toBeGreaterThan(narrations1);
    expect(engine.getState().clock - clock0).toBe(TURN_COSTS.movement.minutes + TURN_COSTS.freeformNarrative.minutes);
    expect(engine.getState().actors["pc.you"]?.energy).toBe(
      workingCap(1, DEFAULT_MAX_ENERGY) - TURN_COSTS.movement.energy - TURN_COSTS.freeformNarrative.energy,
    );
  });

  test("level 5 refuses fresh out-of-combat exertion", async () => {
    const playset = await loadExample();
    const state = drainedState(playset, 0);
    state.actors["pc.you"]!.exhaustion = 5;
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
    const { engine, events } = await makeEngine({
      playset,
      store,
      classifier: scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
    });
    const narrations0 = byKind(events, "narration").length;

    await engine.submitPlayerInput("march to the square");
    expect(engine.getState().partyLocationId).toBe("loc.tavern");
    expect(engine.getState().actors["pc.you"]?.exhaustion).toBe(5);
    expect(engine.getState().actors["pc.you"]?.energy).toBe(0);
    expect(engine.getState().clock).toBe(1);
    expect(byKind(events, "narration").length).toBeGreaterThan(narrations0);
  });

  test("high exhaustion slows movement, caps the refreshed pool, and applies the level-5 HP bite", async () => {
    const playset = await loadExample();
    const state = drainedState(playset, 0);
    state.actors["pc.you"]!.exhaustion = 4;
    state.actors["pc.you"]!.currentHp = 24;
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
    const { engine } = await makeEngine({
      playset,
      store,
      classifier: scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
    });

    await engine.submitPlayerInput("march to the square");
    const pc = engine.getState().actors["pc.you"]!;
    expect(engine.getState().partyLocationId).toBe("loc.square");
    expect(engine.getState().clock).toBe(45);
    expect(pc.exhaustion).toBe(5);
    expect(pc.energy).toBe(workingCap(5, DEFAULT_MAX_ENERGY) - TURN_COSTS.movement.energy);
    expect(pc.currentHp).toBe(18);
  });

  test("pushing past level 5 reaches collapse and sets unconscious", async () => {
    const playset = await loadExample();
    const state = drainedState(playset, 0);
    state.actors["pc.you"]!.exhaustion = 5;
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
    const { engine } = await makeEngine({
      playset,
      store,
      classifier: scriptedClassifier([planOf({ kind: "freeformNarrative" })]),
    });

    await engine.submitPlayerInput("force myself to stay awake");
    const pc = engine.getState().actors["pc.you"]!;
    expect(pc.exhaustion).toBe(6);
    expect(pc.energy).toBe(0);
    expect(pc.conditions).toContain("unconscious");
  });

  test("a long rest (camp → End Day) restores energy to full and advances to the next day's wake hour", async () => {
    const playset = await loadExample();
    const store = new InMemoryGameStateStore();
    const evening = drainedState(playset, 0);
    evening.clock = 1200; // 20:00 — an EVENING rest, the case that must roll the day
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), evening);
    const { engine } = await makeEngine({
      playset,
      store,
      classifier: scriptedClassifier([planOf({ kind: "enterCamp" }), planOf({ kind: "endDay" })]),
    });
    const clock0 = engine.getState().clock;

    // Enter camp (time frozen, no recovery), then End Day (full recovery + day rollover).
    await engine.submitPlayerInput("make camp for the night");
    await engine.submitPlayerInput("end the day");
    const s = engine.getState();
    // adjustEnergy by-difference: the stored value becomes exactly full.
    expect(s.actors["pc.you"]?.energy).toBe(DEFAULT_MAX_ENERGY);
    // enterCamp freezes the clock; End Day's resolver advances to the next day's wake hour, so the DAY
    // counter (floor(clock/1440)+1) rolls over (audit fix).
    expect(s.clock - clock0).toBe(restAdvanceMinutes(clock0));
    expect(s.clock % 1440).toBe(REST_WAKE_MINUTE); // wakes at 07:00
    expect(Math.floor(s.clock / 1440)).toBe(Math.floor(clock0 / 1440) + 1); // exactly one day later
    // A companion with no energy field was already "full" — the rest never materializes her key.
    expect(s.actors["npc.lyra"]?.energy).toBeUndefined();
  });

  test("long rest consumes one ration to lower exhaustion; no rations leaves it unchanged", async () => {
    const playset = await loadExample();
    const fedState = drainedState(playset, 0);
    fedState.clock = 1200; // 20:00 — the rest must cross into a new day for upkeep to settle at all
    fedState.actors["pc.you"]!.inventory = ["item.rations"];
    fedState.actors["pc.you"]!.exhaustion = 3;
    const fedStore = new InMemoryGameStateStore();
    await fedStore.save(makeSaveKey(playset.campaign.id, "pc.you"), fedState);
    const fed = await makeEngine({
      playset,
      store: fedStore,
      classifier: scriptedClassifier([planOf({ kind: "enterCamp" }), planOf({ kind: "endDay" })]),
    });
    await fed.engine.submitPlayerInput("make camp");
    await fed.engine.submitPlayerInput("end day");
    expect(fed.engine.getState().actors["pc.you"]?.inventory).toEqual([]);
    expect(fed.engine.getState().actors["pc.you"]?.exhaustion).toBe(2);

    const hungryState = drainedState(playset, 0);
    hungryState.clock = 1200;
    hungryState.actors["pc.you"]!.exhaustion = 6;
    hungryState.actors["pc.you"]!.conditions = ["unconscious"];
    const hungryStore = new InMemoryGameStateStore();
    await hungryStore.save(makeSaveKey(playset.campaign.id, "pc.you"), hungryState);
    const hungry = await makeEngine({
      playset,
      store: hungryStore,
      classifier: scriptedClassifier([planOf({ kind: "enterCamp" }), planOf({ kind: "endDay" })]),
    });
    await hungry.engine.submitPlayerInput("make camp");
    await hungry.engine.submitPlayerInput("end day");
    expect(hungry.engine.getState().actors["pc.you"]?.exhaustion).toBe(6);
    expect(hungry.engine.getState().actors["pc.you"]?.conditions).not.toContain("unconscious");
  });

  test("zero-cost invariants: empty input advances nothing", async () => {
    const { engine } = await makeEngine();
    const clock0 = engine.getState().clock;
    await engine.submitPlayerInput("   ");
    expect(engine.getState().clock).toBe(clock0);
    expect(engine.getState().actors["pc.you"]?.energy).toBeUndefined(); // never touched, never materialized
  });
});
