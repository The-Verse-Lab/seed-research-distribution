/**
 * WorldView tests — lock the read-façade's resolution to the values the old inline joins
 * produced, so Phase 0's "no behavior change" guarantee holds and later phases can repoint
 * its internals safely. Deterministic (offline gateway + seeded rng, no network).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  WorldView,
  establishedFactsAt,
  hpBandOf,
  modelExits,
  modelLocationSnapshot,
  modelPresence,
} from "../src/world/queries.ts";
import { displayName, isConjuredSpawn } from "../src/world/entity.ts";
import { fromGameState } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { buildNarrationContext } from "../src/agents/context.ts";
import { makeEngine } from "./support/harness.ts";

describe("WorldView (Phase 0 read façade)", () => {
  test("resolves player, location, names, and exits at the start", async () => {
    const { engine, playset } = await makeEngine();
    const view = new WorldView(playset.world, playset.campaign, engine.getState());

    expect(view.playerId).toBe("pc.you");
    expect(view.partyLocationId()).toBe("loc.tavern");
    expect(view.location()?.name).toBe("The Ashen Tankard");

    expect(view.name("pc.you")).toBe("You"); // PC
    expect(view.name("npc.lyra")).toBe("Lyra Vane"); // world NPC
    expect(view.name("missing.id")).toBe("missing.id"); // unknown → id

    expect(view.exitsFrom().map((e) => e.id)).toEqual(["loc.square"]);
    expect(view.exitsFrom().map((e) => e.name)).toEqual(["Emberford Square"]);
  });

  test("presence: narrator set (party+companions) vs classifier set (companions+roster)", async () => {
    const { engine, playset } = await makeEngine();
    const view = new WorldView(playset.world, playset.campaign, engine.getState());

    // Narrator / `/who`: party PCs + companions here.
    expect(view.actorsAt().sort()).toEqual(["npc.lyra", "pc.you"]);
    // Classifier: companions here ∪ the authored location roster (npc.brann tends the inn).
    expect(new Set([...view.companionsAt(), ...view.locationNpcs()])).toEqual(
      new Set(["npc.lyra", "npc.brann"]),
    );
  });

  test("hpBand reports a band for known HP and '' for unknown entities", async () => {
    const { engine, playset } = await makeEngine();
    const view = new WorldView(playset.world, playset.campaign, engine.getState());
    expect(view.hpBand("pc.you")).toBe("unhurt"); // full HP at start
    expect(view.hpBand("missing.id")).toBe(""); // no max → no band
  });
});

describe("displayName (clean player-facing labels)", () => {
  test("strips a trailing instance suffix and never returns a raw id", () => {
    // A named spawn with a #N instance tag → the base name.
    expect(displayName({ id: "mon.gen.deepwood", name: "Fevered dead#0" })).toBe("Fevered dead");
    // Multi-digit suffix.
    expect(displayName({ id: "npc.crowd", name: "Onlooker#12" })).toBe("Onlooker");
    // A clean name is unchanged.
    expect(displayName({ id: "npc.lyra", name: "Lyra Vane" })).toBe("Lyra Vane");
    // An empty name degrades to the id, suffix-stripped (never a bare "npc.foo#3").
    expect(displayName({ id: "npc.velvet-enforcer#3", name: "" })).toBe("npc.velvet-enforcer");
    expect(displayName({ id: "mon.gen.edge", name: "   " })).toBe("mon.gen.edge");
  });
});

describe("isConjuredSpawn (beaten transient threat despawn — owner ask B)", () => {
  test("a runtime instance (id `template#n`, non-significant) is conjured", () => {
    expect(isConjuredSpawn({ id: "npc.lane-tough#0", tier: "tracked" })).toBe(true);
    expect(isConjuredSpawn({ id: "npc.lane-tough#12", tier: "transient" })).toBe(true);
  });
  test("an authored, directly placed threat (bare id) PERSISTS", () => {
    // Vane / the Masque / Sereth — authored world NPCs are never despawned on break-free.
    expect(isConjuredSpawn({ id: "npc.the-masque", tier: "tracked" })).toBe(false);
    expect(isConjuredSpawn({ id: "npc.stalker", tier: "tracked" })).toBe(false);
  });
  test("a significant-tier entity is never treated as conjured, even with an instance id", () => {
    expect(isConjuredSpawn({ id: "npc.captor#0", tier: "significant" })).toBe(false);
  });
  test("a missing entity is not conjured", () => {
    expect(isConjuredSpawn(undefined)).toBe(false);
  });
});

describe("WorldModel-sourced narrator joins (presence/exits)", () => {
  test("hpBandOf bands by stats and returns '' when max is unknown", () => {
    expect(hpBandOf({ currentHp: 28, maxHp: 28, conditions: [], inventory: [] })).toBe("unhurt");
    expect(hpBandOf({ currentHp: 10, maxHp: 28, conditions: [], inventory: [] })).toBe("wounded");
    expect(hpBandOf({ currentHp: 0, maxHp: 28, conditions: [], inventory: [] })).toBe("down");
    expect(hpBandOf(undefined)).toBe("");
  });

  test("modelPresence includes the authored location NPC the old narrator set omitted", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const present = modelPresence(model, playset.world);
    const ids = present.map((p) => p.id);
    // The narrator now sees the full registry presence (matching the classifier): the companion
    // AND npc.brann — the inn's static NPC the old WorldView.actorsAt() (party+companions) dropped.
    expect(ids).toContain("npc.lyra");
    expect(ids).toContain("npc.brann");
    expect(ids).not.toContain("pc.you"); // the player is excluded
    // The companion has stats → a band; the statless innkeeper has none.
    expect(present.find((p) => p.id === "npc.lyra")?.band).toBe("unhurt");
    expect(present.find((p) => p.id === "npc.brann")?.band).toBeUndefined();
    expect(present.find((p) => p.id === "npc.brann")?.summary).toContain("barkeep");
  });

  test("one location snapshot grounds presence and deduplicated established facts", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const location = modelLocationSnapshot(model);
    const requested: string[] = [];
    const disclosure = {
      get(id: string): string[] {
        requested.push(id);
        return id === "npc.lyra" ? ["The bridge is out.", "Lyra keeps watch."] : ["The bridge is out."];
      },
    };

    expect(modelPresence(model, playset.world, location).map((p) => p.id)).toEqual([
      "npc.lyra",
      "npc.brann",
    ]);
    expect(establishedFactsAt(model, disclosure, location)).toEqual([
      "The bridge is out.",
      "Lyra keeps watch.",
    ]);
    expect(requested).toEqual(["npc.lyra", "npc.brann"]);
  });

  test("modelExits resolves display names and filters hidden exits", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const locationName = (id: string): string =>
      playset.world.locations.find((l) => l.id === id)?.name ?? id;
    expect(modelExits(model, locationName)).toEqual(["Emberford Square"]);

    // Mark the lone exit hidden — it must no longer be offered to the narrator.
    model.map.exits.set("loc.tavern", [{ to: "loc.square", locked: false, hidden: true }]);
    expect(modelExits(model, locationName)).toEqual([]);
  });

  test("a moved tracked NPC reaches the narrator's Present set (registry, not roster)", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    // Brann follows the party to the square; presence is a position query, so he travels with it.
    applyCommand(model, { type: "moveEntity", entityId: "npc.brann", to: "loc.square" });
    applyCommand(model, { type: "moveParty", to: "loc.square" });
    const ids = modelPresence(model, playset.world).map((p) => p.id);
    expect(ids).toContain("npc.brann");
    expect(ids).toContain("npc.lyra");
  });

  test("buildNarrationContext renders the supplied present/exits over the WorldView fallback", async () => {
    const { engine, playset } = await makeEngine();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const locationName = (id: string): string =>
      playset.world.locations.find((l) => l.id === id)?.name ?? id;
    const nctx = buildNarrationContext({
      world: playset.world,
      campaign: playset.campaign,
      state: engine.getState(),
      recentEvents: [],
      trigger: "you look around",
      present: modelPresence(model, playset.world),
      exits: modelExits(model, locationName),
    });
    expect(nctx.contextText).toContain("Present:");
    expect(nctx.contextText).toContain("Brann"); // the authored NPC the old brief never showed
    expect(nctx.contextText).toContain("Exits: Emberford Square");
  });
});
