import { createHash } from "node:crypto";

import type {
  ResearchExitState,
  ResearchQuestState,
  ResearchWorldDefinition,
} from "./schema";

export interface ResearchEntityState {
  locationId: string | null;
  inventory: string[];
}

export interface ResearchCaseState {
  evidenceFactIds: string[];
  status: "open" | "solved" | "failed";
}

export interface ResearchWorldState {
  version: 1;
  worldId: string;
  campaignId: string;
  playerId: string;
  companionId: string;
  partyEntityIds: string[];
  locationId: string;
  clock: number;
  mechanicsSeed: string;
  entities: Record<string, ResearchEntityState>;
  exitStates: Record<string, ResearchExitState>;
  quests: Record<string, ResearchQuestState>;
  objectives: Record<string, Record<string, boolean>>;
  playerKnownFactIds: string[];
  cases: Record<string, ResearchCaseState>;
  firedEventIds: string[];
}

export interface ResearchWorldSetup {
  locationId?: string;
  clock?: number;
  mechanicsSeed?: string;
  entityLocations?: Record<string, string | null>;
  inventories?: Record<string, readonly string[]>;
  exitStates?: Record<string, ResearchExitState>;
  questStates?: Record<string, ResearchQuestState>;
  objectives?: Record<string, Record<string, boolean>>;
  playerKnownFactIds?: readonly string[];
  caseEvidence?: Record<string, readonly string[]>;
  caseStatuses?: Record<string, ResearchCaseState["status"]>;
  firedEventIds?: readonly string[];
}

export function researchExitKey(locationId: string, to: string): string {
  return `${locationId}->${to}`;
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function cloneResearchWorldState(state: ResearchWorldState): ResearchWorldState {
  return structuredClone(state);
}

export function findResearchExit(
  definition: ResearchWorldDefinition,
  locationId: string,
  to: string,
) {
  return definition.locations.find((location) => location.id === locationId)?.exits.find((exit) => exit.to === to);
}

export function effectiveResearchExitState(
  definition: ResearchWorldDefinition,
  state: ResearchWorldState,
  locationId: string,
  to: string,
): ResearchExitState | undefined {
  const exit = findResearchExit(definition, locationId, to);
  if (!exit) return undefined;
  return state.exitStates[researchExitKey(locationId, to)] ?? exit.initialState;
}

function assertSetupKeys<T>(label: string, values: Record<string, T> | undefined, allowed: Set<string>): void {
  if (!values) return;
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} setup key "${key}"`);
  }
}

/** Build the complete, JSON-native seed snapshot used by reducer replay. */
export function createResearchWorldState(
  definition: ResearchWorldDefinition,
  setup: ResearchWorldSetup = {},
): ResearchWorldState {
  const entityIds = new Set(definition.entities.map((entity) => entity.id));
  const locationIds = new Set(definition.locations.map((location) => location.id));
  const factIds = new Set(definition.facts.map((fact) => fact.id));
  const questIds = new Set(definition.quests.map((quest) => quest.id));
  const caseIds = new Set(definition.cases.map((caseDefinition) => caseDefinition.id));
  const eventIds = new Set(definition.events.map((event) => event.id));
  assertSetupKeys("entity location", setup.entityLocations, entityIds);
  assertSetupKeys("inventory", setup.inventories, entityIds);
  assertSetupKeys("quest", setup.questStates, questIds);
  assertSetupKeys("objective", setup.objectives, questIds);
  assertSetupKeys("case evidence", setup.caseEvidence, caseIds);
  assertSetupKeys("case status", setup.caseStatuses, caseIds);

  const entities: Record<string, ResearchEntityState> = {};
  for (const entity of definition.entities) {
    const hasLocationOverride = Object.prototype.hasOwnProperty.call(setup.entityLocations ?? {}, entity.id);
    const locationId = hasLocationOverride ? setup.entityLocations![entity.id]! : entity.locationId;
    if (locationId !== null && !locationIds.has(locationId)) {
      throw new Error(`Entity "${entity.id}" is assigned to unknown location "${locationId}"`);
    }
    entities[entity.id] = {
      locationId,
      inventory: sortedUnique(setup.inventories?.[entity.id] ?? entity.inventory),
    };
  }

  const initialPlayerLocation = entities[definition.playerId]?.locationId;
  const locationId = setup.locationId ?? initialPlayerLocation;
  if (locationId === null || locationId === undefined || !locationIds.has(locationId)) {
    throw new Error("The research player must start at a defined location");
  }
  entities[definition.playerId]!.locationId = locationId;
  for (const entityId of definition.partyEntityIds) {
    const authoredLocation = definition.entities.find((entity) => entity.id === entityId)?.locationId;
    if (setup.locationId !== undefined || authoredLocation === initialPlayerLocation) {
      entities[entityId]!.locationId = locationId;
    }
  }

  const exitStates: Record<string, ResearchExitState> = {};
  for (const location of definition.locations) {
    for (const exit of location.exits) {
      exitStates[researchExitKey(location.id, exit.to)] = exit.initialState;
    }
  }
  for (const [key, exitState] of Object.entries(setup.exitStates ?? {})) {
    if (!(key in exitStates)) throw new Error(`Unknown exit setup key "${key}"`);
    exitStates[key] = exitState;
  }

  const quests: Record<string, ResearchQuestState> = {};
  const objectives: Record<string, Record<string, boolean>> = {};
  for (const quest of definition.quests) {
    quests[quest.id] = setup.questStates?.[quest.id] ?? quest.initialState;
    const authoredObjectiveIds = new Set(quest.objectiveIds);
    const objectiveOverrides = setup.objectives?.[quest.id] ?? {};
    for (const objectiveId of Object.keys(objectiveOverrides)) {
      if (!authoredObjectiveIds.has(objectiveId)) {
        throw new Error(`Unknown objective setup key "${quest.id}:${objectiveId}"`);
      }
    }
    objectives[quest.id] = Object.fromEntries(
      quest.objectiveIds.map((objectiveId) => [objectiveId, objectiveOverrides[objectiveId] ?? false]),
    );
  }

  const cases: Record<string, ResearchCaseState> = {};
  for (const caseDefinition of definition.cases) {
    const evidence = setup.caseEvidence?.[caseDefinition.id] ?? [];
    for (const factId of evidence) {
      if (!caseDefinition.evidenceFactIds.includes(factId)) {
        throw new Error(`Fact "${factId}" is not evidence for case "${caseDefinition.id}"`);
      }
    }
    cases[caseDefinition.id] = {
      evidenceFactIds: sortedUnique(evidence),
      status: setup.caseStatuses?.[caseDefinition.id] ?? "open",
    };
  }

  const firedEventIds = [...(setup.firedEventIds ?? [])];
  for (const eventId of firedEventIds) {
    if (!eventIds.has(eventId)) throw new Error(`Unknown fired event "${eventId}"`);
  }
  if (new Set(firedEventIds).size !== firedEventIds.length) {
    throw new Error("Fired event setup contains a duplicate event id");
  }
  for (const factId of setup.playerKnownFactIds ?? []) {
    if (!factIds.has(factId)) throw new Error(`Unknown player-known fact "${factId}"`);
  }
  if (!Number.isSafeInteger(setup.clock ?? 0) || (setup.clock ?? 0) < 0) {
    throw new Error("Research clock must be a non-negative safe integer");
  }

  return {
    version: 1,
    worldId: definition.worldId,
    campaignId: definition.campaignId,
    playerId: definition.playerId,
    companionId: definition.companionId,
    partyEntityIds: [...definition.partyEntityIds],
    locationId,
    clock: setup.clock ?? 0,
    mechanicsSeed: setup.mechanicsSeed ?? "0",
    entities,
    exitStates,
    quests,
    objectives,
    playerKnownFactIds: sortedUnique(setup.playerKnownFactIds ?? []),
    cases,
    firedEventIds,
  };
}

function canonicalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Non-plain object at ${path}`);
    }
    const source = value as Record<string, unknown>;
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
      const entry = source[key];
      if (entry === undefined) throw new Error(`Undefined value at ${path}.${key}`);
      target[key] = canonicalize(entry, `${path}.${key}`);
    }
    return target;
  }
  throw new Error(`Non-JSON value at ${path}`);
}

/** Stable JSON representation: object keys sort recursively while authored array order is retained. */
export function canonicalResearchJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

export function hashResearchValue(value: unknown): string {
  return createHash("sha256").update(canonicalResearchJson(value)).digest("hex");
}

export function hashResearchWorldState(state: ResearchWorldState): string {
  return hashResearchValue(state);
}
