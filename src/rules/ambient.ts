/**
 * Ambient life — the pure, seeded core the AmbientLifeModule uses to decide HOW MANY extras fill a
 * location on arrival and whether an off-roster threat lurks. Mirrors `rules/travel-events.ts`:
 * every function is deterministic, and the only randomness is a PRIVATE id-keyed draw
 * (`mulberry32(fnv1a(key))`) so wiring it into a tick shifts no other seeded mechanic and replays
 * byte-identically. No state, no model, no rng passed in — just numbers → numbers.
 *
 * @author Runkai Zhang
 */
import type { DayPhase } from "../content/schema.ts";
import { fnv1a, mulberry32 } from "./dice.ts";

/**
 * Day-phase population factor for a foot-traffic locale: markets throng at midday, roads empty out
 * after dark. Multiplies the crowd headcount so the SAME `crowd` region reads busy by day and
 * deserted at deep-night — dynamic population with zero extra state.
 */
export function crowdPhaseFactor(phase: DayPhase): number {
  switch (phase) {
    case "morning":
    case "afternoon":
      return 1;
    case "dawn":
    case "dusk":
      return 0.6;
    case "night":
      return 0.3;
    case "deep night":
      return 0.15;
  }
}

/**
 * Deterministic ambient headcount for one spawn rule: `crowd` (0..3, 1 = neutral) scaled by the
 * day-phase factor, with a ±1 seeded jitter, clamped to `[0, max]`. crowd 0 ⇒ 0 (dead), 1 ⇒ ~max/2,
 * 2 ⇒ ~max, 3 ⇒ max. Same `(loc, visit, ruleIdx)` key ⇒ same count forever (replay-safe).
 */
export function ambientCount(max: number, crowd: number, phaseFactor: number, key: string): number {
  const c = Math.max(0, Math.min(3, crowd));
  if (c === 0) return 0; // a dead place stays dead — no jitter conjures a lone figure
  const base = max * (c / 2) * phaseFactor;
  const jitter = Math.floor(mulberry32(fnv1a(`${key}:n`))() * 3) - 1; // -1 | 0 | +1
  return Math.max(0, Math.min(max, Math.round(base) + jitter));
}

/**
 * Deterministic pack size for an AUTHORED location `spawns` rule (typically a monster pack the author
 * placed here). Scaled by region DANGER, not crowd — a deadly region reliably fields its packs, a
 * safe one almost never does — so the same authored spawn reads empty on the Grain Coast and full in
 * the Ashwild. ±1 seeded jitter, clamped `[0, max]`. Distinct from `ambientCount` (people), which is
 * crowd/phase-scaled; a monster does not thin out just because it is midnight.
 */
export function packCount(max: number, danger: number, key: string): number {
  const d = Math.max(0, Math.min(3, danger));
  const base = max * (d / 3);
  const jitter = Math.floor(mulberry32(fnv1a(`${key}:p`))() * 3) - 1; // -1 | 0 | +1
  return Math.max(0, Math.min(max, Math.round(base) + jitter));
}

/**
 * Per-arrival chance a location's authored monster pack materializes at all, scaled by region danger
 * — so even a deadly region has some quiet arrivals (a monster-free path) instead of a fight EVERY
 * time. danger 0 ⇒ 0.2, 1 ⇒ 0.4, 2 ⇒ 0.6, 3 ⇒ 0.8. Gates the pack spawn; `packCount` then sizes it.
 */
export function packChance(danger: number): number {
  return Math.max(0, Math.min(0.9, 0.2 + Math.max(0, Math.min(3, danger)) * 0.2));
}

/** Arrivals without a monster before the drought bonus starts paying out. */
const QUIET_ARRIVALS_FREE = 6;
/** Per-arrival bonus once the drought starts, and the ceiling it climbs to. */
const QUIET_STEP = 0.04;
const QUIET_MAX = 0.3;

/**
 * The drought bonus: a player who has walked a long way without meeting anything grows likelier to.
 *
 * The r5 run played ~70 turns as a sword-and-shield fighter across five settlements and never had a
 * single fight — the sword was used once, as a prop in an intimidation check. Half the sheet was
 * inert, and the run never tested whether combat is fun. Per-arrival odds alone can do that: on the
 * Grain Coast a pack rolls at 0.2, and 0.8^n stays comfortably alive for a long time.
 *
 * So quiet arrivals accumulate. Six are free (a town circuit stays a town circuit), then every
 * further monster-free arrival adds 4 points, capped at +30 — a floor on the pity timer, never a
 * guarantee, and it resets the moment a pack materializes. It cannot conjure anything on its own:
 * a location still needs an authored `spawns` rule for there to be something to roll for.
 */
export function packDroughtBonus(quietArrivals: number): number {
  const over = Math.max(0, quietArrivals - QUIET_ARRIVALS_FREE);
  return Math.min(QUIET_MAX, over * QUIET_STEP);
}

/**
 * Per-arrival chance an off-roster threat lurks in a dangerous locale. Zero below danger 2, so a
 * calm region (danger ≤ 1) never spawns ambient threats; danger 2 ⇒ 0.18, danger 3 ⇒ 0.36. A
 * region also needs an authored `threatPool` for any of this to fire (the module gate).
 */
export function threatAmbientChance(danger: number): number {
  return danger <= 1 ? 0 : Math.min(0.5, (danger - 1) * 0.18);
}

/**
 * A one-word ambience cue for the brief's optional `Ambience:` line, from the effective busyness
 * (`crowd × phaseFactor`). Returns "" at the NEUTRAL middle (crowd 1 at full midday) so an
 * unremarkable place — and every unregioned world — emits NOTHING and the brief stays byte-stable.
 */
export function crowdAdjective(crowd: number, phaseFactor: number): string {
  if (crowd === 1 && phaseFactor === 1) return ""; // neutral ⇒ no cue
  const busy = crowd * phaseFactor;
  if (busy >= 2.5) return "thronged"; // a packed market at midday (crowd 3)
  if (busy >= 1.3) return "busy"; // a lively place (crowd 2 by day)
  if (busy >= 0.4) return "sparse"; // thinned by the hour
  return "all but deserted"; // crowd 0, or anywhere deep-night
}
