/**
 * Map view (revisit wave) — the truthful, derived read-side: real exit-graph edges, major routes
 * that follow the true room chain between towns, region metadata, and realized point-of-interest
 * kinds. All pure — no engine, no state mutation.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import {
  discoveredEdges,
  discoveredRegions,
  exploredLocationIds,
  majorRouteEdges,
  realizedKindMap,
  regionColor,
  regionMeta,
  revealedLocationIds,
} from "../src/world/mapview.ts";
import { visitedFlag } from "../src/world/expansion.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** A world of located rooms wired hub → mid → town2 (a chain), plus a coordless straggler and a
 *  frontier edge — everything the edge/region derivations must correctly include or skip. */
function buildPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.map",
    name: "Mapworld",
    summary: "A world with a shape.",
    locations: [
      {
        id: "loc.hub",
        name: "The Hub",
        description: "A crossroads.",
        region: "grain-coast",
        x: 0,
        y: 0,
        exits: [
          { to: "loc.mid", direction: "east" },
          { to: "frontier:north", direction: "north" }, // frontier — never an edge
          { to: "loc.void", direction: "south" }, // coordless target — never an edge
        ],
      },
      {
        id: "loc.mid",
        name: "The Mid",
        description: "A waystation.",
        region: "grain-coast",
        x: 10,
        y: 0,
        exits: [{ to: "loc.town2", direction: "east" }],
      },
      {
        id: "loc.town2",
        name: "Farhold",
        description: "A far settlement.",
        region: "iron-marches",
        x: 20,
        y: 0,
        exits: [{ to: "loc.mid", direction: "west" }], // back-edge — must dedupe with mid→town2
      },
      // Coordless straggler — undiscovered, contributes no node/edge/region.
      { id: "loc.void", name: "Nowhere", description: "Unplaced.", region: "saltmire", exits: [] },
    ],
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.map",
    name: "Map Campaign",
    worldId: "w.map",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.hub", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

describe("mapview — discoveredEdges", () => {
  test("real adjacency only: skips frontier + coordless targets, dedupes undirected", () => {
    const { world } = buildPlayset();
    const edges = discoveredEdges(world).map(([a, b]) => [a, b].sort().join("~")).sort();
    expect(edges).toEqual(["loc.hub~loc.mid", "loc.mid~loc.town2"]);
  });
});

describe("mapview — fog of war", () => {
  test("turn 1: only the start room is explored; its neighbor is glimpsed, the rest hidden", () => {
    const { world } = buildPlayset();
    const state = { flags: {}, partyLocationId: "loc.hub" };
    // current room is explored even without a visited flag (belt-and-suspenders)
    expect([...exploredLocationIds(world, state)].sort()).toEqual(["loc.hub"]);
    // reveal = hub + its one-hop neighbor (mid); town2 is two hops out ⇒ hidden
    expect([...revealedLocationIds(world, state)].sort()).toEqual(["loc.hub", "loc.mid"]);
  });

  test("the reveal filter drops edges + regions beyond the glimpse frontier", () => {
    const { world } = buildPlayset();
    const revealed = revealedLocationIds(world, { flags: {}, partyLocationId: "loc.hub" });
    // mid~town2 is culled (town2 unrevealed); only hub~mid ships
    expect(discoveredEdges(world, revealed).map(([a, b]) => [a, b].sort().join("~"))).toEqual([
      "loc.hub~loc.mid",
    ]);
    // iron-marches (town2's region) stays hidden until town2 is revealed
    expect(discoveredRegions(world, revealed).map((r) => r.id)).toEqual(["grain-coast"]);
  });

  test("walking on (visited flags) widens the reveal + surfaces the next region", () => {
    const { world } = buildPlayset();
    const state = {
      flags: { [visitedFlag("loc.hub")]: true, [visitedFlag("loc.mid")]: true },
      partyLocationId: "loc.mid",
    };
    expect([...exploredLocationIds(world, state)].sort()).toEqual(["loc.hub", "loc.mid"]);
    const revealed = revealedLocationIds(world, state);
    // mid now explored ⇒ its neighbor town2 becomes glimpsed
    expect([...revealed].sort()).toEqual(["loc.hub", "loc.mid", "loc.town2"]);
    expect(discoveredRegions(world, revealed).map((r) => r.id)).toEqual(["grain-coast", "iron-marches"]);
  });
});

describe("mapview — regions", () => {
  test("regionMeta: title-cased name + deterministic color", () => {
    const m = regionMeta("grain-coast");
    expect(m.name).toBe("Grain Coast");
    expect(m.color).toBe(regionColor("grain-coast"));
    expect(regionColor("grain-coast")).toBe(regionColor("grain-coast")); // stable
    expect(regionColor("grain-coast")).not.toBe(regionColor("iron-marches"));
    expect(m.color).toMatch(/^hsl\(\d+, 42%, 52%\)$/);
  });

  test("discoveredRegions: distinct located regions in first-seen order, straggler excluded", () => {
    const { world } = buildPlayset();
    expect(discoveredRegions(world).map((r) => r.id)).toEqual(["grain-coast", "iron-marches"]);
  });
});

describe("mapview — majorRouteEdges", () => {
  test("no route with fewer than two discovered towns", () => {
    const ps = buildPlayset();
    expect(majorRouteEdges(ps, {})).toEqual([]);
  });

  test("follows the true room chain between towns, not a straight line", () => {
    const ps = buildPlayset();
    // An emergent town at loc.town2 gives a second town node; the hub is the first.
    const state = {
      modules: {
        expansion: {
          pockets: {
            "frontier:seed": {
              fromLocationId: "loc.mid",
              locations: [{ id: "loc.town2" }],
              emergentTown: { id: "loc.town2", name: "Farhold", kind: "town" },
            },
          },
        },
      },
      flags: {},
    };
    const route = majorRouteEdges(ps, state).map(([a, b]) => [a, b].sort().join("~")).sort();
    expect(route).toEqual(["loc.hub~loc.mid", "loc.mid~loc.town2"]);
  });
});

describe("mapview — realizedKindMap", () => {
  test("maps a reached gazetteer terminal room to its kind (ruin), gated by arrival", () => {
    const ps = buildPlayset();
    // Author a gazetteer ruin and realize it at loc.town2 (reusing the located room as the terminal).
    ps.world.gazetteer = [{ id: "gaz.ruin", name: "Old Ruin", kind: "ruin", summary: "", hooks: [] }];
    const pockets = {
      "frontier:ruin": { fromLocationId: "loc.mid", locations: [{ id: "loc.town2" }], realizedGazetteerId: "gaz.ruin" },
    };
    // Not arrived yet → not known → absent.
    expect(realizedKindMap(ps, { modules: { expansion: { pockets } }, flags: {} }).size).toBe(0);
    // Arrived flag set → surfaces as a ruin node.
    const kinds = realizedKindMap(ps, {
      modules: { expansion: { pockets } },
      flags: { "gazetteer.arrived:gaz.ruin": true },
    });
    expect(kinds.get("loc.town2")).toBe("ruin");
  });
});
