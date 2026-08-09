/**
 * NPC enrichment — transient→permanent promotion that persists.
 *
 * When a runtime NPC (a spawned extra, a generated lurker's survivor, anyone without a full
 * authored template) is promoted to a permanent fixture — joining the party is the trigger —
 * a COMPLETE NpcTemplate is composed for it (src/modules/party/enrich.ts) and applied through
 * the reducer's `enrichNpc` command. The matching `npcEnriched` delta carries the FULL template,
 * so replay is verbatim and LLM-free, exactly like `worldExpanded` carries full locations.
 *
 * Persistence mirrors the expansion pattern one-for-one: the durable record is the `enrichment`
 * module slice (rides `GameState.modules`, written only by the reducer/replay shared writer in
 * src/world/reducer.ts); `world.npcs` is the derived CONTENT cache the narrator/agents read
 * descriptive data from, and `hydrateEnrichments()` — the twin of `hydrateExpansions()` —
 * rebuilds that mirror from the slice on every load.
 *
 * @author Runkai Zhang
 */
import type { NpcTemplate, World } from "../content/schema.ts";

/** The durable record of every enrichment, kept as a module slice (persists + replays). */
export interface EnrichmentSlice {
  /** Keyed by the enriched ENTITY's id — also the re-promotion short-circuit. */
  npcs: Record<string, NpcTemplate>;
}

/** Read the recorded enrichments off a modules record (model.modules or GameState.modules). */
export function enrichmentsOf(modules: Record<string, unknown> | undefined): Record<string, NpcTemplate> {
  const slice = modules?.enrichment as Partial<EnrichmentSlice> | undefined;
  return slice?.npcs ?? {};
}

/**
 * Mirror one enrichment template into the world CONTENT cache: push when new, replace when an
 * entry with the same id exists. Template ids are ENTITY ids (the reducer enforces it), so a
 * spawned instance's enrichment lands as its OWN entry — it never overwrites a shared authored
 * template other entities resolve from; only enriching an authored NPC itself (entity id ==
 * authored id) supersedes its entry. Idempotent; shared by the engine-side mirror at promotion
 * time and load-time hydration so the two cannot drift.
 */
export function mirrorEnrichment(world: World, template: NpcTemplate): void {
  const idx = world.npcs.findIndex((n) => n.id === template.id);
  if (idx === -1) world.npcs.push(structuredClone(template));
  else world.npcs[idx] = structuredClone(template);
}

/**
 * Re-apply every persisted enrichment onto freshly loaded world CONTENT before the model is
 * built from it — the `hydrateExpansions()` twin. The `enrichment` module slice is the durable
 * record; `world.npcs` is the derived content cache. Idempotent.
 */
export function hydrateEnrichments(world: World, modules: Record<string, unknown> | undefined): void {
  for (const template of Object.values(enrichmentsOf(modules))) {
    mirrorEnrichment(world, template);
  }
}
