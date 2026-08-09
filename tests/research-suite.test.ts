/** Controlled-scenario contract for the Wakeward research overlay. */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../src/engine/engine.ts";
import { actCandidates, groundToCommand } from "../src/modules/autonomy/grounding.ts";
import {
  instantiateResearchScenario,
  loadResearchSuiteFromDir,
  researchDecisionDiagnostic,
} from "../src/research/index.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

const DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));

describe("ResearchSuite loader and isolation", () => {
  test("loads six matched three-row families with stable public IDs", async () => {
    const loaded = await loadResearchSuiteFromDir(DIR);
    expect(loaded.manifest.scenarios).toHaveLength(18);
    expect(new Set(loaded.manifest.scenarios.map((row) => row.family)).size).toBe(6);
    expect(new Set(loaded.manifest.scenarios.map((row) => row.id)).size).toBe(18);
    expect(new Set(loaded.manifest.scenarios.map((row) => row.opportunityId)).size).toBe(18);
    expect(new Set(loaded.manifest.scenarios.flatMap((row) => row.outcomeMetrics.map((metric) => metric.kind)))).toEqual(
      new Set(["questState", "objective", "itemCustody", "coins", "clock", "hp", "relationship", "factionStanding"]),
    );
    for (const family of new Set(loaded.manifest.scenarios.map((row) => row.family))) {
      const rows = loaded.manifest.scenarios.filter((row) => row.family === family);
      expect(rows.map((row) => row.opportunityKind).sort()).toEqual(["control", "informing", "instrumental"]);
      expect(new Set(rows.map((row) => row.suffixHorizonTurns)).size).toBe(1);
      expect(new Set(rows.flatMap((row) => row.relevantFactIds)).size).toBe(3);
    }
  });

  test("asymmetry changes metadata masks only; incentive changes Mara's goals only", async () => {
    const loaded = await loadResearchSuiteFromDir(DIR);
    const before = structuredClone(loaded.playset);
    const scenario = loaded.manifest.scenarios.find((row) => row.id === "scenario.cold-passage.instrumental")!;
    const low = instantiateResearchScenario(loaded, scenario.id, {
      asymmetry: 0,
      incentive: "cooperative",
      seed: scenario.rngSeed,
    });
    const high = instantiateResearchScenario(loaded, scenario.id, {
      asymmetry: 0.7,
      incentive: "cooperative",
      seed: scenario.rngSeed,
    });
    expect(low.playset).toEqual(high.playset);
    expect(low.playerKnownFactIds).toHaveLength(3);
    expect(high.playerKnownFactIds).toHaveLength(1);
    expect(low.companionKnownFactIds).toEqual(high.companionKnownFactIds);

    const mixed = instantiateResearchScenario(loaded, scenario.id, {
      asymmetry: 0,
      incentive: "mixed",
      seed: scenario.rngSeed,
    });
    const cooperativeWithoutGoals = structuredClone(low.playset);
    const mixedWithoutGoals = structuredClone(mixed.playset);
    cooperativeWithoutGoals.world.npcs.find((row) => row.id === loaded.manifest.companionId)!.goals = [];
    mixedWithoutGoals.world.npcs.find((row) => row.id === loaded.manifest.companionId)!.goals = [];
    expect(cooperativeWithoutGoals).toEqual(mixedWithoutGoals);
    expect(
      low.playset.world.npcs.find((row) => row.id === loaded.manifest.companionId)!.goals,
    ).not.toEqual(mixed.playset.world.npcs.find((row) => row.id === loaded.manifest.companionId)!.goals);
    expect(loaded.playset).toEqual(before);
  });

  test("rejects RNG drift across otherwise matched conditions", async () => {
    const loaded = await loadResearchSuiteFromDir(DIR);
    const scenario = loaded.manifest.scenarios[0]!;
    expect(() => instantiateResearchScenario(loaded, scenario.id, {
      asymmetry: 0.3,
      incentive: "cooperative",
      seed: scenario.rngSeed + 1,
    })).toThrow(/fixed scenario seed/);
  });
});

describe("Research interventions are legal and mechanically observable", () => {
  test("every instrumental action is offered by the existing closed grounder", async () => {
    const loaded = await loadResearchSuiteFromDir(DIR);
    for (const scenario of loaded.manifest.scenarios.filter((row) => row.opportunityKind === "instrumental")) {
      if (scenario.intervention.kind !== "act") throw new Error(`fixture: ${scenario.id} is not an act`);
      const instantiated = instantiateResearchScenario(loaded, scenario.id, {
        asymmetry: 0.7,
        incentive: "cooperative",
        seed: scenario.rngSeed,
      });
      const engine = new GameEngine({
        classifier: heuristicClassifier,
        playset: instantiated.playset,
        store: new InMemoryGameStateStore(),
        gateway: new OfflineGateway(),
        rng: mulberry32(scenario.rngSeed),
      });
      await engine.start();
      const model = fromGameState(engine.getState(), instantiated.playset.world, instantiated.playset.campaign);
      const act = scenario.intervention.act;
      const candidates = actCandidates(loaded.manifest.companionId, model, instantiated.playset.world);
      const targets = candidates[act.do];
      expect(Array.isArray(targets) && targets.some((row) => row.id === act.target), scenario.id).toBe(true);
      const grounded = groundToCommand(
        loaded.manifest.companionId,
        act,
        model,
        instantiated.playset.world,
      );
      expect(grounded.fellBack, scenario.id).toBe(false);
      expect(grounded.action.kind, scenario.id).toBe("command");
      if (grounded.action.kind !== "command") throw new Error(`fixture: ${scenario.id} did not ground`);

      const silence = toGameState(fromGameState(engine.getState(), instantiated.playset.world, instantiated.playset.campaign));
      const acted = fromGameState(engine.getState(), instantiated.playset.world, instantiated.playset.campaign);
      expect(applyCommand(acted, grounded.action.command).rejected, scenario.id).toBeFalsy();
      const actionState = toGameState(acted);
      expect(actionState, `${scenario.id} must change mechanical state`).not.toEqual(silence);

      const diagnostic = researchDecisionDiagnostic(instantiated, {
        grounding: "accepted",
        reasonCode: "closed-candidate-match",
        outcome: { stateChanged: true },
      });
      expect(diagnostic).toMatchObject({
        scenarioId: scenario.id,
        opportunityId: scenario.opportunityId,
        grounding: "accepted",
        reasonCode: "closed-candidate-match",
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/reasoning|chain.of.thought/i);
      engine.stop();
    }
  });

  test("control rows preserve a correct explicit no-op diagnostic", async () => {
    const loaded = await loadResearchSuiteFromDir(DIR);
    for (const scenario of loaded.manifest.scenarios.filter((row) => row.opportunityKind === "control")) {
      const instantiated = instantiateResearchScenario(loaded, scenario.id, {
        asymmetry: 0.3,
        incentive: "mixed",
        seed: scenario.rngSeed,
      });
      expect(instantiated.scenario.intervention).toEqual({ kind: "none" });
      const diagnostic = researchDecisionDiagnostic(instantiated, {
        grounding: "no-op",
        reasonCode: "already-satisfied",
        factIdsUsed: [],
        outcome: { stateChanged: false },
      });
      expect(diagnostic.grounding).toBe("no-op");
      expect(diagnostic.outcome.stateChanged).toBe(false);
      expect(diagnostic.proposedIntervention).toEqual({ kind: "none" });
    }
  });
});
