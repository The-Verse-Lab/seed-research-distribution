/**
 * Packet → prompt lines. The composer decided WHAT is speakable; this renders it into the two
 * reply-brief blocks (`# ANSWER FACTS`, `# WHAT YOU WILL NOT DISCLOSE`) with the temporal
 * qualifiers spelled out, so the model can phrase naturally but cannot promote history to now.
 *
 * @author Runkai Zhang
 */
import type { NpcEpistemicPacket } from "./types.ts";

export interface RenderedEpistemicBlocks {
  /** Body of `# ANSWER FACTS` (bullets + the timeframe rule). Empty ⇒ omit the block entirely. */
  answerFacts: string[];
  /** Body of `# WHAT YOU WILL NOT DISCLOSE`. Empty ⇒ omit. */
  disclosure: string[];
  /**
   * Handle → canonical fact id for the `[F#]` tags on ANSWER FACTS lines (epistemic plan §13.3).
   * The structured intent's `factsUsed` names these handles (a CLOSED list — anything else is
   * dropped), which is what lets code know which canonical facts were actually voiced without
   * trusting free prose. Only canonical world facts get handles; projections and personal
   * knowledge cannot be "learned" by listeners, so they carry none.
   */
  factHandles: Record<string, string>;
}

/** Render the packet into prompt-ready lines. Deterministic; empty sections render nothing. */
export function renderEpistemicBlocks(packet: NpcEpistemicPacket): RenderedEpistemicBlocks {
  const answerFacts: string[] = [];
  const factHandles: Record<string, string> = {};
  const canonical = new Set(packet.factIds);
  let handleSeq = 0;
  const tag = (id: string): string => {
    if (!canonical.has(id)) return "";
    handleSeq += 1;
    const handle = `F${handleSeq}`;
    factHandles[handle] = id;
    return `[${handle}] `;
  };
  const historicalAsk = packet.request?.timeframe === "historical";

  for (const line of packet.authoritative) {
    answerFacts.push(`- ${tag(line.id)}${line.text}`);
  }
  for (const line of packet.history) {
    // For a current ask these are trailing color; for a historical ask the "history" section
    // holds the CURRENT successors, offered only as contrast.
    answerFacts.push(
      historicalAsk
        ? `- ${tag(line.id)}(today, for contrast: ${line.text})`
        : `- ${tag(line.id)}(no longer true — history only: ${line.text})`,
    );
  }
  for (const line of packet.beliefs) {
    answerFacts.push(`- ${tag(line.id)}(you have only heard this — qualify it if you speak it: ${line.text})`);
  }
  answerFacts.push(...packet.unknowns);

  if (answerFacts.length > 0) {
    answerFacts.push(
      historicalAsk
        ? `The question is about the PAST — answer from what you remember or know of it; today's facts are contrast, not the answer.`
        : `Answer from the facts above, CURRENT first. An unqualified practical question means NOW — never give a "(no longer true)" line as the current answer; history may only follow as color.`,
    );
    if (handleSeq > 0) {
      answerFacts.push(
        `The [F#] tags are internal handles — NEVER speak or write them in your reply; they exist only for the "factsUsed" field of your answer.`,
      );
    }
  }

  return { answerFacts, disclosure: [...packet.disclosureConstraints], factHandles };
}

/**
 * Ground a model's `factsUsed` claims against the closed handle list: accepts `F#` handles or raw
 * fact ids ALREADY in the packet; anything else is dropped (an unlisted id is a hallucination,
 * never a fact). Deduped, packet order not preserved (callers treat it as a set).
 */
export function groundUsedFactIds(
  raw: readonly string[] | undefined,
  blocks: RenderedEpistemicBlocks,
  packetFactIds: readonly string[],
): string[] {
  if (!raw || raw.length === 0) return [];
  const canonical = new Set(packetFactIds);
  const out = new Set<string>();
  for (const token of raw) {
    const t = token.trim().replace(/^\[|\]$/g, "");
    const viaHandle = blocks.factHandles[t] ?? blocks.factHandles[t.toUpperCase()];
    if (viaHandle) out.add(viaHandle);
    else if (canonical.has(t)) out.add(t);
  }
  return [...out];
}
