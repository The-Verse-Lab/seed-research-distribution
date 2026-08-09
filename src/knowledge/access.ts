/**
 * Plausible-access gate — can THIS character know THIS world fact at all?
 * (NPC-EPISTEMIC-CONTEXT-PLAN §4.5/§11: "public" means safe to voice, not universally known.)
 *
 * Deterministic and code-owned: home region (roster location), current region, faction
 * membership, professional domain overlap, and explicit per-NPC grants. No model call, no
 * embeddings — access is decided before any relevance ranking.
 *
 * @author Runkai Zhang
 */
import type { NpcTemplate, World, WorldFact } from "../content/schema.ts";
import { structuredKnowledgeOf } from "./facts.ts";

/** The region tag of the location an NPC is rostered at (its authored home), if any. */
export function npcHomeRegion(world: World, npcTemplateId: string): string | undefined {
  const home = world.locations.find((l) => l.npcs.includes(npcTemplateId));
  return home?.region;
}

/** True when this NPC holds an explicit knowledge/privateKnowledge grant naming the fact id. */
export function hasExplicitGrant(npc: NpcTemplate, factId: string): boolean {
  if (structuredKnowledgeOf(npc).some((e) => e.factId === factId)) return true;
  return (npc.privateKnowledge ?? []).some((e) => e.factId === factId);
}

/**
 * Whether `npc` plausibly has access to `fact`. An explicit grant always passes (the author said
 * so); otherwise the fact's access tier decides:
 *  - `common`       — everyone.
 *  - `local`        — home or current region in scope.regionIds, or roster location in scope.locationIds.
 *  - `faction`      — npc.factionId in scope.factionIds.
 *  - `professional` — the NPC's own structured knowledge shares a domain with the fact.
 *  - `restricted`   — explicit grant only.
 */
export function canAccessFact(
  world: World,
  npc: NpcTemplate,
  fact: WorldFact,
  opts: { currentRegionId?: string; currentLocationId?: string | null } = {},
): boolean {
  if (hasExplicitGrant(npc, fact.id)) return true;
  switch (fact.access) {
    case "common":
      return true;
    case "local": {
      const home = npcHomeRegion(world, npc.id);
      const regions = fact.scope.regionIds;
      if (home && regions.includes(home)) return true;
      if (opts.currentRegionId && regions.includes(opts.currentRegionId)) return true;
      const rosterLoc = world.locations.find((l) => l.npcs.includes(npc.id))?.id;
      if (rosterLoc && fact.scope.locationIds.includes(rosterLoc)) return true;
      if (opts.currentLocationId && fact.scope.locationIds.includes(opts.currentLocationId)) return true;
      return false;
    }
    case "faction":
      return npc.factionId !== undefined && fact.scope.factionIds.includes(npc.factionId);
    case "professional": {
      if (fact.domains.length === 0) return false;
      const own = new Set(structuredKnowledgeOf(npc).flatMap((e) => e.domains));
      for (const e of npc.privateKnowledge ?? []) for (const d of e.domains) own.add(d);
      return fact.domains.some((d) => own.has(d));
    }
    case "restricted":
      return false; // explicit grant already handled above
  }
}
