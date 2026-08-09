/**
 * Danger-weighted generation of prose NPCs (ASK 4) — pure, deterministic units.
 *
 * Higher world danger skews a generated NPC's seeded alignment/personality toward evil/exploitative and
 * raises the exploitative share. All draws are id-keyed and deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { Alignment } from "../src/content/schema.ts";
import { dangerThreatShare, dangerWeightedPools, seededIdentityFor, seededExploitative } from "../src/worldsmith/reconcile.ts";

const EVIL = new Set<Alignment>(["le", "ne", "ce"]);
const EXPLOITATIVE_PERS = new Set(["brute", "schemer", "zealot", "firebrand"]);

describe("dangerWeightedPools — evil/exploitative lean rises with danger", () => {
  const evilCount = (d: number): number => dangerWeightedPools(d).alignments.filter((a) => EVIL.has(a)).length;
  const exploitativeCount = (d: number): number =>
    dangerWeightedPools(d).personalities.filter((p) => EXPLOITATIVE_PERS.has(p)).length;

  test("danger 3 carries strictly more evil-alignment multiplicity than danger 0", () => {
    expect(evilCount(3)).toBeGreaterThan(evilCount(0));
  });
  test("danger 3 carries strictly more exploitative-personality multiplicity than danger 0", () => {
    expect(exploitativeCount(3)).toBeGreaterThan(exploitativeCount(0));
  });
  test("the evil SHARE of the alignment pool is higher at danger 3 than danger 0", () => {
    const share = (d: number): number => evilCount(d) / dangerWeightedPools(d).alignments.length;
    expect(share(3)).toBeGreaterThan(share(0));
    expect(share(0)).toBeLessThan(0.5); // a cozy world's pool is not evil-dominated
  });
});

describe("dangerThreatShare — monotone, clamped", () => {
  test("rises with danger and clamps to [0, 0.85]", () => {
    expect(dangerThreatShare(0)).toBeCloseTo(0.25);
    expect(dangerThreatShare(3)).toBeCloseTo(0.85);
    expect(dangerThreatShare(3)).toBeGreaterThan(dangerThreatShare(0));
    expect(dangerThreatShare(10)).toBeLessThanOrEqual(0.85);
  });
});

describe("seededExploitative — evil-only", () => {
  test("NEVER exploitative for a non-evil alignment, even at share 1", () => {
    for (const a of ["lg", "ng", "cg", "ln", "tn", "cn"] as Alignment[]) {
      expect(seededExploitative("salt", "npc.prose.x", a, 1)).toBe(false);
    }
  });
  test("a higher danger share marks strictly more evil actors exploitative (aggregate)", () => {
    let low = 0;
    let high = 0;
    for (let i = 0; i < 240; i++) {
      if (seededExploitative("s", `npc.prose.${i}`, "ne", dangerThreatShare(0))) low++;
      if (seededExploitative("s", `npc.prose.${i}`, "ne", dangerThreatShare(3))) high++;
    }
    expect(high).toBeGreaterThan(low);
  });
});

describe("seededIdentityFor with danger pools — deterministic + evil-leaning at high danger", () => {
  test("a high-danger pool lands an evil alignment far more often than a danger-0 pool (over many ids)", () => {
    let low = 0;
    let high = 0;
    for (let i = 0; i < 300; i++) {
      if (EVIL.has(seededIdentityFor("world", `npc.prose.${i}`, dangerWeightedPools(0)).alignment)) low++;
      if (EVIL.has(seededIdentityFor("world", `npc.prose.${i}`, dangerWeightedPools(3)).alignment)) high++;
    }
    expect(high).toBeGreaterThan(low);
  });
  test("same salt + id + pool ⇒ byte-identical identity (replay-safe)", () => {
    const a = seededIdentityFor("world", "npc.prose.keeper", dangerWeightedPools(3));
    const b = seededIdentityFor("world", "npc.prose.keeper", dangerWeightedPools(3));
    expect(a).toEqual(b);
  });
});
