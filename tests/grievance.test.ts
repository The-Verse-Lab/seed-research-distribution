/**
 * Grievance decay math (Feature 3) — the pure counter a leader's disciplinary escalation reads
 * (src/rules/grievance.ts). Bump is decay-then-+1-capped; decay drains one point per fixed window.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { decayedGrievance, grievanceBump, GRIEVANCE_CAP } from "../src/rules/grievance.ts";
import type { AutonomyRuntime } from "../src/state/types.ts";

const RT = (grievance: number, grievanceAt: number): AutonomyRuntime => ({
  talking: false,
  replyDepth: 0,
  lastActedAt: 0,
  grievance,
  grievanceAt,
});

const WINDOW = 240_000; // GRIEVANCE_DECAY_MS

describe("grievance", () => {
  test("absent/zero grievance reads 0", () => {
    expect(decayedGrievance(undefined, 1_000_000)).toBe(0);
    expect(decayedGrievance(RT(0, 0), 1_000_000)).toBe(0);
  });

  test("a fresh bump reads back its value with no elapsed time", () => {
    const rt = grievanceBump(undefined, 1_000_000);
    expect(rt.grievance).toBe(1);
    expect(decayedGrievance(rt, 1_000_000)).toBe(1);
  });

  test("bumps accumulate and clamp at the cap", () => {
    let rt: AutonomyRuntime | undefined;
    for (let i = 0; i < 10; i++) rt = grievanceBump(rt, 1_000_000);
    expect(rt!.grievance).toBe(GRIEVANCE_CAP);
  });

  test("a grudge drains one point per decay window of quiet time", () => {
    const rt = RT(3, 0);
    expect(decayedGrievance(rt, 0)).toBe(3);
    expect(decayedGrievance(rt, WINDOW - 1)).toBe(3);
    expect(decayedGrievance(rt, WINDOW)).toBe(2);
    expect(decayedGrievance(rt, 2 * WINDOW)).toBe(1);
    expect(decayedGrievance(rt, 5 * WINDOW)).toBe(0); // never negative
  });

  test("bumping decays the prior value to now first, then adds 1", () => {
    // Grievance 3 stamped at t=0; two windows later it has decayed to 1, so a bump lands it at 2.
    const rt = grievanceBump(RT(3, 0), 2 * WINDOW);
    expect(rt.grievance).toBe(2);
    expect(rt.grievanceAt).toBe(2 * WINDOW);
  });
});
