/**
 * Reducer + model tests — the single mutation chokepoint and the GameState⇄WorldModel
 * projection. Pure, deterministic, no engine/IO.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState, partyLocationOf } from "../src/world/model.ts";
import type { WorldModel } from "../src/world/model.ts";
import { loadExample } from "./support/harness.ts";
import type { PlaySet } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { Command } from "../src/world/commands.ts";
import { visitedFlag } from "../src/world/expansion.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import { applyDelta } from "./support/replay.ts";
import { coverageRow, WARDROBE_MODULE, type WardrobeSlice } from "../src/rules/wardrobe.ts";

/** A started engine's projected state → a fresh model seeded from the example world. */
async function exampleModel(): Promise<{ model: WorldModel; playset: PlaySet }> {
  const playset = await loadExample();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  const model = fromGameState(engine.getState(), playset.world, playset.campaign);
  return { model, playset };
}

describe("GameState ⇄ WorldModel projection", () => {
  test("round-trips the starting state losslessly", async () => {
    const { model, playset } = await exampleModel();
    const gs = toGameState(model);
    expect(gs.party).toEqual(["pc.you"]);
    expect(gs.companions).toEqual(["npc.lyra"]);
    expect(gs.partyLocationId).toBe("loc.tavern");
    expect(gs.actors["pc.you"]?.locationId).toBe("loc.tavern");
    expect(gs.actors["npc.lyra"]?.locationId).toBe("loc.tavern");
    // Re-seed from the projection and project again — stable.
    const again = toGameState(fromGameState(gs, playset.world, playset.campaign));
    expect(again).toEqual(gs);
  });

  test("persists statless authored NPC runtime state through save and reload", async () => {
    const playset = await loadExample();
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await engine.start();

    const control = engine as unknown as {
      apply(cmd: Command): { mutated: boolean };
      persist(): Promise<void>;
    };
    expect(control.apply({ type: "moveEntity", entityId: "npc.brann", to: "loc.square" }).mutated).toBe(true);
    expect(
      control.apply({ type: "setFlag", scope: "entity", entityId: "npc.brann", key: "served", value: "oatcake" }).mutated,
    ).toBe(true);
    await control.persist();

    const key = makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]);
    const saved = await store.load(key);
    expect(saved?.authoredNpcs?.["npc.brann"]).toEqual({
      locationId: "loc.square",
      flags: { served: "oatcake" },
    });

    const fresh = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await fresh.start();
    const reloaded = fromGameState(fresh.getState(), playset.world, playset.campaign);
    expect(reloaded.entities.get("npc.brann")?.locationId).toBe("loc.square");
    expect(reloaded.entities.get("npc.brann")?.flags).toEqual({ served: "oatcake" });
  });

  test("persists flags on stats-bearing actors through JSON projection and reload", async () => {
    const { model, playset } = await exampleModel();
    const result = applyCommand(model, {
      type: "setFlag",
      scope: "entity",
      entityId: "pc.you",
      key: "swore-oath",
      value: { to: "npc.lyra", kept: true },
    });
    expect(result.mutated).toBe(true);

    const projected = toGameState(model);
    expect(projected.actors["pc.you"]?.flags).toEqual({
      "swore-oath": { to: "npc.lyra", kept: true },
    });
    const reloaded = fromGameState(JSON.parse(JSON.stringify(projected)), playset.world, playset.campaign);
    expect(reloaded.entities.get("pc.you")?.flags).toEqual(projected.actors["pc.you"]?.flags);
    expect(toGameState(reloaded)).toEqual(projected);
  });

  test("old snapshots without authored NPC runtime re-derive statless NPCs from content", async () => {
    const { model, playset } = await exampleModel();
    const oldSnapshot = toGameState(model);
    delete oldSnapshot.authoredNpcs;

    const reloaded = fromGameState(oldSnapshot, playset.world, playset.campaign);
    expect(reloaded.entities.get("npc.brann")?.locationId).toBe("loc.tavern");
    expect(reloaded.entities.get("npc.brann")?.flags).toEqual({});
  });

  test("pre-economy snapshots (no coins/equipped keys) still load; new fields survive a JSON round-trip", async () => {
    const { model, playset } = await exampleModel();

    // The "old save": a snapshot minted before coins/equipped existed carries neither key.
    // JSON round-trip stands in for the sqlite store (which is JSON.parse without a schema).
    const oldJson = JSON.parse(JSON.stringify(toGameState(model))) as ReturnType<typeof toGameState>;
    expect("coins" in (oldJson.actors["pc.you"] ?? {})).toBe(false);
    expect("equipped" in (oldJson.actors["pc.you"] ?? {})).toBe(false);
    const reloaded = fromGameState(oldJson, playset.world, playset.campaign);
    expect(reloaded.entities.get("pc.you")?.stats?.coins).toBeUndefined(); // absent = 0 everywhere
    // …and the defaulted state accepts economy commands immediately (0 + 25 = 25).
    const res = applyCommand(reloaded, { type: "adjustCoins", entityId: "pc.you", by: 25 });
    expect(res.deltas[0]).toMatchObject({ kind: "coinsChanged", coins: 25 });

    // The "new save": coins + equipped project, serialize, and reload losslessly.
    applyCommand(reloaded, { type: "transferItem", itemId: "weapon.dagger", from: null, to: "pc.you" });
    applyCommand(reloaded, { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: "weapon.dagger" });
    const newJson = JSON.parse(JSON.stringify(toGameState(reloaded))) as ReturnType<typeof toGameState>;
    expect(newJson.actors["pc.you"]?.coins).toBe(25);
    expect(newJson.actors["pc.you"]?.equipped).toEqual({ weapon: "weapon.dagger" });
    const again = fromGameState(newJson, playset.world, playset.campaign);
    expect(again.entities.get("pc.you")?.stats?.coins).toBe(25);
    expect(again.entities.get("pc.you")?.stats?.equipped).toEqual({ weapon: "weapon.dagger" });
    expect(toGameState(again)).toEqual(toGameState(reloaded));
  });
});

describe("reducer — the only writer", () => {
  test("moveParty validates the exit, moves all co-located members, emits deltas", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "moveParty", to: "loc.square" });
    expect(res.mutated).toBe(true);
    expect(res.deltas.filter((d) => d.kind === "entityMoved").length).toBe(2);
    expect(partyLocationOf(model)).toBe("loc.square");
    expect(model.entities.get("npc.lyra")?.locationId).toBe("loc.square");
    // fog-of-war: both endpoints recorded visited via set-once flagSet deltas
    const flags = res.deltas.filter((d) => d.kind === "flagSet").map((d) => (d as { key: string }).key).sort();
    expect(flags).toEqual([visitedFlag("loc.square"), visitedFlag("loc.tavern")].sort());
  });

  test("moveParty records visited flags set-once — a return trip re-flags only the new room", async () => {
    const { model } = await exampleModel();
    applyCommand(model, { type: "moveParty", to: "loc.square" }); // flags tavern + square
    const back = applyCommand(model, { type: "moveParty", to: "loc.tavern" });
    // both endpoints already visited except… both ARE already visited ⇒ no new visited flagSet
    const flags = back.deltas.filter((d) => d.kind === "flagSet").map((d) => (d as { key: string }).key);
    expect(flags).toEqual([]);
    expect(model.flags[visitedFlag("loc.tavern")]).toBe(true);
    expect(model.flags[visitedFlag("loc.square")]).toBe(true);
  });

  test("moveParty solo moves ONLY the player; companions stay put (party split)", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "moveParty", to: "loc.square", solo: true });
    expect(res.mutated).toBe(true);
    // Only the PC moved — a single entityMoved delta, not two.
    expect(res.deltas.filter((d) => d.kind === "entityMoved").length).toBe(1);
    expect(model.entities.get("pc.you")?.locationId).toBe("loc.square");
    expect(partyLocationOf(model)).toBe("loc.square"); // re-anchors on the moved PC
    // The companion is left behind at the old location — the deliberate split.
    expect(model.entities.get("npc.lyra")?.locationId).toBe("loc.tavern");
  });

  test("moveParty to an unreachable location is rejected and mutates nothing", async () => {
    const { model } = await exampleModel();
    // `loc.nowhere` is not in the map at all — the one-writer guard rejects it as a non-location
    // (frontier/absent destinations can never hold the party — audit #1) before the barrier check.
    const res = applyCommand(model, { type: "moveParty", to: "loc.nowhere" });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("loc.nowhere");
    expect(partyLocationOf(model)).toBe("loc.tavern");
  });

  test("moveParty onto a raw frontier: sentinel is rejected (no soft-lock)", async () => {
    const { model } = await exampleModel();
    // A leader's grounded "explore that way" must never strand the party on an ungenerated pocket id.
    const res = applyCommand(model, { type: "moveParty", to: "frontier:somewhere" });
    expect(res.mutated).toBe(false);
    expect(partyLocationOf(model)).toBe("loc.tavern");
  });

  test("advanceClock accumulates and reports the new total", async () => {
    const { model } = await exampleModel();
    applyCommand(model, { type: "advanceClock", by: 1 });
    const res = applyCommand(model, { type: "advanceClock", by: 2 });
    expect(model.clock).toBe(3);
    expect(res.deltas[0]).toMatchObject({ kind: "clockAdvanced", by: 2, to: 3 });
  });

  test("adjustHp clamps to [0, maxHp] and emits hpChanged", async () => {
    const { model } = await exampleModel();
    const max = model.entities.get("pc.you")?.stats?.maxHp ?? 0;
    const down = applyCommand(model, { type: "adjustHp", entityId: "pc.you", by: -1000 });
    expect(model.entities.get("pc.you")?.stats?.currentHp).toBe(0);
    expect(down.deltas[0]).toMatchObject({ kind: "hpChanged", to: 0 });
    const up = applyCommand(model, { type: "adjustHp", entityId: "pc.you", by: 1000 });
    expect(model.entities.get("pc.you")?.stats?.currentHp).toBe(max);
    expect(up.mutated).toBe(true);
  });

  test("setQuestState and adjustRelationship are idempotent at the target value", async () => {
    const { model } = await exampleModel();
    expect(applyCommand(model, { type: "setQuestState", questId: "q1", state: "active" }).mutated).toBe(true);
    expect(applyCommand(model, { type: "setQuestState", questId: "q1", state: "active" }).mutated).toBe(false);

    const r = applyCommand(model, { type: "adjustRelationship", actorId: "npc.lyra", targetId: "pc.you", by: 5 });
    expect(r.deltas[0]).toMatchObject({ kind: "relationshipChanged", actorId: "npc.lyra", targetId: "pc.you" });
  });

  test("modulePatch merges into a namespaced slice (autonomy bookkeeping)", async () => {
    const { model } = await exampleModel();
    applyCommand(model, { type: "modulePatch", module: "autonomy", patch: { "npc.lyra": { talking: false, replyDepth: 0, lastActedAt: 42 } } });
    const slice = model.modules.autonomy as Record<string, { lastActedAt: number }>;
    expect(slice["npc.lyra"]?.lastActedAt).toBe(42);
  });

  test("automatic wardrobe coverage only escalates, while explicit manual/reset patches may de-escalate", async () => {
    const { model } = await exampleModel();
    applyCommand(model, {
      type: "modulePatch",
      module: WARDROBE_MODULE,
      patch: { "pc.you": { head: "removed", upper: "removed", lower: "worn" } },
    });

    const displaced = applyCommand(model, {
      type: "escalateWardrobeCoverage",
      entityId: "pc.you",
      state: "displaced",
    });
    expect(displaced.mutated).toBe(true);
    let row = (model.modules[WARDROBE_MODULE] as WardrobeSlice)["pc.you"];
    expect(row).toEqual({ head: "removed", ...coverageRow("displaced"), upper: "removed" });

    applyCommand(model, { type: "escalateWardrobeCoverage", entityId: "pc.you", state: "removed" });
    row = (model.modules[WARDROBE_MODULE] as WardrobeSlice)["pc.you"];
    expect(row).toEqual({ head: "removed", ...coverageRow("removed") });

    const weakerRepeat = applyCommand(model, {
      type: "escalateWardrobeCoverage",
      entityId: "pc.you",
      state: "displaced",
    });
    expect(weakerRepeat.mutated).toBe(false);
    expect((model.modules[WARDROBE_MODULE] as WardrobeSlice)["pc.you"]).toEqual({
      head: "removed",
      ...coverageRow("removed"),
    });

    // Paper-doll/manual dressing and lifecycle resets intentionally retain a non-monotone path.
    applyCommand(model, {
      type: "modulePatch",
      module: WARDROBE_MODULE,
      patch: { "pc.you": { upper: "worn" } },
    });
    expect((model.modules[WARDROBE_MODULE] as WardrobeSlice)["pc.you"]).toEqual({ upper: "worn" });
  });

  test("transferItem is atomic — a rejected transfer leaves the source inventory intact", async () => {
    const { model } = await exampleModel();
    const pc = model.entities.get("pc.you");
    if (!pc?.stats) throw new Error("pc.you should have stats");
    pc.stats.inventory = ["item.test"];
    // `to` cannot hold items (unknown/statless) → must reject WITHOUT having emptied `from` first.
    const res = applyCommand(model, { type: "transferItem", itemId: "item.test", from: "pc.you", to: "npc.nobody" });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("cannot hold");
    expect(model.entities.get("pc.you")?.stats?.inventory).toEqual(["item.test"]); // item not lost
  });

  test("transferItem moves an item between two stats-bearing entities", async () => {
    const { model } = await exampleModel();
    const pc = model.entities.get("pc.you");
    const lyra = model.entities.get("npc.lyra");
    if (!pc?.stats || !lyra?.stats) throw new Error("pc.you and npc.lyra should have stats");
    pc.stats.inventory = ["item.gift"];
    const res = applyCommand(model, { type: "transferItem", itemId: "item.gift", from: "pc.you", to: "npc.lyra" });
    expect(res.mutated).toBe(true);
    expect(res.deltas[0]).toMatchObject({ kind: "itemTransferred", itemId: "item.gift", from: "pc.you", to: "npc.lyra" });
    expect(pc.stats.inventory).not.toContain("item.gift");
    expect(lyra.stats.inventory).toContain("item.gift");
  });
});

describe("reducer — items & economy (Phase 1)", () => {
  test("transferItem removes exactly ONE instance from a stack and allows duplicates on add", async () => {
    const { model } = await exampleModel();
    const pc = model.entities.get("pc.you");
    const lyra = model.entities.get("npc.lyra");
    if (!pc?.stats || !lyra?.stats) throw new Error("pc.you and npc.lyra should have stats");
    pc.stats.inventory = ["item.potion-healing", "item.potion-healing"];
    lyra.stats.inventory = ["item.potion-healing"];

    applyCommand(model, { type: "transferItem", itemId: "item.potion-healing", from: "pc.you", to: "npc.lyra" });
    expect(pc.stats.inventory).toEqual(["item.potion-healing"]); // one of two left, not zero
    expect(lyra.stats.inventory).toEqual(["item.potion-healing", "item.potion-healing"]); // duplicate id stacked

    applyCommand(model, { type: "transferItem", itemId: "item.potion-healing", from: "pc.you", to: "npc.lyra" });
    expect(pc.stats.inventory).toEqual([]);
    expect(lyra.stats.inventory).toEqual(["item.potion-healing", "item.potion-healing", "item.potion-healing"]);
  });

  test("adjustCoins treats an absent purse as 0, clamps at 0, and reports the absolute balance", async () => {
    const { model } = await exampleModel();
    const pc = model.entities.get("pc.you");
    if (!pc?.stats) throw new Error("pc.you should have stats");
    expect(pc.stats.coins).toBeUndefined(); // pre-economy actor — no purse key at all

    expect(applyCommand(model, { type: "adjustCoins", entityId: "pc.you", by: -5 }).mutated).toBe(false); // 0 → 0
    const earn = applyCommand(model, { type: "adjustCoins", entityId: "pc.you", by: 30 });
    expect(earn.deltas[0]).toMatchObject({ kind: "coinsChanged", entityId: "pc.you", coins: 30 });
    const overspend = applyCommand(model, { type: "adjustCoins", entityId: "pc.you", by: -50 });
    expect(overspend.deltas[0]).toMatchObject({ kind: "coinsChanged", coins: 0 }); // clamped, absolute post-value
    expect(pc.stats.coins).toBe(0);
  });

  test("adjustCoins rejects statless entities and non-integer amounts", async () => {
    const { model } = await exampleModel();
    expect(applyCommand(model, { type: "adjustCoins", entityId: "npc.brann", by: 10 }).rejected?.reason).toContain(
      "no stats",
    );
    expect(applyCommand(model, { type: "adjustCoins", entityId: "pc.you", by: 1.5 }).rejected?.reason).toContain(
      "integer",
    );
  });

  test("equipItem requires possession; re-equip is a noop; null unequips", async () => {
    const { model } = await exampleModel();
    const pc = model.entities.get("pc.you");
    if (!pc?.stats) throw new Error("pc.you should have stats");

    const unheld = applyCommand(model, { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: "weapon.dagger" });
    expect(unheld.rejected?.reason).toContain("does not hold");

    pc.stats.inventory = [...pc.stats.inventory, "weapon.dagger"];
    const equip = applyCommand(model, { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: "weapon.dagger" });
    expect(equip.deltas[0]).toMatchObject({ kind: "equipmentChanged", entityId: "pc.you", equipped: { weapon: "weapon.dagger" } });
    expect(pc.stats.equipped).toEqual({ weapon: "weapon.dagger" });

    expect(applyCommand(model, { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: "weapon.dagger" }).mutated).toBe(false);

    const unequip = applyCommand(model, { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: null });
    expect(unequip.deltas[0]).toMatchObject({ kind: "equipmentChanged", equipped: {} }); // absolute record
    expect(pc.stats.equipped).toEqual({});
    expect(applyCommand(model, { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: null }).mutated).toBe(false);
  });

  test("transferring away the LAST copy of an equipped item clears its slot (both deltas emitted)", async () => {
    const { model } = await exampleModel();
    const pc = model.entities.get("pc.you");
    if (!pc?.stats) throw new Error("pc.you should have stats");
    pc.stats.inventory = ["weapon.dagger", "weapon.dagger"];
    applyCommand(model, { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: "weapon.dagger" });

    // A copy remains — the slot survives, no equipment delta.
    const first = applyCommand(model, { type: "transferItem", itemId: "weapon.dagger", from: "pc.you", to: "npc.lyra" });
    expect(first.deltas.map((d) => d.kind)).toEqual(["itemTransferred"]);
    expect(pc.stats.equipped).toEqual({ weapon: "weapon.dagger" });

    // The last copy leaves — the slot is vacated in the same command.
    const second = applyCommand(model, { type: "transferItem", itemId: "weapon.dagger", from: "pc.you", to: "npc.lyra" });
    expect(second.deltas.map((d) => d.kind)).toEqual(["itemTransferred", "equipmentChanged"]);
    expect(second.deltas[1]).toMatchObject({ kind: "equipmentChanged", entityId: "pc.you", equipped: {} });
    expect(pc.stats.equipped).toEqual({});
    expect(pc.stats.inventory).not.toContain("weapon.dagger");
  });
});

describe("reducer armor: unknown command type", () => {
  test("an unknown/typo command `type` is REJECTED (mutates nothing) instead of returning undefined", async () => {
    const { model } = await exampleModel();
    // Data-driven effects (authored defeat-outcome tables) can carry a bogus `type` the union never saw.
    // The reducer's default case must return a proper CommandResult so the engine never crashes on
    // `res.deltas` (the High-severity finding).
    const before = structuredClone(model.flags);
    const res = applyCommand(model, { type: "totallyNotACommand", key: "x" } as unknown as Command);
    expect(res).toBeDefined();
    expect(res.deltas).toEqual([]);
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toMatch(/unknown command type: totallyNotACommand/);
    // Nothing changed.
    expect(model.flags).toEqual(before);
  });

  test("rejections/no-ops do not materialize helper slices, and non-finite payloads are rejected", async () => {
    const { model } = await exampleModel();
    const before = structuredClone(model);

    const unknownLeader = applyCommand(model, {
      type: "setPartyLeader",
      entityId: "npc.does-not-exist",
    });
    expect(unknownLeader.rejected?.reason).toContain("unknown entity");
    expect(model).toEqual(before); // partySlice() from preflight never leaks into the live model

    const noMemory = applyCommand(model, { type: "clearNpcMemory", npcId: "npc.lyra" });
    expect(noMemory.mutated).toBe(false);
    expect(model).toEqual(before); // npcMemorySlice() also remains absent on a noop

    for (const command of [
      { type: "advanceClock", by: Number.NaN },
      { type: "adjustHp", entityId: "pc.you", by: Number.POSITIVE_INFINITY },
      { type: "modulePatch", module: "bad", patch: { nested: { value: Number.NEGATIVE_INFINITY } } },
    ] as Command[]) {
      const result = applyCommand(model, command);
      expect(result.rejected?.reason).toContain("non-finite");
      expect(model).toEqual(before);
    }
  });
});
