/**
 * Bystander intervention + the call-for-help detector (ASK 3) — pure, deterministic units.
 *
 * decideIntervention LEANS DECLINE (keeping company is not a guaranteed shield) but a warm, good ally
 * who dislikes the threat steps in; rollIntervention is a private id-keyed draw; detectCallForHelp
 * is the module's own in-encounter intent surface (a yell, never a give-in).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { decideIntervention, INTERVENTION_BASE, rollIntervention } from "../src/rules/intervention.ts";

const NEUTRAL = { good: 0, warmth: 0, exploitative: 0 };

describe("decideIntervention — leans decline, driven by ties", () => {
  test("a neutral bystander with no tie sits at the low base (leans decline)", () => {
    const c = decideIntervention({ leans: NEUTRAL, relationshipToPc: 0, relationshipToThreat: 0 });
    expect(c).toBe(INTERVENTION_BASE);
    expect(c).toBeLessThan(0.5);
  });

  test("a warm, good ally fond of the PC and hostile to the threat likely steps in", () => {
    const c = decideIntervention({
      leans: { good: 1, warmth: 0.28, exploitative: 0 },
      relationshipToPc: 80,
      relationshipToThreat: -80,
    });
    expect(c).toBeGreaterThan(0.7);
  });

  test("a exploitative (complicit) bystander helps LESS than a neutral one", () => {
    const neutral = decideIntervention({ leans: NEUTRAL, relationshipToPc: 0, relationshipToThreat: 0 });
    const complicit = decideIntervention({ leans: { good: 0, warmth: 0, exploitative: 0.24 }, relationshipToPc: 0, relationshipToThreat: 0 });
    expect(complicit).toBeLessThan(neutral);
  });

  test("fondness for the threat makes an ally MORE reluctant to cross them", () => {
    const dislikesThreat = decideIntervention({ leans: NEUTRAL, relationshipToPc: 50, relationshipToThreat: -50 });
    const likesThreat = decideIntervention({ leans: NEUTRAL, relationshipToPc: 50, relationshipToThreat: 50 });
    expect(dislikesThreat).toBeGreaterThan(likesThreat);
  });

  test("the chance is always clamped to [0, 0.95]", () => {
    const maxed = decideIntervention({ leans: { good: 1, warmth: 1, exploitative: 0 }, relationshipToPc: 100, relationshipToThreat: -100 });
    const floored = decideIntervention({ leans: { good: -1, warmth: -1, exploitative: 1 }, relationshipToPc: -100, relationshipToThreat: 100 });
    expect(maxed).toBeLessThanOrEqual(0.95);
    expect(floored).toBeGreaterThanOrEqual(0);
  });
});

describe("rollIntervention — deterministic, replay-safe", () => {
  test("same key + chance ⇒ same verdict; consumes no shared rng", () => {
    expect(rollIntervention(0.5, "intervene:a:b:1")).toBe(rollIntervention(0.5, "intervene:a:b:1"));
  });
  test("chance 0 never fires; chance 1 always fires", () => {
    expect(rollIntervention(0, "k")).toBe(false);
    expect(rollIntervention(1, "k")).toBe(true);
  });
});
