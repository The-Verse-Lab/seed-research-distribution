/** Research-only authored mechanics schema. It deliberately has no game-engine dependencies. */
import { z } from "zod";

export const ResearchQuestStateSchema = z.enum(["hidden", "offered", "active", "complete", "failed"]);
export const ResearchExitStateSchema = z.enum(["open", "locked", "blocked", "broken"]);

export const ResearchEntityDefinitionSchema = z.object({
  id: z.string().min(1),
  locationId: z.string().min(1).nullable(),
  inventory: z.array(z.string().min(1)).default([]),
});

export const ResearchExitDefinitionSchema = z.object({
  to: z.string().min(1),
  minutes: z.number().int().nonnegative(),
  initialState: ResearchExitStateSchema.default("open"),
});

export const ResearchLocationDefinitionSchema = z.object({
  id: z.string().min(1),
  exits: z.array(ResearchExitDefinitionSchema).default([]),
});

export const ResearchQuestDefinitionSchema = z.object({
  id: z.string().min(1),
  initialState: ResearchQuestStateSchema.default("hidden"),
  objectiveIds: z.array(z.string().min(1)).default([]),
});

export const ResearchEventConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("atLocation"), locationId: z.string().min(1) }),
  z.object({
    kind: z.literal("questState"),
    questId: z.string().min(1),
    state: ResearchQuestStateSchema,
  }),
  z.object({ kind: z.literal("hasItem"), entityId: z.string().min(1), itemId: z.string().min(1) }),
  z.object({ kind: z.literal("factKnown"), factId: z.string().min(1) }),
]);

export const ResearchEventEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discloseFacts"), factIds: z.array(z.string().min(1)).min(1) }),
  z.object({
    kind: z.literal("transferItem"),
    itemId: z.string().min(1),
    from: z.string().min(1).nullable(),
    to: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("setExitState"),
    locationId: z.string().min(1),
    to: z.string().min(1),
    state: ResearchExitStateSchema,
  }),
  z.object({
    kind: z.literal("setQuestState"),
    questId: z.string().min(1),
    state: ResearchQuestStateSchema,
  }),
  z.object({
    kind: z.literal("setObjective"),
    questId: z.string().min(1),
    objectiveId: z.string().min(1),
    done: z.boolean(),
  }),
  z.object({
    kind: z.literal("revealCaseEvidence"),
    caseId: z.string().min(1),
    factId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("resolveCase"),
    caseId: z.string().min(1),
    status: z.enum(["solved", "failed"]),
  }),
  z.object({ kind: z.literal("advanceClock"), minutes: z.number().int().nonnegative() }),
]);

export const ResearchCaseDefinitionSchema = z.object({
  id: z.string().min(1),
  questId: z.string().min(1),
  culpritId: z.string().min(1),
  evidenceFactIds: z.array(z.string().min(1)).min(1),
  requiredEvidenceFactIds: z.array(z.string().min(1)).min(1),
  successEffects: z.array(ResearchEventEffectSchema).default([]),
});

export const ResearchEnterEventSchema = z.object({
  id: z.string().min(1),
  when: z.literal("onEnterLocation").default("onEnterLocation"),
  trigger: z.object({ allOf: z.array(ResearchEventConditionSchema).default([]) }),
  effects: z.array(ResearchEventEffectSchema).default([]),
  once: z.literal("campaign").default("campaign"),
});

export const ResearchWorldDefinitionSchema = z.object({
  version: z.literal(1),
  worldId: z.string().min(1),
  campaignId: z.string().min(1),
  playerId: z.string().min(1),
  companionId: z.string().min(1),
  partyEntityIds: z.array(z.string().min(1)).min(1),
  entities: z.array(ResearchEntityDefinitionSchema).min(1),
  locations: z.array(ResearchLocationDefinitionSchema).min(1),
  facts: z.array(z.object({ id: z.string().min(1), text: z.string().optional() })).default([]),
  quests: z.array(ResearchQuestDefinitionSchema).default([]),
  cases: z.array(ResearchCaseDefinitionSchema).default([]),
  events: z.array(ResearchEnterEventSchema).default([]),
  mechanics: z.object({ travelMinuteJitter: z.number().int().nonnegative().default(0) }).default({
    travelMinuteJitter: 0,
  }),
});

export type ResearchQuestState = z.infer<typeof ResearchQuestStateSchema>;
export type ResearchExitState = z.infer<typeof ResearchExitStateSchema>;
export type ResearchEntityDefinition = z.infer<typeof ResearchEntityDefinitionSchema>;
export type ResearchExitDefinition = z.infer<typeof ResearchExitDefinitionSchema>;
export type ResearchLocationDefinition = z.infer<typeof ResearchLocationDefinitionSchema>;
export type ResearchQuestDefinition = z.infer<typeof ResearchQuestDefinitionSchema>;
export type ResearchEventCondition = z.infer<typeof ResearchEventConditionSchema>;
export type ResearchEventEffect = z.infer<typeof ResearchEventEffectSchema>;
export type ResearchCaseDefinition = z.infer<typeof ResearchCaseDefinitionSchema>;
export type ResearchEnterEvent = z.infer<typeof ResearchEnterEventSchema>;
export type ResearchWorldDefinition = z.infer<typeof ResearchWorldDefinitionSchema>;

function duplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/** Parse and cross-check all references used by the research reducer and event evaluator. */
export function parseResearchWorldDefinition(value: unknown): ResearchWorldDefinition {
  const definition = ResearchWorldDefinitionSchema.parse(value);
  const fail = (message: string): never => {
    throw new Error(`Research world mismatch: ${message}`);
  };
  const duplicateEntity = duplicate(definition.entities.map((row) => row.id));
  const duplicateLocation = duplicate(definition.locations.map((row) => row.id));
  const duplicateQuest = duplicate(definition.quests.map((row) => row.id));
  const duplicateCase = duplicate(definition.cases.map((row) => row.id));
  const duplicateEvent = duplicate(definition.events.map((row) => row.id));
  const duplicateFact = duplicate(definition.facts.map((row) => row.id));
  if (duplicateEntity) fail(`entity "${duplicateEntity}" is declared twice`);
  if (duplicateLocation) fail(`location "${duplicateLocation}" is declared twice`);
  if (duplicateQuest) fail(`quest "${duplicateQuest}" is declared twice`);
  if (duplicateCase) fail(`case "${duplicateCase}" is declared twice`);
  if (duplicateEvent) fail(`event "${duplicateEvent}" is declared twice`);
  if (duplicateFact) fail(`fact "${duplicateFact}" is declared twice`);
  const duplicatePartyEntity = duplicate(definition.partyEntityIds);
  if (duplicatePartyEntity) fail(`party entity "${duplicatePartyEntity}" is listed twice`);

  const entityIds = new Set(definition.entities.map((row) => row.id));
  const locationIds = new Set(definition.locations.map((row) => row.id));
  const factIds = new Set(definition.facts.map((row) => row.id));
  const questById = new Map(definition.quests.map((row) => [row.id, row] as const));
  const caseById = new Map(definition.cases.map((row) => [row.id, row] as const));
  if (!entityIds.has(definition.playerId)) fail(`player "${definition.playerId}" is not an entity`);
  if (!entityIds.has(definition.companionId)) fail(`companion "${definition.companionId}" is not an entity`);
  for (const entityId of definition.partyEntityIds) {
    if (!entityIds.has(entityId)) fail(`party entity "${entityId}" is not defined`);
  }
  if (!definition.partyEntityIds.includes(definition.playerId)) fail("party does not include the player");
  for (const entity of definition.entities) {
    if (entity.locationId !== null && !locationIds.has(entity.locationId)) {
      fail(`entity "${entity.id}" starts at unknown location "${entity.locationId}"`);
    }
  }
  for (const location of definition.locations) {
    const duplicateExit = duplicate(location.exits.map((exit) => exit.to));
    if (duplicateExit) fail(`location "${location.id}" has two exits to "${duplicateExit}"`);
    for (const exit of location.exits) {
      if (!locationIds.has(exit.to)) fail(`exit ${location.id}->${exit.to} has an unknown destination`);
    }
  }
  for (const quest of definition.quests) {
    const duplicateObjective = duplicate(quest.objectiveIds);
    if (duplicateObjective) fail(`quest "${quest.id}" declares objective "${duplicateObjective}" twice`);
  }
  for (const caseDefinition of definition.cases) {
    if (!questById.has(caseDefinition.questId)) fail(`case "${caseDefinition.id}" has an unknown quest`);
    if (!entityIds.has(caseDefinition.culpritId)) fail(`case "${caseDefinition.id}" has an unknown culprit`);
    const available = new Set(caseDefinition.evidenceFactIds);
    const duplicateEvidence = duplicate(caseDefinition.evidenceFactIds);
    const duplicateRequiredEvidence = duplicate(caseDefinition.requiredEvidenceFactIds);
    if (duplicateEvidence) fail(`case "${caseDefinition.id}" declares evidence "${duplicateEvidence}" twice`);
    if (duplicateRequiredEvidence) {
      fail(`case "${caseDefinition.id}" requires evidence "${duplicateRequiredEvidence}" twice`);
    }
    for (const factId of caseDefinition.requiredEvidenceFactIds) {
      if (!available.has(factId)) fail(`case "${caseDefinition.id}" requires undeclared evidence "${factId}"`);
    }
    for (const factId of caseDefinition.evidenceFactIds) {
      if (!factIds.has(factId)) fail(`case "${caseDefinition.id}" names unknown evidence fact "${factId}"`);
    }
  }
  const validateEffects = (owner: string, effects: readonly ResearchEventEffect[]): void => {
    for (const effect of effects) {
      if (effect.kind === "discloseFacts") {
        for (const factId of effect.factIds) if (!factIds.has(factId)) fail(`${owner} discloses unknown fact "${factId}"`);
      } else if (effect.kind === "transferItem") {
        if (effect.from === null && effect.to === null) fail(`${owner} declares a transfer with no endpoint`);
        if (effect.from !== null && !entityIds.has(effect.from)) fail(`${owner} names unknown source "${effect.from}"`);
        if (effect.to !== null && !entityIds.has(effect.to)) fail(`${owner} names unknown destination "${effect.to}"`);
      } else if (effect.kind === "setExitState") {
        const location = definition.locations.find((entry) => entry.id === effect.locationId);
        if (!location?.exits.some((exit) => exit.to === effect.to)) fail(`${owner} names unknown exit "${effect.locationId}->${effect.to}"`);
      } else if (effect.kind === "setQuestState") {
        if (!questById.has(effect.questId)) fail(`${owner} names unknown quest "${effect.questId}"`);
      } else if (effect.kind === "setObjective") {
        if (!questById.get(effect.questId)?.objectiveIds.includes(effect.objectiveId)) {
          fail(`${owner} names unknown objective "${effect.questId}:${effect.objectiveId}"`);
        }
      } else if (effect.kind === "revealCaseEvidence") {
        if (!caseById.get(effect.caseId)?.evidenceFactIds.includes(effect.factId)) {
          fail(`${owner} names invalid evidence "${effect.caseId}:${effect.factId}"`);
        }
      } else if (effect.kind === "resolveCase" && !caseById.has(effect.caseId)) {
        fail(`${owner} names unknown case "${effect.caseId}"`);
      }
    }
  };
  for (const caseDefinition of definition.cases) {
    validateEffects(`case "${caseDefinition.id}"`, caseDefinition.successEffects);
  }
  for (const event of definition.events) {
    for (const condition of event.trigger.allOf) {
      if (condition.kind === "atLocation" && !locationIds.has(condition.locationId)) {
        fail(`event "${event.id}" names unknown location "${condition.locationId}"`);
      }
      if (condition.kind === "questState" && !questById.has(condition.questId)) {
        fail(`event "${event.id}" names unknown quest "${condition.questId}"`);
      }
      if (condition.kind === "hasItem" && !entityIds.has(condition.entityId)) {
        fail(`event "${event.id}" names unknown entity "${condition.entityId}"`);
      }
      if (condition.kind === "factKnown" && factIds.size > 0 && !factIds.has(condition.factId)) {
        fail(`event "${event.id}" names unknown fact "${condition.factId}"`);
      }
    }
    validateEffects(`event "${event.id}"`, event.effects);
  }
  return definition;
}
