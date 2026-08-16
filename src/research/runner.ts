/**
 * Bounded, no-network counterfactual execution for prepared Wakeward research episodes.
 *
 * Each condition is instantiated once as a shared prefix. Intervention and silence branches start
 * from that exact state, receive at most the authored branch intervention, and run the same explicit
 * waypoint policy under the same seed. The engine and reducer remain authoritative for movement,
 * events, barriers, quests, and case resolution.
 *
 * @author Runkai Zhang
 */
import type { GameEvent } from "../events/types.ts";
import { GameEngine } from "../engine/engine.ts";
import type { TurnClassifier } from "../engine/classify.ts";
import { freeformPlan } from "../engine/turn-plan.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../llm/types.ts";
import { groundToCommand } from "../modules/autonomy/grounding.ts";
import { mulberry32 } from "../rules/dice.ts";
import { factionStandingOf } from "../rules/factions.ts";
import type { GameState } from "../state/types.ts";
import type { CommittedSnapshot, EventQuery, GameStateStore, SaveKey } from "../state/store.ts";
import { fromGameState, toGameState } from "../world/model.ts";
import { applyCommand } from "../world/reducer.ts";
import type { PlaySet, World } from "../content/schema.ts";
import type { ResearchPreparationArtifact, PlannedResearchEpisode } from "./artifacts.ts";
import { instantiateResearchScenario, type LoadedResearchSuite, type ResearchOutcomeMetric } from "./scenario.ts";
import {
  MODEL_FREE_RUNNER_ID,
  RESEARCH_RESULTS_SCHEMA_VERSION,
  buildResearchResultsArtifact,
  researchStateHash,
  type ResearchEpisodeResult,
  type ResearchInterventionReceipt,
  type ResearchMetricObservation,
  type ResearchResultsArtifact,
  type ResearchSuffixAction,
} from "./results.ts";

const CASE_INPUT = "[research scripted case resolution]";
const STUB_NARRATION = "The scripted action resolves in the recorded world state.";

/** One-save, in-process store used only for isolated research branches. */
class ResearchMemoryStore implements GameStateStore {
  private state: GameState | null;
  private events: GameEvent[] = [];

  constructor(state?: GameState) {
    this.state = state ? structuredClone(state) : null;
  }

  load(_key: SaveKey): Promise<GameState | null> {
    return Promise.resolve(this.state ? structuredClone(this.state) : null);
  }

  save(_key: SaveKey, state: GameState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }

  appendEvent(_key: SaveKey, event: GameEvent): Promise<void> {
    if (this.events.some((row) => row.seq === event.seq)) return Promise.reject(new Error(`duplicate event seq ${event.seq}`));
    this.events.push(structuredClone(event));
    this.events.sort((left, right) => left.seq - right.seq);
    return Promise.resolve();
  }

  readEvents(_key: SaveKey, query: EventQuery = {}): Promise<GameEvent[]> {
    let rows = this.events;
    if (query.sinceSeq !== undefined) rows = rows.filter((row) => row.seq >= query.sinceSeq!);
    if (query.beforeSeq !== undefined) rows = rows.filter((row) => row.seq < query.beforeSeq!);
    if (query.includeSilent === false) rows = rows.filter((row) => row.silent !== true);
    if (query.limit !== undefined) rows = rows.slice(-query.limit);
    return Promise.resolve(rows.map((row) => structuredClone(row)));
  }

  loadCommitted(_key: SaveKey): Promise<CommittedSnapshot | null> {
    if (!this.state) return Promise.resolve(null);
    return Promise.resolve({
      state: structuredClone(this.state),
      eventSeq: this.events.reduce((max, row) => Math.max(max, row.seq), -1),
      replayableFromOrigin: false,
    });
  }

  commitTurn(_key: SaveKey, state: GameState, events: readonly GameEvent[]): Promise<void> {
    const seen = new Set(this.events.map((row) => row.seq));
    for (const event of events) {
      if (seen.has(event.seq)) return Promise.reject(new Error(`duplicate event seq ${event.seq}`));
      seen.add(event.seq);
    }
    this.events = [...this.events, ...events.map((row) => structuredClone(row))]
      .sort((left, right) => left.seq - right.seq);
    this.state = structuredClone(state);
    return Promise.resolve();
  }

  replaceSave(
    _key: SaveKey,
    state: GameState,
    events: readonly GameEvent[] = [],
  ): Promise<void> {
    this.state = structuredClone(state);
    this.events = events.map((row) => structuredClone(row)).sort((left, right) => left.seq - right.seq);
    return Promise.resolve();
  }
}

/** Deterministic local stub. Requests are counted, but no endpoint, model, or network is contacted. */
class ResearchStubGateway implements LlmGateway {
  readonly requests = { complete: 0, stream: 0, embed: 0 };

  complete(_role: LlmRole, _request: CompletionRequest): Promise<CompletionResult> {
    this.requests.complete++;
    return Promise.resolve({ text: STUB_NARRATION, model: MODEL_FREE_RUNNER_ID });
  }

  async *stream(_role: LlmRole, _request: CompletionRequest): AsyncIterable<CompletionChunk> {
    this.requests.stream++;
    yield { delta: STUB_NARRATION, done: false };
    yield { delta: "", done: true };
  }

  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    this.requests.embed++;
    return Promise.resolve({ vectors: texts.map(() => [0]), model: MODEL_FREE_RUNNER_ID });
  }
}

function executionPlayset(playset: PlaySet): PlaySet {
  const clone = structuredClone(playset);
  // One authored intervention is the treatment. Suppress later autonomous beats in both suffixes.
  for (const npc of clone.world.npcs) npc.autonomy.level = "passive";
  // Avoid even local embedding-stub work; the scripted suffix never consumes narration or retrieval.
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

function engineFor(playset: PlaySet, state: GameState | undefined, seed: number, terminal: PlannedResearchEpisode["rollout"]["terminalCase"]) {
  const gateway = new ResearchStubGateway();
  const store = new ResearchMemoryStore(state);
  const engine = new GameEngine({
    playset,
    store,
    gateway,
    classifier: classifierFor(terminal),
    rng: mulberry32(seed),
    continuityJudge: false,
    summary: false,
    lore: { k: 1, minScore: 1, cache: false },
    now: () => 0,
  });
  return { engine, gateway, store };
}

function shortestPath(world: World, start: string, target: string): string[] | null {
  if (start === target) return [];
  const locations = new Map(world.locations.map((row) => [row.id, row] as const));
  const queue: Array<{ locationId: string; path: string[] }> = [{ locationId: start, path: [] }];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const location = locations.get(current.locationId);
    if (!location) continue;
    for (const exit of location.exits) {
      if (seen.has(exit.to)) continue;
      const path = [...current.path, exit.to];
      if (exit.to === target) return path;
      seen.add(exit.to);
      queue.push({ locationId: exit.to, path });
    }
  }
  return null;
}

function objectiveValue(state: GameState, questId: string, objectiveId: string): boolean {
  const objectives = state.modules?.objectives as Record<string, Record<string, boolean>> | undefined;
  return objectives?.[questId]?.[objectiveId] ?? false;
}

function metricObservation(state: GameState, metric: ResearchOutcomeMetric): ResearchMetricObservation {
  switch (metric.kind) {
    case "questState": {
      const value = state.quests[metric.questId] ?? "hidden";
      const desiredSatisfied = value === metric.desired;
      return { metric: structuredClone(metric), value, desiredSatisfied, utility: desiredSatisfied ? metric.weight : 0 };
    }
    case "objective": {
      const value = objectiveValue(state, metric.questId, metric.objectiveId);
      const desiredSatisfied = value === metric.desired;
      return { metric: structuredClone(metric), value, desiredSatisfied, utility: desiredSatisfied ? metric.weight : 0 };
    }
    case "itemCustody": {
      const value = state.actors[metric.holderId]?.inventory.includes(metric.itemId) ?? false;
      return { metric: structuredClone(metric), value, desiredSatisfied: value, utility: value ? metric.weight : 0 };
    }
    case "coins": {
      const value = state.actors[metric.entityId]?.coins ?? 0;
      return { metric: structuredClone(metric), value, utility: metric.direction === "maximize" ? value * metric.weight : -value * metric.weight };
    }
    case "clock": {
      const value = state.clock;
      return { metric: structuredClone(metric), value, utility: metric.direction === "maximize" ? value * metric.weight : -value * metric.weight };
    }
    case "hp": {
      const value = state.actors[metric.entityId]?.currentHp ?? 0;
      return { metric: structuredClone(metric), value, utility: metric.direction === "maximize" ? value * metric.weight : -value * metric.weight };
    }
    case "relationship": {
      const value = state.relationships[metric.actorId]?.[metric.targetId] ?? 0;
      return { metric: structuredClone(metric), value, utility: metric.direction === "maximize" ? value * metric.weight : -value * metric.weight };
    }
    case "factionStanding": {
      const value = factionStandingOf(state.modules, metric.pcId, metric.factionId);
      return { metric: structuredClone(metric), value, utility: metric.direction === "maximize" ? value * metric.weight : -value * metric.weight };
    }
  }
}

function observedOutcome(state: GameState, metrics: readonly ResearchOutcomeMetric[]) {
  const observations = metrics.map((metric) => metricObservation(state, metric));
  const desired = observations.filter((row) => row.desiredSatisfied !== undefined);
  return {
    score: Number(observations.reduce((sum, row) => sum + row.utility, 0).toFixed(6)),
    desiredMetricsSatisfied: desired.filter((row) => row.desiredSatisfied).length,
    desiredMetricsTotal: desired.length,
    metrics: observations,
  };
}

function applyIntervention(
  sharedState: GameState,
  playset: PlaySet,
  episode: PlannedResearchEpisode,
  companionId: string,
): { state: GameState; facts: string[]; receipt: ResearchInterventionReceipt } {
  const facts = new Set(episode.playerKnownFactIds);
  const intervention = episode.plannedIntervention;
  if (intervention.kind === "none") {
    return {
      state: structuredClone(sharedState),
      facts: [...facts].sort(),
      receipt: { kind: "none", grounding: "no-op", reasonCode: "silence-branch", factsAdded: [], deltas: [] },
    };
  }
  if (intervention.kind === "inform") {
    const factsAdded = intervention.factIds.filter((factId) => !facts.has(factId));
    for (const factId of intervention.factIds) facts.add(factId);
    return {
      state: structuredClone(sharedState),
      facts: [...facts].sort(),
      receipt: {
        kind: "inform",
        grounding: "accepted",
        reasonCode: factsAdded.length > 0 ? "authored-facts-added" : "facts-already-known",
        factsAdded,
        deltas: [],
      },
    };
  }

  const model = fromGameState(sharedState, playset.world, playset.campaign);
  const grounded = groundToCommand(companionId, intervention.act, model, playset.world);
  if (grounded.fellBack || grounded.action.kind !== "command") {
    return {
      state: structuredClone(sharedState),
      facts: [...facts].sort(),
      receipt: { kind: "act", grounding: "rejected", reasonCode: "closed-grounding-rejected", factsAdded: [], deltas: [] },
    };
  }
  const applied = applyCommand(model, grounded.action.command);
  return {
    state: toGameState(model),
    facts: [...facts].sort(),
    receipt: {
      kind: "act",
      grounding: applied.rejected ? "rejected" : "accepted",
      reasonCode: applied.rejected
        ? typeof applied.rejected === "string"
          ? applied.rejected
          : applied.rejected.reason
        : "closed-candidate-match",
      factsAdded: [],
      command: structuredClone(grounded.action.command),
      deltas: structuredClone(applied.deltas),
    },
  };
}

async function executeEpisode(options: {
  episode: PlannedResearchEpisode;
  plan: ResearchPreparationArtifact;
  playset: PlaySet;
  sharedState: GameState;
  companionId: string;
}): Promise<ResearchEpisodeResult> {
  const { episode, plan, playset, sharedState, companionId } = options;
  const sharedPrefixHash = researchStateHash(sharedState);
  const applied = applyIntervention(sharedState, playset, episode, companionId);
  const branchStartHash = researchStateHash(applied.state);
  const missingRequiredFactIds = episode.rollout.requiredFactIds.filter((factId) => !applied.facts.includes(factId));
  const actions: ResearchSuffixAction[] = [];
  let endState = structuredClone(applied.state);
  let status: ResearchEpisodeResult["runnerStatus"] = "completed";
  let runnerNote: string | undefined;
  const gatewayRequests = { complete: 0, stream: 0, embed: 0 };

  if (applied.receipt.grounding === "rejected") {
    status = "blocked";
    runnerNote = "The authored intervention did not ground at the shared decision state.";
  } else if (missingRequiredFactIds.length > 0) {
    status = "policy-withheld";
    runnerNote = `The scripted policy lacked required facts: ${missingRequiredFactIds.join(", ")}`;
  } else {
    const branchPlayset = structuredClone(playset);
    const { engine, gateway } = engineFor(branchPlayset, applied.state, episode.condition.seed, episode.rollout.terminalCase);
    try {
      await engine.start();
      outer: for (const waypoint of episode.rollout.waypointLocationIds) {
        while (engine.getState().partyLocationId !== waypoint) {
          if (actions.length >= episode.suffixHorizonTurns) {
            status = "horizon-exhausted";
            runnerNote = `Suffix horizon ended before waypoint ${waypoint}.`;
            break outer;
          }
          const before = engine.getState();
          const path = shortestPath(branchPlayset.world, before.partyLocationId, waypoint);
          if (!path || path.length === 0) {
            status = "blocked";
            runnerNote = `No authored route from ${before.partyLocationId} to ${waypoint}.`;
            break outer;
          }
          const next = path[0]!;
          await engine.submitAction({ kind: "move", exitId: next });
          const after = engine.getState();
          const accepted = after.partyLocationId === next;
          actions.push({
            turn: actions.length + 1,
            kind: "move",
            targetId: next,
            accepted,
            beforeStateHash: researchStateHash(before),
            afterStateHash: researchStateHash(after),
          });
          if (!accepted) {
            status = "blocked";
            runnerNote = `Movement to ${next} was rejected by the engine.`;
            break outer;
          }
        }
      }
      if (status === "completed" && episode.rollout.terminalCase) {
        if (actions.length >= episode.suffixHorizonTurns) {
          status = "horizon-exhausted";
          runnerNote = "Suffix horizon ended before the terminal case action.";
        } else {
          const before = engine.getState();
          await engine.submitPlayerInput(CASE_INPUT);
          const after = engine.getState();
          actions.push({
            turn: actions.length + 1,
            kind: "caseAction",
            targetId: episode.rollout.terminalCase.caseId,
            accepted: researchStateHash(before) !== researchStateHash(after),
            beforeStateHash: researchStateHash(before),
            afterStateHash: researchStateHash(after),
          });
        }
      }
      endState = engine.getState();
    } catch (error) {
      status = "error";
      runnerNote = error instanceof Error ? error.message : String(error);
      try {
        endState = engine.getState();
      } catch {
        endState = structuredClone(applied.state);
      }
    } finally {
      engine.stop();
      Object.assign(gatewayRequests, gateway.requests);
    }
  }

  return {
    schemaVersion: RESEARCH_RESULTS_SCHEMA_VERSION,
    artifactKind: "seed.research.episode-result",
    planId: plan.planId,
    planHash: plan.planHash,
    sourceDigest: plan.source.sourceDigest,
    episodeId: episode.episodeId,
    pairingId: episode.pairingId,
    sharedPrefixId: episode.sharedPrefixId,
    scenarioId: episode.scenarioId,
    family: episode.family,
    opportunityKind: episode.opportunityKind,
    branch: episode.branch,
    condition: structuredClone(episode.condition),
    runnerId: MODEL_FREE_RUNNER_ID,
    runnerStatus: status,
    ...(runnerNote ? { runnerNote } : {}),
    externalModelCalls: 0,
    stubGatewayRequests: gatewayRequests,
    sharedPrefixHash,
    branchStartHash,
    endStateHash: researchStateHash(endState),
    playerKnownFactIdsBefore: [...episode.playerKnownFactIds].sort(),
    playerKnownFactIdsAfter: applied.facts,
    intervention: applied.receipt,
    suffix: {
      horizonTurns: episode.suffixHorizonTurns,
      turnsExecuted: actions.length,
      waypointLocationIds: [...episode.rollout.waypointLocationIds],
      requiredFactIds: [...episode.rollout.requiredFactIds],
      missingRequiredFactIds,
      actions,
    },
    outcome: observedOutcome(endState, episode.outcomeMetrics),
  };
}

export interface ExecuteResearchPlanOptions {
  runId: string;
  generatedAt: string;
  scenarioIds?: string[];
}

export async function executeResearchPlan(
  loaded: LoadedResearchSuite,
  plan: ResearchPreparationArtifact,
  options: ExecuteResearchPlanOptions,
): Promise<ResearchResultsArtifact> {
  if (plan.artifactKind !== "seed.research.preparation") throw new Error("Research runner requires a preparation artifact");
  if (plan.source.worldId !== loaded.manifest.worldId || plan.source.campaignId !== loaded.manifest.campaignId) {
    throw new Error("Research plan world/campaign does not match the loaded suite");
  }
  const selected = new Set(options.scenarioIds ?? loaded.manifest.scenarios.map((row) => row.id));
  const known = new Set(loaded.manifest.scenarios.map((row) => row.id));
  for (const scenarioId of selected) if (!known.has(scenarioId)) throw new Error(`Unknown selected research scenario: ${scenarioId}`);
  const cells = plan.cells.filter((cell) => selected.has(cell.scenarioId));
  const episodes: ResearchEpisodeResult[] = [];

  for (const cell of cells) {
    const scenario = loaded.manifest.scenarios.find((row) => row.id === cell.scenarioId);
    if (!scenario) throw new Error(`Plan references unknown research scenario: ${cell.scenarioId}`);
    const instantiated = instantiateResearchScenario(loaded, scenario.id, cell.condition);
    const playset = executionPlayset(instantiated.playset);
    const prefix = engineFor(structuredClone(playset), undefined, scenario.rngSeed, undefined);
    let sharedState: GameState;
    try {
      await prefix.engine.start();
      sharedState = prefix.engine.getState();
    } finally {
      prefix.engine.stop();
    }
    for (const episode of cell.episodes) {
      episodes.push(await executeEpisode({ episode, plan, playset, sharedState, companionId: loaded.manifest.companionId }));
    }
  }

  return buildResearchResultsArtifact({
    runId: options.runId,
    generatedAt: options.generatedAt,
    planId: plan.planId,
    planHash: plan.planHash,
    sourceDigest: plan.source.sourceDigest,
    scenarioIds: [...selected],
    plannedEpisodes: cells.flatMap((cell) => cell.episodes).length,
    episodes,
  });
}
