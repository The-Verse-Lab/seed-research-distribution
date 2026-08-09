/**
 * Region resolution — the location→region→profile fallback chain (src/rules/regions.ts). Proves the
 * world-danger fallback (so an unregioned world is byte-identical), the tag-without-row case, a full
 * region override, and the threatShare default-vs-override. Pure; no engine, no content fixtures.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { WorldSchema } from "../src/content/schema.ts";
import { regionOfLocation, regionProfileOf } from "../src/rules/regions.ts";
import { dangerThreatShare } from "../src/worldsmith/reconcile.ts";

const world = (over: Record<string, unknown> = {}) =>
  WorldSchema.parse({ id: "w", name: "W", ...over });

describe("regionProfileOf — fallback chain", () => {
  test("no regions, untagged location ⇒ world-danger fallback (byte-identical posture)", () => {
    const w = world({ locations: [{ id: "loc.a", name: "A" }], constitution: { danger: 2 } });
    const p = regionProfileOf(w, "loc.a");
    expect(p.regionId).toBe(null);
    expect(p.danger).toBe(2);
    expect(p.crowd).toBe(1);
    expect(p.eventRate).toBe(1);
    expect(p.ambientPool).toEqual([]);
    expect(p.threatPool).toEqual([]);
    expect(p.threatShare).toBeCloseTo(dangerThreatShare(2));
  });

  test("null location ⇒ fallback with default world danger 1", () => {
    const p = regionProfileOf(world(), null);
    expect(p.regionId).toBe(null);
    expect(p.danger).toBe(1);
    expect(p.threatShare).toBeCloseTo(dangerThreatShare(1));
  });

  test("region TAG present but no first-class row ⇒ fallback danger, but regionId reported", () => {
    const w = world({
      locations: [{ id: "loc.a", name: "A", region: "r.mire" }],
      constitution: { danger: 3 },
    });
    const p = regionProfileOf(w, "loc.a");
    expect(p.regionId).toBe("r.mire"); // so an `inRegion` gate still resolves the tag
    expect(p.danger).toBe(3); // still falls back to the world danger
    expect(p.crowd).toBe(1);
  });

  test("first-class region row overrides danger/crowd/eventRate + carries pools", () => {
    const w = world({
      locations: [{ id: "loc.a", name: "A", region: "r.mire" }],
      regions: [
        {
          id: "r.mire",
          name: "The Mire",
          danger: 3,
          crowd: 0,
          eventRate: 1.5,
          ambientPool: [{ templateId: "npc.smuggler", max: 2 }],
          threatPool: [{ templateId: "npc.reaver", max: 1 }],
        },
      ],
      constitution: { danger: 1 },
    });
    const p = regionProfileOf(w, "loc.a");
    expect(p.danger).toBe(3);
    expect(p.crowd).toBe(0);
    expect(p.eventRate).toBe(1.5);
    expect(p.ambientPool).toHaveLength(1);
    expect(p.threatPool).toHaveLength(1);
    expect(p.threatShare).toBeCloseTo(dangerThreatShare(3)); // no override ⇒ danger-derived
  });

  test("region danger absent ⇒ inherits world danger; threatShare override wins", () => {
    const w = world({
      locations: [{ id: "loc.a", name: "A", region: "r.coast" }],
      regions: [{ id: "r.coast", name: "Coast", crowd: 2, threatShare: 0 }],
      constitution: { danger: 2 },
    });
    const p = regionProfileOf(w, "loc.a");
    expect(p.danger).toBe(2); // inherited
    expect(p.threatShare).toBe(0); // explicit override, not the danger-derived value
  });

  test("regionOfLocation returns the tag, undefined when untagged/missing", () => {
    const w = world({ locations: [{ id: "loc.a", name: "A", region: "r.coast" }, { id: "loc.b", name: "B" }] });
    expect(regionOfLocation(w, "loc.a")).toBe("r.coast");
    expect(regionOfLocation(w, "loc.b")).toBeUndefined();
    expect(regionOfLocation(w, "loc.nope")).toBeUndefined();
    expect(regionOfLocation(w, null)).toBeUndefined();
  });
});
