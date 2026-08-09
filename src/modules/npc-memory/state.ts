/**
 * NPC-memory module state — the read-only views onto the journal slice (M4 Part B).
 *
 * The slice itself lives at `WorldModel.modules.npcMemory` and is written ONLY through the reducer's
 * typed memory commands (which emit typed, absolute-post-state deltas) — so it is fully replayable
 * (`snapshot == fold(deltas)`). This file owns the recall helpers the read-back wiring uses; neither
 * ever mutates the model. The value types `NpcMemoryEntry` / `NpcMemorySlice` are owned by the pure
 * leaf `src/rules/npc-memory.ts` and re-exported here for the module's convenience.
 *
 * @author Runkai Zhang
 */
import {
  cloneEntry,
  recallRelevance,
  recallScore,
  type NpcMemoryEntry,
  type NpcMemorySlice,
} from "../../rules/npc-memory.ts";
import { queryTokens } from "../../knowledge/packet.ts";
import {
  NPC_DEALINGS_ROWS,
  dueLabel,
  exchangesWith,
  openAgreements,
  readExchangesSlice,
  readServicesSlice,
} from "../../rules/exchange.ts";
import type { World } from "../../content/schema.ts";
import { formativeFloor } from "../../rules/formative-memory.ts";
import type { WorldModel } from "../../world/model.ts";

export type { NpcMemoryEntry, NpcMemorySlice };

/** How many of an NPC's most-recent memories to surface in its prompt (bounded recall). */
export const RECALL_LIMIT = 6;

/**
 * The most-recent `limit` memories for one NPC, oldest→newest (read-only copies). Empty when the NPC
 * has no journal. Recall is bounded here (the prompt side) independently of the reducer's storage cap.
 */
export function recallFor(model: WorldModel, npcId: string, limit = RECALL_LIMIT): NpcMemoryEntry[] {
  const journal = (model.modules.npcMemory as Partial<NpcMemorySlice> | undefined)?.entries?.[npcId];
  if (!journal || journal.length === 0) return [];
  return journal.slice(-limit).map(cloneEntry);
}

/**
 * The `limit` journal entries most RELEVANT to a spoken line (epistemic plan §12.1), chronological
 * order, read-only copies. Deterministic and model-free: `recallScore` ranks subject/token/domain
 * hits over salience and recency, so an old betrayal outranks recent small talk when trust is the
 * question. A line that touches NOTHING stored (zero subject/token hits everywhere) degrades to
 * plain recency — exactly `recallFor` — so ordinary chatter keeps today's behavior.
 */
export function recallForQuery(
  model: WorldModel,
  npcId: string,
  query: string,
  limit = RECALL_LIMIT,
): NpcMemoryEntry[] {
  const journal = (model.modules.npcMemory as Partial<NpcMemorySlice> | undefined)?.entries?.[npcId];
  if (!journal || journal.length === 0) return [];
  const tokens = queryTokens(query);
  const scored = journal.map((entry, index) => ({
    entry,
    index,
    score: recallScore(entry, tokens, model.clock),
    // Relevance alone (subject/token hits, no salience/recency floor) decides whether the QUERY
    // selected anything — when no entry matched, recency wins wholesale (today's behavior).
    relevant: recallRelevance(entry, tokens) > 0,
  }));
  if (!scored.some((s) => s.relevant)) return journal.slice(-limit).map(cloneEntry);
  return scored
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at || b.index - a.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((s) => cloneEntry(s.entry));
}

/** The code-owned dealings/custody ledger rows that ride every remembered-things block (r8). */
function ledgerLines(model: WorldModel, npcId: string): string[] {
  const lines: string[] = [];
  // Dealings with THIS player ride the same remembered-things block (r8): a vendor who sold the
  // lantern an hour ago, or who is holding the rapier they were paid to dress, must never shrug
  // at either. Code-owned rows from the exchange ledger — the NPC phrases them, never disputes them.
  for (const rec of exchangesWith(readExchangesSlice(model.modules), npcId, NPC_DEALINGS_ROWS)) {
    lines.push(`‣ (your ledger with them) ${rec.note}`);
  }
  for (const a of openAgreements(readServicesSlice(model.modules))) {
    if (a.npcId !== npcId || !a.custody) continue;
    lines.push(`‣ (your ledger with them) You hold their ${a.itemName ?? "property"} for ${a.label} — ${dueLabel(a)}; it goes back to them, it is not yours to sell.`);
  }
  return lines;
}

/**
 * The derived formative beats for an NPC, or none.
 *
 * Gated on the world's `formativeMemories` opt-in and appended BELOW whatever the NPC actually
 * remembers, so lived history always speaks first and a world that has not opted in renders a
 * byte-identical prompt. Nothing here touches the model — see `src/rules/formative-memory.ts`.
 */
function formativeLines(world: World | undefined, npcId: string, realBeats: number): string[] {
  if (world?.formativeMemories !== true) return [];
  const template = world.npcs?.find((n) => n.id === npcId);
  return formativeFloor(world, template, realBeats).map((e) => `‣ ${e.summary}`);
}

/**
 * One NPC's recent memories rendered as prompt bullets for the `# YOU REMEMBER` block, oldest→newest
 * (the `‣` bullet matches the `# RELEVANT LORE` rendering, M4 Part A). EMPTY array when the NPC has
 * no journal, so `npc.ts` omits the whole block ⇒ a memory-less NPC's prompt is byte-identical. The
 * single place recall is turned into prompt text, shared by the dialogue + autonomy modules.
 *
 * `world` is optional and additive: pass it to let a world that opted into formative memories give a
 * barely-met NPC something of its own to remember. Omit it and behavior is exactly as before.
 */
export function renderRecall(
  model: WorldModel,
  npcId: string,
  limit = RECALL_LIMIT,
  world?: World,
): string[] {
  const recalled = recallFor(model, npcId, limit);
  return [
    ...recalled.map((e) => `‣ ${e.summary}`),
    ...formativeLines(world, npcId, recalled.length),
    ...ledgerLines(model, npcId),
  ];
}

/**
 * Query-aware sibling of {@link renderRecall} for DIRECT REPLIES: the remembered beats most
 * relevant to the player's actual line (plus the same non-negotiable dealings ledger). Same shape,
 * same bullet, same omit-when-empty contract.
 */
export function renderRecallForQuery(
  model: WorldModel,
  npcId: string,
  query: string,
  limit = RECALL_LIMIT,
  world?: World,
): string[] {
  const recalled = recallForQuery(model, npcId, query, limit);
  return [
    ...recalled.map((e) => `‣ ${e.summary}`),
    ...formativeLines(world, npcId, recalled.length),
    ...ledgerLines(model, npcId),
  ];
}
