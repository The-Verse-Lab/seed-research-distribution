/** Model-free experiment preparation and artifact contract. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  buildResearchPreparation,
  researchPreparationJson,
  researchSourceFile,
  writeResearchPreparationArtifacts,
  type BuildResearchPreparationOptions,
  type LoadedResearchSuite,
} from "../src/research/index.ts";
import { parseResearchPreparationArgs } from "../src/research/prepare.ts";
import { loadResearchSuiteFromDir } from "../src/research/scenario.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORLD_DIR = join(ROOT, "worlds/wakeward-isles");

async function fixture(): Promise<{ loaded: LoadedResearchSuite; options: BuildResearchPreparationOptions }> {
  const loaded = await loadResearchSuiteFromDir(WORLD_DIR);
  const sourceFiles = await Promise.all(
    ["world.json", "campaign.json", "research.json"].map(async (name) =>
      researchSourceFile(`worlds/wakeward-isles/${name}`, await readFile(join(WORLD_DIR, name)))
    ),
  );
  return {
    loaded,
    options: {
      runId: "test-preparation",
      generatedAt: "2026-08-09T12:00:00.000Z",
      worldDir: "worlds/wakeward-isles",
      sourceFiles,
      repository: { commit: "96017b7", dirty: false },
      runtime: { bun: "1.3.0", node: "v22.0.0" },
    },
  };
}

describe("research preparation plan", () => {
  test("enumerates the complete controlled design without inventing results", async () => {
    const { loaded, options } = await fixture();
    const artifact = buildResearchPreparation(loaded, options);
    const episodes = artifact.cells.flatMap((cell) => cell.episodes);

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      artifactKind: "seed.research.preparation",
      execution: {
        status: "not-run",
        runnerStatus: "available-model-free-scripted-v1",
        modelCalls: 0,
        outcomeRecords: 0,
      },
      design: {
        scenarioCount: 18,
        conditionCellCount: 108,
        plannedEpisodeCount: 180,
        interventionEpisodeCount: 72,
        silenceEpisodeCount: 108,
      },
    });
    expect(artifact.cells).toHaveLength(18 * 3 * 2);
    expect(new Set(artifact.cells.map((cell) => cell.cellId)).size).toBe(artifact.cells.length);
    expect(new Set(episodes.map((episode) => episode.episodeId)).size).toBe(episodes.length);

    for (const cell of artifact.cells) {
      const scenario = loaded.manifest.scenarios.find((row) => row.id === cell.scenarioId)!;
      expect(cell.condition.seed).toBe(scenario.rngSeed);
      expect(cell.pairedScenarioId).toBe(scenario.pairedScenarioId);
      expect(cell.controlScenarioId).toBe(scenario.controlScenarioId);
      expect(new Set(cell.episodes.map((episode) => episode.pairingId))).toEqual(new Set([cell.cellId]));
      expect(new Set(cell.episodes.map((episode) => episode.sharedPrefixId)).size).toBe(1);
      if (cell.opportunityKind === "control") {
        expect(cell.episodes.map((episode) => episode.branch)).toEqual(["silence"]);
      } else {
        expect(cell.episodes.map((episode) => episode.branch)).toEqual(["intervention", "silence"]);
      }
      for (const episode of cell.episodes) {
        expect(episode.status).toBe("planned");
        const mask = scenario.factMasks[String(cell.condition.asymmetry) as "0" | "0.3" | "0.7"];
        expect(episode.playerKnownFactIds).toEqual(mask.playerKnownFactIds);
        expect(episode.companionKnownFactIds).toEqual(mask.companionKnownFactIds);
        expect(episode.companionGoals).toEqual([
          ...loaded.manifest.sharedCompanionGoals,
          ...scenario.incentiveGoals[cell.condition.incentive],
        ]);
        expect(episode.setup).toEqual(scenario.setup);
        expect(episode.rollout).toEqual(scenario.rollout);
        if (episode.branch === "silence") {
          expect(episode.plannedIntervention).toEqual({ kind: "none" });
          expect(episode.interventionBudget).toBe(0);
        }
      }
    }

    const json = researchPreparationJson(artifact);
    expect(json).not.toMatch(/"result"|"score"|"winner"/i);
    expect(json).not.toMatch(/chain.of.thought|hidden reasoning/i);
  });

  test("keeps the plan hash stable while generation provenance remains auditable", async () => {
    const { loaded, options } = await fixture();
    const first = buildResearchPreparation(loaded, options);
    const regenerated = buildResearchPreparation(loaded, {
      ...options,
      runId: "later-preparation",
      generatedAt: "2026-08-10T12:00:00.000Z",
      repository: { commit: "different-worktree", dirty: true },
      runtime: { bun: "9.9.9", node: "v99.0.0" },
      sourceFiles: [...options.sourceFiles].reverse(),
    });
    expect(regenerated.planId).toBe(first.planId);
    expect(regenerated.planHash).toBe(first.planHash);
    expect(regenerated.artifactHash).not.toBe(first.artifactHash);

    const changedSource = structuredClone(options.sourceFiles);
    changedSource[0] = { ...changedSource[0]!, sha256: "f".repeat(64) };
    const changed = buildResearchPreparation(loaded, { ...options, sourceFiles: changedSource });
    expect(changed.planHash).not.toBe(first.planHash);
  });

  test("parses a bounded, model-free preparation CLI", () => {
    expect(parseResearchPreparationArgs([])).toEqual({ worldDir: "worlds/wakeward-isles", help: false });
    expect(parseResearchPreparationArgs(["custom/world", "--out", "scratch/run", "--run-id=trial-1"])).toEqual({
      worldDir: "custom/world",
      outputDir: "scratch/run",
      runId: "trial-1",
      help: false,
    });
    expect(() => parseResearchPreparationArgs(["--judge"])).toThrow(/unknown flag/);
  });
});

describe("research preparation package", () => {
  test("writes scheduler JSONL and verifiable checksums without overwriting prior output", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-research-preparation-"));
    try {
      const { loaded, options } = await fixture();
      const artifact = buildResearchPreparation(loaded, options);
      const paths = await writeResearchPreparationArtifacts(join(scratch, "package"), artifact);
      const plan = JSON.parse(await readFile(paths.plan, "utf8")) as { planHash: string };
      expect(plan.planHash).toBe(artifact.planHash);

      const episodeLines = (await readFile(paths.episodes, "utf8")).trim().split("\n");
      expect(episodeLines).toHaveLength(180);
      expect(JSON.parse(episodeLines[0]!) as object).toMatchObject({
        artifactKind: "seed.research.planned-episode",
        planId: artifact.planId,
        status: "planned",
      });

      const checksumLines = (await readFile(paths.checksums, "utf8")).trim().split("\n");
      expect(checksumLines).toHaveLength(3);
      for (const line of checksumLines) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        expect(match).not.toBeNull();
        const expectedHash = match?.[1];
        const filename = match?.[2];
        if (!expectedHash || !filename) throw new Error(`invalid checksum fixture: ${line}`);
        const contents = await readFile(join(paths.directory, filename));
        expect(createHash("sha256").update(contents).digest("hex")).toBe(expectedHash);
      }

      await expect(writeResearchPreparationArtifacts(paths.directory, artifact)).rejects.toThrow(
        /Refusing to overwrite non-empty artifact directory/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
