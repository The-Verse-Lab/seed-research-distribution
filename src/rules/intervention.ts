/**
 * Bystander intervention — when a hostile NPC threatens the PC with other party members present
 * and the PC yells for help, each present ally decides,
 * independently and deterministically, whether to step in or stand by. The design intent: allies MAY
 * decline (the default lean), so keeping company is not a guaranteed shield — but a loyal, good-
 * aligned ally who dislikes the threat will cross them.
 *
 * Pure + deterministic: a weighted-sum-then-clamp probability (the exploitation.ts idiom), rolled from a
 * PRIVATE id-keyed rng so it consumes ZERO draws from the shared tick stream and replays identically.
 * No state writes and no model calls.
 *
 * @author Runkai Zhang
 */
import type { BystanderLeans } from "./agenda.ts";
import { mulberry32 } from "./dice.ts";
import { fnv1a } from "../worldsmith/seeded.ts";

export interface InterventionInputs {
  /** The bystander's alignment/personality leans (from agenda.ts `bystanderLeans`). */
  leans: BystanderLeans;
  /** The bystander's regard toward the PC (−100..100): higher ⇒ likelier to help. */
  relationshipToPc: number;
  /** The bystander's regard toward the threat (−100..100): lower ⇒ likelier to cross them. */
  relationshipToThreat: number;
}

/** The base chance a bystander with no strong tie intervenes — LOW, so declining is the default. */
export const INTERVENTION_BASE = 0.15;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * The probability [0, 0.95] this bystander steps in. Leans DECLINE: a neutral stranger rarely helps;
 * a warm, good-aligned ally who dislikes the threat likely does; an exploitative or threat-friendly
 * bystander is complicit and helps less. Monotone in each factor's intended direction. Pure — no rng.
 */
export function decideIntervention(inputs: InterventionInputs): number {
  const relPc = clamp(inputs.relationshipToPc, -100, 100) / 100;
  const relThreat = clamp(inputs.relationshipToThreat, -100, 100) / 100;
  const l = inputs.leans;
  const chance =
    INTERVENTION_BASE +
    Math.max(0, relPc) * 0.5 + // fond of the PC → protective
    l.warmth * 0.6 + // warm archetypes step in; cold ones hang back (may subtract)
    Math.max(0, l.good) * 0.15 + // a good streak helps
    Math.max(0, -relThreat) * 0.3 - // dislikes the threat → likelier to cross them
    Math.max(0, l.exploitative) * 0.4 - // a exploitative bystander is complicit, not a rescuer
    Math.max(0, relThreat) * 0.2; // fond of the threat → reluctant to cross them
  return clamp(chance, 0, 0.95);
}

/** Roll the chance from a PRIVATE id-keyed rng (zero shared-stream draws; same key ⇒ same verdict). */
export function rollIntervention(chance: number, key: string): boolean {
  return mulberry32(fnv1a(key))() < chance;
}
