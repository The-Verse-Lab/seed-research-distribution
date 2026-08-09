/**
 * Action costs — the per-action time & energy table (Workstream H).
 *
 * One data table, not scattered constants: every resolved player turn costs in-world MINUTES
 * (spent through the existing `advanceClock` command — no new clock writer) and PC ENERGY
 * (spent through `adjustEnergy`). Mechanics live in code; all costs are static data, so offline
 * runs stay fully deterministic. Heartbeat (NPC autonomy) ticks are never taxed, and a long
 * rest advances its own clock (`LONG_REST_MINUTES` in the engine) — its row here is zero.
 *
 * @author Runkai Zhang
 */
import type { TurnKind } from "../engine/turn-plan.ts";
import type { EntityStats } from "../world/entity.ts";

export interface ActionCost {
  /** In-world minutes the action takes (0 ⇒ the clock does not move). */
  minutes: number;
  /** Energy the action drains from the acting PC (0 ⇒ free). */
  energy: number;
}

/**
 * Energy ceiling when an entity declares no `maxEnergy` of its own — a full waking day's worth.
 * Old saves carry no energy fields at all and default to full (the `coins` precedent: absent
 * means the feature-neutral value, so pre-energy campaigns wake rested, not exhausted).
 */
export const DEFAULT_MAX_ENERGY = 100;

/**
 * Ceiling on the energy ONE action may cost, however long it takes.
 *
 * Authored durations (a day's shift, an eight-hour march) scale energy with the hours — a long road
 * has to cost more than a stroll, or the clock moves and nothing else does. Scaled linearly and
 * uncapped, though, a single march would drain 130 of a 100-point pool and collapse the PC on
 * arrival, which is not what "tiring" means. The cap keeps the shape (longer = costlier, monotonic)
 * while leaving anyone standing at the end of the longest single thing they can do.
 */
export const MAX_ACTION_ENERGY = 40;

/**
 * How duration bends into energy ABOVE the priced duration: past the base row, cost grows with the
 * SQUARE-ish root of the extra hours, not with the hours themselves. At or below the base row the
 * scaling stays exactly linear — the bend is piecewise (see {@link scaledEnergy}).
 *
 * The live finding (playtest, 15 authored jobs): linear scaling put the clamp
 * crossover at MAX_ACTION_ENERGY / work-row = 40 × 60 / 12 = 200 minutes, and every single authored
 * job is 240 minutes or longer. So a four-hour courier run and an eight-hour mine shift both cost
 * exactly 40 — the entire job board priced at one flat number, half-day shifts strictly dominant
 * (same stamina, half the clock), and the authored `minutes` field differentiating the clock and
 * nothing else.
 *
 * Sub-linear rather than a taller cap because the cap is load-bearing, not a rounding artefact: at
 * linear scale an eight-hour march costs 132 of a 100-point pool and drops the PC on arrival (see
 * {@link MAX_ACTION_ENERGY}). Raising the ceiling to make long jobs distinguishable would restore
 * exactly the collapse the ceiling exists to prevent. Bending the curve instead buys back the range
 * BELOW the cap — 240 min ⇒ 28, 480 min ⇒ 40 — so the shift a player picks is a real trade again,
 * while the longest things in the world still land on the ceiling and still leave them standing.
 *
 * PIECEWISE — the bend applies only ABOVE the base duration — because x^0.6 sits ABOVE x for every
 * x below 1, so a curve meant to cheapen LONG actions silently made every SHORT one dearer. Applied
 * across the whole range it repriced 76 intra-district 15-minute exits in the regression corpus (ratio 0.5)
 * from 4 energy to 5: a full 100-point pool covering 20 local moves instead of 25, a flat tax on
 * ordinary walking and the exact opposite of the intent. Nothing below the base row was ever broken
 * — the flattening this curve exists to fix happens only at the long end, against the clamp — so
 * every below-base action keeps its exact pre-curve linear price.
 *
 * 0.6 is the shallowest exponent that keeps a full-day shift at the cap (12 × 8^0.6 = 41.8) while
 * pulling a half-day clear of it; it also matches the fiction, where the second hour of hauling
 * costs less than the first because the body settles into the work.
 */
export const ENERGY_DURATION_EXPONENT = 0.6;

/**
 * The cost table, by classified turn kind. Notes:
 *  - Conversational/investigative kinds cost REAL clock (r4 playtest: ~30 one-minute turns sat
 *    inside the 300-minute `morning` window while the prose rang noon and NPC deadlines could
 *    never arrive — the clock must move when the player does). A spoken exchange, an examined
 *    room, a case deliberation are each a ~10-minute beat; a proper search/attempt is longer.
 *    Energy stays a SEPARATE meter (physical exertion) — talking spends the day, not the body.
 *  - `attack` is a combat ROUND — seconds in fiction; one minute is the clock's resolution floor.
 *  - `rest` (short rest) is zero here because its resolver advances `SHORT_REST_MINUTES` itself.
 *  - `enterCamp`/`endDay` are zero here: entering camp only teleports (no time passes), and End Day
 *    advances its own clock (`restAdvanceMinutes`) exactly like the old long rest.
 *  - `metaOOC` never reaches the clock (the engine gates it), and costs nothing by definition.
 */
export const TURN_COSTS: Readonly<Record<TurnKind, ActionCost>> = {
  dialogueToNpc: { minutes: 10, energy: 0 },
  movement: { minutes: 30, energy: 8 },
  attemptRequiringCheck: { minutes: 15, energy: 4 },
  attack: { minutes: 1, energy: 3 },
  rest: { minutes: 0, energy: 0 },
  enterCamp: { minutes: 0, energy: 0 },
  endDay: { minutes: 0, energy: 0 },
  // Renting a room only teleports the PC into the room (no time passes, like enterCamp); Wake advances
  // its own clock to the next morning (like endDay). Both zero here.
  rentRoom: { minutes: 0, energy: 0 },
  wakeInRoom: { minutes: 0, energy: 0 },
  // Signing a sellsword at the board is a short transaction — terms read, coin counted, no toil.
  hireMercenary: { minutes: 5, energy: 0 },
  itemAction: { minutes: 2, energy: 1 },
  // A cast is a spell-round — seconds in fiction, one minute at the clock's floor (the `attack`
  // precedent). Energy is the cost that gates at-will magic: casting is real exertion (SR's lore:
  // magic "leaves a scar"), so a spent caster cannot spam workings.
  cast: { minutes: 1, energy: 4 },
  // Learning a working is quiet study, not exertion — it takes a chunk of the clock (mastering the
  // shape of a new spell) but little stamina; the acquisition cost lives in coin/scroll/credit.
  learn: { minutes: 30, energy: 2 },
  clothing: { minutes: 2, energy: 0 },
  trade: { minutes: 10, energy: 1 },
  // A confirmed basket is one full stop at a counter — several goods, one haggle-and-pack beat.
  // Cheaper than N single trades on purpose: the window exists so provisioning stops eating a morning.
  tradeBatch: { minutes: 20, energy: 1 },
  // Striking a service deal: terms named, fee counted, the work itself runs on the agreement's due
  // clock (custody) or inside this beat (while-you-wait) — either way the player's turn is short.
  service: { minutes: 10, energy: 0 },
  // A work shift is the costliest routine action — an hour of toil, real stamina spent. That
  // cost IS the grind: coin has to be worked for, and an exhausted PC cannot start a shift.
  work: { minutes: 60, energy: 12 },
  // Asking after work is reading a board and hearing the terms — minutes, no exertion.
  workInquiry: { minutes: 5, energy: 0 },
  locationInteraction: { minutes: 10, energy: 0 },
  partyAction: { minutes: 2, energy: 0 },
  questAction: { minutes: 1, energy: 0 },
  caseAction: { minutes: 10, energy: 0 },
  // Dispatching an errand is a spoken beat — terms stated, hand shaken. The RUNNER does the
  // walking, and their hours are the errand's own `dueAtClock`, not the player's turn.
  errand: { minutes: 10, energy: 0 },
  freeformNarrative: { minutes: 10, energy: 1 },
  metaOOC: { minutes: 0, energy: 0 },
};

/**
 * The default beat any clock-advancing turn costs when its path never priced itself (private
 * whispers, agenda pressure, proposal answers — everything that only flips `advancesClock`).
 * Pinned to the dialogue row: an unpriced turn is a spoken beat, and the two must never drift.
 */
export const DEFAULT_TURN_MINUTES = TURN_COSTS.dialogueToNpc.minutes;

/** Cost row for a turn kind (total, so callers never index the record directly). */
export function costOf(kind: TurnKind): ActionCost {
  return TURN_COSTS[kind];
}

/**
 * Energy for an action that takes `actualMinutes` where the table priced `baseMinutes` — the scaling
 * an AUTHORED duration earns (a long exit, a full-day work shift). Linear up to the priced duration
 * and sub-linear only beyond it (see {@link ENERGY_DURATION_EXPONENT}) — monotonic throughout, never
 * free, and never more than {@link MAX_ACTION_ENERGY}. A zero-energy base stays free.
 */
export function scaledEnergy(baseEnergy: number, actualMinutes: number, baseMinutes: number): number {
  if (baseEnergy <= 0 || baseMinutes <= 0) return baseEnergy;
  const ratio = actualMinutes / baseMinutes;
  // A shorter-than-priced action pays its exact share (the 15-minute district hop stays 4, as it was
  // before the curve landed); only an over-long one is compressed, which is the only place the clamp
  // ever flattened the range. See {@link ENERGY_DURATION_EXPONENT} for why the split has to exist.
  const factor = ratio <= 1 ? ratio : ratio ** ENERGY_DURATION_EXPONENT;
  const scaled = Math.round(baseEnergy * factor);
  return Math.max(1, Math.min(MAX_ACTION_ENERGY, scaled));
}


/** Current energy, defaulting the absent fields to full (pre-energy saves wake rested). */
export function energyOf(stats: Pick<EntityStats, "energy" | "maxEnergy">): number {
  return stats.energy ?? maxEnergyOf(stats);
}

/** Energy ceiling, defaulting to {@link DEFAULT_MAX_ENERGY}. */
export function maxEnergyOf(stats: Pick<EntityStats, "maxEnergy">): number {
  return stats.maxEnergy ?? DEFAULT_MAX_ENERGY;
}
