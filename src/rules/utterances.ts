/**
 * Utterance history — a bounded, per-NPC memory of the lines each NPC most recently SAID, the
 * math-leaf that stops a companion from looping the same words verbatim (playtest W6: a companion
 * repeated one line three times in a row).
 *
 * The math-leaf sibling of the whisper channel (`whispers.ts`): a pure value shape plus the two
 * helpers over the `model.modules.utterances` slice — `isRecentDuplicate` (a normalized-equality
 * read) and `pushUtterance` (the next bounded slice value). The slice is written ONLY by the
 * reducer, via the generic `modulePatch` command the emit sites enqueue with `ctx.applySilent`
 * (replay-safe: `modulePatched` deltas fold with `Object.assign`, and each patch carries the
 * absolute new per-NPC list). Bounded by design: exactly the last {@link MAX_RECENT} lines per NPC
 * (a FIFO ring), so the slice can never grow past the recent-window × the cast that has spoken.
 *
 * The temporal dedup in the autonomy Director (`MIN_DEDUP_MS`) stops an NPC speaking twice within a
 * few seconds; this stops it speaking the SAME words, which the clock alone never catches. The two
 * gates are independent and both stay in force.
 *
 * @author Runkai Zhang
 */

/** The module-slice key under `model.modules` (written via the generic `modulePatch` command). */
export const UTTERANCES_MODULE = "utterances";

/**
 * How many recent lines to remember per NPC. Small on purpose: enough to catch the "looped the
 * exact line" defect without letting a long conversation ever re-say a stock phrase forever.
 */
export const MAX_RECENT = 3;

/**
 * The full runtime slice stored at `model.modules.utterances`: per-NPC id → the NPC's last few
 * SAID lines, oldest-first, capped at {@link MAX_RECENT}. Absent key ⇒ that NPC has not spoken yet.
 */
export type UtterancesSlice = Record<string, string[]>;

/** Wrapper marks an NPC line can arrive dressed in, peeled off both edges before comparison. */
const LEAD_WRAPPER_RE = /^[\s"'“”‘’«»\[(*_—–-]+/u;
const TAIL_WRAPPER_RE = /[\s"'“”‘’«»\])*_]+$/u;
/** Terminal sentence punctuation — the trailing-edge strip that has always been here. */
const TAIL_PUNCT_RE = /[.,!?;:…—–-]+$/u;

/**
 * Normalize a line to its dedup key: lowercase, collapse internal whitespace to single spaces, and
 * peel the EDGES — wrapping quote/bracket/emphasis marks and terminal sentence punctuation — so
 * `"Well met."` and `well met` compare equal. Two lines are "the same words" iff their normalized
 * forms are byte-equal. Pure — no state read.
 *
 * The edge peel used to be the trailing `TAIL_PUNCT_RE` alone, which stops dead on a closing
 * quote: the regex audit reproduced `normalizeUtterance('"Well met."') === '"well met."'` against
 * `normalizeUtterance("Well met.") === "well met"`, so an NPC whose line the pipeline delivered
 * quoted once and bare once was NOT a recent duplicate and said the same words twice — exactly the
 * W6 loop this module exists to stop. `**Well met!**` (a model's markdown emphasis) had the same
 * problem from both edges. The peel alternates lead/tail/punct until stable, because the marks
 * nest (`"Well met."` needs quote-then-period, `**Well met!**` needs asterisks-then-bang).
 *
 * Only the EDGES are touched — interior wording is never rewritten, so two lines that differ in
 * their WORDS always keep different keys and neither is ever wrongly suppressed.
 */
export function normalizeUtterance(line: string): string {
  let key = line.toLowerCase().replace(/\s+/g, " ").trim();
  let prev = "";
  while (key !== prev) {
    prev = key;
    key = key.replace(LEAD_WRAPPER_RE, "").replace(TAIL_WRAPPER_RE, "").replace(TAIL_PUNCT_RE, "").trim();
  }
  return key;
}

/** Read the per-NPC list defensively (the modules bag is `unknown` by contract). */
function recentFor(modules: Record<string, unknown>, npcId: string): string[] {
  const slice = modules[UTTERANCES_MODULE] as UtterancesSlice | undefined;
  const list = slice?.[npcId];
  return Array.isArray(list) ? list : [];
}

/**
 * Whether `candidate` matches (by normalized equality) any of `npcId`'s last {@link MAX_RECENT}
 * lines — the check the emit sites run BEFORE speaking. A blank/whitespace candidate is never a
 * duplicate (there is nothing to suppress). Read-only; the slice is written elsewhere.
 */
export function isRecentDuplicate(
  modules: Record<string, unknown>,
  npcId: string,
  candidate: string,
): boolean {
  const key = normalizeUtterance(candidate);
  if (key.length === 0) return false;
  return recentFor(modules, npcId).some((line) => normalizeUtterance(line) === key);
}

/**
 * The next bounded per-NPC list after `npcId` says `line`: the existing lines with `line` appended,
 * truncated to the most-recent {@link MAX_RECENT} (a FIFO ring — the oldest drops off). Pure: returns
 * the value the caller hands to the `modulePatch` command; it does not mutate the slice. A
 * blank/whitespace line records nothing (returns the list unchanged) — there is nothing to dedup on.
 */
export function pushUtterance(
  modules: Record<string, unknown>,
  npcId: string,
  line: string,
): string[] {
  const existing = recentFor(modules, npcId);
  if (line.trim().length === 0) return existing;
  return [...existing, line].slice(-MAX_RECENT);
}
