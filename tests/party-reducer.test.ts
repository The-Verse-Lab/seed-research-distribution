/**
 * Party reducer + persistence spine (Phase 2, Stage A) — the single-writer contract for party
 * membership/leadership. Pure, deterministic, no IO. Asserts: the validation paths (unknown /
 * wrong-kind / statless entities, non-member leaders), the atomic leave (flag + cleared
 * pendingLeave + leader reset in ONE command), absent-slice defaults (`leaderId` null ⇒ the PC
 * leads), that every delta carries the ABSOLUTE post-state slice (a detached copy, never the live
 * one), and that a promoted location NPC's membership + the slice survive the GameState
 * save-shape round trip (toGameState → JSON → fromGameState).
 *
 * Membership is mechanically NEUTRAL (the uncensored pillar): the reducer flips one flag and
 * touches nothing else — no relationship/disposition writes ride the delta.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { partySlice } from "../src/world/module-slices.ts";
import { clonePartySlice, defaultPartySlice } from "../src/rules/party.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { PlaySet } from "../src/content/schema.ts";
import { loadExample } from "./support/harness.ts";

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
  return { model: fromGameState(engine.getState(), playset.world, playset.campaign), playset };
}

/** Promote the statless authored npc.brann the Stage-B way: respawn with a body, raise the tier. */
function promoteBrann(model: WorldModel): void {
  expect(applyCommand(model, { type: "despawnEntity", entityId: "npc.brann" }).mutated).toBe(true);
  const spawned = applyCommand(model, {
    type: "spawnEntity",
    entity: {
      id: "npc.brann",
      kind: "npc",
      tier: "tracked",
      name: "Brann",
      locationId: "loc.tavern",
      templateId: "npc.brann",
      stats: { currentHp: 12, maxHp: 12, inventory: ["item.lantern"], coins: 25 },
    },
  });
  expect(spawned.mutated).toBe(true);
  expect(applyCommand(model, { type: "setEntityTier", entityId: "npc.brann", tier: "significant" }).mutated).toBe(true);
}

describe("party slice — defaults", () => {
  test("absent slice defaults to leaderId null (the PC leads) + empty pendingLeave", async () => {
    const { model } = await exampleModel();
    expect(model.modules.party).toBeUndefined(); // nothing seeded it
    expect(partySlice(model)).toEqual(defaultPartySlice());
    expect(partySlice(model)).toEqual({ leaderId: null, pendingLeave: {} });
  });
});

describe("setPartyMembership — validation + the atomic leave", () => {
  test("rejects an unknown entity, a monster, and a statless NPC; mutates nothing", async () => {
    const { model } = await exampleModel();
    const before = toGameState(model);

    const unknown = applyCommand(model, { type: "setPartyMembership", entityId: "npc.ghost", member: true });
    expect(unknown.rejected?.reason).toContain("unknown entity");

    // Spawn a monster with stats — right body, wrong kind.
    applyCommand(model, {
      type: "spawnEntity",
      entity: { id: "mob.rat", kind: "monster", tier: "transient", name: "Rat", locationId: "loc.square", stats: { currentHp: 7, maxHp: 7 } },
    });
    const monster = applyCommand(model, { type: "setPartyMembership", entityId: "mob.rat", member: true });
    expect(monster.rejected?.reason).toContain("only NPCs and PCs");
    applyCommand(model, { type: "despawnEntity", entityId: "mob.rat" });

    // npc.brann is authored + statless — membership needs a body (promotion grants one first).
    const statless = applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: true });
    expect(statless.rejected?.reason).toContain("has no stats");

    expect(toGameState(model)).toEqual(before); // rejected commands mutated nothing
  });

  test("join flips ONLY the flag; the delta carries the absolute detached slice", async () => {
    const { model } = await exampleModel();
    promoteBrann(model);
    const relationshipsBefore = structuredClone(
      Object.fromEntries([...model.relationships].map(([a, m]) => [a, Object.fromEntries(m)])),
    );

    const res = applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: true });
    expect(res.mutated).toBe(true);
    expect(model.entities.get("npc.brann")?.partyMember).toBe(true);
    expect(res.deltas).toEqual([
      { kind: "partyMembershipChanged", entityId: "npc.brann", member: true, party: { leaderId: null, pendingLeave: {} } },
    ]);
    // The delta's slice is a copy, not the live one — mutating it cannot bypass the reducer.
    const delta = res.deltas[0] as { party: { leaderId: string | null } };
    delta.party.leaderId = "npc.brann";
    expect(partySlice(model).leaderId).toBeNull();

    // Mechanically neutral: joining wrote NO relationship/disposition bonus; every subsystem sees
    // a party member exactly like any other NPC.
    expect(Object.fromEntries([...model.relationships].map(([a, m]) => [a, Object.fromEntries(m)]))).toEqual(
      relationshipsBefore,
    );

    // Idempotent: joining again is a noop.
    const again = applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: true });
    expect(again.mutated).toBe(false);
    expect(again.rejected).toBeUndefined();
  });

  test("leave clears the member's pendingLeave and resets leadership when they led — atomically", async () => {
    const { model } = await exampleModel();
    promoteBrann(model);
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: true });
    applyCommand(model, { type: "setPartyLeader", entityId: "npc.brann" });
    applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.brann", deniedAtSeq: 3 });
    expect(partySlice(model)).toEqual({ leaderId: "npc.brann", pendingLeave: { "npc.brann": { deniedAtSeq: 3 } } });

    const res = applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: false });
    expect(res.mutated).toBe(true);
    expect(model.entities.get("npc.brann")?.partyMember).toBe(false);
    expect(res.deltas).toEqual([
      { kind: "partyMembershipChanged", entityId: "npc.brann", member: false, party: { leaderId: null, pendingLeave: {} } },
    ]);
    expect(partySlice(model)).toEqual({ leaderId: null, pendingLeave: {} });
  });

  test("leave keeps another member's leadership and pendingLeave untouched", async () => {
    const { model } = await exampleModel();
    promoteBrann(model);
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: true });
    applyCommand(model, { type: "setPartyLeader", entityId: "pc.you" });
    applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.lyra", deniedAtSeq: 9 });

    applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: false });
    expect(partySlice(model)).toEqual({ leaderId: "pc.you", pendingLeave: { "npc.lyra": { deniedAtSeq: 9 } } });
  });
});

describe("setPartyLeader — validation", () => {
  test("rejects an unknown entity and a non-member NPC; accepts a member, the PC, and null", async () => {
    const { model } = await exampleModel();
    promoteBrann(model);

    expect(applyCommand(model, { type: "setPartyLeader", entityId: "npc.ghost" }).rejected?.reason).toContain(
      "unknown entity",
    );
    // Promoted but NOT yet a member — leadership requires membership.
    expect(applyCommand(model, { type: "setPartyLeader", entityId: "npc.brann" }).rejected?.reason).toContain(
      "not a party member",
    );

    // npc.lyra is an authored companion (a member) — she may lead.
    const lyra = applyCommand(model, { type: "setPartyLeader", entityId: "npc.lyra" });
    expect(lyra.mutated).toBe(true);
    expect(lyra.deltas).toEqual([{ kind: "partyLeaderChanged", party: { leaderId: "npc.lyra", pendingLeave: {} } }]);

    // Same leader again is a noop.
    expect(applyCommand(model, { type: "setPartyLeader", entityId: "npc.lyra" }).mutated).toBe(false);

    // The PC may take the reins explicitly, and null resets to the default (the PC leads).
    expect(applyCommand(model, { type: "setPartyLeader", entityId: "pc.you" }).mutated).toBe(true);
    const reset = applyCommand(model, { type: "setPartyLeader", entityId: null });
    expect(reset.mutated).toBe(true);
    expect(partySlice(model).leaderId).toBeNull();
    expect(applyCommand(model, { type: "setPartyLeader", entityId: null }).mutated).toBe(false); // noop repeat
  });
});

describe("recordLeaveDenied — validation + bookkeeping", () => {
  test("rejects unknown entities and non-members; records + noops on an identical repeat", async () => {
    const { model } = await exampleModel();
    promoteBrann(model);

    expect(applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.ghost" }).rejected?.reason).toContain(
      "unknown entity",
    );
    expect(applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.brann" }).rejected?.reason).toContain(
      "not a party member",
    );

    const res = applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.lyra", deniedAtSeq: 41 });
    expect(res.mutated).toBe(true);
    expect(res.deltas).toEqual([
      { kind: "partyLeaveDenied", entityId: "npc.lyra", party: { leaderId: null, pendingLeave: { "npc.lyra": { deniedAtSeq: 41 } } } },
    ]);

    // Identical repeat is a noop; a NEW refusal (different seq) re-records.
    expect(applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.lyra", deniedAtSeq: 41 }).mutated).toBe(false);
    expect(applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.lyra", deniedAtSeq: 55 }).mutated).toBe(true);
    expect(partySlice(model).pendingLeave["npc.lyra"]).toEqual({ deniedAtSeq: 55 });

    // A seq-less refusal also records (presence of the key alone is the fact).
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: true });
    const bare = applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.brann" });
    expect(bare.mutated).toBe(true);
    expect(partySlice(model).pendingLeave["npc.brann"]).toEqual({});
    expect(applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.brann" }).mutated).toBe(false);
  });
});

describe("party — save-shape round trip (promoted location NPC)", () => {
  test("a promoted NPC's membership, tier, and the slice survive toGameState → JSON → fromGameState", async () => {
    const { model, playset } = await exampleModel();
    promoteBrann(model);
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.brann", member: true });
    applyCommand(model, { type: "setPartyLeader", entityId: "npc.brann" });
    applyCommand(model, { type: "recordLeaveDenied", entityId: "npc.lyra", deniedAtSeq: 42 });
    const liveSlice = clonePartySlice(partySlice(model));

    const gs = toGameState(model);
    // npc.brann was NOT in the authored startingState arrays — the projection derives membership
    // from the entity flag, so the promoted NPC lands in the save's companions.
    expect(playset.campaign.startingState.companions).not.toContain("npc.brann");
    expect(gs.companions).toContain("npc.brann");
    expect(gs.actors["npc.brann"]).toBeDefined();

    // Simulate the store: the snapshot is persisted as JSON (sqlite/in-memory both serialize).
    const restored = fromGameState(JSON.parse(JSON.stringify(gs)), playset.world, playset.campaign);

    const brann = restored.entities.get("npc.brann");
    expect(brann?.partyMember).toBe(true);
    expect(brann?.kind).toBe("npc");
    expect(brann?.tier).toBe("significant"); // party members reload significant (never culled)
    expect(brann?.stats).toEqual({ currentHp: 12, maxHp: 12, conditions: [], inventory: ["item.lantern"], coins: 25 });
    expect(partySlice(restored)).toEqual(liveSlice);
    expect(partySlice(restored)).toEqual({ leaderId: "npc.brann", pendingLeave: { "npc.lyra": { deniedAtSeq: 42 } } });

    // The round trip is stable: projecting the restored model reproduces the same save shape.
    expect(toGameState(restored)).toEqual(gs);
  });
});
