/**
 * Ambient-life pure core (src/rules/ambient.ts) — the seeded headcount + day-phase + threat-chance
 * math the AmbientLifeModule drives. Deterministic; proves crowd/phase scaling, the `[0, max]` clamp,
 * a dead (crowd 0) place stays empty, off-roster threats never appear below danger 2, and the
 * `Ambience:` adjective is empty at the neutral middle (so the brief stays byte-stable).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  ambientCount,
  crowdAdjective,
  crowdPhaseFactor,
  packChance,
  packCount,
  packDroughtBonus,
  threatAmbientChance,
} from "../src/rules/ambient.ts";

describe("crowdPhaseFactor", () => {
  test("busy by day, sparse at dawn/dusk, near-dead deep night", () => {
    expect(crowdPhaseFactor("morning")).toBe(1);
    expect(crowdPhaseFactor("afternoon")).toBe(1);
    expect(crowdPhaseFactor("dawn")).toBe(0.6);
    expect(crowdPhaseFactor("dusk")).toBe(0.6);
    expect(crowdPhaseFactor("night")).toBe(0.3);
    expect(crowdPhaseFactor("deep night")).toBe(0.15);
  });
});

describe("ambientCount", () => {
  test("deterministic for the same key", () => {
    const a = ambientCount(4, 2, 1, "loc:1:0");
    const b = ambientCount(4, 2, 1, "loc:1:0");
    expect(a).toBe(b);
  });

  test("crowd 0 ⇒ always empty, whatever the key", () => {
    for (let v = 0; v < 40; v++) {
      expect(ambientCount(4, 0, 1, `loc:${v}:0`)).toBe(0);
    }
  });

  test("always clamped to [0, max]", () => {
    for (let v = 0; v < 60; v++) {
      const n = ambientCount(3, 3, 1, `loc:${v}:0`);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  test("busier crowd yields a higher average headcount than a quiet one", () => {
    const mean = (crowd: number) => {
      let sum = 0;
      for (let v = 0; v < 200; v++) sum += ambientCount(4, crowd, 1, `loc:${v}:0`);
      return sum / 200;
    };
    expect(mean(3)).toBeGreaterThan(mean(1));
  });

  test("night thins the crowd vs midday for the same region", () => {
    const mean = (pf: number) => {
      let sum = 0;
      for (let v = 0; v < 200; v++) sum += ambientCount(4, 2, pf, `loc:${v}:0`);
      return sum / 200;
    };
    expect(mean(crowdPhaseFactor("morning"))).toBeGreaterThan(mean(crowdPhaseFactor("deep night")));
  });
});

describe("packCount", () => {
  const mean = (danger: number) => {
    let sum = 0;
    for (let v = 0; v < 200; v++) sum += packCount(3, danger, `loc:${v}`);
    return sum / 200;
  };
  test("scales with region danger, not crowd (deadly ⇒ full packs, safe ⇒ near-empty)", () => {
    expect(mean(3)).toBeGreaterThan(mean(1));
    expect(mean(1)).toBeGreaterThan(mean(0));
  });
  test("deterministic + clamped to [0, max]", () => {
    expect(packCount(3, 3, "k")).toBe(packCount(3, 3, "k"));
    for (let v = 0; v < 40; v++) {
      const n = packCount(2, 3, `loc:${v}`);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(2);
    }
  });
});

describe("packChance", () => {
  test("rises with danger, leaving quiet arrivals even in a deadly region", () => {
    expect(packChance(0)).toBeCloseTo(0.2);
    expect(packChance(1)).toBeCloseTo(0.4);
    expect(packChance(2)).toBeCloseTo(0.6);
    expect(packChance(3)).toBeCloseTo(0.8);
    expect(packChance(3)).toBeLessThan(1); // never a guaranteed fight on every arrival
  });
});

describe("packDroughtBonus (r5 P3 — 70 turns, a fighter, and no fight at all)", () => {
  test("the first arrivals are free — a town circuit stays a town circuit", () => {
    for (const quiet of [0, 1, 3, 6]) expect(packDroughtBonus(quiet)).toBe(0);
  });

  test("then it climbs, and it stops climbing", () => {
    expect(packDroughtBonus(7)).toBeCloseTo(0.04);
    expect(packDroughtBonus(11)).toBeCloseTo(0.2);
    expect(packDroughtBonus(14)).toBeCloseTo(0.3);
    expect(packDroughtBonus(200)).toBeCloseTo(0.3); // capped — never a guaranteed fight
  });

  test("even a long drought on the safest ground stays under an even chance", () => {
    expect(packChance(0) + packDroughtBonus(500)).toBeLessThan(0.55);
  });
});

describe("threatAmbientChance", () => {
  test("zero below danger 2, rising above", () => {
    expect(threatAmbientChance(0)).toBe(0);
    expect(threatAmbientChance(1)).toBe(0);
    expect(threatAmbientChance(2)).toBeCloseTo(0.18);
    expect(threatAmbientChance(3)).toBeCloseTo(0.36);
  });
  test("never exceeds 0.5", () => {
    expect(threatAmbientChance(10)).toBeLessThanOrEqual(0.5);
  });
});

describe("crowdAdjective", () => {
  test("empty at the neutral middle (crowd 1, full midday) ⇒ no brief line", () => {
    expect(crowdAdjective(1, 1)).toBe("");
  });
  test("busy/thronged when crowded, deserted when empty", () => {
    expect(crowdAdjective(3, 1)).toBe("thronged");
    expect(crowdAdjective(2, 1)).toBe("busy");
    expect(crowdAdjective(0, 1)).toBe("all but deserted");
    expect(crowdAdjective(2, 0.15)).toBe("all but deserted"); // a busy market goes dead deep-night
  });
});
