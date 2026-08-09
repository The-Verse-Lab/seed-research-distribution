/**
 * Travel-event mechanics — the pure, deterministic core of the DoL-style random-event roller.
 *
 * Mirrors `src/rules/exploitation.ts`: every stochastic decision draws from a PRIVATE id-keyed rng
 * (`mulberry32(fnv1a(key))`), never the shared tick stream, so wiring the roller into a tick
 * consumes ZERO draws from `ctx.services.rng` and can never shift another seeded mechanic (existing
 * seeded tests stay byte-identical). Same key ⇒ same draw ⇒ fully replay-safe. Cooldowns are counter-
 * based (the persisted move counter), not wall-clock, so they replay exactly.
 *
 * @author Runkai Zhang
 */
import type { Effect, TravelEvent } from "../content/schema.ts";
import { fnv1a, mulberry32 } from "./dice.ts";

/** One eligible travel event as the weighted pick sees it: an id and a positive weight. */
export interface TravelEventCandidate {
  id: string;
  weight: number;
}

export interface KeyedCheckResult {
  roll: number;
  total: number;
  dc: number;
  success: boolean;
}

/**
 * Whether a travel event fires on THIS move — a private-keyed roll of the base per-move chance. Zero
 * draws from any shared rng. `chance <= 0` never fires; `chance >= 1` always fires.
 */
export function keyedFireCheck(chance: number, key: string): boolean {
  if (chance <= 0) return false;
  if (chance >= 1) return true;
  return mulberry32(fnv1a(key))() < chance;
}

/** A private-keyed d20 check. The caller supplies a fully resolved modifier; no shared rng enters. */
export function keyedCheck(mod: number, dc: number, key: string): KeyedCheckResult {
  const roll = 1 + Math.floor(mulberry32(fnv1a(key))() * 20);
  const total = roll + mod;
  return { roll, total, dc, success: total >= dc };
}

/**
 * Pick one candidate id weighted by `weight`, from a PRIVATE keyed rng (zero shared draws). Walks the
 * candidates in the given order (the caller MUST pass them in a stable order — the parsed authoring
 * order — so the cumulative buckets are identical on every run/replay). Returns `null` for an empty
 * list or a non-positive total weight. Same key + same candidate list ⇒ same pick, forever.
 */
export function keyedWeightedPick(candidates: TravelEventCandidate[], key: string): string | null {
  const total = candidates.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0);
  if (candidates.length === 0 || total <= 0) return null;
  let r = mulberry32(fnv1a(key))() * total;
  for (const c of candidates) {
    const w = c.weight > 0 ? c.weight : 0;
    if (r < w) return c.id;
    r -= w;
  }
  // Floating-point tail: the draw landed exactly at the total — award the last positive-weight candidate.
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i]!.weight > 0) return candidates[i]!.id;
  }
  return null;
}

/**
 * Whether a counter-gated cooldown has elapsed: true when the thing has never fired (`undefined`) or
 * at least `cooldownMoves` moves have passed since it last fired. Counter-based (not wall-clock) ⇒
 * fully replay-safe. `cooldownMoves <= 0` ⇒ always ready.
 */
export function cooledDownByCounter(
  lastFiredCounter: number | undefined,
  cooldownMoves: number,
  currentCounter: number,
): boolean {
  if (lastFiredCounter === undefined) return true;
  if (cooldownMoves <= 0) return true;
  return currentCounter - lastFiredCounter >= cooldownMoves;
}

/** Moves of quiet before the roller starts leaning on the scales. */
const QUIET_MOVES_FREE = 4;
/** Per-quiet-move bump to the base fire chance, and its ceiling. */
const DROUGHT_CHANCE_STEP = 0.05;
const DROUGHT_CHANCE_MAX = 0.35;
/** Per-quiet-move weight multiplier added to combat-carrying candidates, and its ceiling. */
const DROUGHT_WEIGHT_STEP = 0.75;
const DROUGHT_WEIGHT_MAX = 8;

/**
 * THE COMBAT DROUGHT (r11 F-10, owner decision 2026-08-01 — "keep working on that system").
 *
 * The r11 sweep's combat scenario walked a wreck and two roads for 24 turns with a bravo persona
 * explicitly hunting a scrap, and met nothing it could fight: zero `attack` turns, the combat module
 * absent from the cost table, the back third of the run a exploitation hold instead. The ambient-life
 * drought bonus could not help — it only rolls where a LOCATION authors `spawns`, and 23 of the
 * flagship's 47 locations author none, so a road walk has nothing to roll for however long the
 * quiet runs.
 *
 * The random-event roller is the system that *does* cover roads, and the arithmetic was the whole
 * story: on a generic road roughly two of ~50 eligible weight-points open a fight, against ~14 that
 * open a exploitation scene — a 1.4 % chance of a fight per move against 10× that of being preyed on.
 * The vacuum was never authored, it was weighted.
 *
 * So the roller counts its own quiet. Four moves are free (a town circuit stays a town circuit),
 * then every further fightless move both raises the odds that ANY event fires and up-weights the
 * events that open a fight — a floor on the pity timer, never a guarantee: a road with no eligible
 * combat event still produces none, and the counter resets the moment a fight opens.
 */
export function combatDroughtBonus(quietMoves: number): number {
  const over = Math.max(0, quietMoves - QUIET_MOVES_FREE);
  return Math.min(DROUGHT_CHANCE_MAX, over * DROUGHT_CHANCE_STEP);
}

/**
 * The weight multiplier a combat-carrying candidate gets during a drought — 1 while the quiet is
 * still young, then climbing to 8×. Applied to the WEIGHT only, so eligibility, cooldowns, `once`
 * and every predicate still decide what may fire at all; this only changes which of the legal
 * events wins the bucket.
 */
export function combatDroughtWeight(quietMoves: number): number {
  const over = Math.max(0, quietMoves - QUIET_MOVES_FREE);
  return Math.min(DROUGHT_WEIGHT_MAX, 1 + over * DROUGHT_WEIGHT_STEP);
}

/** Whether an effect (or either branch of a keyed check) opens a fight. */
function effectOpensCombat(eff: Effect): boolean {
  if (eff.kind === "ambush") return true;
  if (eff.kind === "check") return eff.onSuccess.some(effectOpensCombat) || eff.onFail.some(effectOpensCombat);
  return false;
}

/** Whether a travel event can open a fight — the drought's definition of "something happened". */
export function opensCombat(ev: TravelEvent): boolean {
  return ev.effects.some(effectOpensCombat);
}

function effectCampUnsafe(eff: Effect): boolean {
  switch (eff.kind) {
    case "spawn":
    case "ambush":
      return true;
    case "check":
      return eff.onSuccess.some(effectCampUnsafe) || eff.onFail.some(effectCampUnsafe);
    default:
      return false;
  }
}

/**
 * Whether a travel event may fire while the party is at Camp (the filtered long-rest subset). The
 * authored `campSafe` wins if present; otherwise DERIVED — safe iff no effect spawns or ambushes
 * an adversary (`spawn`/`ambush`), including inside check
 * branches. A courier/messenger (`giveItem`), a bit of news (`narrate`), a quest/flag/relationship
 * beat, coins, and energy are all camp-safe; the random-attack class is not. Keeps the
 * messenger-can-still-find-you feel without letting an ambush reach a resting party.
 */
export function isCampSafe(ev: TravelEvent): boolean {
  return ev.campSafe ?? !ev.effects.some(effectCampUnsafe);
}
