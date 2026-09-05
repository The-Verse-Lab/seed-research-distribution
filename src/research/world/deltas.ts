import type { ResearchExitState, ResearchQuestState } from "./schema";
import type { ResearchCaseState, ResearchWorldState } from "./state";
import { researchExitKey } from "./state";

export type ResearchWorldDelta =
  | { kind: "entityMoved"; entityId: string; from: string | null; to: string | null }
  | { kind: "playerFactsChanged"; before: string[]; after: string[] }
  | { kind: "inventoryChanged"; entityId: string; before: string[]; after: string[] }
  | {
      kind: "exitStateChanged";
      locationId: string;
      to: string;
      before: ResearchExitState;
      after: ResearchExitState;
    }
  | { kind: "questStateChanged"; questId: string; before: ResearchQuestState; after: ResearchQuestState }
  | { kind: "objectiveChanged"; questId: string; objectiveId: string; before: boolean; after: boolean }
  | { kind: "caseEvidenceChanged"; caseId: string; before: string[]; after: string[] }
  | {
      kind: "caseStatusChanged";
      caseId: string;
      before: ResearchCaseState["status"];
      after: ResearchCaseState["status"];
    }
  | { kind: "clockAdvanced"; by: number; before: number; after: number }
  | { kind: "eventMarked"; eventId: string };

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mismatch(delta: ResearchWorldDelta, message: string): never {
  throw new Error(`Cannot replay ${delta.kind}: ${message}`);
}

/** Strict in-place fold primitive shared by the command reducer and replay API. */
export function applyResearchDeltaInPlace(state: ResearchWorldState, delta: ResearchWorldDelta): void {
  switch (delta.kind) {
    case "entityMoved": {
      const entity = state.entities[delta.entityId];
      if (!entity) mismatch(delta, `entity "${delta.entityId}" is missing`);
      if (entity.locationId !== delta.from) mismatch(delta, "entity location does not match delta.before");
      if (delta.entityId === state.playerId) {
        if (delta.to === null) mismatch(delta, "player cannot move to null");
        state.locationId = delta.to;
      }
      entity.locationId = delta.to;
      return;
    }
    case "playerFactsChanged":
      if (!sameStrings(state.playerKnownFactIds, delta.before)) mismatch(delta, "fact ledger does not match delta.before");
      state.playerKnownFactIds = [...delta.after];
      return;
    case "inventoryChanged": {
      const entity = state.entities[delta.entityId];
      if (!entity) mismatch(delta, `entity "${delta.entityId}" is missing`);
      if (!sameStrings(entity.inventory, delta.before)) mismatch(delta, "inventory does not match delta.before");
      entity.inventory = [...delta.after];
      return;
    }
    case "exitStateChanged": {
      const key = researchExitKey(delta.locationId, delta.to);
      if (state.exitStates[key] !== delta.before) mismatch(delta, "exit state does not match delta.before");
      state.exitStates[key] = delta.after;
      return;
    }
    case "questStateChanged":
      if (state.quests[delta.questId] !== delta.before) mismatch(delta, "quest state does not match delta.before");
      state.quests[delta.questId] = delta.after;
      return;
    case "objectiveChanged": {
      const questObjectives = state.objectives[delta.questId];
      if (!questObjectives || questObjectives[delta.objectiveId] !== delta.before) {
        mismatch(delta, "objective does not match delta.before");
      }
      questObjectives[delta.objectiveId] = delta.after;
      return;
    }
    case "caseEvidenceChanged": {
      const caseState = state.cases[delta.caseId];
      if (!caseState) mismatch(delta, `case "${delta.caseId}" is missing`);
      if (!sameStrings(caseState.evidenceFactIds, delta.before)) mismatch(delta, "case evidence does not match delta.before");
      caseState.evidenceFactIds = [...delta.after];
      return;
    }
    case "caseStatusChanged": {
      const caseState = state.cases[delta.caseId];
      if (!caseState) mismatch(delta, `case "${delta.caseId}" is missing`);
      if (caseState.status !== delta.before) mismatch(delta, "case status does not match delta.before");
      caseState.status = delta.after;
      return;
    }
    case "clockAdvanced":
      if (state.clock !== delta.before) mismatch(delta, "clock does not match delta.before");
      if (delta.by < 0 || delta.before + delta.by !== delta.after) mismatch(delta, "clock arithmetic is invalid");
      state.clock = delta.after;
      return;
    case "eventMarked":
      if (state.firedEventIds.includes(delta.eventId)) mismatch(delta, `event "${delta.eventId}" is already marked`);
      state.firedEventIds.push(delta.eventId);
      return;
  }
}
