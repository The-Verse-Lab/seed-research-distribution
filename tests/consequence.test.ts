/**
 * Consequence table (Phase 3) — the PURE domain × severity × outcome → effects mapping and the
 * notoriety tier/flag helpers. No engine, no rng: these pin the shape of what a meaningful turn earns
 * (and prove a neutral turn earns nothing, so the deterministic test suite stays byte-identical). The
 * engine grounding (effects → reducer commands, the ≥1-delta floor) is exercised in the engine
 * integration test.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  consequencesFor,
  isMeaningful,
  NOTORIETY_MARKED,
  NOTORIETY_WANTED,
  notorietyFlagKey,
  notorietyTier,
  wantedFlagKey,
  witnessedFlagKey,
  type ConsequenceKey,
} from "../src/rules/consequence.ts";

const key = (over: Partial<ConsequenceKey>): ConsequenceKey => ({
  domain: "none",
  severity: "none",
  outcome: "flavor",
  witnessed: false,
  hasVictim: false,
  ...over,
});

describe("consequencesFor — a neutral turn earns nothing (byte-stable)", () => {
  test("domain none ⇒ [] regardless of outcome/witnesses", () => {
    expect(consequencesFor(key({ domain: "none", outcome: "success", witnessed: true, hasVictim: true }))).toEqual([]);
  });

  test("a pure flavor beat earns nothing — even a real domain that didn't land", () => {
    expect(consequencesFor(key({ domain: "violence", severity: "minor", outcome: "flavor" }))).toEqual([]);
  });

  test("a WITNESSED flavor beat with a real domain earns only a witness flag", () => {
    expect(consequencesFor(key({ domain: "violence", severity: "minor", outcome: "flavor", witnessed: true }))).toEqual([
      { kind: "witnessFlag" },
    ]);
  });
});

describe("consequencesFor — the floor invariant (a meaningful turn always earns ≥1 effect)", () => {
  const domains = ["social", "property", "violence", "deception"] as const;
  const severities = ["minor", "serious", "grave"] as const;
  const outcomes = ["success", "failure", "refused"] as const;

  test("every meaningful (domain+severity+non-flavor) key with a victim earns ≥1 effect", () => {
    for (const domain of domains) {
      for (const severity of severities) {
        for (const outcome of outcomes) {
          const k = key({ domain, severity, outcome, hasVictim: true, witnessed: true });
          expect(isMeaningful(k)).toBe(true);
          expect(consequencesFor(k).length).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  test("a neutral/flavor key is NOT meaningful", () => {
    expect(isMeaningful(key({ domain: "none", severity: "minor", outcome: "success" }))).toBe(false);
    expect(isMeaningful(key({ domain: "violence", severity: "none", outcome: "success" }))).toBe(false);
    expect(isMeaningful(key({ domain: "violence", severity: "serious", outcome: "flavor" }))).toBe(false);
  });
});

describe("consequencesFor — social asks", () => {
  test("a WON ask grants the asked thing + warms the target", () => {
    const eff = consequencesFor(key({ domain: "social", severity: "minor", outcome: "success", hasVictim: true }));
    expect(eff).toContainEqual({ kind: "grantAsk" });
    expect(eff).toContainEqual({ kind: "disposition", who: "victim", by: 2 });
  });

  test("a LOST ask cools the target (a real trace, not a bare 'failure')", () => {
    const eff = consequencesFor(key({ domain: "social", severity: "minor", outcome: "failure", hasVictim: true }));
    expect(eff).toEqual([{ kind: "disposition", who: "victim", by: -2 }]);
  });

  test("a targetless social attempt binds nothing at the table (the engine floor still back-stops)", () => {
    expect(consequencesFor(key({ domain: "social", severity: "minor", outcome: "success", hasVictim: false }))).toEqual([]);
  });
});

describe("consequencesFor — transgressions scale with severity + landing", () => {
  test("a landed serious property crime hits notoriety + victim disposition/faction/memory + witnesses", () => {
    const eff = consequencesFor(key({ domain: "property", severity: "serious", outcome: "success", hasVictim: true, witnessed: true }));
    expect(eff).toContainEqual({ kind: "notoriety", by: 2 }); // serious = weight 2, landed
    expect(eff).toContainEqual({ kind: "disposition", who: "victim", by: -15 }); // −(5 + 5*2)
    expect(eff).toContainEqual({ kind: "faction", by: -10 });
    expect(eff).toContainEqual({ kind: "memory" });
    expect(eff.some((e) => e.kind === "disposition" && e.who === "witnesses")).toBe(true);
  });

  test("a FAILED transgression still leaves a (lighter) trace — you were seen trying", () => {
    const landed = consequencesFor(key({ domain: "violence", severity: "grave", outcome: "success", hasVictim: true }));
    const failed = consequencesFor(key({ domain: "violence", severity: "grave", outcome: "failure", hasVictim: true }));
    const notorietyOf = (e: ReturnType<typeof consequencesFor>) =>
      (e.find((x) => x.kind === "notoriety") as { by: number }).by;
    expect(notorietyOf(failed)).toBeGreaterThanOrEqual(1);
    expect(notorietyOf(failed)).toBeLessThan(notorietyOf(landed)); // a miss weighs less than a hit
  });
});

describe("notoriety tiers + flag-key helpers", () => {
  test("tiers cross at the thresholds", () => {
    expect(notorietyTier(0)).toBe("clear");
    expect(notorietyTier(NOTORIETY_MARKED - 1)).toBe("clear");
    expect(notorietyTier(NOTORIETY_MARKED)).toBe("marked");
    expect(notorietyTier(NOTORIETY_WANTED - 1)).toBe("marked");
    expect(notorietyTier(NOTORIETY_WANTED)).toBe("wanted");
  });

  test("flag keys are stable + scoped", () => {
    expect(notorietyFlagKey("iron-marches")).toBe("notoriety.iron-marches");
    expect(wantedFlagKey("iron-marches")).toBe("wanted.iron-marches");
    expect(witnessedFlagKey("loc.square")).toBe("witnessed.loc.square");
  });
});
