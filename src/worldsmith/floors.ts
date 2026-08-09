/**
 * Worldsmith floors — the deterministic, no-LLM rumor template for a gazetteer entry.
 *
 * `gazetteerRumor` is the canonical rumor-register template for realizing an author-canon gazetteer
 * entry into a real location during frontier expansion. NOTE: `src/world/expansion.ts` currently
 * composes the equivalent hearsay prose inline (it references this helper only in a comment), so the
 * function is not on the live path today — it is retained (and test-covered by
 * `tests/gazetteer-realization.test.ts`) as the single source for that phrasing, available to re-wire
 * expansion back onto. It was also the offline floor/reconcile fallback the (now-archived) world
 * generator used for the same slot.
 *
 * @author Runkai Zhang
 */

/**
 * The gazetteer's kind vocabulary — a local mirror of `GazetteerEntrySchema`'s enum (schema.ts).
 * Deliberately re-declared rather than imported: this stays decoupled from the engine's content
 * contract, so a drift fails loud wherever a caller narrows an incompatible string.
 */
export type GazetteerKind = "city" | "town" | "ruin" | "wilds" | "poi";

/** Kind → the phrase a local would use for a place of that sort. Setting-neutral. */
const GAZ_KIND_PHRASES: Record<GazetteerKind, string> = {
  city: "a walled city",
  town: "a market town",
  ruin: "an old ruin",
  wilds: "a stretch of wild country",
  poi: "a place travelers mark",
};

/**
 * The deterministic one-sentence rumor for a gazetteer slot — shared by frontier-expansion
 * realization and (formerly) worldsmith generation, so the two could never drift.
 */
export function gazetteerRumor(kind: GazetteerKind, direction: string): string {
  return `${GAZ_KIND_PHRASES[kind]}, somewhere to the ${direction} — known here only from travelers' talk.`;
}
