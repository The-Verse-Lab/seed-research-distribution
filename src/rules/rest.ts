/**
 * Rest and the clock — how long sleeping takes and when you wake.
 *
 * Pure arithmetic over the in-world clock, with no engine state anywhere in it, which is why it
 * belongs here rather than in the engine that used to hold it. The lodging resolver and the tests
 * both read these; `engine.ts` re-exports the public ones so existing importers are unaffected.
 *
 * @author Runkai Zhang
 */

/** Nominal length of a long rest (a full night's sleep, SRD-ish 8h) — retained for callers/tests
 *  that reason about "a night"; the actual advance is computed by `restAdvanceMinutes` so the day
 *  counter always rolls over (below). */
export const LONG_REST_MINUTES = 480;
/** Minutes-into-day the party WAKES from a long rest (07:00 = start of "morning", dayPhaseOf). */
export const REST_WAKE_MINUTE = 420;
/** Minutes-into-day from which lying down means THE NIGHT (20:00), not a daylight lie-down. */
export const NIGHT_START_MINUTE = 1200;
/** What getting up off a rented bed in daylight costs — boots, stairs, nothing more. */
export const RISE_MINUTES = 10;
/** Minutes in one in-world day (mirrors dayPhaseOf's `day = 1440`). */
export const MINUTES_PER_DAY = 1440;

/**
 * How many clock-minutes a long rest advances from `clock`: forward to the NEXT wake hour (07:00).
 * From any waking hour that is one day later, so the day counter rolls over by exactly one (the
 * audit's "rest advances time-of-day but not the day" fix).
 *
 * The SMALL-HOURS branch is r5 P2: a player who turned in after midnight was charged a full extra
 * day — bedding down at 01:00 on day 2 woke on day 3 at 07:00, thirty hours later. It cost that run
 * an entire day and the quest deadline riding on it. Past midnight the night now ends at THIS day's
 * dawn, which is the same night's sleep, not a day skipped. Pure — unit-testable, replay-safe.
 */
export function restAdvanceMinutes(clock: number): number {
  const dayStart = Math.floor(clock / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  const intoDay = clock - dayStart;
  const wake =
    intoDay < REST_WAKE_MINUTE
      ? dayStart + REST_WAKE_MINUTE // already past midnight: sleep to THIS dawn
      : dayStart + MINUTES_PER_DAY + REST_WAKE_MINUTE; // an evening rest: tomorrow's dawn
  return wake - clock;
}

/** How long a SHORT rest takes (in place; no day rollover) — an hour to catch your breath. */
export const SHORT_REST_MINUTES = 60;
/** Fraction of MISSING hp a short rest restores (partial recovery; a long rest heals to full). */
export const SHORT_REST_HP_FRACTION = 0.5;
/** Fraction of MISSING energy a short rest restores. */
export const SHORT_REST_ENERGY_FRACTION = 0.5;
