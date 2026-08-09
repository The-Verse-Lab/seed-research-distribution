/**
 * Journey memory — the party's recent real travels, remembered by the WORLD.
 *
 * The 2026-07-25 playtest's worst failure: after a bugged relocation, an NPC confidently denied a
 * mechanically-real day of travel ("we talked about going — we haven't gone yet") because the
 * truth ledger (`# THE RECORD`) was quest-only and movement lived nowhere authoritative. This
 * slice is the fix's memory half: the reducer's `moveParty` appends a bounded log of legs, the
 * brief renders the last few as `[TRAVELED]` rows under `# THE RECORD` (so `ledgerContradiction`
 * covers journey denial), and the classifier's established facts carry them too.
 *
 * Bounded and additive: absent slice ⇒ no rows, old saves parse unchanged. Teleports (camp,
 * rented rooms, captivity) are scene framing, not journeys — never logged.
 *
 * @author Runkai Zhang
 */

/** The `model.modules` key the journey log lives under. */
export const JOURNEY_MODULE = "journey";

/** Bound on the stored log — enough for "the last few days of roads", never a transcript. */
export const JOURNEY_LOG_CAP = 8;

/** How many of the newest legs the brief/classifier surfaces render. */
export const JOURNEY_BRIEF_ROWS = 3;

/** One real party movement: where from, where to, and the campaign clock at departure. */
export interface JourneyLeg {
  fromId: string;
  toId: string;
  atClock: number;
}

/** The journey slice value shape. */
export interface JourneySlice {
  log: JourneyLeg[];
}

/** Defaulting reader — absent slice reads as an empty log. */
export function readJourneySlice(modules: Record<string, unknown>): JourneySlice {
  const slice = modules[JOURNEY_MODULE] as Partial<JourneySlice> | undefined;
  return { log: Array.isArray(slice?.log) ? (slice.log as JourneyLeg[]) : [] };
}

/** The newest legs, oldest→newest, capped at `JOURNEY_BRIEF_ROWS` for rendering. */
export function recentJourneys(modules: Record<string, unknown>): JourneyLeg[] {
  return readJourneySlice(modules).log.slice(-JOURNEY_BRIEF_ROWS);
}
