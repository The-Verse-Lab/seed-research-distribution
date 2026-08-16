/** Golden parity gate between the legacy GameEngine-backed Wakeward runner and the research kernel. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "bun:test";

import type { Condition, Effect, PlaySet } from "../src/content/schema.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { freeformPlan } from "../src/engine/turn-plan.ts";
import { caseRuntimeOf } from "../src/rules/cases.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { GameState } from "../src/state/types.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import {
  buildResearchPreparation,
  executeResearchPlan,
  instantiateResearchScenario,
  loadResearchSuiteFromDir,
  researchSourceFile,
  researchStateHash,
  type LoadedResearchSuite,
  type PlannedResearchEpisode,
  type ResearchCondition,
  type ResearchEpisodeResult,
  type ResearchPreparationArtifact,
  type ResearchResultsArtifact,
  type ResearchScenario,
} from "../src/research/index.ts";
import {
  ResearchWorldExecutor,
  canonicalResearchJson,
  researchExitKey,
  type ResearchEventCondition,
  type ResearchEventEffect,
  type ResearchWorldDefinition,
  type ResearchWorldState,
} from "../src/research/world/index.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORLD_DIR = join(ROOT, "worlds/wakeward-isles");
const CASE_INPUT = "[research scripted case resolution]";
const CANONICAL_CONDITION = { asymmetry: 0.7, incentive: "cooperative", seed: 1729 } as const;

const PARITY_EXCLUSIONS = [
  {
    field: "narration, transcript prose, and stub-gateway request text",
    reason: "The research kernel intentionally retains mechanics only; prose is not reducer state.",
  },
  {
    field: "legacy full-state hashes versus research-kernel hashes",
    reason: "The schemas intentionally differ, so parity is asserted over the named mechanical projection.",
  },
  {
    field: "HP and energy",
    reason: "The retained kernel has no combat or stamina slice; Wakeward parity still asserts task state and time.",
  },
  {
    field: "relationships, faction standing, coins, and unrelated rewards",
    reason: "These are legacy scoring side channels outside the preregistered task-mechanics projection.",
  },
  {
    field: "location-interaction onCommand events",
    reason: "The scripted research suffix issues only movement and case actions, so these events are unreachable in every original episode.",
  },
  {
    field: "scenario.second-bell.instrumental silence: ev.ferry.confirm and confirm-second-bell",
    reason: "Legacy seeds its event cursor with null, so the first rejected gate attempt spuriously counts as entering the unchanged starting location; the kernel requires a successful move.",
  },
  {
    field: "scenario.true-bearing.instrumental intervention: residual player weather-chart custody",
    reason: "Legacy inventories are multisets: weather collection mints a duplicate chart and posting removes one; the research kernel intentionally normalizes inventory ids as set-like custody.",
  },
] as const;

interface KernelActionProjection {
  kind: "move" | "caseAction";
  targetId: string;
  accepted: boolean;
}

interface KernelEpisodeExecution {
  runnerStatus: ResearchEpisodeResult["runnerStatus"];
  interventionGrounding: ResearchEpisodeResult["intervention"]["grounding"];
  missingRequiredFactIds: string[];
  actions: KernelActionProjection[];
  state: ResearchWorldState;
}

let loaded: LoadedResearchSuite;
let plan: ResearchPreparationArtifact;
let legacyResults: ResearchResultsArtifact;
let definition: ResearchWorldDefinition;

function conditionKey(condition: ResearchCondition): string {
  return `${condition.asymmetry}:${condition.incentive}:${condition.seed}`;
}

function episodeKey(scenarioId: string, condition: ResearchCondition, branch: string): string {
  return `${scenarioId}:${conditionKey(condition)}:${branch}`;
}

function playerIdOf(playset: PlaySet): string {
  const playerId = playset.campaign.startingState.party[0] ?? playset.campaign.characters[0]?.id;
  if (!playerId) throw new Error("Wakeward parity requires a starting player");
  return playerId;
}

function translateCondition(condition: Condition): ResearchEventCondition {
  switch (condition.kind) {
    case "atLocation":
      return { kind: "atLocation", locationId: condition.locationId };
    case "questState":
      return { kind: "questState", questId: condition.questId, state: condition.state };
    case "hasItem":
      return { kind: "hasItem", entityId: condition.entityId, itemId: condition.itemId };
    default:
      throw new Error(`Wakeward parity does not silently translate legacy condition "${condition.kind}"`);
  }
}

function translateEffect(effect: Effect, playerId: string): ResearchEventEffect[] {
  switch (effect.kind) {
    case "narrate":
      return [];
    case "giveItem":
      return [{ kind: "transferItem", itemId: effect.itemId, from: null, to: effect.to ?? playerId }];
    case "transferItem":
      return [{ kind: "transferItem", itemId: effect.itemId, from: effect.from, to: effect.to }];
    case "setExitState":
      return [{ kind: "setExitState", locationId: effect.locationId, to: effect.to, state: effect.state }];
    case "setQuestState":
      return [{ kind: "setQuestState", questId: effect.questId, state: effect.state }];
    case "setObjectiveDone":
      return [{
        kind: "setObjective",
        questId: effect.questId,
        objectiveId: effect.objectiveId,
        done: effect.done,
      }];
    case "revealCaseFact":
      // Legacy case facts are both player knowledge and evidence in the per-case runtime.
      return [
        { kind: "discloseFacts", factIds: [effect.factId] },
        { kind: "revealCaseEvidence", caseId: effect.caseId, factId: effect.factId },
      ];
    default:
      throw new Error(`Wakeward parity does not silently translate legacy effect "${effect.kind}"`);
  }
}

function researchDefinition(suite: LoadedResearchSuite): ResearchWorldDefinition {
  const { playset } = suite;
  const playerId = playerIdOf(playset);
  const companionId = suite.manifest.companionId;
  const caseFacts = playset.campaign.cases.flatMap((caseDefinition) => caseDefinition.facts);
  const factRows = [...(playset.world.facts ?? []), ...caseFacts];
  const facts = [...new Map(factRows.map((fact) => [fact.id, { id: fact.id }])).values()];
  const startingLocation = playset.campaign.startingState.locationId;

  return {
    version: 1,
    worldId: playset.world.id,
    campaignId: playset.campaign.id,
    playerId,
    companionId,
    partyEntityIds: [playerId, companionId],
    entities: [
      ...playset.campaign.characters.map((character) => ({
        id: character.id,
        locationId: character.id === playerId ? startingLocation : null,
        inventory: [...character.inventory],
      })),
      ...playset.world.npcs.map((npc) => ({
        id: npc.id,
        locationId: npc.id === companionId ? startingLocation : null,
        inventory: [...npc.inventory],
      })),
    ],
    locations: playset.world.locations.map((location) => ({
      id: location.id,
      exits: location.exits.map((exit) => ({
        to: exit.to,
        minutes: exit.minutes ?? 30,
        initialState: exit.locked
          ? "locked"
          : exit.barrier?.kind === "rubble"
            ? "blocked"
            : exit.barrier
              ? "locked"
              : "open",
      })),
    })),
    facts,
    quests: playset.campaign.quests.map((quest) => ({
      id: quest.id,
      initialState: "hidden",
      objectiveIds: quest.objectives.map((objective) => objective.id),
    })),
    cases: playset.campaign.cases.map((caseDefinition) => ({
      id: caseDefinition.id,
      questId: caseDefinition.questId,
      culpritId: caseDefinition.truth.culpritId,
      evidenceFactIds: caseDefinition.facts.map((fact) => fact.id),
      requiredEvidenceFactIds: [...caseDefinition.accusation.requiredCoreFacts],
      successEffects: caseDefinition.accusation.successEffects.flatMap((effect) =>
        translateEffect(effect, playerId)
      ),
    })),
    events: playset.campaign.events.filter((event) => event.when === "onEnterLocation").map((event) => {
      if (event.once !== "campaign") {
        throw new Error(`Wakeward parity requires campaign-once enter event semantics for "${event.id}"`);
      }
      return {
        id: event.id,
        when: "onEnterLocation" as const,
        trigger: { allOf: event.trigger.allOf.map(translateCondition) },
        effects: event.effects.flatMap((effect) => translateEffect(effect, playerId)),
        once: "campaign" as const,
      };
    }),
    mechanics: { travelMinuteJitter: 0 },
  };
}

function shortestPath(world: ResearchWorldDefinition, start: string, target: string): string[] | null {
  if (start === target) return [];
  const locations = new Map(world.locations.map((location) => [location.id, location] as const));
  const queue: Array<{ locationId: string; path: string[] }> = [{ locationId: start, path: [] }];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const exit of locations.get(current.locationId)?.exits ?? []) {
      if (seen.has(exit.to)) continue;
      const path = [...current.path, exit.to];
      if (exit.to === target) return path;
      seen.add(exit.to);
      queue.push({ locationId: exit.to, path });
    }
  }
  return null;
}

function setExitOpenBothWays(executor: ResearchWorldExecutor, from: string, to: string): boolean {
  const forward = executor.execute({ kind: "setExitState", locationId: from, to, state: "open" });
  if (!forward.accepted) return false;
  if (definition.locations.find((location) => location.id === to)?.exits.some((exit) => exit.to === from)) {
    const reverse = executor.execute({ kind: "setExitState", locationId: to, to: from, state: "open" });
    if (!reverse.accepted) return false;
  }
  return true;
}

function legacyExit(from: string, to: string) {
  return loaded.playset.world.locations.find((location) => location.id === from)?.exits.find((exit) => exit.to === to);
}

function openWithHeldKeyIfPossible(executor: ResearchWorldExecutor, from: string, to: string): void {
  const exit = legacyExit(from, to);
  const state = executor.snapshot();
  const current = state.exitStates[researchExitKey(from, to)];
  const keyItemId = exit?.barrier?.keyItemId;
  if (current !== "open" && keyItemId && state.entities[state.playerId]?.inventory.includes(keyItemId)) {
    if (!setExitOpenBothWays(executor, from, to)) {
      throw new Error(`Kernel could not apply passive key opening for ${from}->${to}`);
    }
  }
}

function applyKernelIntervention(
  executor: ResearchWorldExecutor,
  episode: PlannedResearchEpisode,
): ResearchEpisodeResult["intervention"]["grounding"] {
  const intervention = episode.plannedIntervention;
  if (intervention.kind === "none") return "no-op";
  if (intervention.kind === "inform") {
    return executor.discloseFacts([...intervention.factIds]).accepted ? "accepted" : "rejected";
  }

  switch (intervention.act.do) {
    case "give":
      return executor.transferItem(
        intervention.act.target,
        loaded.manifest.companionId,
        intervention.act.to ?? null,
      ).accepted
        ? "accepted"
        : "rejected";
    case "open":
      return setExitOpenBothWays(executor, episode.setup.locationId, intervention.act.target)
        ? "accepted"
        : "rejected";
    case "move":
    case "pick":
    case "force":
      throw new Error(`No original Wakeward scenario may require test-only ${intervention.act.do} translation`);
  }
}

function executeKernelEpisode(episode: PlannedResearchEpisode): KernelEpisodeExecution {
  const executor = new ResearchWorldExecutor(definition, {
    setup: {
      locationId: episode.setup.locationId,
      clock: episode.setup.clock,
      mechanicsSeed: String(episode.condition.seed),
      inventories: {
        [definition.playerId]: [...episode.setup.playerInventory],
        [definition.companionId]: [...episode.setup.companionInventory],
      },
      questStates: { ...episode.setup.questStates },
      playerKnownFactIds: [...episode.playerKnownFactIds],
    },
  });
  const interventionGrounding = applyKernelIntervention(executor, episode);
  const missingRequiredFactIds = episode.rollout.requiredFactIds.filter(
    (factId) => !executor.snapshot().playerKnownFactIds.includes(factId),
  );
  const actions: KernelActionProjection[] = [];
  let runnerStatus: ResearchEpisodeResult["runnerStatus"] = "completed";

  if (interventionGrounding === "rejected") {
    runnerStatus = "blocked";
  } else if (missingRequiredFactIds.length > 0) {
    runnerStatus = "policy-withheld";
  } else {
    outer: for (const waypoint of episode.rollout.waypointLocationIds) {
      while (executor.snapshot().locationId !== waypoint) {
        if (actions.length >= episode.suffixHorizonTurns) {
          runnerStatus = "horizon-exhausted";
          break outer;
        }
        const from = executor.snapshot().locationId;
        const path = shortestPath(definition, from, waypoint);
        if (!path || path.length === 0) {
          runnerStatus = "blocked";
          break outer;
        }
        const next = path[0]!;
        openWithHeldKeyIfPossible(executor, from, next);
        const movement = executor.moveParty(next);
        actions.push({ kind: "move", targetId: next, accepted: movement.accepted });
        if (!movement.accepted) {
          // The legacy hard-refusal turn costs one minute; map it through the retained clock command.
          executor.execute({ kind: "advanceClock", minutes: 1 });
          runnerStatus = "blocked";
          break outer;
        }
      }
    }

    if (runnerStatus === "completed" && episode.rollout.terminalCase) {
      if (actions.length >= episode.suffixHorizonTurns) {
        runnerStatus = "horizon-exhausted";
      } else {
        const before = executor.stateHash();
        executor.resolveCase({
          caseId: episode.rollout.terminalCase.caseId,
          suspectId: episode.rollout.terminalCase.suspectId,
          citedEvidenceFactIds: [...episode.rollout.terminalCase.factIds],
        });
        // A legacy case deliberation is a ten-minute player turn even if the proof does not hold.
        executor.execute({ kind: "advanceClock", minutes: 10 });
        actions.push({
          kind: "caseAction",
          targetId: episode.rollout.terminalCase.caseId,
          accepted: before !== executor.stateHash(),
        });
      }
    }
  }

  executor.assertReplayInvariant();
  return {
    runnerStatus,
    interventionGrounding,
    missingRequiredFactIds,
    actions,
    state: executor.snapshot(),
  };
}

function hasLegacyRejectedEntryCursorQuirk(episode: PlannedResearchEpisode): boolean {
  return episode.scenarioId === "scenario.second-bell.instrumental" && episode.branch === "silence";
}

function plannedEpisodeById(id: string): PlannedResearchEpisode {
  const episode = plan.cells.flatMap((cell) => cell.episodes).find((row) => row.episodeId === id);
  if (!episode) throw new Error(`Missing planned episode ${id}`);
  return episode;
}

function finalLegacyLocation(episode: PlannedResearchEpisode, result: ResearchEpisodeResult): string {
  let locationId = episode.setup.locationId;
  for (const action of result.suffix.actions) {
    if (action.kind === "move" && action.accepted) locationId = action.targetId;
  }
  return locationId;
}

function retainedMetricValue(state: ResearchWorldState, metric: PlannedResearchEpisode["outcomeMetrics"][number]) {
  switch (metric.kind) {
    case "questState":
      return state.quests[metric.questId] ?? "hidden";
    case "objective":
      return state.objectives[metric.questId]?.[metric.objectiveId] ?? false;
    case "itemCustody":
      return state.entities[metric.holderId]?.inventory.includes(metric.itemId) ?? false;
    case "clock":
      return state.clock;
    case "coins":
    case "hp":
    case "relationship":
    case "factionStanding":
      return undefined;
  }
}

function metricKey(metric: PlannedResearchEpisode["outcomeMetrics"][number]): string {
  switch (metric.kind) {
    case "questState":
      return `quest:${metric.questId}`;
    case "objective":
      return `objective:${metric.questId}:${metric.objectiveId}`;
    case "itemCustody":
      return `item:${metric.itemId}:${metric.holderId}`;
    case "clock":
      return "clock";
    case "coins":
      return `excluded:coins:${metric.entityId}`;
    case "hp":
      return `excluded:hp:${metric.entityId}`;
    case "relationship":
      return `excluded:relationship:${metric.actorId}:${metric.targetId}`;
    case "factionStanding":
      return `excluded:faction:${metric.pcId}:${metric.factionId}`;
  }
}

function retainedLegacyMetrics(result: ResearchEpisodeResult): Record<string, string | number | boolean> {
  return Object.fromEntries(
    result.outcome.metrics
      .filter((observation) => ["questState", "objective", "itemCustody", "clock"].includes(observation.metric.kind))
      .map((observation) => [metricKey(observation.metric), observation.value]),
  );
}

function retainedKernelMetrics(
  episode: PlannedResearchEpisode,
  state: ResearchWorldState,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    episode.outcomeMetrics.flatMap((metric) => {
      const value = retainedMetricValue(state, metric);
      return value === undefined ? [] : [[metricKey(metric), value] as const];
    }),
  );
}

function passiveLegacyPlayset(playset: PlaySet): PlaySet {
  const clone = structuredClone(playset);
  for (const npc of clone.world.npcs) npc.autonomy.level = "passive";
  clone.world.lore = [];
  return clone;
}

function classifierFor(terminal: PlannedResearchEpisode["rollout"]["terminalCase"]): TurnClassifier {
  return {
    classify(input) {
      if (input === CASE_INPUT && terminal) {
        return Promise.resolve({
          ...freeformPlan(),
          kind: "caseAction",
          targetId: terminal.suspectId,
          case: {
            verb: "accuse",
            suspectId: terminal.suspectId,
            factIds: [...terminal.factIds],
            caseId: terminal.caseId,
          },
          confidence: 1,
        });
      }
      return Promise.resolve(freeformPlan());
    },
  };
}

async function startLegacyEngine(
  playset: PlaySet,
  state: GameState | undefined,
  seed: number,
  terminal: PlannedResearchEpisode["rollout"]["terminalCase"],
): Promise<GameEngine> {
  const store = new InMemoryGameStateStore();
  if (state) {
    await store.save(
      { campaignId: playset.campaign.id, characterId: playerIdOf(playset) },
      structuredClone(state),
    );
  }
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    classifier: classifierFor(terminal),
    rng: mulberry32(seed),
    continuityJudge: false,
    summary: false,
    lore: { k: 1, minScore: 1, cache: false },
    now: () => 0,
  });
  await engine.start();
  return engine;
}

function branchStartState(
  sharedState: GameState,
  playset: PlaySet,
  result: ResearchEpisodeResult,
): GameState {
  const command = result.intervention.command;
  if (!command) return structuredClone(sharedState);
  const model = fromGameState(sharedState, playset.world, playset.campaign);
  const applied = applyCommand(model, command);
  if (applied.rejected) throw new Error(`Recorded accepted intervention now rejects: ${String(applied.rejected)}`);
  return toGameState(model);
}

async function detailedLegacyState(
  playset: PlaySet,
  sharedState: GameState,
  result: ResearchEpisodeResult,
  episode: PlannedResearchEpisode,
): Promise<GameState> {
  const start = branchStartState(sharedState, playset, result);
  if (result.suffix.actions.length === 0) {
    expect(researchStateHash(start), result.episodeId).toBe(result.endStateHash);
    return start;
  }
  const engine = await startLegacyEngine(structuredClone(playset), start, episode.condition.seed, episode.rollout.terminalCase);
  try {
    for (const action of result.suffix.actions) {
      if (action.kind === "move") await engine.submitAction({ kind: "move", exitId: action.targetId });
      else await engine.submitPlayerInput(CASE_INPUT);
    }
    const state = engine.getState();
    expect(researchStateHash(state), result.episodeId).toBe(result.endStateHash);
    return state;
  } finally {
    engine.stop();
  }
}

function scenarioQuestId(scenario: ResearchScenario): string {
  const ids = Object.keys(scenario.setup.questStates);
  if (ids.length !== 1) throw new Error(`${scenario.id} must isolate one task quest`);
  return ids[0]!;
}

function relevantTaskItems(scenario: ResearchScenario): string[] {
  const questId = scenarioQuestId(scenario);
  const items = new Set<string>();
  for (const metric of scenario.outcomeMetrics) if (metric.kind === "itemCustody") items.add(metric.itemId);
  if (scenario.intervention.kind === "act" && scenario.intervention.act.do === "give") {
    items.add(scenario.intervention.act.target);
  }
  if (scenario.intervention.kind === "act" && scenario.intervention.act.do === "open") {
    const exit = legacyExit(scenario.setup.locationId, scenario.intervention.act.target);
    if (exit?.barrier?.keyItemId) items.add(exit.barrier.keyItemId);
  }
  for (const event of loaded.playset.campaign.events) {
    if (!event.trigger.allOf.some((condition) => condition.kind === "questState" && condition.questId === questId)) continue;
    for (const effect of event.effects) {
      if (effect.kind === "giveItem" || effect.kind === "transferItem") items.add(effect.itemId);
    }
  }
  return [...items].sort();
}

function legacyItemHolders(state: GameState, itemId: string): string[] {
  return Object.values(state.actors)
    .filter((actor) => actor.inventory.includes(itemId))
    .map((actor) => actor.id)
    .sort();
}

function kernelItemHolders(state: ResearchWorldState, itemId: string): string[] {
  return Object.entries(state.entities)
    .filter(([, entity]) => entity.inventory.includes(itemId))
    .map(([entityId]) => entityId)
    .sort();
}

function mechanicsProjection(playset: PlaySet, suite: LoadedResearchSuite): unknown {
  const playerId = playerIdOf(playset);
  const companionId = suite.manifest.companionId;
  return {
    startingState: playset.campaign.startingState,
    playerInventory: playset.campaign.characters.find((character) => character.id === playerId)?.inventory,
    companionInventory: playset.world.npcs.find((npc) => npc.id === companionId)?.inventory,
    quests: playset.campaign.quests.map((quest) => ({
      id: quest.id,
      state: quest.state,
      objectives: quest.objectives.map((objective) => objective.id),
    })),
    locations: playset.world.locations.map((location) => ({ id: location.id, exits: location.exits })),
    events: playset.campaign.events,
    cases: playset.campaign.cases,
  };
}

beforeAll(async () => {
  loaded = await loadResearchSuiteFromDir(WORLD_DIR);
  const sourceFiles = await Promise.all(
    ["world.json", "campaign.json", "research.json"].map(async (name) =>
      researchSourceFile(`worlds/wakeward-isles/${name}`, await readFile(join(WORLD_DIR, name)))
    ),
  );
  plan = buildResearchPreparation(loaded, {
    runId: "research-kernel-parity-plan",
    generatedAt: "2026-08-16T00:00:00.000Z",
    worldDir: "worlds/wakeward-isles",
    sourceFiles,
    repository: { commit: "parity-test", dirty: false },
    runtime: { bun: process.versions.bun ?? null, node: process.version },
  });
  legacyResults = await executeResearchPlan(loaded, plan, {
    runId: "research-kernel-parity-results",
    generatedAt: "2026-08-16T00:01:00.000Z",
  });
  definition = researchDefinition(loaded);
});

describe("Wakeward research-kernel parity gate", () => {
  test("covers every original scenario, condition cell, and authored branch", () => {
    expect(loaded.manifest.scenarios).toHaveLength(18);
    expect(plan.design).toMatchObject({
      scenarioCount: 18,
      conditionCellCount: 108,
      plannedEpisodeCount: 180,
    });
    expect(legacyResults.scope).toEqual({
      scenarioIds: loaded.manifest.scenarios.map((scenario) => scenario.id).sort(),
      plannedEpisodes: 180,
      executedEpisodes: 180,
    });
    expect(new Set(legacyResults.episodes.map((episode) => episode.scenarioId)).size).toBe(18);
    expect(legacyResults.episodes.every((episode) => episode.externalModelCalls === 0)).toBe(true);
  });

  test("proves condition changes do not alter retained world mechanics", () => {
    for (const scenario of loaded.manifest.scenarios) {
      const projections = new Set<string>();
      for (const asymmetry of loaded.manifest.asymmetryLevels) {
        const knownByIncentive: string[] = [];
        for (const incentive of loaded.manifest.incentives) {
          const instantiated = instantiateResearchScenario(loaded, scenario.id, {
            asymmetry,
            incentive,
            seed: scenario.rngSeed,
          });
          projections.add(canonicalResearchJson(mechanicsProjection(instantiated.playset, loaded)));
          knownByIncentive.push([...instantiated.playerKnownFactIds].sort().join(","));
        }
        expect(new Set(knownByIncentive).size, `${scenario.id} facts must be incentive-invariant`).toBe(1);
      }
      expect(projections.size, `${scenario.id} retained mechanics must be condition-invariant`).toBe(1);
    }
  });

  test("matches the legacy public mechanical projection for all 180 episodes", () => {
    for (const legacy of legacyResults.episodes) {
      const episode = plannedEpisodeById(legacy.episodeId);
      const kernel = executeKernelEpisode(episode);
      const label = episodeKey(legacy.scenarioId, legacy.condition, legacy.branch);

      expect(kernel.runnerStatus, `${label}: runner status`).toBe(legacy.runnerStatus);
      expect(kernel.interventionGrounding, `${label}: intervention grounding`).toBe(legacy.intervention.grounding);
      expect(kernel.missingRequiredFactIds, `${label}: fact-policy stop`).toEqual(
        legacy.suffix.missingRequiredFactIds,
      );
      expect(
        kernel.state.playerKnownFactIds.filter((factId) => episode.relevantFactIds.includes(factId)),
        `${label}: controlled player facts`,
      ).toEqual(legacy.playerKnownFactIdsAfter);
      expect(kernel.actions, `${label}: suffix actions`).toEqual(
        legacy.suffix.actions.map((action) => ({
          kind: action.kind,
          targetId: action.targetId,
          accepted: action.accepted,
        })),
      );
      expect(kernel.actions.length, `${label}: turns executed`).toBe(legacy.suffix.turnsExecuted);
      expect(kernel.state.locationId, `${label}: final location`).toBe(finalLegacyLocation(episode, legacy));
      expect(retainedKernelMetrics(episode, kernel.state), `${label}: retained outcome metrics`).toEqual(
        retainedLegacyMetrics(legacy),
      );
    }
  });

  test("matches direct legacy state for fired events, cases, objectives, and relevant custody", async () => {
    const canonicalResults = new Map(
      legacyResults.episodes
        .filter(
          (episode) =>
            episode.condition.asymmetry === CANONICAL_CONDITION.asymmetry &&
            episode.condition.incentive === CANONICAL_CONDITION.incentive,
        )
        .map((episode) => [episodeKey(episode.scenarioId, episode.condition, episode.branch), episode]),
    );

    for (const scenario of loaded.manifest.scenarios) {
      const condition = { ...CANONICAL_CONDITION, seed: scenario.rngSeed } satisfies ResearchCondition;
      const instantiated = instantiateResearchScenario(loaded, scenario.id, condition);
      const legacyPlayset = passiveLegacyPlayset(instantiated.playset);
      const prefix = await startLegacyEngine(structuredClone(legacyPlayset), undefined, scenario.rngSeed, undefined);
      const sharedState = prefix.getState();
      prefix.stop();

      const cell = plan.cells.find(
        (candidate) => candidate.scenarioId === scenario.id && conditionKey(candidate.condition) === conditionKey(condition),
      );
      if (!cell) throw new Error(`Missing canonical parity cell for ${scenario.id}`);
      for (const episode of cell.episodes) {
        const key = episodeKey(scenario.id, condition, episode.branch);
        const legacy = canonicalResults.get(key);
        if (!legacy) throw new Error(`Missing canonical legacy result ${key}`);
        const oldState = await detailedLegacyState(legacyPlayset, sharedState, legacy, episode);
        const kernel = executeKernelEpisode(episode).state;
        const questId = scenarioQuestId(scenario);
        const oldObjectives = oldState.modules?.objectives as Record<string, Record<string, boolean>> | undefined;
        const oldEvents = oldState.modules?.events as { fired?: string[] } | undefined;

        expect(kernel.locationId, `${key}: direct location`).toBe(oldState.partyLocationId);
        expect(kernel.clock, `${key}: direct clock`).toBe(oldState.clock);
        expect(kernel.quests[questId], `${key}: direct quest state`).toBe(oldState.quests[questId]);
        const kernelObjectives = { ...(kernel.objectives[questId] ?? {}) };
        const legacyObjectives = Object.fromEntries(
          Object.keys(kernelObjectives).map((objectiveId) => [
            objectiveId,
            oldObjectives?.[questId]?.[objectiveId] ?? false,
          ]),
        );
        const kernelEvents = [...kernel.firedEventIds];
        const legacyEvents = [...(oldEvents?.fired ?? [])];
        if (hasLegacyRejectedEntryCursorQuirk(episode)) {
          expect(legacyObjectives["confirm-second-bell"], `${key}: pinned legacy cursor objective`).toBe(true);
          expect(kernelObjectives["confirm-second-bell"], `${key}: kernel rejects false entry`).toBe(false);
          delete legacyObjectives["confirm-second-bell"];
          delete kernelObjectives["confirm-second-bell"];
          expect(legacyEvents.includes("ev.ferry.confirm"), `${key}: pinned legacy cursor event`).toBe(true);
          expect(kernelEvents.includes("ev.ferry.confirm"), `${key}: kernel excludes false entry`).toBe(false);
          legacyEvents.splice(legacyEvents.indexOf("ev.ferry.confirm"), 1);
        }
        expect(kernelObjectives, `${key}: direct objectives`).toEqual(legacyObjectives);
        expect(kernelEvents, `${key}: authored event cursor`).toEqual(legacyEvents);

        for (const itemId of relevantTaskItems(scenario)) {
          const kernelHolders = kernelItemHolders(kernel, itemId);
          const legacyHolders = legacyItemHolders(oldState, itemId);
          if (
            scenario.id === "scenario.true-bearing.instrumental" &&
            episode.branch === "intervention" &&
            itemId === "item.weather-chart"
          ) {
            expect(legacyHolders.includes(definition.playerId), `${key}: pinned legacy duplicate custody`).toBe(true);
            expect(kernelHolders.includes(definition.playerId), `${key}: normalized kernel custody`).toBe(false);
            legacyHolders.splice(legacyHolders.indexOf(definition.playerId), 1);
          }
          expect(kernelHolders, `${key}: custody of ${itemId}`).toEqual(legacyHolders);
        }

        if (episode.rollout.terminalCase) {
          const caseId = episode.rollout.terminalCase.caseId;
          const oldCase = caseRuntimeOf(oldState.modules, caseId);
          expect(kernel.cases[caseId]?.evidenceFactIds, `${key}: case evidence`).toEqual(
            [...oldCase.playerKnown].sort(),
          );
          expect(kernel.cases[caseId]?.status, `${key}: case status`).toBe(oldCase.status);
        }
      }
    }
  });

  test("pins the intentionally excluded legacy-only fields", () => {
    expect(PARITY_EXCLUSIONS).toEqual([
      {
        field: "narration, transcript prose, and stub-gateway request text",
        reason: "The research kernel intentionally retains mechanics only; prose is not reducer state.",
      },
      {
        field: "legacy full-state hashes versus research-kernel hashes",
        reason: "The schemas intentionally differ, so parity is asserted over the named mechanical projection.",
      },
      {
        field: "HP and energy",
        reason: "The retained kernel has no combat or stamina slice; Wakeward parity still asserts task state and time.",
      },
      {
        field: "relationships, faction standing, coins, and unrelated rewards",
        reason: "These are legacy scoring side channels outside the preregistered task-mechanics projection.",
      },
      {
        field: "location-interaction onCommand events",
        reason: "The scripted research suffix issues only movement and case actions, so these events are unreachable in every original episode.",
      },
      {
        field: "scenario.second-bell.instrumental silence: ev.ferry.confirm and confirm-second-bell",
        reason: "Legacy seeds its event cursor with null, so the first rejected gate attempt spuriously counts as entering the unchanged starting location; the kernel requires a successful move.",
      },
      {
        field: "scenario.true-bearing.instrumental intervention: residual player weather-chart custody",
        reason: "Legacy inventories are multisets: weather collection mints a duplicate chart and posting removes one; the research kernel intentionally normalizes inventory ids as set-like custody.",
      },
    ]);
    const excludedMetricKinds = new Set(
      legacyResults.episodes.flatMap((episode) =>
        episode.outcome.metrics
          .map((observation) => observation.metric.kind)
          .filter((kind) => !["questState", "objective", "itemCustody", "clock"].includes(kind))
      ),
    );
    expect([...excludedMetricKinds].sort()).toEqual(["coins", "factionStanding", "hp", "relationship"]);
  });
});
