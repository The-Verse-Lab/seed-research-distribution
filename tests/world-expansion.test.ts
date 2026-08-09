/**
 * Explore-time world expansion — frontier exits, the `expandWorld` chokepoint, replay, and the
 * engine end-to-end walk into generated land (including persistence across a reload).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { fileURLToPath } from "node:url";
import type { DeltaEvent } from "../src/events/deltas.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { reduceDeltas } from "./support/replay.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { canReach, exitsFrom } from "../src/world/map.ts";
import { generatePocket, hydrateExpansions, isFrontierId } from "../src/world/expansion.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

function buildPlayset(worldExtra?: Record<string, unknown>): PlaySet {
  const world = WorldSchema.parse({
    id: "w.edge",
    name: "Edgeworld",
    summary: "A world with an edge.",
    locations: [
      {
        id: "loc.camp",
        name: "The Camp",
        description: "A camp at the world's edge.",
        exits: [{ to: "frontier:mistlands", name: "a path into the mist" }],
      },
    ],
    npcs: [],
    ...worldExtra,
  });
  const campaign = CampaignSchema.parse({
    id: "c.edge",
    name: "Edge Campaign",
    worldId: "w.edge",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.camp", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

const moveTo = (dest: string): TurnClassifier => ({
  classify: async () => ({
    kind: "movement",
    targetId: null,
    destinationLocationId: dest,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
  }),
});

describe("frontier authoring", () => {
  test("the loader admits frontier exits (bundled worlds carry one)", async () => {
    const dir = fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url));
    const playset = await loadPlaySetFromDir(dir); // throws on a broken reference
    const woods = playset.world.locations.find((l) => l.id === "loc.woods");
    expect(woods?.exits.some((e) => isFrontierId(e.to))).toBe(true);
  });
});

describe("generatePocket", () => {
  test("deterministic: same seed → identical pocket; entrance links back; far end opens a new frontier", () => {
    const { world } = buildPlayset();
    const a = generatePocket(world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const b = generatePocket(world, "loc.camp", "frontier:mistlands", mulberry32(9));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.locations.length).toBeGreaterThanOrEqual(2);
    expect(a.locations[0]?.exits.some((e) => e.to === "loc.camp")).toBe(true);
    const last = a.locations[a.locations.length - 1];
    expect(last?.exits.some((e) => isFrontierId(e.to))).toBe(true);
  });
});

describe("expandWorld (reducer + replay)", () => {
  function seededModel(playset: PlaySet) {
    const gs = {
      campaignId: playset.campaign.id,
      worldId: playset.world.id,
      partyLocationId: "loc.camp",
      clock: 0,
      party: ["pc.you"],
      companions: [],
      actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.camp", inventory: [], conditions: [] } },
      quests: {},
      relationships: {},
      autonomy: {},
      modules: {},
      flags: {},
    };
    return fromGameState(gs as never, playset.world, playset.campaign);
  }

  test("applies the pocket: map grows, the frontier exit retargets, the slice records it", () => {
    const playset = buildPlayset();
    const model = seededModel(playset);
    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const res = applyCommand(model, {
      type: "expandWorld",
      fromLocationId: "loc.camp",
      viaExitTo: "frontier:mistlands",
      locations: pocket.locations,
    });
    expect(res.mutated).toBe(true);
    const entrance = pocket.locations[0]!.id;
    expect(canReach(model.map, "loc.camp", entrance)).toBe(true);
    expect(exitsFrom(model.map, "loc.camp").some((e) => e.to === "frontier:mistlands")).toBe(false);
    // Applying the same expansion again is a no-op (idempotency guard).
    const again = applyCommand(model, {
      type: "expandWorld",
      fromLocationId: "loc.camp",
      viaExitTo: "frontier:mistlands",
      locations: pocket.locations,
    });
    expect(again.mutated).toBe(false);
  });

  test("rejects a non-frontier target and colliding ids", () => {
    const playset = buildPlayset();
    const model = seededModel(playset);
    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    expect(
      applyCommand(model, {
        type: "expandWorld",
        fromLocationId: "loc.camp",
        viaExitTo: "loc.camp",
        locations: pocket.locations,
      }).rejected,
    ).toBeTruthy();
    const colliding = structuredClone(pocket.locations);
    colliding[0]!.id = "loc.camp";
    expect(
      applyCommand(model, {
        type: "expandWorld",
        fromLocationId: "loc.camp",
        viaExitTo: "frontier:mistlands",
        locations: colliding,
      }).rejected,
    ).toBeTruthy();
  });

  test("snapshot == fold(deltas): an expansion replays verbatim", () => {
    const playset = buildPlayset();
    const live = seededModel(playset);
    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const res = applyCommand(live, {
      type: "expandWorld",
      fromLocationId: "loc.camp",
      viaExitTo: "frontier:mistlands",
      locations: pocket.locations,
    });
    const folded = seededModel(buildPlayset());
    reduceDeltas(
      folded,
      res.deltas.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent),
    );
    expect(toGameState(folded)).toEqual(toGameState(live));
    expect([...folded.map.exits.keys()].sort()).toEqual([...live.map.exits.keys()].sort());
  });
});

describe("engine end-to-end", () => {
  test("walking a frontier exit generates the pocket, moves the party in, and survives a reload", async () => {
    const playset = buildPlayset();
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: moveTo("frontier:mistlands"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("take the path into the mist");

    const state = engine.getState();
    expect(state.partyLocationId.startsWith("gen.mistlands.")).toBe(true);
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(true);
    expect(events.some((e) => e.kind === "narration")).toBe(true);
    // The generated location has real content in the world cache (names for the narrator/CLI).
    expect(playset.world.locations.some((l) => l.id === state.partyLocationId)).toBe(true);

    // A fresh engine over the same store + a FRESH world object (as a real relaunch would load
    // from disk) must hydrate the generated pocket and still navigate it.
    const relaunch = buildPlayset();
    const engine2 = new GameEngine({
      playset: relaunch,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(22),
    });
    await engine2.start();
    const state2 = engine2.getState();
    expect(state2.partyLocationId).toBe(state.partyLocationId);
    expect(relaunch.world.locations.some((l) => l.id === state2.partyLocationId)).toBe(true);
  });

  test("flag OFF: crossing a frontier exit STAYS PUT — impassable beat, no pocket (frontierExpansion:false)", async () => {
    // Gate A: with expansion disabled the frontier edge is latent content. Even a plan that grounds
    // straight to the `frontier:` id (the belt-and-suspenders path the classifier suppression also
    // covers) must NOT mint or move — it degrades to a coherent "impassable" narration.
    const playset = buildPlayset({ frontierExpansion: false });
    const before = playset.world.locations.length;
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: moveTo("frontier:mistlands"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("take the path into the mist");

    expect(engine.getState().partyLocationId).toBe("loc.camp"); // stayed put
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false); // nothing generated
    expect(playset.world.locations.length).toBe(before); // no pocket minted
    expect(events.some((e) => e.kind === "narration")).toBe(true); // still narrated (impassable)
  });

  test("flag OFF never breaks REPLAY: a pocket minted flag-on still hydrates when reloaded flag-off", async () => {
    // The suppression gates only NEW generation, never the reducer/replay/hydrate path. A save that
    // grew a pocket while expansion was enabled must still reload verbatim if the world later flips
    // the flag off — the party stays in the generated land, the content cache rebuilds.
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset: buildPlayset(), // enabled (flag absent)
      store,
      gateway: new OfflineGateway(),
      classifier: moveTo("frontier:mistlands"),
      rng: mulberry32(21),
    });
    await engine.start();
    await engine.submitPlayerInput("take the path into the mist");
    const minted = engine.getState().partyLocationId;
    expect(minted.startsWith("gen.mistlands.")).toBe(true);

    // Relaunch the SAME save with the flag now OFF — hydrateExpansions must still rebuild the pocket.
    const relaunch = buildPlayset({ frontierExpansion: false });
    const engine2 = new GameEngine({ playset: relaunch, store, gateway: new OfflineGateway(), rng: mulberry32(22) });
    await engine2.start();
    expect(engine2.getState().partyLocationId).toBe(minted); // still in the generated land
    expect(relaunch.world.locations.some((l) => l.id === minted)).toBe(true); // content cache rebuilt
  });

  test("hydrateExpansions is idempotent and retargets the consumed frontier", () => {
    const playset = buildPlayset();
    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const modules = {
      expansion: { pockets: { "frontier:mistlands": { fromLocationId: "loc.camp", locations: pocket.locations } } },
    };
    hydrateExpansions(playset.world, modules);
    hydrateExpansions(playset.world, modules);
    const ids = playset.world.locations.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    const camp = playset.world.locations.find((l) => l.id === "loc.camp");
    expect(camp?.exits.some((e) => e.to === pocket.locations[0]!.id)).toBe(true);
    expect(camp?.exits.some((e) => e.to === "frontier:mistlands")).toBe(false);
  });
});
