/** Neutral fixtures for the discrete tile-grid layout derived from authored exits. */
import { describe, expect, test } from "bun:test";
import { WorldSchema, type World } from "../src/content/schema.ts";
import { normalizeExits } from "../src/content/loader.ts";
import {
  UNREGIONED_ID,
  cardinalEdges,
  crossRegionGateways,
  effectiveRegionOf,
  isInteriorLocation,
  layoutOverview,
  layoutRegion,
  type PlacedCell,
} from "../src/world/gridmap.ts";

function byId(cells: PlacedCell[]): Map<string, PlacedCell> {
  return new Map(cells.map((cell) => [cell.id, cell] as const));
}

function gridWorld(): World {
  return WorldSchema.parse({
    id: "world.grid-fixture",
    name: "Grid Fixture",
    regions: [
      { id: "center", name: "Center" },
      { id: "north", name: "North" },
      { id: "east", name: "East" },
      { id: "south", name: "South" },
      { id: "west", name: "West" },
    ],
    locations: [
      {
        id: "loc.center-a", name: "Center A", description: "A square.", region: "center",
        exits: [
          { to: "loc.center-b", direction: "east" },
          { to: "loc.center-c", direction: "south" },
          { to: "loc.north", direction: "north" },
          { to: "loc.west", direction: "west" },
          { to: "loc.cellar", direction: "down" },
        ],
      },
      {
        id: "loc.center-b", name: "Center B", description: "An east lane.", region: "center",
        exits: [
          { to: "loc.center-a", direction: "west" },
          { to: "loc.center-d", direction: "south" },
          { to: "loc.east", direction: "east" },
        ],
      },
      {
        id: "loc.center-c", name: "Center C", description: "A south lane.", region: "center",
        exits: [
          { to: "loc.center-a", direction: "north" },
          { to: "loc.center-d", direction: "east" },
          { to: "loc.south", direction: "south" },
        ],
      },
      {
        id: "loc.center-d", name: "Center D", description: "The southeast corner.", region: "center",
        exits: [{ to: "loc.center-b", direction: "north" }, { to: "loc.center-c", direction: "west" }],
      },
      {
        id: "loc.cellar", name: "Cellar", description: "A room below.", region: "center",
        exits: [{ to: "loc.center-a", direction: "up" }],
      },
      { id: "loc.north", name: "North Post", description: "North.", region: "north", exits: [{ to: "loc.center-a", direction: "south" }] },
      { id: "loc.east", name: "East Post", description: "East.", region: "east", exits: [{ to: "loc.center-b", direction: "west" }] },
      { id: "loc.south", name: "South Post", description: "South.", region: "south", exits: [{ to: "loc.center-c", direction: "north" }] },
      { id: "loc.west", name: "West Post", description: "West.", region: "west", exits: [{ to: "loc.center-a", direction: "east" }] },
    ],
  });
}

describe("layoutRegion", () => {
  test("lays out a clean 2x2 grid while preserving a double-parent cell", () => {
    const world = gridWorld();
    const cells = layoutRegion(world, "center", "loc.center-a");
    const map = byId(cells);
    expect(map.get("loc.center-a")).toMatchObject({ col: 0, row: 0 });
    expect(map.get("loc.center-b")).toMatchObject({ col: 1, row: 0 });
    expect(map.get("loc.center-c")).toMatchObject({ col: 0, row: 1 });
    expect(map.get("loc.center-d")).toMatchObject({ col: 1, row: 1 });
    expect(cells.filter((row) => row.id === "loc.center-d")).toHaveLength(1);
    const surface = cells.filter((row) => row.interiorOf === undefined);
    expect(new Set(surface.map((row) => `${row.col},${row.row}`)).size).toBe(surface.length);

    const members = new Set(world.locations.filter((row) => row.region === "center").map((row) => row.id));
    const touching = cardinalEdges(world, members).filter((edge) => edge.a === "loc.center-d" || edge.b === "loc.center-d");
    expect(touching).toHaveLength(2);
  });

  test("nests a portal-only room beneath its surface parent", () => {
    const world = gridWorld();
    const map = byId(layoutRegion(world, "center", "loc.center-a"));
    expect(map.get("loc.center-a")?.interiorOf).toBeUndefined();
    expect(map.get("loc.center-a")?.hasInterior).toBe(true);
    expect(map.get("loc.cellar")?.interiorOf).toBe("loc.center-a");
  });

  test("is deterministic", () => {
    const world = gridWorld();
    expect(layoutRegion(world, "center", "loc.center-a")).toEqual(layoutRegion(world, "center", "loc.center-a"));
  });
});

describe("layoutOverview", () => {
  test("places region blocks from cardinal cross-region exits", () => {
    const world = gridWorld();
    const positions = new Map(layoutOverview(world, "loc.center-a").map((row) => [row.id, { col: row.col, row: row.row }]));
    expect(positions.get("center")).toEqual({ col: 0, row: 0 });
    expect(positions.get("north")).toEqual({ col: 0, row: -1 });
    expect(positions.get("east")).toEqual({ col: 1, row: 0 });
    expect(positions.get("south")).toEqual({ col: 0, row: 1 });
    expect(positions.get("west")).toEqual({ col: -1, row: 0 });

    const directions = new Map(
      crossRegionGateways(world)
        .filter((row) => row.fromRegion === "center")
        .map((row) => [row.toRegion, row.direction]),
    );
    expect(directions).toEqual(new Map([
      ["north", "north"],
      ["west", "west"],
      ["east", "east"],
      ["south", "south"],
    ]));
  });
});

describe("degenerate and regionless maps", () => {
  test("a reciprocal portal chain roots on the seeded outside room", () => {
    const world = WorldSchema.parse({
      id: "world.portal-fixture",
      name: "Portal Fixture",
      locations: [
        { id: "loc.outside", name: "Outside", description: "Yard.", region: "keep", exits: [{ to: "loc.foyer", direction: "in" }] },
        { id: "loc.foyer", name: "Foyer", description: "Hall.", region: "keep", exits: [{ to: "loc.outside", direction: "out" }, { to: "loc.hall", direction: "in" }] },
        { id: "loc.hall", name: "Hall", description: "Deep room.", region: "keep", exits: [{ to: "loc.foyer", direction: "out" }] },
      ],
    });
    normalizeExits(world);
    const map = byId(layoutRegion(world, "keep", "loc.outside"));
    expect(map.get("loc.outside")?.interiorOf).toBeUndefined();
    expect(map.get("loc.foyer")?.interiorOf).toBe("loc.outside");
    expect(map.get("loc.hall")?.interiorOf).toBe("loc.foyer");
  });

  test("directionless connections form one flat unregioned grid", () => {
    const world = WorldSchema.parse({
      id: "world.unregioned-fixture",
      name: "Unregioned Fixture",
      locations: [
        { id: "loc.a", name: "A", description: "A.", connections: ["loc.b"] },
        { id: "loc.b", name: "B", description: "B.", connections: ["loc.a", "loc.c"] },
        { id: "loc.c", name: "C", description: "C.", connections: ["loc.b"] },
      ],
    });
    normalizeExits(world);
    for (const location of world.locations) expect(effectiveRegionOf(location)).toBe(UNREGIONED_ID);
    const members = new Set(world.locations.map((row) => row.id));
    for (const location of world.locations) expect(isInteriorLocation(world, location.id, members)).toBe(false);
    const cells = layoutRegion(world, UNREGIONED_ID, "loc.a");
    expect(cells).toHaveLength(3);
    expect(cells.every((row) => row.interiorOf === undefined)).toBe(true);
    expect(layoutOverview(world, "loc.a")).toEqual([]);
  });

  test("a single room sits at the origin", () => {
    const world = WorldSchema.parse({
      id: "world.single-fixture",
      name: "Single Fixture",
      locations: [{ id: "loc.only", name: "Only", description: "One room.", region: "only" }],
    });
    expect(layoutRegion(world, "only", "loc.only")[0]).toMatchObject({ id: "loc.only", col: 0, row: 0, hasInterior: false });
  });
});
