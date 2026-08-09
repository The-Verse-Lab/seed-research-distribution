/**
 * Captivity — the synthetic holding LOCATION + the persisted state reader for the bad-end follow-up.
 *
 * A lost fight enqueues `beginCaptivity` (src/world/reducer.ts), which teleports
 * the player to a single synthetic location, `loc.__captivity__`, that has NO exits — so, exactly like
 * Camp, every ordinary `moveEntity`/`moveParty` egress is rejected by `traversalRejection` and the held
 * player CANNOT simply walk out. The only ways out are the loop's own `endCaptivity` (serve the term,
 * or win an escape check), which teleports them back to where they were taken.
 *
 * The holding cell is FIXED CONTENT, not runtime history: re-injected into the `world.locations`
 * content mirror deterministically at every engine `start()`/`restart()` (so the narrator can always
 * name it), emits NO delta, and adds nothing to the durable expansion/gazetteer surfaces — the same
 * posture as Camp. The runtime state (`CaptivitySlice`, whose shape lives in the pure
 * `src/rules/captivity.ts`) rides the reducer's generic `modulePatch` (`modulePatched` delta) and
 * persists automatically through the `model.modules` snapshot round-trip — a reload mid-captivity
 * restores intact.
 *
 * The `__`-wrapped id is deliberate (the `camp-long-rest-bg3` gotcha): a plain `loc.captivity` could
 * collide with an authored id; `loc.__captivity__` cannot.
 *
 * @author Runkai Zhang
 */
import { LocationSchema, type Location, type World } from "../content/schema.ts";
import type { WorldModel } from "./model.ts";
import { defaultCaptivitySlice, type CaptivitySlice } from "../rules/captivity.ts";

/** The fixed synthetic id of the holding location — the same cell every capture. */
export const CAPTIVITY_LOCATION_ID = "loc.__captivity__";

const DEFAULT_CAPTIVITY_DESCRIPTION =
  "A cramped, cheerless hold — bare stone, a barred way you cannot simply walk through, the reek of " +
  "captivity. This is where the beaten are kept. The only way out is to earn it, or to run for it.";

/** The generic holding location — no exits, no coordinates (so it never lands on the minimap). */
export function defaultCaptivityLocation(): Location {
  return LocationSchema.parse({
    id: CAPTIVITY_LOCATION_ID,
    name: "Captivity",
    description: DEFAULT_CAPTIVITY_DESCRIPTION,
  });
}

/**
 * The holding location for a world — the per-world `captivityLocation` theming if authored (name/
 * description only), else the generic default. The fixed id + empty exits are always stamped, so a
 * themed hold can never become explorable (kind-specific colour lives in the follow-up beats, not here).
 */
export function resolveCaptivityLocation(world: World): Location {
  const override = world.captivityLocation;
  if (!override) return defaultCaptivityLocation();
  return LocationSchema.parse({
    id: CAPTIVITY_LOCATION_ID,
    name: override.name,
    description: override.description || DEFAULT_CAPTIVITY_DESCRIPTION,
  });
}

/** A defaulting reader for the captivity slice (mirrors readCampSlice / TravelEventsModule.readCursor). */
export function readCaptivitySlice(model: WorldModel): CaptivitySlice {
  const d = defaultCaptivitySlice();
  const slice = model.modules.captivity as Partial<CaptivitySlice> | undefined;
  return {
    active: slice?.active ?? d.active,
    kind: slice?.kind ?? d.kind,
    captorId: slice?.captorId ?? d.captorId,
    captorName: slice?.captorName ?? d.captorName,
    captorOriginLoc: slice?.captorOriginLoc ?? d.captorOriginLoc,
    captorWasTier: slice?.captorWasTier ?? d.captorWasTier,
    returnLocationId: slice?.returnLocationId ?? d.returnLocationId,
    strippedItems: [...(slice?.strippedItems ?? d.strippedItems)],
    droppedMemberIds: [...(slice?.droppedMemberIds ?? d.droppedMemberIds)],
    escapeDc: slice?.escapeDc ?? d.escapeDc,
    progress: slice?.progress ?? d.progress,
    goal: slice?.goal ?? d.goal,
    day: slice?.day ?? d.day,
    enteredClock: slice?.enteredClock ?? d.enteredClock,
  };
}

/** Whether the player is currently HELD — the authoritative slice flag (mirrors the PC being at the cell). */
export function isCaptive(model: WorldModel): boolean {
  return readCaptivitySlice(model).active;
}
