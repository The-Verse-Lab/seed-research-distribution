/**
 * Recruit board — hireable-mercenary helpers (the hall-as-hub wave, Phase B).
 *
 * A guild hall with `guild.recruits` shows a small board of sellswords for hire. The offers are NOT
 * persisted: each is a pure function of (hall, in-world day, slot), so the roster is stable within a
 * day and refreshes daily with zero saved state and zero shared-rng draws — the identity is composed
 * on the fly from the offer id via the same id-keyed seeded floor (`composeNpcTemplate`) that party
 * enrichment uses. The reducer persists ONLY which offer ids were hired (so a taken slot doesn't come
 * back that day) and, for the Phase-C upkeep tick, the per-member daily wage.
 *
 * @author Runkai Zhang
 */
import { fnv1a, mulberry32 } from "./dice.ts";
import { pick } from "../worldsmith/seeded.ts";

/** Persisted slice module keys. */
export const RECRUIT_BOARD_MODULE = "recruitBoard";
export const PARTY_WAGES_MODULE = "partyWages";

/** Which merc-board offers have already been hired (so a taken slot doesn't reappear that day). */
export interface RecruitBoardSlice {
  hired: string[];
}

/** Per-member daily wage owed to hired mercenaries — spent by the Phase-C upkeep tick. */
export type PartyWagesSlice = Record<string, number>;

/** A defaulting reader for the recruit-board slice. */
export function readRecruitBoardSlice(modules: Record<string, unknown> | undefined): RecruitBoardSlice {
  const slice = modules?.[RECRUIT_BOARD_MODULE] as Partial<RecruitBoardSlice> | undefined;
  return { hired: [...(slice?.hired ?? [])] };
}

/** A defaulting reader for the party-wages slice. */
export function readPartyWagesSlice(modules: Record<string, unknown> | undefined): PartyWagesSlice {
  return { ...((modules?.[PARTY_WAGES_MODULE] as PartyWagesSlice | undefined) ?? {}) };
}

/** The in-world day number from the absolute clock (1440 min/day). Day 0 is the first day. */
export function recruitDayOf(clock: number): number {
  return Math.floor(clock / 1440);
}

/**
 * The deterministic offer id for a (hall, day, slot) board seat. Doubles as the ENTITY id when hired
 * — so re-deriving the identity from the same id (board render → hire) yields the SAME sellsword.
 * Shape stays within the wire id charset ([A-Za-z0-9._:#-]).
 */
export function recruitOfferId(hallId: string, day: number, slot: number): string {
  return `merc.${hallId}.${day}.${slot}`;
}

// A grim, setting-neutral name pool for generated sellswords. `composeNpcTemplate` copies an entity's
// NAME (it does not invent one), so a merc offer needs a name before its identity is composed — this
// gives one, id-keyed so the board render and the eventual hire agree on who signed on.
const MERC_FIRST = [
  "Bram", "Cael", "Doran", "Edda", "Fenn", "Gwenna", "Harl", "Ivo", "Joss", "Kestrel", "Lue", "Marek",
  "Nerin", "Orla", "Pell", "Quill", "Rane", "Sable", "Tarn", "Ulf", "Vesk", "Wren", "Yorick", "Zeb",
] as const;
const MERC_LAST = [
  "Ashfen", "Blackwater", "Corran", "Dunmar", "Ekhart", "Foss", "Grael", "Holt", "Ivrone", "Kessel",
  "Locke", "Mord", "Norn", "Ostrel", "Pyke", "Rook", "Sallow", "Thane", "Varr", "Whitlock",
] as const;

/**
 * A deterministic sellsword name for a board offer — id-keyed (stable board-render ↔ hire).
 * `avoidFirstName` (the PC's given name; r4 P4: the board offered "Kestrel Foss" to a PC named
 * Kestrel Vane) rerolls ONLY on an actual collision, from an `:alt` stream over a pool that
 * excludes the avoided name — non-colliding boards stay byte-identical, and both call sites
 * (board render + hire) derive from the same PC name so they always agree.
 */
export function seededMercName(offerId: string, avoidFirstName?: string): string {
  const rng = mulberry32(fnv1a(`${offerId}:name`));
  let first: string = pick(rng, MERC_FIRST);
  const last = pick(rng, MERC_LAST);
  const avoid = avoidFirstName?.trim().split(/\s+/)[0]?.toLowerCase();
  if (avoid && first.toLowerCase() === avoid) {
    const alt = mulberry32(fnv1a(`${offerId}:name:alt`));
    const pool = MERC_FIRST.filter((n) => n.toLowerCase() !== avoid);
    first = pick(alt, pool);
  }
  return `${first} ${last}`;
}
