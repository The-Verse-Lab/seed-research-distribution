/**
 * NPC memory — the per-NPC journal value types, default, and bound (M4, Part B).
 *
 * The stateful half of the memory rebuild (Part A was read-only lore RAG, `src/memory/`). During
 * play the world records salient, *deterministic* beats for each NPC ("the player spoke to me", "a
 * quest resolved"); on its next reply/decide those memories are woven into the NPC's prompt so it
 * speaks as something that remembers. Because this is MUTABLE state it lives on the `WorldModel`
 * and flows through the reducer as typed, replayable deltas. This file is the math-leaf sibling:
 * pure value types plus the single source of
 * the slice default and the journal bound. No IO, no model, no RNG, no wall-clock — recorded state
 * must be fully deterministic so `snapshot == fold(deltas)` holds (replay reproduces it byte-for-byte).
 *
 * Why summaries are engine-authored: a stored line becomes prompt content next turn, and replay
 * must be reproducible, so the journal holds deterministic templated strings the engine writes
 * (`Spoke with ${name}.`), NEVER LLM prose or raw verbatim player text. `entry.at` is `model.clock`
 * (already in the model, deterministic), never `Date.now()`.
 *
 * @author Runkai Zhang
 */

/** One recorded beat in an NPC's journal. `at` is `model.clock` at the time of recording. */
export interface NpcMemoryEntry {
  /** The world clock when the beat was recorded (deterministic; never Date.now()). */
  at: number;
  /** A coarse beat tag (e.g. "addressed", "questResolved") for grouping/extension. */
  kind: string;
  /** The deterministic, engine-templated one-line summary woven back into the NPC's prompt. */
  summary: string;
  // --- Optional recall metadata (epistemic plan §7.7, all additive): legacy entries without any
  //     of these still rank by summary tokens + salience + recency. Every field is engine-authored
  //     at record time — deterministic, replay-safe, never model prose.
  /** Entity/location/faction ids this beat is ABOUT (query subject matching). */
  subjectIds?: string[];
  /** Where it happened. */
  locationId?: string;
  /** Retrieval topics ("trust", "trade") — same free vocabulary as world-fact domains. */
  domains?: string[];
  /** Canonical world facts this beat evidences. */
  factIds?: string[];
  /** Author/engine emphasis added straight into the recall score (rarely needed; default 0). */
  importance?: number;
}

/**
 * The full runtime slice stored at `model.modules.npcMemory`: per-NPC id → that NPC's journal.
 * Declared ONCE here, alongside its value type, so it is the single shape shared by the mutable
 * world-layer accessor (the reducer/replay writer, `src/world/module-slices.ts npcMemorySlice`) and
 * the copy-returning reader (`src/modules/npc-memory/state.ts readNpcMemory`). Both build a typed
 * `NpcMemorySlice` literal, so adding a field is a compile error in every accessor rather than a
 * silent `snapshot == fold(deltas)` divergence (the replay invariant this rebuild exists to protect).
 */
export interface NpcMemorySlice {
  /** Per-NPC journal, keyed by entity id. Absent key ⇒ no memories (rendered as nothing). */
  entries: Record<string, NpcMemoryEntry[]>;
}

/** A fresh, empty memory slice — the single source of the slice's default value. */
export function defaultNpcMemorySlice(): NpcMemorySlice {
  return { entries: {} };
}

/**
 * The per-NPC journal cap (bounded memory; drop oldest beyond this). SINGLE SOURCE — applied ONLY
 * in the reducer's `recordNpcMemory` case, so the truncation logic lives in exactly one place and
 * replay never re-derives it (the delta carries the absolute post-cap list, which replay overwrites
 * verbatim). 24 is a few dozen beats — enough to feel like a memory, small enough to stay cheap and
 * bounded in the prompt.
 */
export const NPC_MEMORY_CAP = 24;

/** Deep-copy one journal entry (defensive — keeps callers from mutating live model state).
 *  MUST copy every optional metadata field too, or the replay fold would silently drop them and
 *  `snapshot == fold(deltas)` diverges on the first metadata-bearing beat. */
export function cloneEntry(e: NpcMemoryEntry): NpcMemoryEntry {
  return {
    at: e.at,
    kind: e.kind,
    summary: e.summary,
    ...(e.subjectIds ? { subjectIds: [...e.subjectIds] } : {}),
    ...(e.locationId !== undefined ? { locationId: e.locationId } : {}),
    ...(e.domains ? { domains: [...e.domains] } : {}),
    ...(e.factIds ? { factIds: [...e.factIds] } : {}),
    ...(e.importance !== undefined ? { importance: e.importance } : {}),
  };
}

/**
 * Per-kind retention weight — higher survives the cap longer. A pure function of the entry's `kind`
 * alone (deterministic; no RNG/clock), so `capJournal` and thus the reducer/replay stay reproducible.
 * `questResolved` (a story turning point) ranks highest; `attireObserved` (witnessing a notable attire
 * disheveled) ranks just under it — a vivid, specific memory; `relationship`/`addressed` (social
 * beats) mid; bulk `traveled` movement lowest. An UNKNOWN/future kind gets a mid default
 * deliberately ABOVE `traveled`, so a new beat type is never treated as the most-disposable noise
 * before it's tuned.
 */
export function salience(entry: NpcMemoryEntry): number {
  switch (entry.kind) {
    case "questResolved":
      return 100;
    case "attireObserved":
      return 55;
    case "relationship":
    case "addressed":
      return 50;
    case "traveled":
      return 10;
    default:
      return 30; // unknown kinds: mid, above `traveled`
  }
}

/**
 * Query-aware recall scoring (epistemic plan §12.1): retention (what survives the cap) and recall
 * (what enters THIS prompt) solve different problems — a salient old betrayal can sit stored for
 * weeks while six newer traveled beats fill the recency window. This scorer ranks stored entries
 * against the player's actual line, deterministically and model-free:
 *
 *   score = 3·subject-hit + 2·token-hits + salience/25 + importance + recency tier (0..2)
 *
 * Legacy entries (no metadata) still rank — their summary text carries the tokens. Callers pass
 * pre-tokenized query terms so one line tokenizes once across a journal.
 */
export function recallRelevance(entry: NpcMemoryEntry, queryTokens: ReadonlySet<string>): number {
  let tokenHits = 0;
  for (const raw of `${entry.summary} ${(entry.domains ?? []).join(" ")}`.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (queryTokens.has(raw) || (raw.length >= 4 && raw.endsWith("s") && queryTokens.has(raw.slice(0, -1)))) {
      tokenHits += 1;
    }
  }
  // Subject ids match by their name-ish tail token ("npc.osric" → "osric") — the way a spoken line
  // actually names people. A full-id hit (rare in prose) counts too.
  let subjectHit = 0;
  for (const id of entry.subjectIds ?? []) {
    const tail = id.split(".").at(-1) ?? id;
    if (queryTokens.has(tail.toLowerCase()) || queryTokens.has(id.toLowerCase())) subjectHit = 1;
  }
  return 3 * subjectHit + 2 * tokenHits;
}

export function recallScore(entry: NpcMemoryEntry, queryTokens: ReadonlySet<string>, nowClock: number): number {
  const ageMinutes = Math.max(0, nowClock - entry.at);
  const recency = ageMinutes <= 240 ? 2 : ageMinutes <= 1440 ? 1 : 0;
  return recallRelevance(entry, queryTokens) + salience(entry) / 25 + (entry.importance ?? 0) + recency;
}

/**
 * Cap a journal to `cap` entries. When over, keep the `cap` HIGHEST-salience beats (ties broken by
 * recency: later `at`, then later original position), and return the kept set in its ORIGINAL
 * (chronological) order — so `recallFor`'s `slice(-limit)` still surfaces the most recent ones and
 * storage stays append-ordered. Under (or at) cap the input array is returned unchanged.
 *
 * Deterministic: a pure function of (`journal`, `cap`) — no RNG, no wall-clock, only entries' own
 * `at` (plus stable original index as the final tiebreak). The result length is exactly
 * `min(journal.length, cap)`. When every entry shares a salience (e.g. all `traveled`), the recency
 * tiebreak makes this degrade to FIFO drop-oldest — the prior behaviour.
 */
export function capJournal(journal: NpcMemoryEntry[], cap = NPC_MEMORY_CAP): NpcMemoryEntry[] {
  if (journal.length <= cap) return journal;
  const ranked = journal
    .map((entry, index) => ({ entry, index }))
    // Most-worth-keeping first: salience desc, then more-recent (at desc), then later index desc.
    .sort((a, b) => {
      const bySalience = salience(b.entry) - salience(a.entry);
      if (bySalience !== 0) return bySalience;
      const byAt = b.entry.at - a.entry.at;
      if (byAt !== 0) return byAt;
      return b.index - a.index;
    });
  // Keep the top `cap`, then restore chronological (original-index) order for storage.
  return ranked
    .slice(0, cap)
    .sort((a, b) => a.index - b.index)
    .map((r) => r.entry);
}
