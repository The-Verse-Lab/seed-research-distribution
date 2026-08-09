/**
 * Phase 3 tests — entity registry presence, the spatial model (exits/locks), and tier-driven
 * culling. Deterministic, no network.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { fromGameState, toGameState, entitiesAt, partyLocationOf, type WorldModel } from "../src/world/model.ts";
import { mapFromWorld, canReach, exitsFrom } from "../src/world/map.ts";
import { cullTransients } from "../src/world/maintenance.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { loadExample } from "./support/harness.ts";

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

describe("presence as a registry query", () => {
  test("authored location NPCs are seeded as entities at their location", async () => {
    const model = await exampleModel();
    const here = entitiesAt(model, "loc.tavern").map((e) => e.id);
    expect(here).toContain("pc.you"); // party PC
    expect(here).toContain("npc.lyra"); // companion
    expect(here).toContain("npc.brann"); // the inn's static NPC, now a registry row
    const brann = model.entities.get("npc.brann");
    expect(brann?.tier).toBe("tracked");
    expect(brann?.locationId).toBe("loc.tavern");
  });

  test("statless location NPCs do not leak into the projected GameState.actors", async () => {
    const model = await exampleModel();
    const gs = toGameState(model);
    expect(Object.keys(gs.actors)).not.toContain("npc.brann");
    expect(gs.actors["pc.you"]).toBeDefined();
  });
});

describe("spatial model — exits and locks", () => {
  test("mapFromWorld derives bidirectional exits from legacy connections", async () => {
    const { world } = await loadExample();
    const map = mapFromWorld(world);
    expect(canReach(map, "loc.tavern", "loc.square")).toBe(true);
    expect(canReach(map, "loc.square", "loc.tavern")).toBe(true);
    expect(exitsFrom(map, "loc.tavern").map((e) => e.to)).toEqual(["loc.square"]);
  });

  test("a locked exit is not reachable and the reducer rejects moving through it", async () => {
    const map = { exits: new Map([["a", [{ to: "b", locked: true, hidden: false }]]]) };
    expect(canReach(map, "a", "b")).toBe(false);

    const model = await exampleModel();
    model.map.exits.set("loc.tavern", [{ to: "loc.square", locked: true, hidden: false }]);
    const res = applyCommand(model, { type: "moveParty", to: "loc.square" });
    expect(res.mutated).toBe(false);
    expect(partyLocationOf(model)).toBe("loc.tavern");
  });
});

describe("tier-driven culling", () => {
  test("transients away from the party are culled; those with the party survive", async () => {
    const model = await exampleModel();
    applyCommand(model, {
      type: "spawnEntity",
      entity: { id: "mob.gone", kind: "monster", tier: "transient", name: "Stray", locationId: "loc.square" },
    });
    applyCommand(model, {
      type: "spawnEntity",
      entity: { id: "mob.here", kind: "monster", tier: "transient", name: "Rat", locationId: "loc.tavern" },
    });
    const cmds = cullTransients(model, "loc.tavern");
    expect(cmds).toEqual([{ type: "despawnEntity", entityId: "mob.gone" }]);
  });
});
