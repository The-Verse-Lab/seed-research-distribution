import type { ResearchWorldCommand } from "./commands";
import type { ResearchWorldDelta } from "./deltas";
import { applyResearchDeltaInPlace } from "./deltas";
import type { ResearchWorldDefinition } from "./schema";
import {
  cloneResearchWorldState,
  effectiveResearchExitState,
  findResearchExit,
  sortedUnique,
  type ResearchWorldState,
} from "./state";

export interface ResearchCommandResult {
  accepted: boolean;
  mutated: boolean;
  deltas: ResearchWorldDelta[];
  reasonCode?: string;
  message?: string;
}

function rejected(reasonCode: string, message: string): ResearchCommandResult {
  return { accepted: false, mutated: false, deltas: [], reasonCode, message };
}

function getEntity(state: ResearchWorldState, entityId: string) {
  return state.entities[entityId];
}

/**
 * Reduce one command atomically. Validation and delta construction happen against a clone;
 * only a fully accepted command can mutate the caller's snapshot.
 */
export function applyResearchCommand(
  state: ResearchWorldState,
  definition: ResearchWorldDefinition,
  command: ResearchWorldCommand,
): ResearchCommandResult {
  const staged = cloneResearchWorldState(state);
  const deltas: ResearchWorldDelta[] = [];
  const emit = (delta: ResearchWorldDelta): void => {
    applyResearchDeltaInPlace(staged, delta);
    deltas.push(delta);
  };

  let rejection: ResearchCommandResult | undefined;
  switch (command.kind) {
    case "moveParty": {
      const from = staged.locationId;
      const exit = findResearchExit(definition, from, command.to);
      if (!exit) {
        rejection = rejected("not_adjacent", `No authored exit connects "${from}" to "${command.to}"`);
        break;
      }
      const exitState = effectiveResearchExitState(definition, staged, from, command.to);
      if (exitState !== "open") {
        rejection = rejected("exit_not_open", `Exit "${from}->${command.to}" is ${exitState ?? "missing"}`);
        break;
      }
      for (const entityId of staged.partyEntityIds) {
        const entity = getEntity(staged, entityId);
        if (!entity) {
          rejection = rejected("unknown_party_entity", `Party entity "${entityId}" is missing`);
          break;
        }
        if (entity.locationId === from) {
          emit({ kind: "entityMoved", entityId, from, to: command.to });
        }
      }
      break;
    }
    case "discloseFacts": {
      const authoredFacts = new Set(definition.facts.map((fact) => fact.id));
      const requested = sortedUnique(command.factIds);
      const unknownFact = requested.find((factId) => !authoredFacts.has(factId));
      if (unknownFact) {
        rejection = rejected("unknown_fact", `Fact "${unknownFact}" is not authored`);
        break;
      }
      const after = sortedUnique([...staged.playerKnownFactIds, ...requested]);
      if (after.length !== staged.playerKnownFactIds.length) {
        emit({ kind: "playerFactsChanged", before: [...staged.playerKnownFactIds], after });
      }
      break;
    }
    case "transferItem": {
      if (command.from === null && command.to === null) {
        rejection = rejected("invalid_transfer", "A transfer needs at least one entity endpoint");
        break;
      }
      const from = command.from === null ? undefined : getEntity(staged, command.from);
      const to = command.to === null ? undefined : getEntity(staged, command.to);
      if (command.from !== null && !from) {
        rejection = rejected("unknown_source", `Transfer source "${command.from}" is missing`);
        break;
      }
      if (command.to !== null && !to) {
        rejection = rejected("unknown_destination", `Transfer destination "${command.to}" is missing`);
        break;
      }
      if (from && !from.inventory.includes(command.itemId)) {
        rejection = rejected("item_not_held", `Entity "${command.from}" does not hold "${command.itemId}"`);
        break;
      }
      if (command.from === command.to) break;
      if (from) {
        emit({
          kind: "inventoryChanged",
          entityId: command.from!,
          before: [...from.inventory],
          after: from.inventory.filter((itemId) => itemId !== command.itemId),
        });
      }
      if (to && !to.inventory.includes(command.itemId)) {
        emit({
          kind: "inventoryChanged",
          entityId: command.to!,
          before: [...to.inventory],
          after: sortedUnique([...to.inventory, command.itemId]),
        });
      }
      break;
    }
    case "setExitState": {
      const exit = findResearchExit(definition, command.locationId, command.to);
      if (!exit) {
        rejection = rejected("unknown_exit", `Exit "${command.locationId}->${command.to}" is not authored`);
        break;
      }
      const before = effectiveResearchExitState(definition, staged, command.locationId, command.to);
      if (before === undefined) {
        rejection = rejected("unknown_exit", `Exit "${command.locationId}->${command.to}" is not authored`);
        break;
      }
      if (before !== command.state) {
        emit({
          kind: "exitStateChanged",
          locationId: command.locationId,
          to: command.to,
          before,
          after: command.state,
        });
      }
      break;
    }
    case "setQuestState": {
      const before = staged.quests[command.questId];
      if (before === undefined) {
        rejection = rejected("unknown_quest", `Quest "${command.questId}" is not authored`);
        break;
      }
      if ((before === "complete" || before === "failed") && before !== command.state) {
        rejection = rejected("quest_terminal", `Quest "${command.questId}" is already ${before}`);
        break;
      }
      if (before !== command.state) {
        emit({ kind: "questStateChanged", questId: command.questId, before, after: command.state });
      }
      break;
    }
    case "setObjective": {
      const objectives = staged.objectives[command.questId];
      if (!objectives || objectives[command.objectiveId] === undefined) {
        rejection = rejected(
          "unknown_objective",
          `Objective "${command.questId}:${command.objectiveId}" is not authored`,
        );
        break;
      }
      const before = objectives[command.objectiveId]!;
      if (before !== command.done) {
        emit({
          kind: "objectiveChanged",
          questId: command.questId,
          objectiveId: command.objectiveId,
          before,
          after: command.done,
        });
      }
      break;
    }
    case "revealCaseEvidence": {
      const caseDefinition = definition.cases.find((entry) => entry.id === command.caseId);
      const caseState = staged.cases[command.caseId];
      if (!caseDefinition || !caseState) {
        rejection = rejected("unknown_case", `Case "${command.caseId}" is not authored`);
        break;
      }
      if (!caseDefinition.evidenceFactIds.includes(command.factId)) {
        rejection = rejected("invalid_evidence", `Fact "${command.factId}" is not evidence for case "${command.caseId}"`);
        break;
      }
      if (caseState.status !== "open") {
        rejection = rejected("case_terminal", `Case "${command.caseId}" is already ${caseState.status}`);
        break;
      }
      const after = sortedUnique([...caseState.evidenceFactIds, command.factId]);
      if (after.length !== caseState.evidenceFactIds.length) {
        emit({
          kind: "caseEvidenceChanged",
          caseId: command.caseId,
          before: [...caseState.evidenceFactIds],
          after,
        });
      }
      break;
    }
    case "resolveCase": {
      const caseDefinition = definition.cases.find((entry) => entry.id === command.caseId);
      const caseState = staged.cases[command.caseId];
      if (!caseDefinition || !caseState) {
        rejection = rejected("unknown_case", `Case "${command.caseId}" is not authored`);
        break;
      }
      if (caseState.status !== "open") {
        rejection = rejected("case_terminal", `Case "${command.caseId}" is already ${caseState.status}`);
        break;
      }
      if (command.status === "solved") {
        if (command.suspectId !== caseDefinition.culpritId) {
          rejection = rejected("wrong_suspect", `Suspect does not solve case "${command.caseId}"`);
          break;
        }
        const cited = new Set(command.citedEvidenceFactIds ?? []);
        const recorded = new Set(caseState.evidenceFactIds);
        const known = new Set(staged.playerKnownFactIds);
        const missing = caseDefinition.requiredEvidenceFactIds.find(
          (factId) => !cited.has(factId) || !recorded.has(factId) || !known.has(factId),
        );
        if (missing) {
          rejection = rejected(
            "missing_required_evidence",
            `Required evidence "${missing}" must be cited, recorded, and player-known`,
          );
          break;
        }
        const invalidCitation = [...cited].find(
          (factId) => !caseDefinition.evidenceFactIds.includes(factId) || !recorded.has(factId) || !known.has(factId),
        );
        if (invalidCitation) {
          rejection = rejected("invalid_evidence_citation", `Evidence citation "${invalidCitation}" is invalid`);
          break;
        }
      }
      emit({
        kind: "caseStatusChanged",
        caseId: command.caseId,
        before: "open",
        after: command.status,
      });
      break;
    }
    case "advanceClock": {
      if (!Number.isSafeInteger(command.minutes) || command.minutes < 0) {
        rejection = rejected("invalid_clock_delta", "Clock advancement must be a non-negative safe integer");
        break;
      }
      if (!Number.isSafeInteger(staged.clock + command.minutes)) {
        rejection = rejected("clock_overflow", "Clock advancement exceeds safe integer range");
        break;
      }
      if (command.minutes > 0) {
        emit({
          kind: "clockAdvanced",
          by: command.minutes,
          before: staged.clock,
          after: staged.clock + command.minutes,
        });
      }
      break;
    }
    case "markEventFired": {
      if (!definition.events.some((event) => event.id === command.eventId)) {
        rejection = rejected("unknown_event", `Event "${command.eventId}" is not authored`);
        break;
      }
      if (!staged.firedEventIds.includes(command.eventId)) {
        emit({ kind: "eventMarked", eventId: command.eventId });
      }
      break;
    }
  }

  if (rejection) return rejection;
  for (const delta of deltas) applyResearchDeltaInPlace(state, delta);
  return { accepted: true, mutated: deltas.length > 0, deltas };
}
