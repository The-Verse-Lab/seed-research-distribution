/**
 * Ground items — the minimal floor model that makes `drop` reversible.
 *
 * `transferItem {to: null}` moves an item out of every inventory, but the WorldModel had no notion
 * of WHERE it landed — a freeform-dropped club was gone for good (live 07-18 #2). This slice
 * (`modules.groundItems`: locationId → itemId[]) records what lies on the floor of each location,
 * written ONLY through the existing generic `modulePatch` command with ABSOLUTE per-location arrays
 * (the statusEffects precedent: shallow-merge patch + absolute values ⇒ `snapshot == fold(deltas)`
 * holds with no new Command or Delta kind).
 *
 * Deliberately persistent: floor items survive the party leaving (come back later, the club is
 * still there) — location reaping culls transient ENTITIES, never this slice. Readers return pure
 * COPIES (the `combatSlice()` write-back trap — see CLAUDE.md gotchas).
 *
 * @author Runkai Zhang
 */

/** The module-slice key under `WorldModel.modules`. */
export const GROUND_ITEMS_MODULE = "groundItems";

/** locationId → item ids lying on that floor (insertion order = drop order). */
export type GroundItemsSlice = Record<string, string[]>;

/** Pure read: item ids on the floor of `locationId` (a COPY — never the live array). */
export function groundItemsAt(modules: Record<string, unknown> | undefined, locationId: string): string[] {
  const slice = modules?.[GROUND_ITEMS_MODULE] as Partial<GroundItemsSlice> | undefined;
  const ids = slice?.[locationId];
  return Array.isArray(ids) ? [...ids] : [];
}

/** The absolute post-drop patch for `modulePatch` — the location's array with `itemId` appended. */
export function groundPatchAdd(
  modules: Record<string, unknown> | undefined,
  locationId: string,
  itemId: string,
): Record<string, string[]> {
  return { [locationId]: [...groundItemsAt(modules, locationId), itemId] };
}

/**
 * The absolute post-pickup patch — the location's array with ONE instance of `itemId` removed.
 * Null when the item is not on this floor (the caller refuses honestly instead of patching).
 */
export function groundPatchRemove(
  modules: Record<string, unknown> | undefined,
  locationId: string,
  itemId: string,
): Record<string, string[]> | null {
  const ids = groundItemsAt(modules, locationId);
  const at = ids.indexOf(itemId);
  if (at < 0) return null;
  ids.splice(at, 1);
  return { [locationId]: ids };
}
