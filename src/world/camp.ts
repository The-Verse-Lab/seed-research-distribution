/**
 * Camp — the BG3-style long-rest destination.
 *
 * A long rest teleports the player + the party members currently with them to a single synthetic
 * location, `loc.camp`, that has NO exits (inaccessible by construction: `exitsFrom(camp) === []`,
 * so every `moveParty`/`moveEntity` egress is rejected by `traversalRejection`). The only way out is
 * the engine's End Day path, which teleports everyone back to the stored origin.
 *
 * Camp is FIXED CONTENT, not runtime history: it is re-injected into the `world.locations` content
 * mirror deterministically at every engine `start()`/`restart()` (so the narrator can always name it),
 * emits NO delta, and adds nothing to the durable expansion/gazetteer surfaces. The camp runtime state
 * (`CampSlice`) rides the reducer's `modulePatch` (already-folded `modulePatched` delta) and persists
 * automatically through the `model.modules` snapshot round-trip — so a reload mid-camp restores intact.
 *
 * @author Runkai Zhang
 */
import { LocationSchema, type Location, type World } from "../content/schema.ts";
import { partyLocationOf, type WorldModel } from "./model.ts";

/**
 * The fixed synthetic id of the Camp location — the same room every long rest. Deliberately
 * `__`-wrapped (the engine's reserved-sentinel convention, cf. the `__empty:` slot marker): a plain
 * `loc.camp` collides with worlds/tests that author a literal campsite by that natural id, which would
 * make `isAtCamp` fire at a real location. No authored/worldsmith id ever uses `__`.
 */
export const CAMP_LOCATION_ID = "loc.__camp__";

const DEFAULT_CAMP_DESCRIPTION =
  "A ring of bedrolls around a low fire, the dark pressing in beyond the reach of the light. Here the " +
  "day is set down — a place to rest, talk, and take stock before the road picks up again.";

/** The generic Camp location — no exits, no coordinates (so it never lands on the minimap). */
export function defaultCampLocation(): Location {
  return LocationSchema.parse({
    id: CAMP_LOCATION_ID,
    name: "Camp",
    description: DEFAULT_CAMP_DESCRIPTION,
  });
}

/**
 * The Camp location for a world — the per-world `campLocation` theming if authored (name/description
 * only), else the generic default. The fixed id + empty exits are always stamped, so a themed Camp can
 * never become explorable.
 */
export function resolveCampLocation(world: World): Location {
  const override = world.campLocation;
  if (!override) return defaultCampLocation();
  return LocationSchema.parse({
    id: CAMP_LOCATION_ID,
    name: override.name,
    description: override.description || DEFAULT_CAMP_DESCRIPTION,
  });
}

/** Persisted per-campaign camp runtime (WorldModel.modules.camp). */
export interface CampSlice {
  /** True while the party is camped (long rest in progress). */
  active: boolean;
  /** Where the party was when they made camp — where End Day returns everyone. Null when not camped. */
  returnLocationId: string | null;
  /** The member ids taken to camp at enter (diagnostics; the live party set drives the return). */
  memberIds: string[];
  /** The clock reading when camp was entered (frozen for the duration). */
  enteredClock: number;
}

/** A defaulting reader for the camp slice (mirrors TravelEventsModule.readCursor). */
export function readCampSlice(model: WorldModel): CampSlice {
  const slice = model.modules.camp as Partial<CampSlice> | undefined;
  return {
    active: slice?.active ?? false,
    returnLocationId: slice?.returnLocationId ?? null,
    memberIds: [...(slice?.memberIds ?? [])],
    enteredClock: slice?.enteredClock ?? 0,
  };
}

/** Whether the party is currently at Camp — the derived truth (the slice's `active` mirrors it). */
export function isAtCamp(model: WorldModel): boolean {
  return partyLocationOf(model) === CAMP_LOCATION_ID;
}
