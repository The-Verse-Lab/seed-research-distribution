/**
 * Campaign rolling-summary fold (M4 follow-up) — maintain a "story so far".
 *
 * As play proceeds, events scroll out of the narrator's live recent-window and would otherwise be
 * forgotten. This folds the scrolled-out events into a single, capped, natural-language summary the
 * brief carries forward (see `src/agents/context.ts` `# STORY SO FAR`), so a long campaign keeps its
 * through-line. The mechanical half (gating, which events, the cursor, persistence) lives in the
 * engine; this is the prose half.
 *
 * THE critical architectural posture: the summary is LLM-generated ⇒ non-deterministic ⇒ it is NOT
 * source-of-truth and never enters the `WorldModel`/reducer/deltas/snapshot/event-log (that would
 * break the `snapshot==fold(deltas)` replay invariant). It is a best-effort, regenerated derived
 * cache — exactly the posture of the M4 vector cache: persisted separately, loaded into the brief,
 * never authoritative.
 *
 * Generation flows through the GUARDED `narrator` role, so the summary is minor-safety-screened for
 * free (it can echo played content). On ANY failure (a safety block, an empty reply, a thrown error)
 * it falls back to the deterministic `buildDigest` floor — which is pure, so failure paths reproduce
 * it and tests can assert on it. `foldCampaignSummary` NEVER throws.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../llm/gateway.ts";

export interface FoldInput {
  /** The running summary before this fold (empty on the first fold). */
  prevSummary: string;
  /** Every batch event rendered as a transcript line (incl. dice) — the LLM's raw material. */
  batchLines: string[];
  /** The de-noised subset (narration/dialogue/state changes, no dice) — the deterministic floor's material. */
  digestLines: string[];
  /** Hard word budget for the resulting summary (both LLM and floor paths honor it). */
  maxWords: number;
}

/** Keep the last `maxWords` words (recency-biased), marking the elision so it reads as a continuation. */
export function capWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return "… " + words.slice(words.length - maxWords).join(" ");
}

/** Strip a transcript line's leading state-change marker so the digest reads as prose, not a log. */
function detag(line: string): string {
  return line.replace(/^\[\*\] /, "").trim();
}

/**
 * The deterministic floor: append the new salient lines to the prior summary and cap to the word
 * budget (dropping the oldest words first). Pure — same inputs always yield the same string, so it
 * is the reproducible offline/failure path and the thing tests assert on. No Date.now()/RNG.
 */
export function buildDigest(prevSummary: string, digestLines: string[], maxWords: number): string {
  const parts = [prevSummary.trim(), ...digestLines.map(detag)].filter((s) => s.length > 0);
  return capWords(parts.join(" "), maxWords);
}

export const SUMMARY_SYSTEM_PROMPT = [
  "You are the ARCHIVIST. Maintain a running \"story so far\" for an ongoing tabletop campaign — a",
  "compact account a Game Master skims to recall what has happened. You are given the PREVIOUS",
  "summary and the NEWER events that have since scrolled out of immediate memory.",
  "",
  "Hard requirements:",
  "- Merge the two into ONE updated summary. Be terse and factual; third person, past tense.",
  "- PRESERVE durable facts: who did what, deaths/defeats, places reached, quests advanced or",
  "  completed, promises/decisions made, and shifts in who trusts whom. DROP idle chatter and dice noise.",
  "- Invent nothing absent from the inputs. Do not address the player. No preamble, headers, or labels.",
  "Output only the updated summary prose.",
].join("\n");

export function buildSummaryMessage(input: FoldInput): string {
  return [
    "# PREVIOUS SUMMARY",
    input.prevSummary.trim() || "(none yet — this is the opening of the chronicle)",
    "",
    "# NEWER EVENTS (oldest first)",
    input.batchLines.join("\n") || "(none)",
    "",
    `Rewrite both into a single updated summary of at most ${input.maxWords} words.`,
  ].join("\n");
}

/**
 * Fold newer events into the running summary; the deterministic digest is the guaranteed floor
 * (blocked, empty, or thrown all return it). Never throws. Generated via the GUARDED
 * `narrator` role so the summary is minor-safety-screened. The model's own output is defensively
 * word-capped too, so the brief can't grow unbounded.
 */
export async function foldCampaignSummary(gateway: LlmGateway, input: FoldInput): Promise<string> {
  const digest = buildDigest(input.prevSummary, input.digestLines, input.maxWords);
  try {
    const res = await gateway.complete("narrator", {
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: buildSummaryMessage(input) },
      ],
      temperature: 0.3,
      maxTokens: input.maxWords * 2,
    });
    // Regex audit §10a (2026-07-28): this used to ALSO drop the reply when `res.model` started with
    // "offline" — product code sniffing for the test gateway by model-id prefix. Reproduced: a
    // self-hoster whose LM Studio tag reads "offline-llama-3-8b" got the digest ("a b") instead of
    // their model's summary on every fold, forever, silently. Only the two structural signals a
    // gateway really reports decide now: a guard block, or nothing said at all.
    if (res.blocked || !res.text.trim()) return digest;
    return capWords(res.text.trim(), input.maxWords);
  } catch {
    return digest;
  }
}
