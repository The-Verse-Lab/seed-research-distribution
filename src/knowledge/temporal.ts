/**
 * Temporal resolution — which facts may ANSWER the asked timeframe, and which are only history
 * (NPC-EPISTEMIC-CONTEXT-PLAN §11). Hard invariants 5–7: an unqualified practical question means
 * NOW; a superseded/ended fact can never be phrased as current; history answers only history.
 *
 * @author Runkai Zhang
 */
import type { WorldFact } from "../content/schema.ts";
import type { KnowledgeTimeframe } from "./types.ts";

/** Is this fact still CURRENT truth? Ended, superseded, or historical/defunct/rumor kinds are not. */
export function isCurrentFact(fact: WorldFact): boolean {
  if (fact.kind !== "current") return false;
  if (fact.supersededBy !== undefined) return false;
  if (fact.validUntil !== undefined) return false;
  return true;
}

/** Is this fact a historical proposition (a thing that WAS true)? Rumors are neither. */
export function isHistoricalFact(fact: WorldFact): boolean {
  if (fact.kind === "historical" || fact.kind === "defunct") return true;
  // A "current"-kind fact that ended or was superseded is history now, whatever it was authored as.
  return fact.kind === "current" && (fact.supersededBy !== undefined || fact.validUntil !== undefined);
}

/**
 * Split candidate facts into ANSWER facts (may satisfy the asked timeframe) and CONTEXT facts
 * (speakable only as clearly-marked history/color after the answer). Rumor-kind facts belong to
 * neither — the caller routes them to the beliefs section, always qualified.
 */
export function selectForTimeframe(
  facts: readonly WorldFact[],
  timeframe: KnowledgeTimeframe,
): { answer: WorldFact[]; context: WorldFact[] } {
  const current = facts.filter(isCurrentFact);
  const historical = facts.filter(isHistoricalFact);
  switch (timeframe) {
    case "current":
      return { answer: current, context: historical };
    case "historical":
      // The current successor may trail a history answer as contrast — never the other way around.
      return { answer: historical, context: current };
    case "any":
      // Unspecified defaults to the current world (hard invariant 5): current facts answer,
      // history remains marked context.
      return { answer: current, context: historical };
  }
}
