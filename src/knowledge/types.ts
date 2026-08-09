/**
 * Epistemic-context types — the knowledge-request frame and the per-NPC packet
 * (NPC-EPISTEMIC-CONTEXT-PLAN §6.7/§6.8).
 *
 * The classifier supplies the FRAME (what kind of answer the player's spoken line asks for);
 * code in this module selects the facts; the model only phrases them. Nothing here touches
 * world state — the packet is prompt material, composed fresh every turn.
 *
 * @author Runkai Zhang
 */

/** What kind of answer a spoken question requests. Mirrored into the classifier's closed enum. */
export const KNOWLEDGE_ASK_KINDS = [
  "current-location",
  "current-service",
  "current-status",
  "whereabouts",
  "history",
  "explanation",
  "rumor-opinion",
  "general",
] as const;
export type KnowledgeAskKind = (typeof KNOWLEDGE_ASK_KINDS)[number];

export const KNOWLEDGE_TIMEFRAMES = ["current", "historical", "any"] as const;
export type KnowledgeTimeframe = (typeof KNOWLEDGE_TIMEFRAMES)[number];

export const KNOWLEDGE_LOCALITIES = ["here", "nearby", "region", "world", "unspecified"] as const;
export type KnowledgeLocality = (typeof KNOWLEDGE_LOCALITIES)[number];

/**
 * The classifier-owned interpretation of a spoken knowledge request (plan §8). The raw player
 * line remains the semantic query; this frame carries what embeddings cannot infer — requested
 * timeframe, locality, and (when groundable) the subject. Absent/invalid ⇒ the safe default
 * `general`/`any`, under the standing invariant that a historical fact is still never rendered
 * as a current answer.
 */
export interface KnowledgeAsk {
  kind: KnowledgeAskKind;
  timeframe: KnowledgeTimeframe;
  locality: KnowledgeLocality;
  /** Grounded subject entity id (copied from classifier context candidates), or null/absent. */
  subjectId?: string | null;
}

/** Where a packet line's authority comes from. `model` = live runtime projection (highest). */
export type EpistemicSource = "model" | "authored" | "memory" | "belief" | "claim";

/** Temporal class of a packet line, as rendered to the prompt. */
export type EpistemicTemporal = "current" | "historical" | "last-known" | "timeless";

export type EpistemicCertainty = "rumor" | "uncertain" | "confident" | "certain";

/** One selected line of the packet, with provenance kept for traces/tests (never rendered raw). */
export interface EpistemicLine {
  /** Stable id — the fact id, or a synthetic `proj.*`/`pk.*` id for projections/personal entries. */
  id: string;
  text: string;
  source: EpistemicSource;
  temporal: EpistemicTemporal;
  certainty: EpistemicCertainty;
  /** Selection priority (higher wins inside a section). Runtime projections sit on top. */
  authority: number;
}

/**
 * The observer-specific epistemic packet for ONE interaction (plan §6.8, first-slice subset:
 * answer facts, history, beliefs, disclosure constraints, unknowns — scene observation and memory
 * recall keep their existing dedicated blocks until the later phases fold them in).
 */
export interface NpcEpistemicPacket {
  observer: { id: string; name: string };
  request?: KnowledgeAsk;
  /** Facts that may ANSWER the asked timeframe, best first. */
  authoritative: EpistemicLine[];
  /** Historical/superseded context — speakable only as history, never as the current answer. */
  history: EpistemicLine[];
  /** Rumors/uncertain beliefs, always qualified. A false belief is NOT labeled false here. */
  beliefs: EpistemicLine[];
  /** Behavioral concealment cues for relevant-but-withheld knowledge (no secret text). */
  disclosureConstraints: string[];
  /** Explicit "you do not know" lines when a framed question found nothing answerable. */
  unknowns: string[];
  /** Every fact id available in this packet — the closed list for intent fact-id telemetry. */
  factIds: string[];
}
