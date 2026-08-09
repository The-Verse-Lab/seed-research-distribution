/**
 * Status effects — reusable temporary mechanical modifiers.
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TickContext } from "../src/engine/tick.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import { resolveAttack, type Combatant } from "../src/rules/combat.ts";
import { resolveCheck } from "../src/rules/checks.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { getWeapon } from "../src/rules/srd/index.ts";
import { exposureEffectFor, statusMods, type StatusEffectSlice } from "../src/rules/status-effects.ts";
import { BASELINE_COVERAGE_SLOT_IDS, coverageRow, type WardrobeSlice } from "../src/rules/wardrobe.ts";
import { CharacterSchema, type Campaign } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { applyCommand, type CommandResult } from "../src/world/reducer.ts";
import { toGameState, type WorldModel } from "../src/world/model.ts";
import type { Command } from "../src/world/commands.ts";
import { StatusEffectsModule } from "../src/modules/status-effects/module.ts";
import { applyDelta } from "./support/replay.ts";
import { loadExample } from "./support/harness.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

function model(): WorldModel {
  return {
    campaignId: "c.status",
    worldId: "w.status",
    clock: 0,
    entities: new Map([
      [
        "pc.you",
        {
          id: "pc.you",
          kind: "pc",
          tier: "significant",
          name: "You",
          locationId: "loc.test",
          stats: {
            currentHp: 10,
            maxHp: 10,
            conditions: [],
            inventory: [],
            energy: 20,
          },
          partyMember: true,
          flags: {},
        },
      ],
    ]),
    map: { exits: new Map([["loc.test", []]]) },
    quests: new Map(),
    relationships: new Map(),
    modules: {},
    flags: {},
  };
}

// `campaign` is optional and omitted by most callers (a lightweight ctx with no services, exactly
// like a real tick's react/narrate phases never touch) — only the occupancy-narrowing tests below
// supply one, to drive the module's own `ctx.services.campaign` lookup.
function runStatusTick(target: WorldModel, campaign?: Campaign): EmittedDelta[] {
  const deltas: EmittedDelta[] = [];
  const ctx = {
    trigger: { kind: "player", input: "wait" },
    model: target,
    data: {},
    ...(campaign ? { services: { campaign } } : {}),
    apply: (cmd: Command): CommandResult => {
      const res = applyCommand(target, cmd);
      deltas.push(...res.deltas);
      return res;
    },
  } as TickContext;
  const module = new StatusEffectsModule();
  module.phases.perceive?.(ctx);
  module.phases.commit?.(ctx);
  return deltas;
}

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

const freeformClassifier: TurnClassifier = {
  classify: async () => planOf({ kind: "freeformNarrative" }),
};

describe("status effects: reducer and tick", () => {
  test("applyStatusEffect mirrors the condition tag and stores the effect slice", () => {
    const live = model();
    const res = applyCommand(live, {
      type: "applyStatusEffect",
      entityId: "pc.you",
      effect: { kind: "maimed", turnsRemaining: 2, mods: { check: -2, attack: -2, energy: 2 } },
    });

    expect(res.rejected).toBeUndefined();
    expect(live.entities.get("pc.you")?.stats?.conditions).toContain("maimed");
    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]).toHaveLength(1);
    expect(res.deltas.map((d) => d.kind)).toEqual(["conditionChanged", "modulePatched"]);
  });

  test("statusMods sums modifiers and ORs disadvantage", () => {
    const live = model();
    applyCommand(live, {
      type: "applyStatusEffect",
      entityId: "pc.you",
      effect: { kind: "maimed", turnsRemaining: 3, mods: { check: -2, attack: -2 } },
    });
    applyCommand(live, {
      type: "applyStatusEffect",
      entityId: "pc.you",
      effect: { kind: "poisoned", turnsRemaining: 3, mods: { check: -1, ac: -1, disadvantage: true } },
    });

    expect(statusMods(live, "pc.you")).toEqual({
      check: -3,
      attack: -2,
      ac: -1,
      energy: 0,
      advantage: false,
      disadvantage: true,
    });
  });

  test("the turn tick decrements effects and clears the mirrored condition at zero", () => {
    const live = model();
    applyCommand(live, {
      type: "applyStatusEffect",
      entityId: "pc.you",
      effect: { kind: "maimed", turnsRemaining: 2, mods: { check: -2 } },
    });

    runStatusTick(live);
    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]?.[0]?.turnsRemaining).toBe(1);
    expect(live.entities.get("pc.you")?.stats?.conditions).toContain("maimed");

    const deltas = runStatusTick(live);
    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]).toBeUndefined();
    expect(live.entities.get("pc.you")?.stats?.conditions).not.toContain("maimed");
    expect(deltas).toContainEqual({ kind: "conditionChanged", entityId: "pc.you", condition: "maimed", active: false });
  });

  test("apply plus full tick-to-expiry arc replays to the same snapshot", () => {
    const live = model();
    const seed = structuredClone(live);
    const deltas: EmittedDelta[] = [];

    deltas.push(
      ...applyCommand(live, {
        type: "applyStatusEffect",
        entityId: "pc.you",
        effect: { kind: "maimed", turnsRemaining: 2, mods: { check: -2, attack: -2, energy: 2 } },
      }).deltas,
    );
    deltas.push(...runStatusTick(live));
    deltas.push(...runStatusTick(live));

    deltas.map(stamp).forEach((delta) => applyDelta(seed, delta));
    expect(toGameState(seed)).toEqual(toGameState(live));
  });

  test("check and attack callers can apply the penalty mechanically", () => {
    const check = resolveCheck({ abilityScore: 10, dc: 10, bonus: statusMods({ ...model(), modules: { statusEffects: { active: { "pc.you": [{ kind: "maimed", turnsRemaining: 1, mods: { check: -2 } }] } } } }, "pc.you").check }, () => 0.45);
    expect(check.total).toBe(8);
    expect(check.success).toBe(false);

    const weapon = getWeapon("weapon.longsword")!;
    const attacker: Combatant = {
      id: "pc.you",
      currentHp: 10,
      stats: {
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        maxHp: 10,
        armorClass: 10,
        level: 1,
        speed: 30,
        proficiencies: [],
        spells: [],
      },
    };
    const defender: Combatant = { ...attacker, id: "foe", stats: { ...attacker.stats, armorClass: 12 } };
    expect(resolveAttack(attacker, defender, weapon, () => 0.45).hit).toBe(true);
    expect(resolveAttack(attacker, defender, weapon, () => 0.45, { toHit: -2 }).hit).toBe(false);
  });
});

describe("chilled: bare exposure effect", () => {
  test("exposureEffectFor reads bare vs. dressed/disheveled from the wardrobe row", () => {
    const bare = model();
    bare.modules.wardrobe = { "pc.you": coverageRow("removed") };
    expect(exposureEffectFor(bare, "pc.you")).toBe(true);

    const dressed = model();
    expect(exposureEffectFor(dressed, "pc.you")).toBe(false);

    const disheveled = model();
    disheveled.modules.wardrobe = { "pc.you": { upper: "displaced" } };
    expect(exposureEffectFor(disheveled, "pc.you")).toBe(false);
  });

  // A character whose authored prose names no garment (P1's fallback: just the paper-doll's
  // baseline top/bottoms) reads bare once THOSE two are removed — the brief's own Attire: line
  // already does this via occupancy. Confirmed live: stripping only the baseline pair on a
  // description-only PC showed "Attire: bare" in the brief, but the no-occupancy default below
  // never reached "bare" (4 of 6 coverage slots default to worn) — so `chilled` never applied.
  // `occupied` closes that gap for callers that resolve it (the module, from the campaign sheet).
  test("occupancy narrows bare to just the slots removed, matching the brief's own read", () => {
    const baselineOnly = model();
    baselineOnly.modules.wardrobe = { "pc.you": { upper: "removed", lower: "removed" } };

    expect(exposureEffectFor(baselineOnly, "pc.you")).toBe(false);
    expect(exposureEffectFor(baselineOnly, "pc.you", new Set(BASELINE_COVERAGE_SLOT_IDS))).toBe(true);
  });

  test("bare for one tick ensures chilled, and its mods apply mechanically", () => {
    const live = model();
    live.modules.wardrobe = { "pc.you": coverageRow("removed") };

    runStatusTick(live);

    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]).toEqual([
      { kind: "chilled", turnsRemaining: 2, mods: { check: -1, energy: -1 }, source: "exposure" },
    ]);
    expect(statusMods(live, "pc.you")).toEqual({
      check: -1,
      attack: 0,
      ac: 0,
      energy: -1,
      advantage: false,
      disadvantage: false,
    });
    expect(live.entities.get("pc.you")?.stats?.conditions).toContain("chilled");
  });

  // A live model verification first caught this: a PC already bare when a
  // tick starts got "Attire: bare" in the very same brief, but chilled's -1 didn't apply to a
  // check rolled that same turn — because the mods only got applied in commit, which runs AFTER
  // resolve (where a check reads ctx.model directly) and narrate (where the brief is built). The
  // fix ensures a newly-bare PC's chilled from perceive, before either phase runs.
  test("chilled applies from perceive — before commit runs, in time for this tick's own check", () => {
    const live = model();
    live.modules.wardrobe = { "pc.you": coverageRow("removed") };

    const ctx = {
      trigger: { kind: "player", input: "wait" },
      model: live,
      data: {},
      apply: (cmd: Command): CommandResult => applyCommand(live, cmd),
    } as TickContext;
    const module = new StatusEffectsModule();

    module.phases.perceive?.(ctx);
    expect(statusMods(live, "pc.you")).toEqual({
      check: -1,
      attack: 0,
      ac: 0,
      energy: -1,
      advantage: false,
      disadvantage: false,
    });

    module.phases.commit?.(ctx);
    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]?.[0]?.turnsRemaining).toBe(2);
  });

  test("the module resolves occupancy from the campaign's own character sheet, not just the wardrobe row", () => {
    const live = model();
    // The paper-doll's two strip affordances only — never touches the other four coverage slots.
    live.modules.wardrobe = { "pc.you": { upper: "removed", lower: "removed" } };
    const barePcCharacter = CharacterSchema.parse({
      id: "pc.you",
      name: "You",
      description: "Travel-stained and sharp-eyed, hands callused from rope and rail.", // no garment terms
      stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 },
    });

    runStatusTick(live, { characters: [barePcCharacter] } as Campaign);

    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]?.[0]?.kind).toBe("chilled");
  });

  test("staying bare for 5 turns keeps turnsRemaining refreshed at 2 — it never lapses", () => {
    const live = model();
    live.modules.wardrobe = { "pc.you": coverageRow("removed") };

    for (let i = 0; i < 5; i++) {
      runStatusTick(live);
      expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]).toEqual([
        { kind: "chilled", turnsRemaining: 2, mods: { check: -1, energy: -1 }, source: "exposure" },
      ]);
    }
    expect(live.entities.get("pc.you")?.stats?.conditions).toContain("chilled");
  });

  test("redressing stops the refresh; chilled decays over its own 2 remaining turns, not instantly", () => {
    const live = model();
    live.modules.wardrobe = { "pc.you": coverageRow("removed") };

    runStatusTick(live); // bare: chilled ensured at full duration
    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]?.[0]?.turnsRemaining).toBe(2);

    (live.modules.wardrobe as WardrobeSlice)["pc.you"]!.upper = "worn"; // redress mid-exposure

    runStatusTick(live); // grace turn 1: decrements, still active — no instant clear on redress
    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]?.[0]?.turnsRemaining).toBe(1);
    expect(live.entities.get("pc.you")?.stats?.conditions).toContain("chilled");

    runStatusTick(live); // grace turn 2: expires via the module's ordinary decrement, same as any other kind
    expect((live.modules.statusEffects as StatusEffectSlice).active["pc.you"]).toBeUndefined();
    expect(live.entities.get("pc.you")?.stats?.conditions).not.toContain("chilled");
  });

  test("ensure, refresh, and redress-to-expiry all replay to the same snapshot", () => {
    const live = model();
    live.modules.wardrobe = { "pc.you": coverageRow("removed") };
    const seed = structuredClone(live);
    const deltas: EmittedDelta[] = [];

    deltas.push(...runStatusTick(live)); // ensure @2
    deltas.push(...runStatusTick(live)); // refresh back to @2

    const redress = (m: WorldModel) => {
      (m.modules.wardrobe as WardrobeSlice)["pc.you"]!.upper = "worn";
    };
    redress(live);
    redress(seed);

    deltas.push(...runStatusTick(live)); // grace turn 1
    deltas.push(...runStatusTick(live)); // grace turn 2: expiry

    deltas.map(stamp).forEach((delta) => applyDelta(seed, delta));
    expect(toGameState(seed)).toEqual(toGameState(live));
  });
});

describe("chilled: redress grace period (engine)", () => {
  test("an engine-driven redress clears chilled two ticks later, never instantly", async () => {
    const playset = await loadExample();
    const store = new InMemoryGameStateStore();
    const state: GameState = {
      campaignId: playset.campaign.id,
      worldId: playset.world.id,
      partyLocationId: playset.campaign.startingState.locationId,
      clock: 0,
      party: ["pc.you"],
      companions: [],
      actors: {
        "pc.you": {
          id: "pc.you",
          currentHp: 24,
          locationId: playset.campaign.startingState.locationId,
          inventory: [],
          conditions: [],
          energy: 10,
        },
      },
      quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
      relationships: {},
      autonomy: {},
      modules: {
        wardrobe: { "pc.you": coverageRow("removed") },
      },
      flags: {},
    };
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: freeformClassifier,
      rng: mulberry32(7),
    });
    await engine.start();

    await engine.submitPlayerInput("I wait and catch my breath.");
    expect(engine.getState().actors["pc.you"]?.conditions).toContain("chilled");
    expect(
      (engine.getState().modules?.statusEffects as StatusEffectSlice | undefined)?.active["pc.you"]?.[0]
        ?.turnsRemaining,
    ).toBe(2);

    await engine.submitAction({ kind: "clothing", slotId: "upper", state: "worn" });

    await engine.submitPlayerInput("I wait and catch my breath.");
    expect(engine.getState().actors["pc.you"]?.conditions).toContain("chilled");
    expect(
      (engine.getState().modules?.statusEffects as StatusEffectSlice | undefined)?.active["pc.you"]?.[0]
        ?.turnsRemaining,
    ).toBe(1);

    await engine.submitPlayerInput("I wait and catch my breath.");
    expect(engine.getState().actors["pc.you"]?.conditions).not.toContain("chilled");
  });
});

describe("status effects: engine cost hook", () => {
  test("energy surcharge is spent at the per-turn chokepoint", async () => {
    const playset = await loadExample();
    const store = new InMemoryGameStateStore();
    const state: GameState = {
      campaignId: playset.campaign.id,
      worldId: playset.world.id,
      partyLocationId: playset.campaign.startingState.locationId,
      clock: 0,
      party: ["pc.you"],
      companions: [],
      actors: {
        "pc.you": {
          id: "pc.you",
          currentHp: 24,
          locationId: playset.campaign.startingState.locationId,
          inventory: [],
          conditions: ["maimed"],
          energy: 10,
        },
      },
      quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
      relationships: {},
      autonomy: {},
      modules: {
        statusEffects: {
          active: {
            "pc.you": [{ kind: "maimed", turnsRemaining: 3, mods: { energy: 2 } }],
          },
        },
      },
      flags: {},
    };
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: freeformClassifier,
      rng: mulberry32(7),
    });
    await engine.start();

    await engine.submitPlayerInput("I wait and catch my breath.");

    expect(engine.getState().actors["pc.you"]?.energy).toBe(7);
  });
});
