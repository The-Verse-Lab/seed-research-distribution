import type { ResearchWorldCommand } from "./commands";
import type { ResearchWorldDelta } from "./deltas";
import { matchingResearchEnterEvents, researchEventEffectCommand } from "./events";
import { applyResearchCommand, type ResearchCommandResult } from "./reducer";
import { foldResearchDeltas } from "./replay";
import {
  parseResearchWorldDefinition,
  type ResearchEventEffect,
  type ResearchWorldDefinition,
} from "./schema";
import {
  canonicalResearchJson,
  cloneResearchWorldState,
  createResearchWorldState,
  findResearchExit,
  hashResearchWorldState,
  type ResearchWorldSetup,
  type ResearchWorldState,
} from "./state";

export interface ResearchWorldExecutorOptions {
  setup?: ResearchWorldSetup;
  seedState?: ResearchWorldState;
}

export interface ResearchExecutionResult extends ResearchCommandResult {
  beforeStateHash: string;
  afterStateHash: string;
  eventsFired: string[];
  travelMinutes?: number;
}

export interface ResolveResearchCaseInput {
  caseId: string;
  suspectId: string;
  citedEvidenceFactIds: string[];
}

function mechanicsHash(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Keyed randomness is order-independent: the same seed and movement key always yield the same duration. */
export function keyedResearchTravelMinutes(input: {
  seed: string;
  worldId: string;
  campaignId: string;
  from: string;
  to: string;
  departureClock: number;
  baseMinutes: number;
  jitter: number;
}): number {
  if (!Number.isSafeInteger(input.baseMinutes) || input.baseMinutes < 0) {
    throw new Error("Base travel minutes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.jitter) || input.jitter < 0) {
    throw new Error("Travel jitter must be a non-negative safe integer");
  }
  if (input.jitter === 0) return input.baseMinutes;
  const key = [
    "research-travel-v1",
    input.seed,
    input.worldId,
    input.campaignId,
    input.from,
    input.to,
    String(input.departureClock),
  ].join(":");
  const span = input.jitter * 2 + 1;
  const offset = (mechanicsHash(key) % span) - input.jitter;
  return Math.max(0, input.baseMinutes + offset);
}

/** Pure deterministic facade over the command reducer, event evaluator, and delta replay. */
export class ResearchWorldExecutor {
  readonly definition: ResearchWorldDefinition;
  private readonly origin: ResearchWorldState;
  private state: ResearchWorldState;
  private readonly deltaLog: ResearchWorldDelta[] = [];

  constructor(definition: unknown, options: ResearchWorldExecutorOptions = {}) {
    this.definition = parseResearchWorldDefinition(definition);
    if (options.seedState && options.setup) {
      throw new Error("Provide either seedState or setup, not both");
    }
    this.state = options.seedState
      ? cloneResearchWorldState(options.seedState)
      : createResearchWorldState(this.definition, options.setup);
    if (
      this.state.worldId !== this.definition.worldId ||
      this.state.campaignId !== this.definition.campaignId ||
      this.state.playerId !== this.definition.playerId ||
      this.state.companionId !== this.definition.companionId
    ) {
      throw new Error("Seed state does not belong to this research world/campaign/player");
    }
    if (this.state.entities[this.state.playerId]?.locationId !== this.state.locationId) {
      throw new Error("Seed state's player entity and current location disagree");
    }
    if (!Number.isSafeInteger(this.state.clock) || this.state.clock < 0) {
      throw new Error("Seed state's clock must be a non-negative safe integer");
    }
    this.origin = cloneResearchWorldState(this.state);
    this.assertReplayInvariant();
  }

  snapshot(): ResearchWorldState {
    return cloneResearchWorldState(this.state);
  }

  seedSnapshot(): ResearchWorldState {
    return cloneResearchWorldState(this.origin);
  }

  deltas(): ResearchWorldDelta[] {
    return structuredClone(this.deltaLog);
  }

  stateHash(): string {
    return hashResearchWorldState(this.state);
  }

  replaySnapshot(): ResearchWorldState {
    return foldResearchDeltas(this.origin, this.deltaLog);
  }

  assertReplayInvariant(): void {
    const replayed = this.replaySnapshot();
    if (canonicalResearchJson(replayed) !== canonicalResearchJson(this.state)) {
      throw new Error("Research replay invariant failed: snapshot != fold(seed, deltas)");
    }
  }

  private commit(command: ResearchWorldCommand): ResearchExecutionResult {
    const beforeStateHash = this.stateHash();
    const result = applyResearchCommand(this.state, this.definition, command);
    if (result.accepted) this.deltaLog.push(...structuredClone(result.deltas));
    this.assertReplayInvariant();
    return {
      ...result,
      deltas: structuredClone(result.deltas),
      beforeStateHash,
      afterStateHash: this.stateHash(),
      eventsFired: [],
    };
  }

  private required(command: ResearchWorldCommand, owner: string): ResearchExecutionResult {
    const result = this.commit(command);
    if (!result.accepted) {
      throw new Error(`${owner} emitted rejected ${command.kind}: ${result.reasonCode ?? "unknown"}`);
    }
    return result;
  }

  private requiredEffects(effects: readonly ResearchEventEffect[], owner: string): void {
    for (const effect of effects) {
      this.required(researchEventEffectCommand(effect, this.definition), owner);
    }
  }

  execute(command: ResearchWorldCommand): ResearchExecutionResult {
    if (command.kind === "moveParty") return this.moveParty(command.to);
    return this.commit(command);
  }

  moveParty(to: string): ResearchExecutionResult {
    const startState = cloneResearchWorldState(this.state);
    const startDeltaCount = this.deltaLog.length;
    const beforeStateHash = hashResearchWorldState(startState);
    const from = startState.locationId;
    const departureClock = startState.clock;
    const exit = findResearchExit(this.definition, from, to);

    try {
      const movement = this.commit({ kind: "moveParty", to });
      if (!movement.accepted) return movement;
      if (!exit) throw new Error(`Accepted movement lacks authored exit "${from}->${to}"`);

      // This is intentionally the only snapshot used for every same-tick event predicate.
      const postMovePreEffect = this.snapshot();
      const events = matchingResearchEnterEvents(this.definition, postMovePreEffect);
      for (const event of events) {
        this.required({ kind: "markEventFired", eventId: event.id }, `event "${event.id}"`);
        this.requiredEffects(event.effects, `event "${event.id}"`);
      }

      const travelMinutes = keyedResearchTravelMinutes({
        seed: startState.mechanicsSeed,
        worldId: startState.worldId,
        campaignId: startState.campaignId,
        from,
        to,
        departureClock,
        baseMinutes: exit.minutes,
        jitter: this.definition.mechanics.travelMinuteJitter,
      });
      this.required({ kind: "advanceClock", minutes: travelMinutes }, "travel mechanics");
      const deltas = structuredClone(this.deltaLog.slice(startDeltaCount));
      this.assertReplayInvariant();
      return {
        accepted: true,
        mutated: deltas.length > 0,
        deltas,
        beforeStateHash,
        afterStateHash: this.stateHash(),
        eventsFired: events.map((event) => event.id),
        travelMinutes,
      };
    } catch (error) {
      this.state = startState;
      this.deltaLog.length = startDeltaCount;
      this.assertReplayInvariant();
      throw error;
    }
  }

  discloseFacts(factIds: string[]): ResearchExecutionResult {
    return this.commit({ kind: "discloseFacts", factIds });
  }

  transferItem(itemId: string, from: string | null, to: string | null): ResearchExecutionResult {
    return this.commit({ kind: "transferItem", itemId, from, to });
  }

  /** Validate the terminal accusation before applying authored success effects and quest completion. */
  resolveCase(input: ResolveResearchCaseInput): ResearchExecutionResult {
    const startState = cloneResearchWorldState(this.state);
    const startDeltaCount = this.deltaLog.length;
    const beforeStateHash = hashResearchWorldState(startState);
    const caseDefinition = this.definition.cases.find((entry) => entry.id === input.caseId);
    if (!caseDefinition) {
      this.assertReplayInvariant();
      return {
        accepted: false,
        mutated: false,
        deltas: [],
        reasonCode: "unknown_case",
        message: `Case "${input.caseId}" is not authored`,
        beforeStateHash,
        afterStateHash: beforeStateHash,
        eventsFired: [],
      };
    }

    try {
      const resolution = this.commit({
        kind: "resolveCase",
        caseId: input.caseId,
        status: "solved",
        suspectId: input.suspectId,
        citedEvidenceFactIds: [...input.citedEvidenceFactIds],
      });
      if (!resolution.accepted) return resolution;
      this.requiredEffects(caseDefinition.successEffects, `case "${input.caseId}"`);
      this.required(
        { kind: "setQuestState", questId: caseDefinition.questId, state: "complete" },
        `case "${input.caseId}"`,
      );
      const deltas = structuredClone(this.deltaLog.slice(startDeltaCount));
      this.assertReplayInvariant();
      return {
        accepted: true,
        mutated: deltas.length > 0,
        deltas,
        beforeStateHash,
        afterStateHash: this.stateHash(),
        eventsFired: [],
      };
    } catch (error) {
      this.state = startState;
      this.deltaLog.length = startDeltaCount;
      this.assertReplayInvariant();
      throw error;
    }
  }
}
