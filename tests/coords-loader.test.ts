/**
 * Loader layout pass (Step 3, T3) — every authored/frozen location gets a finite, deterministic,
 * direction-aware coordinate at load, hub at the origin.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";

const load = (name: string) => loadPlaySetFromDir(fileURLToPath(new URL(`fixtures/worlds/${name}`, import.meta.url)));

describe("T3 — loader assigns coordinates", () => {
  test("thistledown (no authored directions): all finite, hub at origin", async () => {
    const { world, campaign } = await load("thistledown");
    const start = world.locations.find((l) => l.id === campaign.startingState.locationId)!;
    expect(start.x).toBe(0);
    expect(start.y).toBe(0);
    for (const l of world.locations) {
      expect(Number.isFinite(l.x)).toBe(true);
      expect(Number.isFinite(l.y)).toBe(true);
    }
  });

  test("duskhollow (authored directions): all finite + deterministic across loads", async () => {
    const a = await load("duskhollow");
    const b = await load("duskhollow");
    // Determinism: two independent loads ⇒ identical coordinates (pure, seeded, id-keyed).
    expect(a.world.locations.map((l) => [l.id, l.x, l.y])).toEqual(
      b.world.locations.map((l) => [l.id, l.x, l.y]),
    );
    const start = a.world.locations.find((l) => l.id === a.campaign.startingState.locationId)!;
    expect(start.x).toBe(0);
    expect(start.y).toBe(0);
    for (const l of a.world.locations) {
      expect(Number.isFinite(l.x)).toBe(true);
      expect(Number.isFinite(l.y)).toBe(true);
    }
  });
});
