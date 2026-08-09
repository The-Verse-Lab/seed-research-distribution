/**
 * Map generation (Step 4, T4/T5) — dead-reckoned coords, anchor-aim on gazetteer realization,
 * emergent towns, and coord survival across a reload. The shared-stream-safety proof (this.rng draw
 * order unchanged) is carried by the existing engine-walk + replay suites, which stay green.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { WorldSchema, type World } from "../src/content/schema.ts";
import { generatePocket, hydrateExpansions } from "../src/world/expansion.ts";
import { gazetteerAnchor } from "../src/world/coords.ts";
import { mulberry32 } from "../src/rules/dice.ts";

function world(extra: Record<string, unknown>): World {
  return WorldSchema.parse({
    id: "w",
    name: "W",
    locations: [
      { id: "loc.hub", name: "Hub", x: 0, y: 0, exits: [{ to: "frontier:n", direction: "north" }] },
    ],
    ...extra,
  });
}

const terminal = <T extends { locations: unknown[] }>(p: T) =>
  (p.locations as Array<{ id: string; name: string; x?: number; y?: number }>)[p.locations.length - 1]!;

describe("T4 — dead-reckoned pockets", () => {
  test("two calls with the same args are byte-identical, incl. coordinates", () => {
    const w = world({ gazetteer: [{ id: "gaz.town", name: "Thornmere", kind: "town", summary: "a town" }] });
    const a = generatePocket(w, "loc.hub", "frontier:n", mulberry32(1), new Set());
    const b = generatePocket(w, "loc.hub", "frontier:n", mulberry32(1), new Set());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const l of a.locations) {
      expect(Number.isFinite(l.x)).toBe(true);
      expect(Number.isFinite(l.y)).toBe(true);
    }
  });

  test("realizing a rumored town lands the terminal room ON its anchor", () => {
    const w = world({ gazetteer: [{ id: "gaz.town", name: "Thornmere", kind: "town", summary: "a town" }] });
    const p = generatePocket(w, "loc.hub", "frontier:n", mulberry32(1), new Set());
    expect(p.realizedGazetteerId).toBe("gaz.town");
    const anchor = gazetteerAnchor({ id: "gaz.town", kind: "town" }, { x: 0, y: 0 }, false);
    const t = terminal(p);
    expect(t.x).toBeCloseTo(anchor.x, 6);
    expect(t.y).toBeCloseTo(anchor.y, 6);
  });

  test("emergent town fires deterministically when opted in; the terminal IS the town", () => {
    const w = world({ emergentTownChance: 1 });
    const p = generatePocket(w, "loc.hub", "frontier:n", mulberry32(2), new Set());
    expect(p.emergentTown).toBeDefined();
    expect(["town", "city"]).toContain(p.emergentTown!.kind);
    const t = terminal(p);
    expect(p.emergentTown!.id).toBe(t.id);
    expect(t.name).toBe(p.emergentTown!.name);
    // Determinism: same frontier ⇒ same town.
    const p2 = generatePocket(w, "loc.hub", "frontier:n", mulberry32(2), new Set());
    expect(p2.emergentTown).toEqual(p.emergentTown);
  });

  test("no emergent town when the world doesn't opt in (chance unset ⇒ 0)", () => {
    const p = generatePocket(world({}), "loc.hub", "frontier:n", mulberry32(2), new Set());
    expect(p.emergentTown).toBeUndefined();
  });
});

describe("T5 — coords survive a reload via the expansion slice", () => {
  test("hydrateExpansions restores baked coordinates", () => {
    const w = world({ emergentTownChance: 1 });
    const p = generatePocket(w, "loc.hub", "frontier:n", mulberry32(3), new Set());
    const t = terminal(p);
    // Simulate persistence + reload: the slice stores full Location objects (with x/y); a fresh world
    // content is rehydrated from it.
    const modules = {
      expansion: {
        pockets: { "frontier:n": { fromLocationId: "loc.hub", locations: p.locations } },
      },
    };
    const fresh = WorldSchema.parse({
      id: "w",
      name: "W",
      locations: [{ id: "loc.hub", name: "Hub", x: 0, y: 0, exits: [{ to: "frontier:n" }] }],
    });
    hydrateExpansions(fresh, modules);
    const restored = fresh.locations.find((l) => l.id === t.id)!;
    expect(restored.x).toBe(t.x);
    expect(restored.y).toBe(t.y);
  });
});
