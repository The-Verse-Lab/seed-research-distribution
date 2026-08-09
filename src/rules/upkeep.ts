/**
 * Party upkeep — the daily coin/food PRESSURE (the hall-as-hub wave, Phase C).
 *
 * Once per in-world day the party owes: WAGES to every hired mercenary (`modules.partyWages`) and FOOD
 * to everyone (one ration/day). Skipping either bites — an unpaid merc walks; an unfed party grows
 * hungry and, past a threshold, exhausted. This is what turns "earn coin" from optional into a loop:
 * a standing party costs money to keep, so the player must keep working/questing/hiring to sustain it.
 *
 * The math is pure here; the `UpkeepModule` (a tick module keyed on the day counter) applies it through
 * the reducer. Reuses the existing exhaustion ladder + the `item.rations` provision the long rest
 * already spent — this wave moves that food bookkeeping into one per-day owner so it also bites when
 * the party marches through the night without resting, not only at camp.
 *
 * @author Runkai Zhang
 */
import { PROVISIONS_ITEM_ID } from "./exhaustion.ts";

/** Persisted slice key (WorldModel.modules.upkeep). */
export const UPKEEP_MODULE = "upkeep";

/** Days a party member can go unfed before the ache becomes real exhaustion (+1 per threshold). */
export const HUNGER_EXHAUSTION_AT = 2;
/** A defensive cap so a huge time-skip can't apply an unbounded penalty in one tick. */
export const MAX_UPKEEP_DAYS = 7;

export { PROVISIONS_ITEM_ID };

export interface UpkeepSlice {
  /** The last in-world day upkeep was settled through. Null until the first tick seeds it. */
  lastDay: number | null;
  /** Per-member accumulated hunger (days unfed since last threshold bite). */
  hunger: Record<string, number>;
}

/** A defaulting reader for the upkeep slice. */
export function readUpkeepSlice(modules: Record<string, unknown> | undefined): UpkeepSlice {
  const slice = modules?.[UPKEEP_MODULE] as Partial<UpkeepSlice> | undefined;
  return {
    lastDay: slice?.lastDay ?? null,
    hunger: { ...(slice?.hunger ?? {}) },
  };
}

/** The in-world day number from the absolute clock (1440 min/day). */
export function upkeepDayOf(clock: number): number {
  return Math.floor(clock / 1440);
}
