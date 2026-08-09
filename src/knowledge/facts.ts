/**
 * Fact utilities — flat text of legacy/structured knowledge, world-fact lookup, and the
 * code-owned CURRENT-truth projections (NPC-EPISTEMIC-CONTEXT-PLAN §9.2 step 3).
 *
 * Projections are the reason a farmhand can answer "where is the closest guild?" truthfully
 * without an authored fact: `Location.guild` is already the mechanical authority for halls, so
 * the same rows are projected here as highest-authority CURRENT lines. Model/world state always
 * outranks static prose (hard invariant 4).
 *
 * @author Runkai Zhang
 */
import type { NpcKnowledgeEntry, NpcTemplate, World, WorldFact } from "../content/schema.ts";
import type { EpistemicLine } from "./types.ts";

/** A knowledge grant in either authored form (legacy string | structured entry). */
export type KnowledgeGrant = string | NpcKnowledgeEntry;

/**
 * Fold a mixed `knowledge[]` to flat statements — what retrieval/errand-pool/enrichment readers
 * consume. Entries whose disclosure is relationship- or never-gated (`trust`/`never`/`misdirect`)
 * are EXCLUDED: those surfaces have no disclosure gate of their own, so indexing a guarded
 * statement there would let `# RELEVANT LORE` retrieval hand the secret to any stranger the
 * packet composer just refused it to. Guarded text flows ONLY through the packet's verdict.
 */
export function knowledgeStatements(entries: readonly KnowledgeGrant[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push(entry);
      continue;
    }
    const mode = entry.disclosure.mode;
    if (mode === "trust" || mode === "never" || mode === "misdirect") continue;
    const text = entry.statement?.trim();
    if (text) out.push(text);
  }
  return out;
}

/** The structured entries of a mixed `knowledge[]` (legacy strings carry no grant metadata). */
export function structuredKnowledgeOf(npc: NpcTemplate | undefined): NpcKnowledgeEntry[] {
  return (npc?.knowledge ?? []).filter((e): e is NpcKnowledgeEntry => typeof e !== "string");
}

/** World facts, folded from the optional field. */
export function worldFactsOf(world: World): WorldFact[] {
  return world.facts ?? [];
}

/**
 * Project the authored guild capabilities into CURRENT answer lines for a location: the hall HERE
 * (authority 100) and halls one road away (authority 90). `adjacentLocationIds` must come from the
 * caller's live map view (WorldModel exits), so runtime expansion/locks stay authoritative.
 */
export function projectGuildFacts(
  world: World,
  locationId: string | null,
  adjacentLocationIds: readonly string[],
): EpistemicLine[] {
  const out: EpistemicLine[] = [];
  const locOf = (id: string) => world.locations.find((l) => l.id === id);
  const clerkNameOf = (clerkId: string | undefined): string | undefined =>
    clerkId ? world.npcs.find((n) => n.id === clerkId)?.name : undefined;

  const here = locationId ? locOf(locationId) : undefined;
  if (here?.guild) {
    const clerk = clerkNameOf(here.guild.clerkId);
    out.push({
      id: `proj.guild.${here.id}`,
      text: `${here.guild.name} is the guild hall HERE at ${here.name} — the current, working contract hall${clerk ? `; ${clerk} keeps its board` : ""}.`,
      source: "model",
      temporal: "current",
      certainty: "certain",
      authority: 100,
    });
  }
  for (const adjId of adjacentLocationIds) {
    if (adjId === locationId) continue;
    const adj = locOf(adjId);
    if (!adj?.guild) continue;
    out.push({
      id: `proj.guild.${adj.id}`,
      text: `${adj.guild.name} at ${adj.name} is a working guild hall one road from here.`,
      source: "model",
      temporal: "current",
      certainty: "certain",
      authority: 90,
    });
  }
  return out;
}

/**
 * Query tokens a guild projection should answer to — the projection's own names plus the small
 * generic vocabulary of the institution it IS. Deterministic; used by the packet's relevance gate
 * so a guild line never rides into an unrelated reply.
 */
export const GUILD_QUERY_TOKENS = ["guild", "hall", "contract", "board", "work", "job", "jobs", "muster"] as const;
