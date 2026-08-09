/**
 * Lodging — a RENTED ROOM at a guild hall (the "hall as hub" wave).
 *
 * Renting a room teleports the PC alone while companions stay in the common hall
 * to a single synthetic location, `loc.__room__`, that has NO exits (inaccessible by construction:
 * `exitsFrom(room) === []`, so every egress is rejected). The only way out is the engine's Wake path,
 * which teleports the PC back to the hall after a full night's recovery. A shared bunk and a
 * private room use the same recovery rules; the tier only changes authored presentation and cost.
 *
 * Like Camp, the room is FIXED CONTENT re-injected into the `world.locations` content mirror while a
 * stay is live (so the narrator can name it) and spliced out on wake; its runtime state (`LodgingSlice`)
 * rides the reducer's `modulePatch` and persists through the `model.modules` snapshot round-trip, so a
 * reload mid-stay restores intact.
 *
 * @author Runkai Zhang
 */
import { LocationSchema, type Location, type LodgingTier } from "../content/schema.ts";
import { partyLocationOf, type WorldModel } from "./model.ts";

/**
 * The fixed synthetic id of the rented Room — `__`-wrapped (the engine's reserved-sentinel convention,
 * cf. `loc.__camp__`): a plain `loc.room` could collide with an authored location. No authored/
 * worldsmith id ever uses `__`.
 */
export const LODGING_LOCATION_ID = "loc.__room__";

const DEFAULT_ROOM_DESCRIPTION =
  "A narrow rented room — a bed, a stool, a shuttered window, a door you can bar from the inside. " +
  "The noise of the hall is a murmur through the wall. Here the day is set down for the night.";

/**
 * The Room location for the current rental — a per-stay theming from the hall name + tier, but always
 * the fixed id + empty exits (so a room can never become explorable). `private` tiers read as a room
 * with a door; a shared bunk reads as a common loft.
 */
export function resolveLodgingLocation(hallName: string | undefined, tier: LodgingTier | undefined): Location {
  const label = tier?.label ?? "a rented room";
  const where = hallName ? ` at ${hallName}` : "";
  const name = tier?.private === false ? "The Common Loft" : "A Rented Room";
  const description = tier?.private === false
    ? `A shared sleeping loft${where} — rows of bunks, the breathing of strangers, no door of your own. ` +
      "You bed down among them for the night."
    : `${label.charAt(0).toUpperCase()}${label.slice(1)}${where}. ${DEFAULT_ROOM_DESCRIPTION}`;
  return LocationSchema.parse({ id: LODGING_LOCATION_ID, name, description });
}

/** Persisted per-campaign lodging runtime (WorldModel.modules.lodging). */
export interface LodgingSlice {
  /** True while the PC is bedded down in a rented room. */
  active: boolean;
  /** Where the PC (and party) were when the room was rented — where Wake returns the PC. Null when not lodging. */
  returnLocationId: string | null;
  /** The guild-hall location the room belongs to (diagnostics + wage/standing context). Null when not lodging. */
  hallId: string | null;
  /** The hall's guild faction (for the Standing surface), if any. Null otherwise. */
  guildFactionId: string | null;
  /** The rented tier id (drives the room theming + the `private` exploitation read). Null when not lodging. */
  tierId: string | null;
  /** Whether the rented tier is a PRIVATE room (exploitation-enabled) vs a shared bunk (damped). */
  private: boolean;
  /** The clock reading when the room was rented (frozen for the duration). */
  enteredClock: number;
  /**
   * The minute through which the last night bought at `hallId` is PAID. Set when the player gets up
   * in daylight instead of sleeping the night through, so going back up to the same bed before the
   * next dawn costs nothing more — leaving a room you paid for must never become a second bill.
   * Optional (absent on a fresh slice ⇒ byte-identical serialization for saves that never used it).
   */
  paidThroughClock?: number;
}

/** A defaulting reader for the lodging slice (mirrors readCampSlice). */
export function readLodgingSlice(model: WorldModel): LodgingSlice {
  const slice = model.modules.lodging as Partial<LodgingSlice> | undefined;
  return {
    active: slice?.active ?? false,
    returnLocationId: slice?.returnLocationId ?? null,
    hallId: slice?.hallId ?? null,
    guildFactionId: slice?.guildFactionId ?? null,
    tierId: slice?.tierId ?? null,
    private: slice?.private ?? true,
    enteredClock: slice?.enteredClock ?? 0,
    ...(typeof slice?.paidThroughClock === "number" ? { paidThroughClock: slice.paidThroughClock } : {}),
  };
}

/** Whether the PC is currently bedded down in a rented room — the derived truth (the slice mirrors it). */
export function isAtLodging(model: WorldModel): boolean {
  return partyLocationOf(model) === LODGING_LOCATION_ID;
}
