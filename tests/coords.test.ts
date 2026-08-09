/**
 * Map coordinates — the pure dead-reckoning + layout helpers (Step 2, T1/T2).
 *
 * Guards the determinism the whole map system rests on: id-keyed rng only, fill-only + idempotent
 * layout, and a self-consistent compass table.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { WorldSchema, type World } from "../src/content/schema.ts";
import {
  COMPASS_OPPOSITE,
  COMPASS_VECTORS,
  SEGMENT,
  assignCoordinates,
  deadReckon,
  gazetteerAnchor,
  idRng,
  normalizeDirection,
  regionCentroid,
} from "../src/world/coords.ts";

function world(locations: unknown[], extra: Record<string, unknown> = {}): World {
  return WorldSchema.parse({ id: "w", name: "W", locations, ...extra });
}

describe("T2 — compass table", () => {
  test("planar directions are unit-length; diagonals normalized", () => {
    for (const [dir, v] of Object.entries(COMPASS_VECTORS)) {
      const len = Math.hypot(v.x, v.y);
      expect(len).toBeCloseTo(1, 6);
      expect(normalizeDirection(dir)).toBe(dir);
    }
  });

  test("north is up (negative y), south is down", () => {
    expect(COMPASS_VECTORS.north!.y).toBeLessThan(0);
    expect(COMPASS_VECTORS.south!.y).toBeGreaterThan(0);
    expect(COMPASS_VECTORS.east!.x).toBeGreaterThan(0);
    expect(COMPASS_VECTORS.west!.x).toBeLessThan(0);
  });

  test("COMPASS_OPPOSITE is an involution", () => {
    for (const [a, b] of Object.entries(COMPASS_OPPOSITE)) {
      expect(COMPASS_OPPOSITE[b]).toBe(a);
    }
  });

  test("normalizeDirection folds aliases + vertical/unknown to ''", () => {
    expect(normalizeDirection("N")).toBe("north");
    expect(normalizeDirection(" ne ")).toBe("northeast");
    expect(normalizeDirection("up")).toBe("");
    expect(normalizeDirection("down")).toBe("");
    expect(normalizeDirection(undefined)).toBe("");
    expect(normalizeDirection("widdershins")).toBe("");
  });
});

describe("T1 — dead-reckoning + layout", () => {
  test("idRng is deterministic per id and diverges across ids", () => {
    const a1 = Array.from({ length: 4 }, idRng("loc.a"));
    // fresh generator, same id ⇒ identical stream
    const a2 = Array.from({ length: 4 }, idRng("loc.a"));
    expect(a1).toEqual(a2);
    const b1 = Array.from({ length: 4 }, idRng("loc.b"));
    expect(b1).not.toEqual(a1);
  });

  test("deadReckon heads in the compass direction", () => {
    const north = deadReckon({ x: 0, y: 0 }, "north", SEGMENT, idRng("r"));
    expect(north.y).toBeLessThan(0);
    const east = deadReckon({ x: 0, y: 0 }, "east", SEGMENT, idRng("r"));
    expect(east.x).toBeGreaterThan(0);
    // same (parent, dir, rng-seed) ⇒ identical point
    expect(deadReckon({ x: 1, y: 1 }, "west", SEGMENT, idRng("k"))).toEqual(
      deadReckon({ x: 1, y: 1 }, "west", SEGMENT, idRng("k")),
    );
  });

  test("assignCoordinates places every location, hub at origin, deterministic + idempotent", () => {
    const w = world([
      { id: "loc.hub", name: "Hub", exits: [{ to: "loc.n", direction: "north" }, { to: "loc.e", direction: "east" }] },
      { id: "loc.n", name: "North", exits: [{ to: "loc.hub", direction: "south" }] },
      { id: "loc.e", name: "East", exits: [{ to: "loc.hub", direction: "west" }] },
      { id: "loc.island", name: "Island", exits: [] }, // disconnected
    ]);
    assignCoordinates(w, "loc.hub");
    const at = (id: string) => w.locations.find((l) => l.id === id)!;
    expect(at("loc.hub").x).toBe(0);
    expect(at("loc.hub").y).toBe(0);
    for (const l of w.locations) {
      expect(Number.isFinite(l.x)).toBe(true);
      expect(Number.isFinite(l.y)).toBe(true);
    }
    // direction fidelity: the "north" child sits above the hub, the "east" child to the right.
    expect(at("loc.n").y!).toBeLessThan(0);
    expect(at("loc.e").x!).toBeGreaterThan(0);

    // Idempotent + deterministic: re-run on a fresh identical world ⇒ identical coords; and a second
    // call on the already-placed world changes nothing (fill-only).
    const before = w.locations.map((l) => [l.id, l.x, l.y]);
    assignCoordinates(w, "loc.hub");
    expect(w.locations.map((l) => [l.id, l.x, l.y])).toEqual(before);
  });

  test("assignCoordinates is fill-only — pre-set coords survive", () => {
    const w = world([
      { id: "loc.hub", name: "Hub", exits: [{ to: "loc.n", direction: "north" }] },
      { id: "loc.n", name: "North", x: 999, y: -999, exits: [{ to: "loc.hub", direction: "south" }] },
    ]);
    assignCoordinates(w, "loc.hub");
    const n = w.locations.find((l) => l.id === "loc.n")!;
    expect(n.x).toBe(999);
    expect(n.y).toBe(-999);
  });

  test("gazetteerAnchor is deterministic per id and kind-scaled", () => {
    const hub = { x: 0, y: 0 };
    const city = gazetteerAnchor({ id: "gaz.metro", kind: "city" }, hub, false);
    expect(gazetteerAnchor({ id: "gaz.metro", kind: "city" }, hub, false)).toEqual(city);
    const poi = gazetteerAnchor({ id: "gaz.metro", kind: "poi" }, hub, false);
    // a city anchors farther out than a poi for the same id
    expect(Math.hypot(city.x, city.y)).toBeGreaterThan(Math.hypot(poi.x, poi.y));
  });

  test("regionCentroid averages a region's located rooms; undefined when empty/unregioned", () => {
    const w = world([
      { id: "loc.a", name: "A", x: 0, y: 0, region: "north", exits: [] },
      { id: "loc.b", name: "B", x: 10, y: 20, region: "north", exits: [] },
      { id: "loc.c", name: "C", x: 99, y: 99, region: "south", exits: [] },
      { id: "loc.d", name: "D", region: "north", exits: [] }, // coordless → excluded from the mean
    ]);
    const c = regionCentroid(w, "north")!;
    expect(c).toEqual({ x: 5, y: 10 });
    expect(regionCentroid(w, "nowhere")).toBeUndefined();
    expect(regionCentroid(w, undefined)).toBeUndefined();
  });

  test("gazetteerAnchor: a region-anchored entry sits near its centroid, not the hub", () => {
    const hub = { x: 0, y: 0 };
    const centroid = { x: 200, y: 200 };
    const regional = gazetteerAnchor({ id: "gaz.keep", kind: "town" }, centroid, true);
    // near the region centroid (tight ring), far from the hub
    expect(Math.hypot(regional.x - centroid.x, regional.y - centroid.y)).toBeLessThan(SEGMENT * 3);
    expect(Math.hypot(regional.x - hub.x, regional.y - hub.y)).toBeGreaterThan(SEGMENT * 10);
    // deterministic per id
    expect(gazetteerAnchor({ id: "gaz.keep", kind: "town" }, centroid, true)).toEqual(regional);
  });
});
