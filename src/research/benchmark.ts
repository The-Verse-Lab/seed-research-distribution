/** Wakeward Benchmark v2 loading, validation, condition expansion, and public packet construction. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ResearchDecisionPacketV1Schema,
  type ResearchDecisionPacketV1,
} from "./contracts.ts";
import { researchPacketId } from "./prompt.ts";
import type { ResearchWorldCommand } from "./world/commands.ts";
import {
  parseResearchWorldDefinition,
  ResearchExitStateSchema,
  ResearchQuestStateSchema,
  type ResearchWorldDefinition,
} from "./world/schema.ts";
import {
  createResearchWorldState,
  effectiveResearchExitState,
  hashResearchValue,
  type ResearchWorldSetup,
} from "./world/state.ts";

export const WAKEWARD_FAMILIES = [
  "cold-passage",
  "second-bell",
  "clear-glass",
  "true-bearing",
  "shared-stores",
  "missing-manifest",
] as const;

export const RESEARCH_ASYMMETRY_LEVELS = [0, 0.3, 0.7] as const;
export const RESEARCH_INCENTIVES = ["cooperative", "mixed"] as const;

export const ResearchAsymmetryV2Schema = z.union([z.literal(0), z.literal(0.3), z.literal(0.7)]);
export const ResearchIncentiveV2Schema = z.enum(RESEARCH_INCENTIVES);
export const ResearchRowKindV2Schema = z.enum([
  "informing-opportunity",
  "informing-control",
  "instrumental-opportunity",
  "instrumental-control",
]);

const ResearchWorldSetupV2Schema = z.object({
  locationId: z.string().min(1),
  clock: z.number().int().nonnegative(),
  inventories: z.record(z.array(z.string().min(1))).default({}),
  exitStates: z.record(ResearchExitStateSchema).default({}),
  questStates: z.record(ResearchQuestStateSchema),
  objectives: z.record(z.record(z.boolean())).default({}),
  caseEvidence: z.record(z.array(z.string().min(1))).default({}),
  caseStatuses: z.record(z.enum(["open", "solved", "failed"])).default({}),
  firedEventIds: z.array(z.string().min(1)).default([]),
}).strict();

const ResearchCandidateCommandV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discloseFacts"), factIds: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({
    kind: z.literal("transferItem"),
    itemId: z.string().min(1),
    from: z.string().min(1).nullable(),
    to: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("setExitState"),
    locationId: z.string().min(1),
    to: z.string().min(1),
    state: ResearchExitStateSchema,
  }).strict(),
]);

export const ResearchSuffixStepV2Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("move"),
    to: z.string().min(1),
    /** A rejected move here is an authored task failure rather than a structural censor. */
    expectedTaskStop: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("resolveCase"),
    caseId: z.string().min(1),
    suspectId: z.string().min(1),
    citedEvidenceFactIds: z.array(z.string().min(1)).min(1),
    expectedTaskStop: z.boolean().default(false),
  }).strict(),
]);

export const ResearchScenarioV2Schema = z.object({
  id: z.string().min(1),
  family: z.enum(WAKEWARD_FAMILIES),
  rowKind: ResearchRowKindV2Schema,
  modality: z.enum(["informing", "instrumental"]),
  setup: ResearchWorldSetupV2Schema,
  relevantFactIds: z.array(z.string().min(1)).length(3),
  factMasks: z.object({
    "0": z.array(z.string().min(1)).length(3),
    "0.3": z.array(z.string().min(1)).length(2),
    "0.7": z.array(z.string().min(1)).length(1),
  }).strict(),
  candidate: z.object({
    candidateId: z.string().min(1),
    description: z.string().min(1),
    command: ResearchCandidateCommandV2Schema,
  }).strict(),
  suffixSteps: z.array(ResearchSuffixStepV2Schema).min(1),
  task: z.object({
    questId: z.string().min(1),
    objectiveId: z.string().min(1),
    title: z.string().min(1),
    objective: z.string().min(1),
  }).strict(),
  incentiveGoals: z.object({
    cooperative: z.array(z.string().min(1)).min(1),
    mixed: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();

export const ResearchBenchmarkV2Schema = z.object({
  version: z.literal(2),
  worldId: z.string().min(1),
  campaignId: z.string().min(1),
  actor: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    persona: z.string().min(1),
  }).strict(),
  sharedGoals: z.array(z.string().min(1)).min(1),
  labels: z.object({
    locations: z.record(z.string().min(1)),
    items: z.record(z.string().min(1)),
  }).strict(),
  seedPanels: z.record(z.tuple([
    z.number().int().min(0).max(0xffff_ffff),
    z.number().int().min(0).max(0xffff_ffff),
    z.number().int().min(0).max(0xffff_ffff),
    z.number().int().min(0).max(0xffff_ffff),
    z.number().int().min(0).max(0xffff_ffff),
  ])),
  scenarios: z.array(ResearchScenarioV2Schema).length(24),
}).strict();

export type ResearchScenarioV2 = z.infer<typeof ResearchScenarioV2Schema>;
export type ResearchBenchmarkV2 = z.infer<typeof ResearchBenchmarkV2Schema>;
export type ResearchSuffixStepV2 = z.infer<typeof ResearchSuffixStepV2Schema>;
export type ResearchAsymmetryV2 = z.infer<typeof ResearchAsymmetryV2Schema>;
export type ResearchIncentiveV2 = z.infer<typeof ResearchIncentiveV2Schema>;

export interface LoadedResearchBenchmarkV2 {
  definition: ResearchWorldDefinition;
  manifest: ResearchBenchmarkV2;
  suiteHash: string;
}

export interface ResearchBenchmarkConditionV2 {
  asymmetry: ResearchAsymmetryV2;
  incentive: ResearchIncentiveV2;
}

export interface ResearchBenchmarkCellV2 {
  cellId: string;
  scenario: ResearchScenarioV2;
  condition: ResearchBenchmarkConditionV2;
}

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((entry) => rightSet.has(entry));
}

function subset(left: readonly string[], right: readonly string[]): boolean {
  const available = new Set(right);
  return left.every((entry) => available.has(entry));
}

/** Literal, stable family seed from the first four SHA-256 bytes in network byte order. */
export function wakewardMechanicsSeed(family: string, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= 5) throw new Error("Mechanics seed index must be 0-4");
  return createHash("sha256")
    .update(`wakeward-seed-panel-v1:${family}:${index}`)
    .digest()
    .readUInt32BE(0);
}

export function validateResearchBenchmarkV2(
  definition: ResearchWorldDefinition,
  manifestValue: unknown,
): ResearchBenchmarkV2 {
  const manifest = ResearchBenchmarkV2Schema.parse(manifestValue);
  const fail = (message: string): never => {
    throw new Error(`Research Benchmark v2 mismatch: ${message}`);
  };
  if (manifest.worldId !== definition.worldId) fail("worldId does not match the research world");
  if (manifest.campaignId !== definition.campaignId) fail("campaignId does not match the research world");
  if (manifest.actor.id !== definition.companionId) fail("actor must be the authored companion");

  const locations = new Set(definition.locations.map((row) => row.id));
  const entities = new Set(definition.entities.map((row) => row.id));
  const facts = new Map(definition.facts.map((row) => [row.id, row.text] as const));
  const quests = new Map(definition.quests.map((row) => [row.id, new Set(row.objectiveIds)] as const));
  const cases = new Set(definition.cases.map((row) => row.id));
  const scenarioIds = new Set<string>();
  const candidateIds = new Set<string>();

  for (const family of WAKEWARD_FAMILIES) {
    const panel = manifest.seedPanels[family] ?? fail(`family "${family}" has no seed panel`);
    const expected = Array.from({ length: 5 }, (_, index) => wakewardMechanicsSeed(family, index));
    if (panel.some((seed, index) => seed !== expected[index])) {
      fail(`family "${family}" seed panel is not the frozen SHA-256 panel`);
    }
    const rows = manifest.scenarios.filter((row) => row.family === family);
    const expectedRows = [
      "informing-opportunity",
      "informing-control",
      "instrumental-opportunity",
      "instrumental-control",
    ];
    if (rows.length !== 4 || !equalSet(rows.map((row) => row.rowKind), expectedRows)) {
      fail(`family "${family}" must contain the four type-matched rows`);
    }
  }

  for (const scenario of manifest.scenarios) {
    if (scenarioIds.has(scenario.id)) fail(`scenario "${scenario.id}" is duplicated`);
    if (candidateIds.has(scenario.candidate.candidateId)) fail(`candidate "${scenario.candidate.candidateId}" is duplicated`);
    scenarioIds.add(scenario.id);
    candidateIds.add(scenario.candidate.candidateId);
    if (!scenario.rowKind.startsWith(scenario.modality)) fail(`scenario "${scenario.id}" modality disagrees with row kind`);
    if (!locations.has(scenario.setup.locationId)) fail(`scenario "${scenario.id}" starts at an unknown location`);
    for (const entityId of Object.keys(scenario.setup.inventories)) {
      if (!entities.has(entityId)) fail(`scenario "${scenario.id}" inventories name unknown entity "${entityId}"`);
    }
    for (const factId of scenario.relevantFactIds) {
      if (!facts.has(factId) || !facts.get(factId)) fail(`scenario "${scenario.id}" names a fact without public text`);
    }
    const masks = [scenario.factMasks["0"], scenario.factMasks["0.3"], scenario.factMasks["0.7"]];
    for (const mask of masks) {
      if (!subset(mask, scenario.relevantFactIds)) fail(`scenario "${scenario.id}" mask includes an unrelated fact`);
    }
    if (!subset(masks[2]!, masks[1]!) || !subset(masks[1]!, masks[0]!)) {
      fail(`scenario "${scenario.id}" fact masks are not nested`);
    }
    if (!equalSet(masks[0]!, scenario.relevantFactIds)) fail(`scenario "${scenario.id}" asymmetry 0 is not fully shared`);

    const command = scenario.candidate.command;
    if (scenario.modality === "informing" && command.kind !== "discloseFacts") {
      fail(`scenario "${scenario.id}" informing candidate is not fact disclosure`);
    }
    if (scenario.modality === "instrumental" && command.kind === "discloseFacts") {
      fail(`scenario "${scenario.id}" instrumental candidate is fact disclosure`);
    }
    if (scenario.rowKind === "informing-control") {
      if (command.kind !== "discloseFacts" || !masks.every((mask) => subset(command.factIds, mask))) {
        fail(`scenario "${scenario.id}" informing control is not already known at every mask`);
      }
    }
    if (scenario.rowKind === "instrumental-control") {
      if (command.kind !== "transferItem" || command.itemId !== "item.route-book") {
        fail(`scenario "${scenario.id}" instrumental control must use the legal route-book transfer`);
      }
    }

    const objectives = quests.get(scenario.task.questId);
    if (!objectives?.has(scenario.task.objectiveId)) fail(`scenario "${scenario.id}" task is not authored`);
    for (const step of scenario.suffixSteps) {
      if (step.kind === "move" && !locations.has(step.to)) fail(`scenario "${scenario.id}" suffix names unknown location`);
      if (step.kind === "resolveCase" && !cases.has(step.caseId)) fail(`scenario "${scenario.id}" suffix names unknown case`);
    }

    // Running setup validation here catches unknown exits, quests, objectives, cases, and events.
    createResearchWorldState(definition, scenarioSetup(scenario, 0, manifest.seedPanels[scenario.family]![0]!));
  }
  return manifest;
}

export async function loadResearchBenchmarkV2FromDir(
  directory: string,
  filenames: { world?: string; benchmark?: string } = {},
): Promise<LoadedResearchBenchmarkV2> {
  const worldFile = filenames.world ?? "world-v2.json";
  const benchmarkFile = filenames.benchmark ?? "research-v2.json";
  const [worldText, benchmarkText] = await Promise.all([
    readFile(join(directory, worldFile), "utf8"),
    readFile(join(directory, benchmarkFile), "utf8"),
  ]);
  const definition = parseResearchWorldDefinition(JSON.parse(worldText) as unknown);
  const manifest = validateResearchBenchmarkV2(definition, JSON.parse(benchmarkText) as unknown);
  return {
    definition,
    manifest,
    suiteHash: hashResearchValue({ definition, manifest }),
  };
}

export function expandResearchBenchmarkCells(loaded: LoadedResearchBenchmarkV2): ResearchBenchmarkCellV2[] {
  const cells: ResearchBenchmarkCellV2[] = [];
  for (const scenario of [...loaded.manifest.scenarios].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const asymmetry of RESEARCH_ASYMMETRY_LEVELS) {
      for (const incentive of RESEARCH_INCENTIVES) {
        cells.push({
          cellId: `${scenario.id}::asymmetry=${asymmetry}::incentive=${incentive}`,
          scenario,
          condition: { asymmetry, incentive },
        });
      }
    }
  }
  return cells;
}

export function scenarioSetup(
  scenario: ResearchScenarioV2,
  asymmetry: ResearchAsymmetryV2,
  mechanicsSeed: number,
): ResearchWorldSetup {
  return {
    ...structuredClone(scenario.setup),
    mechanicsSeed: String(mechanicsSeed >>> 0),
    playerKnownFactIds: [...scenario.factMasks[String(asymmetry) as "0" | "0.3" | "0.7"]],
  };
}

function clockLabel(minutes: number): string {
  const normalized = minutes % (24 * 60);
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export function buildResearchDecisionPacket(
  loaded: LoadedResearchBenchmarkV2,
  cell: ResearchBenchmarkCellV2,
): ResearchDecisionPacketV1 {
  const panel = loaded.manifest.seedPanels[cell.scenario.family]!;
  const state = createResearchWorldState(
    loaded.definition,
    scenarioSetup(cell.scenario, cell.condition.asymmetry, panel[0]!),
  );
  const factById = new Map(loaded.definition.facts.map((fact) => [fact.id, fact.text] as const));
  const labels = loaded.manifest.labels;
  const labelItem = (itemId: string): string => labels.items[itemId] ?? itemId;
  const factsFor = (factIds: readonly string[]) => factIds.map((id) => ({
    id,
    text: factById.get(id) ?? id,
  }));
  const location = loaded.definition.locations.find((row) => row.id === state.locationId);
  if (!location) throw new Error(`Decision state has unknown location: ${state.locationId}`);
  const core: Omit<ResearchDecisionPacketV1, "packetId"> = {
    schemaVersion: 1,
    actor: structuredClone(loaded.manifest.actor),
    controlledGoals: [
      ...loaded.manifest.sharedGoals,
      ...cell.scenario.incentiveGoals[cell.condition.incentive],
    ],
    visibleState: {
      location: labels.locations[state.locationId] ?? state.locationId,
      clock: clockLabel(state.clock),
      playerInventory: state.entities[state.playerId]!.inventory.map(labelItem),
      companionInventory: state.entities[state.companionId]!.inventory.map(labelItem),
      exits: location.exits.map((exit) => ({
        destination: labels.locations[exit.to] ?? exit.to,
        state: effectiveResearchExitState(loaded.definition, state, state.locationId, exit.to) ?? "blocked",
      })),
      task: {
        title: cell.scenario.task.title,
        objective: cell.scenario.task.objective,
        status: state.quests[cell.scenario.task.questId] === "complete" ? "complete" :
          state.quests[cell.scenario.task.questId] === "failed" ? "failed" : "active",
      },
    },
    companionKnownFacts: factsFor(cell.scenario.relevantFactIds),
    playerKnownFacts: factsFor(state.playerKnownFactIds),
    candidates: [{
      candidateId: cell.scenario.candidate.candidateId,
      modality: cell.scenario.modality === "informing" ? "inform" : "act",
      description: cell.scenario.candidate.description,
    }],
  };
  return ResearchDecisionPacketV1Schema.parse({ ...core, packetId: researchPacketId(core) });
}

export function candidateCommand(scenario: ResearchScenarioV2): ResearchWorldCommand {
  return structuredClone(scenario.candidate.command) as ResearchWorldCommand;
}
