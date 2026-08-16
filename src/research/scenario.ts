/**
 * Research-scenario overlays for authored worlds.
 *
 * A research suite never changes the ordinary world/campaign contract. It names a controlled
 * decision point, then instantiation clones the validated PlaySet and varies only the fields the
 * condition owns: fact allocation, the companion's controlled goal, starting position/inventory,
 * and quest state. The returned PlaySet can be handed to GameEngine like any other campaign.
 *
 * Scenario metadata is experimental stratification, not a ground-truth label. Whether an
 * intervention was valuable is determined later from paired mechanical outcomes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  NpcKnowledgeEntrySchema,
  type PlaySet,
} from "../content/schema.ts";
import { loadPlaySetFromDir } from "../content/loader.ts";

export const ResearchAsymmetrySchema = z.union([z.literal(0), z.literal(0.3), z.literal(0.7)]);
export const ResearchIncentiveSchema = z.enum(["cooperative", "mixed"]);

export const ResearchConditionSchema = z.object({
  asymmetry: ResearchAsymmetrySchema,
  incentive: ResearchIncentiveSchema,
  /** Unsigned seed recorded with the condition; the suite does not draw from it. */
  seed: z.number().int().min(0).max(0xffff_ffff),
});

export const ResearchFactMaskSchema = z.object({
  playerKnownFactIds: z.array(z.string()).default([]),
  companionKnownFactIds: z.array(z.string()).default([]),
});

export const ResearchSetupSchema = z.object({
  locationId: z.string(),
  clock: z.number().int().nonnegative(),
  questStates: z.record(z.enum(["hidden", "offered", "active", "complete", "failed"])).default({}),
  playerInventory: z.array(z.string()).default([]),
  companionInventory: z.array(z.string()).default([]),
});

const ResearchActSchema = z.object({
  do: z.enum(["move", "give", "open", "pick", "force"]),
  target: z.string().min(1),
  to: z.string().optional(),
}).superRefine((act, ctx) => {
  if (act.do === "give" && !act.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "give requires a recipient" });
  }
  if (act.do !== "give" && act.to !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: `${act.do} cannot name a recipient` });
  }
});

export const ResearchInterventionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inform"), factIds: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("act"), act: ResearchActSchema }),
  z.object({ kind: z.literal("none") }),
]);

/** Explicit, model-free suffix policy used by the research execution harness. */
export const ResearchRolloutSchema = z.object({
  policy: z.literal("scripted-waypoints-v1"),
  /** Ordered destinations. The runner computes each shortest authored path at execution time. */
  waypointLocationIds: z.array(z.string()).min(1),
  /** The scripted policy waits unless these facts are present after the branch intervention. */
  requiredFactIds: z.array(z.string()).default([]),
  /** Optional deterministic case-resolution action after the final waypoint. */
  terminalCase: z.object({
    caseId: z.string(),
    suspectId: z.string(),
    factIds: z.array(z.string()).min(1),
  }).optional(),
});

export const ResearchOutcomeMetricSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("questState"),
    questId: z.string(),
    desired: z.enum(["hidden", "offered", "active", "complete", "failed"]),
    weight: z.number(),
  }),
  z.object({
    kind: z.literal("objective"),
    questId: z.string(),
    objectiveId: z.string(),
    desired: z.boolean().default(true),
    weight: z.number(),
  }),
  z.object({ kind: z.literal("itemCustody"), itemId: z.string(), holderId: z.string(), weight: z.number() }),
  z.object({ kind: z.literal("coins"), entityId: z.string(), direction: z.enum(["minimize", "maximize"]), weight: z.number() }),
  z.object({ kind: z.literal("clock"), direction: z.enum(["minimize", "maximize"]), weight: z.number() }),
  z.object({ kind: z.literal("hp"), entityId: z.string(), direction: z.enum(["minimize", "maximize"]), weight: z.number() }),
  z.object({
    kind: z.literal("relationship"),
    actorId: z.string(),
    targetId: z.string(),
    direction: z.enum(["minimize", "maximize"]),
    weight: z.number(),
  }),
  z.object({
    kind: z.literal("factionStanding"),
    pcId: z.string(),
    factionId: z.string(),
    direction: z.enum(["minimize", "maximize"]),
    weight: z.number(),
  }),
]);

export const ResearchScenarioSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  family: z.string(),
  opportunityKind: z.enum(["informing", "instrumental", "control"]),
  pairedScenarioId: z.string(),
  controlScenarioId: z.string(),
  tags: z.array(z.string()).default([]),
  /** Fixed across every asymmetry × incentive condition for this scenario. */
  rngSeed: z.number().int().min(0).max(0xffff_ffff),
  setup: ResearchSetupSchema,
  /** Exactly three facts: the masks expose 3/3, 2/3, and 1/3 to the player. */
  relevantFactIds: z.array(z.string()).length(3),
  factMasks: z.object({
    "0": ResearchFactMaskSchema,
    "0.3": ResearchFactMaskSchema,
    "0.7": ResearchFactMaskSchema,
  }),
  intervention: ResearchInterventionSchema,
  rollout: ResearchRolloutSchema,
  incentiveGoals: z.object({
    cooperative: z.array(z.string()).min(1),
    mixed: z.array(z.string()).min(1),
  }),
  suffixHorizonTurns: z.number().int().positive(),
  interventionBudget: z.number().int().nonnegative(),
  outcomeMetrics: z.array(ResearchOutcomeMetricSchema).min(1),
});

export const ResearchSuiteSchema = z.object({
  version: z.literal(1),
  worldId: z.string(),
  campaignId: z.string(),
  companionId: z.string(),
  asymmetryLevels: z.tuple([z.literal(0), z.literal(0.3), z.literal(0.7)]),
  incentives: z.tuple([z.literal("cooperative"), z.literal("mixed")]),
  sharedCompanionGoals: z.array(z.string()).min(1),
  scenarios: z.array(ResearchScenarioSchema).min(1),
});

export type ResearchCondition = z.infer<typeof ResearchConditionSchema>;
export type ResearchIntervention = z.infer<typeof ResearchInterventionSchema>;
export type ResearchOutcomeMetric = z.infer<typeof ResearchOutcomeMetricSchema>;
export type ResearchRollout = z.infer<typeof ResearchRolloutSchema>;
export type ResearchScenario = z.infer<typeof ResearchScenarioSchema>;
export type ResearchSuite = z.infer<typeof ResearchSuiteSchema>;

export interface LoadedResearchSuite {
  playset: PlaySet;
  manifest: ResearchSuite;
}

export interface InstantiatedResearchScenario {
  playset: PlaySet;
  scenario: ResearchScenario;
  condition: ResearchCondition;
  playerKnownFactIds: string[];
  companionKnownFactIds: string[];
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function subset(left: readonly string[], right: readonly string[]): boolean {
  const available = new Set(right);
  return left.every((value) => available.has(value));
}

/** Cross-check every manifest reference and the experimental isolation invariants. */
export function validateResearchSuite(playset: PlaySet, manifest: ResearchSuite): void {
  const fail = (message: string): never => {
    throw new Error(`Research suite mismatch: ${message}`);
  };
  if (manifest.worldId !== playset.world.id) fail(`worldId "${manifest.worldId}" does not match "${playset.world.id}"`);
  if (manifest.campaignId !== playset.campaign.id) {
    fail(`campaignId "${manifest.campaignId}" does not match "${playset.campaign.id}"`);
  }

  const companion = playset.world.npcs.find((npc) => npc.id === manifest.companionId)
    ?? fail(`companionId "${manifest.companionId}" is not a world NPC`);
  if (!companion.autonomy.isPartyMember || companion.autonomy.level !== "proactive" || companion.autonomy.canLead) {
    fail(`companion "${manifest.companionId}" must be a proactive non-leader party member`);
  }

  const locationIds = new Set(playset.world.locations.map((row) => row.id));
  const locationById = new Map(playset.world.locations.map((row) => [row.id, row] as const));
  const factIds = new Set((playset.world.facts ?? []).map((row) => row.id));
  const itemIds = new Set(playset.world.items.map((row) => row.id));
  const npcIds = new Set(playset.world.npcs.map((row) => row.id));
  const pcIds = new Set(playset.campaign.characters.map((row) => row.id));
  const entityIds = new Set([...npcIds, ...pcIds]);
  const factionIds = new Set(playset.world.factions.map((row) => row.id));
  const questById = new Map(playset.campaign.quests.map((row) => [row.id, row] as const));
  const caseById = new Map((playset.campaign.cases ?? []).map((row) => [row.id, row] as const));
  const scenarioById = new Map<string, ResearchScenario>();
  const opportunityIds = new Set<string>();

  for (const scenario of manifest.scenarios) {
    if (scenarioById.has(scenario.id)) fail(`scenario "${scenario.id}" is declared twice`);
    if (opportunityIds.has(scenario.opportunityId)) {
      fail(`opportunityId "${scenario.opportunityId}" is declared twice`);
    }
    scenarioById.set(scenario.id, scenario);
    opportunityIds.add(scenario.opportunityId);
  }

  for (const scenario of manifest.scenarios) {
    const where = `scenario "${scenario.id}"`;
    if (!locationIds.has(scenario.setup.locationId)) fail(`${where} starts at unknown location "${scenario.setup.locationId}"`);
    for (const [questId] of Object.entries(scenario.setup.questStates)) {
      if (!questById.has(questId)) fail(`${where} sets unknown quest "${questId}"`);
    }
    for (const itemId of [...scenario.setup.playerInventory, ...scenario.setup.companionInventory]) {
      if (!itemIds.has(itemId)) fail(`${where} inventories reference unknown item "${itemId}"`);
    }
    if (!scenarioById.has(scenario.pairedScenarioId)) fail(`${where} names unknown pair "${scenario.pairedScenarioId}"`);
    if (!scenarioById.has(scenario.controlScenarioId)) fail(`${where} names unknown control "${scenario.controlScenarioId}"`);
    for (const locationId of scenario.rollout.waypointLocationIds) {
      if (!locationIds.has(locationId)) fail(`${where} rollout names unknown location "${locationId}"`);
    }
    if (!subset(scenario.rollout.requiredFactIds, scenario.relevantFactIds)) {
      fail(`${where} rollout requires an unrelated fact`);
    }

    for (const factId of scenario.relevantFactIds) {
      if (!factIds.has(factId)) fail(`${where} references unknown fact "${factId}"`);
    }
    const masks = [scenario.factMasks["0"], scenario.factMasks["0.3"], scenario.factMasks["0.7"]];
    for (const mask of masks) {
      if (!subset(mask.playerKnownFactIds, scenario.relevantFactIds)) fail(`${where} gives the player an unrelated fact`);
      if (!equalSets(mask.companionKnownFactIds, scenario.relevantFactIds)) {
        fail(`${where} must hold companion knowledge fixed across asymmetry levels`);
      }
    }
    if (!equalSets(masks[0]!.playerKnownFactIds, scenario.relevantFactIds)) fail(`${where} asymmetry 0 must share all three facts`);
    if (masks[1]!.playerKnownFactIds.length !== 2) fail(`${where} asymmetry 0.3 must share two of three facts`);
    if (masks[2]!.playerKnownFactIds.length !== 1) fail(`${where} asymmetry 0.7 must share one of three facts`);
    if (!subset(masks[2]!.playerKnownFactIds, masks[1]!.playerKnownFactIds)) {
      fail(`${where} high-asymmetry player knowledge must be nested within low asymmetry`);
    }

    if (scenario.intervention.kind === "inform") {
      if (scenario.opportunityKind !== "informing") fail(`${where} uses an inform intervention outside an informing row`);
      if (!subset(scenario.intervention.factIds, scenario.relevantFactIds)) fail(`${where} informs with an unrelated fact`);
      if (!equalSets(scenario.rollout.requiredFactIds, scenario.intervention.factIds)) {
        fail(`${where} scripted informing policy must require exactly the informed facts`);
      }
    } else if (scenario.intervention.kind === "act") {
      if (scenario.opportunityKind !== "instrumental") fail(`${where} uses an act intervention outside an instrumental row`);
      const { do: verb, target, to } = scenario.intervention.act;
      if (verb === "give") {
        if (!itemIds.has(target)) fail(`${where} give target "${target}" is not an item`);
        if (!scenario.setup.companionInventory.includes(target)) {
          fail(`${where} companion does not hold give target "${target}" in the initial setup`);
        }
      } else {
        if (!locationIds.has(target)) fail(`${where} ${verb} target "${target}" is not a location`);
        const exit = locationById.get(scenario.setup.locationId)?.exits.find((row) => row.to === target);
        if (!exit) {
          throw new Error(
            `Research suite mismatch: ${where} ${verb} target "${target}" is not an exit from the initial location`,
          );
        }
        if (verb === "move") {
          if (companion.autonomy.isPartyMember && !companion.autonomy.canLead) {
            fail(`${where} cannot move a non-leading party companion away from the party`);
          }
          if (exit.barrier) fail(`${where} move target "${target}" is barred in the initial setup`);
        }
        if (verb === "open") {
          const key = exit.barrier?.keyItemId;
          if (!key || !scenario.setup.companionInventory.includes(key)) {
            fail(`${where} companion cannot passively open "${target}" from the initial setup`);
          }
        }
        if (verb === "pick" && exit.barrier?.dc === undefined) {
          fail(`${where} pick target "${target}" has no lock difficulty`);
        }
        if (verb === "force" && exit.barrier?.breakDc === undefined) {
          fail(`${where} force target "${target}" has no break difficulty`);
        }
      }
      if (to && !entityIds.has(to)) fail(`${where} act recipient "${to}" is not an entity`);
    } else if (scenario.opportunityKind !== "control") {
      fail(`${where} uses none outside a control row`);
    }
    if (scenario.opportunityKind !== "informing" && scenario.rollout.requiredFactIds.length > 0) {
      fail(`${where} non-informing rollout cannot add a knowledge gate`);
    }

    if (scenario.rollout.terminalCase) {
      const terminal = scenario.rollout.terminalCase;
      const caseFile = caseById.get(terminal.caseId)
        ?? fail(`${where} rollout names unknown case "${terminal.caseId}"`);
      if (!entityIds.has(terminal.suspectId)) fail(`${where} rollout names unknown suspect "${terminal.suspectId}"`);
      const caseFactIds = new Set(caseFile.facts.map((row) => row.id));
      for (const factId of terminal.factIds) {
        if (!caseFactIds.has(factId)) fail(`${where} rollout names unknown case fact "${factId}"`);
      }
    }

    for (const metric of scenario.outcomeMetrics) {
      if (metric.kind === "questState" && !questById.has(metric.questId)) fail(`${where} metric names unknown quest "${metric.questId}"`);
      if (metric.kind === "objective") {
        const quest = questById.get(metric.questId)
          ?? fail(`${where} metric names unknown quest "${metric.questId}"`);
        if (!quest.objectives.some((row) => row.id === metric.objectiveId)) {
          fail(`${where} metric names unknown objective "${metric.objectiveId}"`);
        }
      }
      if (metric.kind === "itemCustody") {
        if (!itemIds.has(metric.itemId)) fail(`${where} metric names unknown item "${metric.itemId}"`);
        if (!entityIds.has(metric.holderId)) fail(`${where} metric names unknown holder "${metric.holderId}"`);
      }
      if (metric.kind === "coins" && !entityIds.has(metric.entityId)) fail(`${where} metric names unknown entity "${metric.entityId}"`);
      if (metric.kind === "hp" && !entityIds.has(metric.entityId)) fail(`${where} metric names unknown entity "${metric.entityId}"`);
      if (metric.kind === "relationship") {
        if (!entityIds.has(metric.actorId) || !entityIds.has(metric.targetId)) fail(`${where} relationship metric names an unknown entity`);
      }
      if (metric.kind === "factionStanding") {
        if (!pcIds.has(metric.pcId)) fail(`${where} standing metric names unknown PC "${metric.pcId}"`);
        if (!factionIds.has(metric.factionId)) fail(`${where} standing metric names unknown faction "${metric.factionId}"`);
      }
    }
  }

  const families = new Map<string, ResearchScenario[]>();
  for (const scenario of manifest.scenarios) {
    const rows = families.get(scenario.family) ?? [];
    rows.push(scenario);
    families.set(scenario.family, rows);
  }
  for (const [family, rows] of families) {
    const kinds = rows.map((row) => row.opportunityKind).sort();
    if (rows.length !== 3 || kinds.join(",") !== "control,informing,instrumental") {
      fail(`family "${family}" must contain exactly one informing, instrumental, and control row`);
    }
    const control = rows.find((row) => row.opportunityKind === "control")!;
    const informing = rows.find((row) => row.opportunityKind === "informing")!;
    const instrumental = rows.find((row) => row.opportunityKind === "instrumental")!;
    if (informing.pairedScenarioId !== instrumental.id || instrumental.pairedScenarioId !== informing.id) {
      fail(`family "${family}" informing/instrumental rows must pair with each other`);
    }
    if (informing.controlScenarioId !== control.id || instrumental.controlScenarioId !== control.id) {
      fail(`family "${family}" rows must name its control`);
    }
    if (control.controlScenarioId !== control.id) fail(`family "${family}" control must name itself`);
    if (control.interventionBudget !== 0) fail(`family "${family}" control must have a zero intervention budget`);
    if (informing.interventionBudget < 1 || instrumental.interventionBudget < 1) {
      fail(`family "${family}" intervention rows must have a positive intervention budget`);
    }
    for (const row of rows) {
      if (!equalSets(row.relevantFactIds, control.relevantFactIds)) {
        fail(`family "${family}" rows must use the same relevant-fact set`);
      }
      if (row.suffixHorizonTurns !== control.suffixHorizonTurns) {
        fail(`family "${family}" rows must use the same suffix horizon`);
      }
    }
  }
}

/** Load the standard playset plus its research overlay. */
export async function loadResearchSuiteFromDir(dir: string): Promise<LoadedResearchSuite> {
  const playset = await loadPlaySetFromDir(dir);
  const raw = JSON.parse(await readFile(join(dir, "research.json"), "utf8")) as unknown;
  const manifest = ResearchSuiteSchema.parse(raw);
  validateResearchSuite(playset, manifest);
  return { playset, manifest };
}

function maskFor(scenario: ResearchScenario, asymmetry: ResearchCondition["asymmetry"]) {
  return scenario.factMasks[String(asymmetry) as "0" | "0.3" | "0.7"];
}

/**
 * Instantiate one controlled condition without mutating the loaded suite. Player fact knowledge is
 * returned as experiment metadata because ordinary WorldFacts intentionally do not create a second
 * reducer-owned player-belief model.
 */
export function instantiateResearchScenario(
  loaded: LoadedResearchSuite,
  scenarioId: string,
  rawCondition: ResearchCondition,
): InstantiatedResearchScenario {
  const condition = ResearchConditionSchema.parse(rawCondition);
  const scenario = loaded.manifest.scenarios.find((row) => row.id === scenarioId);
  if (!scenario) throw new Error(`Unknown research scenario: ${scenarioId}`);
  if (condition.seed !== scenario.rngSeed) {
    throw new Error(
      `Research condition seed ${condition.seed} does not match fixed scenario seed ${scenario.rngSeed}`,
    );
  }

  const playset = structuredClone(loaded.playset);
  const companion = playset.world.npcs.find((row) => row.id === loaded.manifest.companionId)!;
  const playerId = playset.campaign.startingState.party[0] ?? playset.campaign.characters[0]?.id;
  const player = playset.campaign.characters.find((row) => row.id === playerId);
  if (!player) throw new Error("Research suite has no starting player character");

  playset.campaign.startingState.locationId = scenario.setup.locationId;
  playset.campaign.startingState.clock = scenario.setup.clock;
  playset.campaign.startingState.companions = [loaded.manifest.companionId];
  delete playset.campaign.startingState.openingSceneId;
  player.inventory = [...scenario.setup.playerInventory];
  companion.inventory = [...scenario.setup.companionInventory];

  for (const quest of playset.campaign.quests) quest.state = "hidden";
  for (const [questId, state] of Object.entries(scenario.setup.questStates)) {
    playset.campaign.quests.find((row) => row.id === questId)!.state = state;
  }

  const relevant = new Set(scenario.relevantFactIds);
  companion.knowledge = companion.knowledge.filter(
    (entry) => typeof entry === "string" || !entry.factId || !relevant.has(entry.factId),
  );
  const mask = maskFor(scenario, condition.asymmetry);
  for (const factId of mask.companionKnownFactIds) {
    companion.knowledge.push(
      NpcKnowledgeEntrySchema.parse({
        factId,
        familiarity: "firsthand",
        certainty: "certain",
        source: "the Wakeward route book and direct service experience",
        disclosure: { mode: "open" },
      }),
    );
  }
  companion.goals = [
    ...loaded.manifest.sharedCompanionGoals,
    ...scenario.incentiveGoals[condition.incentive],
  ];

  return {
    playset,
    scenario: structuredClone(scenario),
    condition,
    playerKnownFactIds: [...mask.playerKnownFactIds],
    companionKnownFactIds: [...mask.companionKnownFactIds],
  };
}

export interface ResearchDecisionDiagnostic {
  scenarioId: string;
  opportunityId: string;
  family: string;
  opportunityKind: ResearchScenario["opportunityKind"];
  condition: ResearchCondition;
  playerKnownFactIds: string[];
  companionKnownFactIds: string[];
  proposedIntervention: ResearchIntervention;
  grounding: "accepted" | "rejected" | "no-op";
  reasonCode?: string;
  factIdsUsed: string[];
  factIdsWithheld: string[];
  outcome: Record<string, number | string | boolean>;
}

/** Build a public-safe, chain-of-thought-free diagnostic record for later trace correlation. */
export function researchDecisionDiagnostic(
  instantiated: InstantiatedResearchScenario,
  result: {
    grounding: ResearchDecisionDiagnostic["grounding"];
    reasonCode?: string;
    factIdsUsed?: string[];
    factIdsWithheld?: string[];
    outcome?: Record<string, number | string | boolean>;
  },
): ResearchDecisionDiagnostic {
  return {
    scenarioId: instantiated.scenario.id,
    opportunityId: instantiated.scenario.opportunityId,
    family: instantiated.scenario.family,
    opportunityKind: instantiated.scenario.opportunityKind,
    condition: structuredClone(instantiated.condition),
    playerKnownFactIds: [...instantiated.playerKnownFactIds],
    companionKnownFactIds: [...instantiated.companionKnownFactIds],
    proposedIntervention: structuredClone(instantiated.scenario.intervention),
    grounding: result.grounding,
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    factIdsUsed: [...(result.factIdsUsed ?? [])],
    factIdsWithheld: [...(result.factIdsWithheld ?? [])],
    outcome: { ...(result.outcome ?? {}) },
  };
}
