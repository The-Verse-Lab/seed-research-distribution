/**
 * Regression locks for the 2026-07-14 stability audit fixes (the deterministic, gateway-free subset).
 *
 * Covers: #1 conjured-spawn identity survives the GameState projection round-trip; #7 a downed party
 * member stays in `Present:` while a downed foe is culled; #5 the shared `isConscious` autonomy gate.
 * The engine-driven fixes (#4 proposal-accept atomicity, #10 barred-frontier expansion, #11 state
 * push) are exercised by the live app and the existing suites; these three pin the pure invariants.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fromGameState, toGameState, partyLocationOf } from "../src/world/model.ts";
import { isConscious, type Entity } from "../src/world/entity.ts";
import { modelPresence } from "../src/world/queries.ts";
import { checkStateAssertions, checkSpatialDrift } from "../src/rules/continuity.ts";
import { DisclosureStore, disclosureSidecarPath } from "../src/memory/disclosure-store.ts";
import { makeEngine } from "./support/harness.ts";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const statted = (
  id: string,
  over: Partial<Entity> & { currentHp: number; conditions?: string[] },
): Entity => ({
  id,
  kind: over.kind ?? "npc",
  tier: over.tier ?? "tracked",
  name: over.name ?? id,
  locationId: over.locationId ?? null,
  ...(over.templateId !== undefined ? { templateId: over.templateId } : {}),
  stats: { currentHp: over.currentHp, maxHp: 10, conditions: over.conditions ?? [], inventory: [] },
  partyMember: over.partyMember ?? false,
  flags: {},
});

describe("audit #1 — conjured spawn identity survives save/reload/rewind", () => {
  test("a monster spawn keeps name/kind/tier/templateId/maxHp across toGameState → fromGameState", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const loc = partyLocationOf(model)!;
    model.entities.set(
      "mon.salt-reaver#0",
      statted("mon.salt-reaver#0", {
        kind: "monster",
        tier: "tracked",
        name: "Salt Reaver",
        templateId: "mon.salt-reaver",
        locationId: loc,
        currentHp: 7,
      }),
    );

    // The identity is persisted onto the actor row (only for the conjured `#n`/monster row) …
    const gs = toGameState(model);
    expect(gs.actors["mon.salt-reaver#0"]).toMatchObject({
      name: "Salt Reaver",
      kind: "monster",
      tier: "tracked",
      templateId: "mon.salt-reaver",
      // maxHp is persisted for the conjured row so a WOUNDED foe (7/10) does not reload as 7/7 (audit #11).
      maxHp: 10,
    });
    // … and a content-backed actor gains NO identity keys — its projection stays byte-stable.
    expect(gs.actors["pc.you"]).not.toHaveProperty("name");
    expect(gs.actors["pc.you"]).not.toHaveProperty("kind");
    expect(gs.actors["pc.you"]).not.toHaveProperty("templateId");

    // Reload: the spawn re-derives with its true identity instead of collapsing to a raw slug / npc.
    const reloaded = fromGameState(gs, playset.world, playset.campaign);
    const back = reloaded.entities.get("mon.salt-reaver#0");
    expect(back).toBeDefined();
    expect(back!.name).toBe("Salt Reaver");
    expect(back!.kind).toBe("monster");
    expect(back!.tier).toBe("tracked");
    expect(back!.templateId).toBe("mon.salt-reaver");
    // The wounded foe reloads at 7/10, not 7/7 — combat stays winnable and heals cap correctly (audit #11).
    expect(back!.stats!.currentHp).toBe(7);
    expect(back!.stats!.maxHp).toBe(10);
  });
});

describe("audit #13 — a transient runtime spawn is not resurrected as a permanent fixture", () => {
  test("a stat-less transient NPC keeps tier 'transient' across toGameState → fromGameState", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const loc = partyLocationOf(model)!;
    model.entities.set("npc.saltmire-extra#3", {
      id: "npc.saltmire-extra#3",
      kind: "npc",
      tier: "transient",
      name: "Saltmire Dockhand",
      locationId: loc,
      partyMember: false,
      flags: {},
    });

    // The transient tier is persisted onto the authored-NPC runtime row …
    const gs = toGameState(model);
    expect(gs.authoredNpcs?.["npc.saltmire-extra#3"]).toMatchObject({ tier: "transient" });

    // … so on reload it re-seeds as `transient` (maintenance will cull it when the party leaves) instead
    // of collapsing to a permanent `tracked` fixture that duplicates on the next visit (audit #13).
    const reloaded = fromGameState(gs, playset.world, playset.campaign);
    expect(reloaded.entities.get("npc.saltmire-extra#3")?.tier).toBe("transient");
  });
});

describe("audit #7 — downed party members stay present; foes are culled", () => {
  test("modelPresence keeps a 0-HP unconscious companion but drops a 0-HP foe", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const loc = partyLocationOf(model)!;
    model.entities.set(
      "npc.ally#0",
      statted("npc.ally#0", {
        name: "Ally",
        tier: "significant",
        locationId: loc,
        currentHp: 0,
        conditions: ["unconscious"],
        partyMember: true,
      }),
    );
    model.entities.set(
      "mon.foe#0",
      statted("mon.foe#0", { kind: "monster", name: "Foe", locationId: loc, currentHp: 0 }),
    );

    const present = modelPresence(model, playset.world).map((p) => p.id);
    expect(present).toContain("npc.ally#0"); // an ally at your feet, not "elsewhere"
    expect(present).not.toContain("mon.foe#0"); // a felled foe stays a corpse
  });
});

describe("audit #5 — isConscious autonomy gate", () => {
  test("statless is conscious; 0-HP or unconscious is not", () => {
    expect(isConscious(undefined)).toBe(true);
    expect(isConscious({ stats: undefined })).toBe(true);
    expect(isConscious({ stats: { currentHp: 5, maxHp: 10, conditions: [], inventory: [] } })).toBe(true);
    expect(isConscious({ stats: { currentHp: 0, maxHp: 10, conditions: [], inventory: [] } })).toBe(false);
    expect(
      isConscious({ stats: { currentHp: 5, maxHp: 10, conditions: ["unconscious"], inventory: [] } }),
    ).toBe(false);
  });
});

describe("audit #9 — phantom-death gate", () => {
  const DEATH = "The wight falls dead at your feet.";
  test("a bare adjustHp (non-lethal hit) does NOT authorize a death claim", () => {
    expect(checkStateAssertions(DEATH, [{ type: "adjustHp", entityId: "mon.wight#0", by: -7 }])).toHaveLength(1);
  });
  test("a real down (setCondition unconscious) authorizes the death claim", () => {
    expect(
      checkStateAssertions(DEATH, [
        { type: "adjustHp", entityId: "mon.wight#0", by: -20 },
        { type: "setCondition", entityId: "mon.wight#0", condition: "unconscious", active: true },
      ]),
    ).toHaveLength(0);
  });
});

describe("audit #8 — spatial drift is scoped to the PLAYER's own move", () => {
  const ARRIVAL = "You make your way into the lantern-lit courtyard.";
  test("a bystander NPC's moveEntity does NOT suppress the player drift guard", () => {
    expect(
      checkSpatialDrift(ARRIVAL, [{ type: "moveEntity", entityId: "npc.bram", to: "loc.x" }], false, "pc.you"),
    ).toHaveLength(1);
  });
  test("the player's OWN moveEntity (captivity/defeat teleport) legitimately suppresses it", () => {
    expect(
      checkSpatialDrift(ARRIVAL, [{ type: "moveEntity", entityId: "pc.you", to: "loc.x" }], false, "pc.you"),
    ).toHaveLength(0);
  });
});

describe("audit(2) #6 — disclosure ledger persists eagerly (survives mid-session reload)", () => {
  test("dirty on record, cleared on save, reloaded by a fresh store with no long rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-disclosure-"));
    try {
      const path = disclosureSidecarPath(dir, { campaignId: "c1", characterId: "pc.you" });
      const a = new DisclosureStore(path, "c1");
      expect(a.isDirty()).toBe(false);
      expect(a.record("npc.toran", ["born in the northern reach"])).toBe(true);
      expect(a.isDirty()).toBe(true);
      await a.save();
      expect(a.isDirty()).toBe(false);
      // A fresh store (a process restart mid-session, no long rest) reloads the fact.
      const b = new DisclosureStore(path, "c1");
      await b.load();
      expect(b.get("npc.toran")).toContain("born in the northern reach");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
