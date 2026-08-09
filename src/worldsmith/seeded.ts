/**
 * Id-keyed seeded helpers — shared by worldsmith reconcile and party enrichment.
 *
 * The pattern: derive a PRIVATE rng per entity (`mulberry32(fnv1a(id))`) and take UNCONDITIONAL,
 * fixed-order draws from it. Because the derived generator is keyed only on the entity id, it
 * consumes ZERO draws from any shared seeded stream — the worldsmith (genome, seed) byte-
 * determinism contract (skeleton.ts stream-order notes) is untouched, and the same id yields the
 * same picks forever, across generation, promotion, and reloads.
 *
 * Pure functions only. This module must import nothing from world/engine/modules (the worldsmith
 * zero-coupling rule); `Rng` is the plain callable from rules/dice.
 *
 * @author Runkai Zhang
 */
import type { Rng } from "../rules/dice.ts";

/**
 * FNV-1a over an entity id — the stable per-entity seed (same id ⇒ same picks, forever). The
 * definition now lives in `rules/dice` (the rng home) so `src/world` can share it without importing
 * from worldsmith; re-exported here so the existing `{ fnv1a }` importers keep resolving.
 */
export { fnv1a } from "../rules/dice.ts";

/** One draw from `rng`, mapped onto `arr` (clamped, so a 1.0 draw cannot index past the end). */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i] as T;
}
