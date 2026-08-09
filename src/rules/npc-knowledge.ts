/**
 * Runtime learned knowledge — the per-NPC record of canonical world facts learned DURING play
 * (NPC-EPISTEMIC-CONTEXT-PLAN §7.6/§12.3). The authored layer says what a character starts
 * knowing; this slice is what the world taught them since: a fact witnessed, told, or overheard,
 * with source and certainty retained.
 *
 * Same discipline as the npc-memory journal (the canonical template): mutable state on the
 * `WorldModel`, written ONLY by the reducer's `learnFact` command, absolute-post-state deltas, so
 * `snapshot == fold(deltas)` holds and a rewind discards exactly the learning of the discarded
 * tail. Model prose can never write this slice — only code-owned hooks (a spoken packet fact a
 * co-located listener witnessed, an authored reveal) enqueue the command.
 *
 * @author Runkai Zhang
 */

export type LearnedCertainty = "rumor" | "uncertain" | "confident" | "certain";
export type LearnedSourceKind = "witnessed" | "told" | "rumor" | "inferred";

/** One learned canonical fact. `learnedAt` is `model.clock` (deterministic; never Date.now()). */
export interface NpcLearnedFact {
  factId: string;
  certainty: LearnedCertainty;
  sourceKind: LearnedSourceKind;
  /** Who/what taught it (speaker entity id, event id) — provenance, never rendered raw. */
  sourceId?: string;
  learnedAt: number;
}

/** The slice at `model.modules.npcKnowledge`: per-NPC id → factId → learned record. */
export interface NpcKnowledgeSlice {
  learned: Record<string, Record<string, NpcLearnedFact>>;
}

export function defaultNpcKnowledgeSlice(): NpcKnowledgeSlice {
  return { learned: {} };
}

/** Per-NPC bound on learned facts — drop the OLDEST (then lowest-certainty) beyond this. */
export const NPC_LEARNED_CAP = 64;

const CERTAINTY_RANK: Record<LearnedCertainty, number> = {
  rumor: 0,
  uncertain: 1,
  confident: 2,
  certain: 3,
};

/** Does `next` upgrade `prev`? Re-learning only ever RAISES certainty; it never downgrades. */
export function certaintyUpgrades(prev: LearnedCertainty, next: LearnedCertainty): boolean {
  return CERTAINTY_RANK[next] > CERTAINTY_RANK[prev];
}

export function cloneLearned(f: NpcLearnedFact): NpcLearnedFact {
  return {
    factId: f.factId,
    certainty: f.certainty,
    sourceKind: f.sourceKind,
    ...(f.sourceId !== undefined ? { sourceId: f.sourceId } : {}),
    learnedAt: f.learnedAt,
  };
}

/**
 * Cap one NPC's learned map to `cap` records: keep the newest (`learnedAt` desc), breaking ties
 * toward higher certainty, then factId asc — deterministic, applied ONLY in the reducer so the
 * delta carries the absolute post-cap map and replay never re-derives it.
 */
export function capLearned(
  learned: Record<string, NpcLearnedFact>,
  cap = NPC_LEARNED_CAP,
): Record<string, NpcLearnedFact> {
  const entries = Object.values(learned);
  if (entries.length <= cap) return learned;
  const kept = entries.sort(
    (a, b) =>
      b.learnedAt - a.learnedAt ||
      CERTAINTY_RANK[b.certainty] - CERTAINTY_RANK[a.certainty] ||
      (a.factId < b.factId ? -1 : 1),
  ).slice(0, cap);
  return Object.fromEntries(kept.map((f) => [f.factId, f]));
}

/** Read-only copies of one NPC's learned facts (empty for an untaught NPC). */
export function readLearnedFacts(
  modules: Record<string, unknown> | undefined,
  npcId: string,
): Record<string, NpcLearnedFact> {
  const slice = modules?.npcKnowledge as Partial<NpcKnowledgeSlice> | undefined;
  const own = slice?.learned?.[npcId];
  if (!own) return {};
  return Object.fromEntries(Object.entries(own).map(([id, f]) => [id, cloneLearned(f)]));
}
