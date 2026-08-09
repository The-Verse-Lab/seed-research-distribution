/**
 * Region resolution — the ONE reader every consumer uses to turn a location into its effective
 * region profile (difficulty, foot-traffic, event rate, and spawn pools). Pure and deterministic;
 * no rng and no state. A world
 * that authors no `regions` gets a fallback built entirely from `constitution.danger`, so every
 * consumer reads exactly what it read before this existed and behavior is byte-identical.
 *
 * The fallback chain, for a location:
 *   no location            → world fallback (danger = constitution.danger)
 *   location has no region  → world fallback
 *   region tag, no row      → world fallback, but `regionId` is reported (so an `inRegion` gate
 *                             still resolves the tag even when no first-class row was authored)
 *   first-class region row  → the row's fields, each with its own world-level fallback
 *
 * @author Runkai Zhang
 */
import type { SpawnRule, World } from "../content/schema.ts";
import { dangerThreatShare } from "../worldsmith/reconcile.ts";

/** The resolved, always-complete region profile the engine reads (never partial, never undefined). */
export interface RegionProfile {
  /** The region id this location belongs to, or null when untagged. */
  regionId: string | null;
  /** True ONLY when a first-class `regions` ROW backs this location — false for the world fallback
   *  AND for a legacy tag with no row. Consumers that key opt-in region behavior (e.g. the exploitation
   *  isolation bonus) off "the author built a real region" must read this, not `regionId !== null`:
   *  a tag-without-row reports its `regionId` (so an `inRegion` gate still resolves) yet is NOT an
   *  authored region, so those worlds stay byte-identical. */
  authored: boolean;
  /** Effective difficulty 0..3 — `region.danger` ?? `constitution.danger`. */
  danger: number;
  /** Foot-traffic 0..3 (1 when unregioned). */
  crowd: number;
  /** Travel-event-rate multiplier (1 when unregioned). */
  eventRate: number;
  /** Region-flavored ambient extras (empty when unregioned). */
  ambientPool: SpawnRule[];
  /** Off-roster threats eligible to ambient-spawn here (empty when unregioned). */
  threatPool: SpawnRule[];
  /** Share of eligible generated NPCs marked exploitative — `region.threatShare` ?? `dangerThreatShare(danger)`. */
  threatShare: number;
}

/** The static locationId → regionId lookup — consolidates the inline copies across the codebase. */
export function regionOfLocation(world: World, locId: string | null | undefined): string | undefined {
  return locId ? world.locations.find((l) => l.id === locId)?.region : undefined;
}

/**
 * Resolve a location's effective region profile with world-level fallback. Pure; the single reader
 * the event roller, ambient-life module, exploitation scorer, and brief all consult.
 */
export function regionProfileOf(world: World, locationId: string | null): RegionProfile {
  const worldDanger = world.constitution.danger ?? 1;
  const fallback: RegionProfile = {
    regionId: null,
    authored: false,
    danger: worldDanger,
    crowd: 1,
    eventRate: 1,
    ambientPool: [],
    threatPool: [],
    threatShare: dangerThreatShare(worldDanger),
  };
  const regionId = regionOfLocation(world, locationId);
  if (!regionId) return fallback;
  const region = world.regions.find((r) => r.id === regionId);
  if (!region) return { ...fallback, regionId }; // tag present, no first-class row ⇒ still fall back
  const danger = region.danger ?? worldDanger;
  return {
    regionId,
    authored: true,
    danger,
    crowd: region.crowd,
    eventRate: region.eventRate,
    ambientPool: region.ambientPool,
    threatPool: region.threatPool,
    threatShare: region.threatShare ?? dangerThreatShare(danger),
  };
}
