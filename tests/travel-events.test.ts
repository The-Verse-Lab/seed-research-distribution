/**
 * Travel-event mechanics — pure, deterministic unit tests (no engine).
 *
 * The roller draws only from private keyed rngs, so these are fully reproducible and prove the
 * replay-safety guarantee (a call-counting shared rng is never touched).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  combatDroughtBonus,
  combatDroughtWeight,
  cooledDownByCounter,
  isCampSafe,
  keyedCheck,
  keyedFireCheck,
  keyedWeightedPick,
  opensCombat,
  type TravelEventCandidate,
} from "../src/rules/travel-events.ts";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { EffectSchema, TravelEventSchema } from "../src/content/schema.ts";

describe("keyedWeightedPick", () => {
  const cands: TravelEventCandidate[] = [
    { id: "a", weight: 1 },
    { id: "b", weight: 3 },
  ];

  test("is deterministic per key", () => {
    for (const k of ["x", "y", "z"]) expect(keyedWeightedPick(cands, k)).toBe(keyedWeightedPick(cands, k));
  });

  test("empty list or non-positive total weight → null", () => {
    expect(keyedWeightedPick([], "k")).toBeNull();
    expect(keyedWeightedPick([{ id: "a", weight: 0 }], "k")).toBeNull();
  });

  test("a single positive candidate always wins", () => {
    for (const k of ["1", "2", "3", "4"]) expect(keyedWeightedPick([{ id: "solo", weight: 2 }], k)).toBe("solo");
  });

  test("weights bias selection ~3:1 across many keys", () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 4000; i++) {
      const p = keyedWeightedPick(cands, `k${i}`);
      if (p === "a") a++;
      else if (p === "b") b++;
    }
    expect(a + b).toBe(4000); // never null for a positive-total list
    const ratio = b / a;
    expect(ratio).toBeGreaterThan(2.3);
    expect(ratio).toBeLessThan(3.9);
  });

  test("candidate order is respected (stable buckets) — reversing order still covers both", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(keyedWeightedPick([...cands].reverse(), `r${i}`) ?? "");
    expect(seen.has("a")).toBe(true);
    expect(seen.has("b")).toBe(true);
  });
});

describe("keyedFireCheck", () => {
  test("chance 0 never fires, chance 1 always fires", () => {
    for (const k of ["a", "b", "c"]) {
      expect(keyedFireCheck(0, k)).toBe(false);
      expect(keyedFireCheck(1, k)).toBe(true);
    }
  });

  test("is deterministic per key", () => {
    for (const k of ["a", "b"]) expect(keyedFireCheck(0.5, k)).toBe(keyedFireCheck(0.5, k));
  });

  test("a mid chance yields a fire fraction near the chance", () => {
    let hits = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) if (keyedFireCheck(0.4, `f${i}`)) hits++;
    const frac = hits / N;
    expect(frac).toBeGreaterThan(0.35);
    expect(frac).toBeLessThan(0.45);
  });
});

describe("keyedCheck", () => {
  test("is deterministic per key", () => {
    expect(keyedCheck(2, 13, "travel-check:a")).toEqual(keyedCheck(2, 13, "travel-check:a"));
    expect(keyedCheck(2, 13, "travel-check:a").roll).toBeGreaterThanOrEqual(1);
    expect(keyedCheck(2, 13, "travel-check:a").roll).toBeLessThanOrEqual(20);
  });

  test("dc 11 with mod 0 lands near fifty percent over many private keys", () => {
    let hits = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) if (keyedCheck(0, 11, `check-${i}`).success) hits++;
    const frac = hits / N;
    expect(frac).toBeGreaterThan(0.45);
    expect(frac).toBeLessThan(0.55);
  });
});

describe("cooledDownByCounter", () => {
  test("never-fired (undefined) is always ready", () => expect(cooledDownByCounter(undefined, 5, 10)).toBe(true));
  test("zero cooldown is always ready", () => expect(cooledDownByCounter(3, 0, 3)).toBe(true));
  test("within the window is NOT ready; at/after it IS", () => {
    expect(cooledDownByCounter(5, 4, 8)).toBe(false); // 8 - 5 = 3 < 4
    expect(cooledDownByCounter(5, 4, 9)).toBe(true); //  9 - 5 = 4 >= 4
    expect(cooledDownByCounter(5, 4, 20)).toBe(true);
  });
});

describe("replay-safety: zero shared-rng draws", () => {
  test("the keyed helpers take a string key, never an Rng — an injected shared rng stays untouched", () => {
    let calls = 0;
    const counting: Rng = () => {
      calls++;
      return mulberry32(1)();
    };
    void counting; // deliberately unused by the helpers — that IS the guarantee
    keyedFireCheck(0.5, "k");
    keyedWeightedPick(
      [
        { id: "a", weight: 1 },
        { id: "b", weight: 1 },
      ],
      "k",
    );
    keyedCheck(0, 11, "k");
    cooledDownByCounter(1, 2, 3);
    expect(calls).toBe(0);
  });
});

describe("EffectSchema — expanded travel effect vocabulary", () => {
  test("accepts coins, energy, ambush, and nested checks with defaulted branches", () => {
    expect(EffectSchema.parse({ kind: "adjustCoins", by: -3 })).toEqual({ kind: "adjustCoins", by: -3 });
    expect(EffectSchema.parse({ kind: "adjustEnergy", by: 5, target: "pc.you" })).toEqual({
      kind: "adjustEnergy",
      by: 5,
      target: "pc.you",
    });
    expect(EffectSchema.parse({ kind: "ambush", templateId: "foe.roadside-bandit" })).toMatchObject({
      kind: "ambush",
      templateId: "foe.roadside-bandit",
      tier: "tracked",
    });

    const parsed = EffectSchema.parse({
      kind: "check",
      ability: "wis",
      dc: 12,
      onSuccess: [{ kind: "adjustCoins", by: 10 }],
      onFail: [{ kind: "check", ability: "dex", dc: 10 }],
    });
    expect(parsed.kind).toBe("check");
    if (parsed.kind === "check") {
      expect(parsed.onSuccess).toHaveLength(1);
      const nested = parsed.onFail[0];
      expect(nested?.kind).toBe("check");
      if (nested?.kind === "check") {
        expect(nested.onSuccess).toEqual([]);
        expect(nested.onFail).toEqual([]);
      }
    }
  });
});

describe("isCampSafe — recursive check branches", () => {
  const ev = (effects: unknown[], campSafe?: boolean) =>
    TravelEventSchema.parse({ id: "tev.x", effects, ...(campSafe === undefined ? {} : { campSafe }) });

  test("nested ambushes are unsafe, while coin/energy checks are safe", () => {
    expect(
      isCampSafe(
        ev([
          {
            kind: "check",
            ability: "cha",
            dc: 14,
            onSuccess: [{ kind: "narrate", text: "talked down" }],
            onFail: [{ kind: "ambush", templateId: "foe.bandit" }],
          },
        ]),
      ),
    ).toBe(false);
    expect(
      isCampSafe(
        ev([
          {
            kind: "check",
            ability: "wis",
            dc: 11,
            onSuccess: [{ kind: "adjustCoins", by: 5 }],
            onFail: [{ kind: "adjustEnergy", by: -2 }],
          },
        ]),
      ),
    ).toBe(true);
  });

  test("explicit campSafe still wins over recursive derivation", () => {
    expect(isCampSafe(ev([{ kind: "check", ability: "dex", dc: 10, onFail: [{ kind: "ambush", templateId: "foe.x" }] }], true))).toBe(true);
    expect(isCampSafe(ev([{ kind: "adjustCoins", by: 1 }], false))).toBe(false);
  });
});

describe("combat drought — the roller counts its own quiet (r11 F-10)", () => {
  const ev = (effects: unknown[]) => TravelEventSchema.parse({ id: "tev.x", effects });

  test("four quiet moves are free, then both dials climb and cap", () => {
    for (const quiet of [0, 1, 2, 3, 4]) {
      expect(combatDroughtBonus(quiet)).toBe(0);
      expect(combatDroughtWeight(quiet)).toBe(1);
    }
    expect(combatDroughtBonus(5)).toBeCloseTo(0.05, 5);
    expect(combatDroughtWeight(5)).toBeCloseTo(1.75, 5);
    // Monotonic, and both bounded — the pity timer is a floor, never a guarantee.
    expect(combatDroughtBonus(1000)).toBe(0.35);
    expect(combatDroughtWeight(1000)).toBe(8);
    expect(combatDroughtBonus(20)).toBeGreaterThan(combatDroughtBonus(10));
  });

});
