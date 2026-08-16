import type { ResearchWorldCommand } from "./commands";
import type {
  ResearchEnterEvent,
  ResearchEventCondition,
  ResearchEventEffect,
  ResearchWorldDefinition,
} from "./schema";
import type { ResearchWorldState } from "./state";

export function researchEventConditionMatches(
  condition: ResearchEventCondition,
  state: ResearchWorldState,
): boolean {
  switch (condition.kind) {
    case "atLocation":
      return state.locationId === condition.locationId;
    case "questState":
      return state.quests[condition.questId] === condition.state;
    case "hasItem":
      return state.entities[condition.entityId]?.inventory.includes(condition.itemId) ?? false;
    case "factKnown":
      return state.playerKnownFactIds.includes(condition.factId);
  }
}

/** Select in authored array order against exactly one caller-provided snapshot. */
export function matchingResearchEnterEvents(
  definition: ResearchWorldDefinition,
  postMovePreEffectState: ResearchWorldState,
): ResearchEnterEvent[] {
  const alreadyFired = new Set(postMovePreEffectState.firedEventIds);
  return definition.events.filter(
    (event) =>
      !alreadyFired.has(event.id) &&
      event.trigger.allOf.every((condition) => researchEventConditionMatches(condition, postMovePreEffectState)),
  );
}

export function researchEventEffectCommand(
  effect: ResearchEventEffect,
  definition: ResearchWorldDefinition,
): ResearchWorldCommand {
  switch (effect.kind) {
    case "discloseFacts":
      return { kind: "discloseFacts", factIds: [...effect.factIds] };
    case "transferItem":
      return { ...effect };
    case "setExitState":
      return { ...effect };
    case "setQuestState":
      return { ...effect };
    case "setObjective":
      return { ...effect };
    case "revealCaseEvidence":
      return { ...effect };
    case "resolveCase": {
      const caseDefinition = definition.cases.find((entry) => entry.id === effect.caseId);
      if (!caseDefinition) throw new Error(`Event effect names unknown case "${effect.caseId}"`);
      return effect.status === "solved"
        ? {
            ...effect,
            suspectId: caseDefinition.culpritId,
            citedEvidenceFactIds: [...caseDefinition.requiredEvidenceFactIds],
          }
        : { ...effect };
    }
    case "advanceClock":
      return { ...effect };
  }
}
