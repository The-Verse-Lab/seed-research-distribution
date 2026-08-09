/**
 * Per-NPC derived history (statefulness #2 + #3, owner decision 2026-07-06) — the "what we've discussed"
 * memory an NPC recalls, consolidated at a long rest (sleep consolidation).
 *
 * THE architectural posture (identical to the campaign rolling summary, `src/memory/summary.ts`): this is
 * BEST-EFFORT, LLM-generated, and lives OUTSIDE the WorldModel / reducer / deltas / snapshot / event-log —
 * so the `snapshot == fold(deltas)` replay invariant is untouched. It is a regenerated derived cache, never
 * source of truth. The deterministic `npcMemory` slice (M4 Part B) keeps its templated mechanical beats; this
 * is the SEMANTIC, model-written layer alongside it.
 *
 * Two tiers, so cost lands where it's cheap:
 *  - DURING the day, a cheap UTILITY-role 1-line GIST of each addressed exchange accrues in the NPC's
 *    day-buffer (`extractGist` → `pushGist`), injected as `# RECENTLY WITH YOU`.
 *  - At a LONG REST, the day-buffer folds into a capped rolling `# OUR HISTORY` (`foldNpcHistory`) and
 *    clears — so the next day the NPC wakes already remembering yesterday. The fold is rare (once per
 *    in-world day), so it can be lavish; the re-injected result stays small (word-capped).
 *
 * Every model call degrades to a deterministic floor (blocked / empty / thrown) and NEVER throws.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../llm/gateway.ts";
import { capWords } from "./summary.ts";

/** One NPC's derived memory: the consolidated history + the current (unconsolidated) day-buffer of gists. */
export interface NpcHistory {
  /** The rolling, capped "our history so far" — folded at each long rest. Empty until the first fold. */
  history: string;
  /** This day's 1-line gists, oldest→newest, capped — folded into `history` at the next long rest. */
  dayGists: string[];
}

/** How many recent gists to keep per NPC in the day-buffer (keeps the per-turn injection lean). */
export const NPC_GIST_CAP = 6;
/** Word budget for the consolidated per-NPC history (re-injected every reply, so kept small). */
export const NPC_HISTORY_MAX_WORDS = 150;

/** A fresh, empty per-NPC history — the single source of the default value. */
export function defaultNpcHistory(): NpcHistory {
  return { history: "", dayGists: [] };
}

/** Append a gist to the day-buffer, capped to the most-recent {@link NPC_GIST_CAP} (blank ⇒ unchanged). Pure. */
export function pushGist(h: NpcHistory, gist: string): NpcHistory {
  const g = gist.trim();
  if (!g) return h;
  return { history: h.history, dayGists: [...h.dayGists, g].slice(-NPC_GIST_CAP) };
}

/**
 * The prompt block an NPC sees: its consolidated `# OUR HISTORY` plus today's fresh gists. Returns an
 * EMPTY array when the NPC has neither (so a memory-less NPC's prompt is byte-identical). Rendered as `‣`
 * bullets to match the `# RELEVANT LORE` / `# YOU REMEMBER` conventions.
 */
export function renderHistoryBlock(h: NpcHistory | undefined): string[] {
  if (!h) return [];
  const out: string[] = [];
  if (h.history.trim()) out.push(`# OUR HISTORY`, `‣ ${h.history.trim()}`, ``);
  if (h.dayGists.length > 0) out.push(`# RECENTLY WITH YOU`, ...h.dayGists.map((g) => `‣ ${g}`), ``);
  return out;
}

export const GIST_SYSTEM_PROMPT = [
  "You compress ONE exchange between a player and an NPC into a single terse note the NPC would remember —",
  "the topic and the NPC's own stance or answer, third person, past tense, at most 20 words.",
  "State only what was actually said. No preamble, labels, or quotes. Output the one line only.",
].join("\n");

/**
 * A 1-line gist of one addressed exchange, from the NPC's point of view. Best-effort on the UTILITY role
 * (cheap); returns "" on blocked / empty / error, so the caller simply records nothing.
 */
export async function extractGist(
  gateway: LlmGateway,
  input: { npcName: string; playerLine: string; npcReply: string },
): Promise<string> {
  try {
    const res = await gateway.complete("utility", {
      messages: [
        { role: "system", content: GIST_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `NPC: ${input.npcName}\n` +
            `Player said: "${input.playerLine}"\n` +
            `${input.npcName} replied: "${input.npcReply}"\n\n` +
            `One-line note ${input.npcName} would remember:`,
        },
      ],
      temperature: 0.2,
      maxTokens: 60,
    });
    // Regex audit §10a: the model-id prefix sniff is gone — see the note in summary.ts. Reproduced
    // here too: with an "offline-llama-3-8b" tag `extractGist` returned "" for every exchange, so
    // the NPC journal never recorded a word.
    if (res.blocked || !res.text.trim()) return "";
    // The prompt says "no quotes", so a model that adds them anyway is peeled here. The class used
    // to be `["']` only — reproduced: a model that answers in SMART quotes (`“He asked about the
    // ledger; she refused.”`, which is what a model writing prose emits) kept BOTH marks, and the
    // NPC's own `# RECENTLY WITH YOU` bullet read `‣ “He asked about the ledger; she refused.”`.
    // Curly quotes, guillemets and markdown emphasis join the peel. Edges only — never interior.
    return res.text
      .trim()
      .replace(/^["'“”‘’«»*_]+|["'“”‘’«»*_]+$/gu, "")
      .split("\n")[0]!
      .slice(0, 200);
  } catch {
    return "";
  }
}

export const FOLD_SYSTEM_PROMPT = [
  "You maintain an NPC's private running memory of ONE person (the player). Merge the PRIOR memory with",
  "TODAY'S notes into one updated memory — third person, past tense, terse and factual. Preserve durable",
  "facts (what was discussed, promises made, shifts in how the NPC regards the player) and drop idle",
  "repetition. Invent nothing absent from the inputs. No preamble or labels. Output only the memory prose.",
].join("\n");

/** The deterministic floor: prior history + today's gists, capped (dropping oldest words first). Pure. */
export function foldNpcHistoryFloor(prevHistory: string, gists: string[], maxWords: number): string {
  const parts = [prevHistory.trim(), ...gists.map((g) => g.trim())].filter((s) => s.length > 0);
  return capWords(parts.join(" "), maxWords);
}

/**
 * Fold the day-buffer into the NPC's rolling history (the sleep-consolidation step). LLM on the UTILITY
 * role with the deterministic floor as the guaranteed fallback. Never throws. Word-capped so the
 * re-injected block stays small. No gists ⇒ the prior history is returned unchanged (no model call).
 */
export async function foldNpcHistory(
  gateway: LlmGateway,
  input: { prevHistory: string; gists: string[]; maxWords: number },
): Promise<string> {
  if (input.gists.length === 0) return input.prevHistory.trim();
  const floor = foldNpcHistoryFloor(input.prevHistory, input.gists, input.maxWords);
  try {
    const res = await gateway.complete("utility", {
      messages: [
        { role: "system", content: FOLD_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `# PRIOR MEMORY\n${input.prevHistory.trim() || "(none yet)"}\n\n` +
            `# TODAY'S NOTES\n${input.gists.join("\n")}\n\n` +
            `Rewrite into one updated memory of at most ${input.maxWords} words.`,
        },
      ],
      temperature: 0.3,
      maxTokens: input.maxWords * 2,
    });
    if (res.blocked || !res.text.trim()) return floor;
    return capWords(res.text.trim(), input.maxWords);
  } catch {
    return floor;
  }
}
