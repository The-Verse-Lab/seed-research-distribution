/**
 * Combat state reducer + replay spine (M3 Phase 2).
 *
 * The combat encounter lives only at `model.modules.combat`, is written only by the reducer,
 * and folds from absolute post-state deltas.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { defaultCombatEncounter, type CombatEncounter } from "../src/rules/combat-state.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import type { WorldModel } from "../src/world/model.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { combatSlice } from "../src/world/module-slices.ts";
import { isCombatActive } from "../src/world/queries.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { applyDelta } from "./support/replay.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { loadExample } from "./support/harness.ts";

function bareModel(): WorldModel {
  return {
    campaignId: "c",
    worldId: "w",
    clock: 0,
    entities: new Map(),
    map: { exits: new Map() },
    quests: new Map(),
    relationships: new Map(),
    modules: {},
    flags: {},
  };
}

async function exampleModel(): Promise<WorldModel> {
  const playset = await loadExample();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  return fromGameState(engine.getState(), playset.world, playset.campaign);
}

const stamp = (pre: EmittedDelta, seq: number): DeltaEvent =>
  ({ ...pre, id: `d${seq}`, at: 0, seq }) as DeltaEvent;

describe("combatSlice", () => {
  test("defaults to an inactive encounter", () => {
    const m = bareModel();
    expect(isCombatActive(m)).toBe(false);
    expect(combatSlice(m)).toEqual(defaultCombatEncounter());
  });
});

describe("startCombat", () => {
  test("creates the slice, copies order, and emits the absolute encounter", () => {
    const m = bareModel();
    const order = ["pc.a", "mob.b"];
    const res = applyCommand(m, { type: "startCombat", locationId: "loc.room", order, turnIndex: 1 });

    expect(res.mutated).toBe(true);
    expect(res.deltas).toEqual([
      {
        kind: "combatStarted",
        encounter: { active: true, locationId: "loc.room", order: ["pc.a", "mob.b"], allies: [], turnIndex: 1, round: 1 },
      },
    ]);
    order.push("mob.c");
    expect(combatSlice(m).order).toEqual(["pc.a", "mob.b"]);
    expect(isCombatActive(m)).toBe(true);
  });

  test("rejects an invalid turn index without mutating", () => {
    const m = bareModel();
    const res = applyCommand(m, { type: "startCombat", locationId: "loc.room", order: ["pc.a"], turnIndex: 3 });

    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("turnIndex");
    expect(combatSlice(m)).toEqual(defaultCombatEncounter());
  });
});

describe("advanceTurn", () => {
  test("advances the turn and increments round only when wrapping", () => {
    const m = bareModel();
    applyCommand(m, { type: "startCombat", locationId: "loc.room", order: ["pc.a", "npc.b", "mob.c"] });

    const a = applyCommand(m, { type: "advanceTurn" });
    expect(a.deltas[0]).toEqual({
      kind: "combatTurnAdvanced",
      encounter: { active: true, locationId: "loc.room", order: ["pc.a", "npc.b", "mob.c"], allies: [], turnIndex: 1, round: 1 },
    });

    applyCommand(m, { type: "advanceTurn" });
    const wrap = applyCommand(m, { type: "advanceTurn" });
    expect((wrap.deltas[0] as { encounter: CombatEncounter }).encounter).toMatchObject({ turnIndex: 0, round: 2 });
  });

  test("is a no-op when combat is inactive", () => {
    const m = bareModel();
    const res = applyCommand(m, { type: "advanceTurn" });
    expect(res.mutated).toBe(false);
    expect(res.deltas).toHaveLength(0);
  });
});

describe("endCombat", () => {
  test("clears the encounter to the default inactive post-state", () => {
    const m = bareModel();
    applyCommand(m, { type: "startCombat", locationId: "loc.room", order: ["pc.a", "mob.b"] });

    const res = applyCommand(m, { type: "endCombat" });

    expect(res.mutated).toBe(true);
    expect(res.deltas).toEqual([{ kind: "combatEnded", encounter: defaultCombatEncounter() }]);
    expect(combatSlice(m)).toEqual(defaultCombatEncounter());
    expect(isCombatActive(m)).toBe(false);
  });

  test("ending an already-default encounter is a no-op", () => {
    const m = bareModel();
    const res = applyCommand(m, { type: "endCombat" });
    expect(res.mutated).toBe(false);
  });
});

describe("replay", () => {
  test("combat deltas overwrite with absolute post-state (applying twice == once)", () => {
    const live = bareModel();
    const pre = applyCommand(live, {
      type: "startCombat",
      locationId: "loc.room",
      order: ["pc.a", "mob.b"],
    }).deltas[0] as EmittedDelta;
    const delta = stamp(pre, 0);

    const target = bareModel();
    target.modules.combat = { active: true, locationId: "loc.other", order: ["wrong"], turnIndex: 0, round: 9 };
    applyDelta(target, delta);
    applyDelta(target, delta);

    expect(combatSlice(target)).toEqual(combatSlice(live));
  });

  test("the slice rides GameState.modules without a store change", async () => {
    const model = await exampleModel();
    applyCommand(model, { type: "startCombat", locationId: "loc.tavern", order: ["pc.you", "npc.lyra"] });

    const gs = toGameState(model);
    expect(gs.modules?.combat).toEqual({
      active: true,
      locationId: "loc.tavern",
      order: ["pc.you", "npc.lyra"],
      allies: [],
      turnIndex: 0,
      round: 1,
    });

    const playset = await loadExample();
    const again = toGameState(fromGameState(gs, playset.world, playset.campaign));
    expect(again.modules?.combat).toEqual(gs.modules?.combat);
  });
});

describe("joinCombat (r5) — a bystander taking the party's side mid-fight", () => {
  const withBody = (id: string) => ({
    type: "spawnEntity" as const,
    entity: { id, kind: "npc" as const, tier: "tracked" as const, name: id, locationId: "loc.room", stats: { currentHp: 8, maxHp: 8, inventory: [] } },
  });

  test("splices in AFTER the current turn, so nobody is granted or skipped a turn", () => {
    const m = bareModel();
    applyCommand(m, withBody("npc.sela"));
    applyCommand(m, { type: "startCombat", locationId: "loc.room", order: ["pc.a", "mob.b", "mob.c"], turnIndex: 1 });
    const res = applyCommand(m, { type: "joinCombat", entityId: "npc.sela", ally: true });

    expect(res.mutated).toBe(true);
    const enc = (res.deltas[0] as { encounter: CombatEncounter }).encounter;
    expect(enc.order).toEqual(["pc.a", "mob.b", "npc.sela", "mob.c"]);
    // The current actor is still mob.b — the insert went after them, not over them.
    expect(enc.order[enc.turnIndex]).toBe("mob.b");
    expect(enc.allies).toEqual(["npc.sela"]);
  });

  test("a joiner with no body is refused — a bodyless combatant would stand in order and never swing", () => {
    const m = bareModel();
    applyCommand(m, {
      type: "spawnEntity",
      entity: { id: "npc.statless", kind: "npc", tier: "tracked", name: "Tobin", locationId: "loc.room" },
    });
    applyCommand(m, { type: "startCombat", locationId: "loc.room", order: ["pc.a", "mob.b"] });
    const res = applyCommand(m, { type: "joinCombat", entityId: "npc.statless", ally: true });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("cannot fight");
  });

  test("joining twice is a no-op, and joining no fight at all is rejected", () => {
    const m = bareModel();
    applyCommand(m, withBody("npc.sela"));
    expect(applyCommand(m, { type: "joinCombat", entityId: "npc.sela", ally: true }).rejected?.reason).toContain(
      "no live encounter",
    );
    applyCommand(m, { type: "startCombat", locationId: "loc.room", order: ["pc.a", "mob.b"] });
    applyCommand(m, { type: "joinCombat", entityId: "npc.sela", ally: true });
    expect(applyCommand(m, { type: "joinCombat", entityId: "npc.sela", ally: true }).mutated).toBe(false);
  });

  test("the delta folds absolutely — applying it twice equals applying it once", () => {
    const m = bareModel();
    applyCommand(m, withBody("npc.sela"));
    applyCommand(m, { type: "startCombat", locationId: "loc.room", order: ["pc.a", "mob.b"] });
    const delta = applyCommand(m, { type: "joinCombat", entityId: "npc.sela", ally: true }).deltas[0]!;
    const folded = { modules: {}, entities: new Map() } as unknown as WorldModel;
    applyDelta(folded, delta as DeltaEvent);
    applyDelta(folded, delta as DeltaEvent);
    expect(combatSlice(folded)).toEqual(combatSlice(m));
  });
});
