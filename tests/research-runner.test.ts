/** Bounded model-free research execution and result artifact contract. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  buildResearchPreparation,
  executeResearchPlan,
  loadResearchSuiteFromDir,
  researchSourceFile,
  writeResearchResultsArtifacts,
  type ResearchPreparationArtifact,
  type ResearchResultsArtifact,
} from "../src/research/index.ts";
import { parseResearchRunArgs } from "../src/research/run.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORLD_DIR = join(ROOT, "worlds/wakeward-isles");
const SELECTED_SCENARIOS = [
  "scenario.cold-passage.informing",
  "scenario.cold-passage.instrumental",
  "scenario.cold-passage.control",
  "scenario.clear-glass.informing",
];

let plan: ResearchPreparationArtifact;
let results: ResearchResultsArtifact;

beforeAll(async () => {
  const loaded = await loadResearchSuiteFromDir(WORLD_DIR);
  const sourceFiles = await Promise.all(
    ["world.json", "campaign.json", "research.json"].map(async (name) =>
      researchSourceFile(`worlds/wakeward-isles/${name}`, await readFile(join(WORLD_DIR, name)))
    ),
  );
  plan = buildResearchPreparation(loaded, {
    runId: "runner-test-plan",
    generatedAt: "2026-08-16T00:00:00.000Z",
    worldDir: "worlds/wakeward-isles",
    sourceFiles,
    repository: { commit: "test", dirty: false },
    runtime: { bun: process.versions.bun ?? null, node: process.version },
  });
  results = await executeResearchPlan(loaded, plan, {
    runId: "runner-test-results",
    generatedAt: "2026-08-16T00:01:00.000Z",
    scenarioIds: SELECTED_SCENARIOS,
  });
});

describe("research run CLI", () => {
  test("requires a plan and accepts bounded scenario filters", () => {
    expect(parseResearchRunArgs([
      "--plan", "scratch/plan.json",
      "--out=results/run-1",
      "--run-id", "run-1",
      "--scenario", "scenario.cold-passage.informing",
      "--scenario=scenario.cold-passage.instrumental",
    ])).toEqual({
      worldDir: "worlds/wakeward-isles",
      planPath: "scratch/plan.json",
      outputDir: "results/run-1",
      runId: "run-1",
      scenarioIds: ["scenario.cold-passage.informing", "scenario.cold-passage.instrumental"],
      help: false,
    });
    expect(() => parseResearchRunArgs([])).toThrow(/--plan is required/);
    expect(() => parseResearchRunArgs(["--plan", "plan.json", "--judge"])).toThrow(/unknown argument/);
  });
});

describe("model-free research runner", () => {
  test("forks matched branches from identical prefixes and records grounded observable evidence", () => {
    expect(results.scope).toEqual({
      scenarioIds: [...SELECTED_SCENARIOS].sort(),
      plannedEpisodes: 42,
      executedEpisodes: 42,
    });
    expect(results.runner).toMatchObject({
      id: "model-free-scripted-v1",
      externalModelCalls: 0,
    });
    expect(results.episodes.every((row) => row.externalModelCalls === 0)).toBe(true);

    for (const pair of results.pairs) {
      const episodes = results.episodes.filter((row) => row.pairingId === pair.pairingId);
      expect(episodes).toHaveLength(2);
      expect(new Set(episodes.map((row) => row.sharedPrefixHash)).size).toBe(1);
      expect(new Set(episodes.map((row) => row.sharedPrefixId)).size).toBe(1);
      expect(episodes.map((row) => row.branch).sort()).toEqual(["intervention", "silence"]);
    }

    const informing = results.episodes.find((row) =>
      row.scenarioId === "scenario.cold-passage.informing" &&
      row.branch === "intervention" &&
      row.condition.asymmetry === 0.7
    );
    expect(informing?.intervention).toMatchObject({ kind: "inform", grounding: "accepted" });
    expect(informing?.suffix.missingRequiredFactIds).toEqual([]);

    const instrumental = results.episodes.find((row) =>
      row.scenarioId === "scenario.cold-passage.instrumental" && row.branch === "intervention"
    );
    expect(instrumental?.intervention).toMatchObject({
      kind: "act",
      grounding: "accepted",
      reasonCode: "closed-candidate-match",
    });
    expect(instrumental?.intervention.command).toBeDefined();
  });

  test("censors mechanically blocked comparisons instead of reporting false verdicts", () => {
    expect(results.summary).toMatchObject({
      pairCount: 18,
      resolvedPairCount: 12,
      censoredPairCount: 6,
    });
    expect(results.pairs.filter((row) => row.scenarioId === "scenario.clear-glass.informing"))
      .toSatisfy((rows: ResearchResultsArtifact["pairs"]) =>
        rows.length === 6 && rows.every((row) =>
          row.comparisonStatus === "censored" && row.verdict === "censored" && row.utilityDelta === null
        )
      );
    expect(results.summary.censoredByReason.some((row) =>
      row.scenarioIds.includes("scenario.clear-glass.informing") && row.reason.includes("loc.highwake-beacon")
    )).toBe(true);
    expect(results.summary.byFamily.map((row) => row.key)).toEqual(["cold-passage"]);
  });
});

describe("research result package", () => {
  test("writes JSONL and verifiable checksums without overwriting prior output", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-research-results-"));
    try {
      const paths = await writeResearchResultsArtifacts(join(scratch, "package"), results);
      const stored = JSON.parse(await readFile(paths.results, "utf8")) as ResearchResultsArtifact;
      expect(stored.resultHash).toBe(results.resultHash);
      expect((await readFile(paths.episodes, "utf8")).trim().split("\n")).toHaveLength(42);

      const checksumLines = (await readFile(paths.checksums, "utf8")).trim().split("\n");
      expect(checksumLines).toHaveLength(3);
      for (const line of checksumLines) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        expect(match).not.toBeNull();
        const contents = await readFile(join(paths.directory, match![2]!));
        expect(createHash("sha256").update(contents).digest("hex")).toBe(match![1]!);
      }
      await expect(writeResearchResultsArtifacts(paths.directory, results)).rejects.toThrow(
        /Refusing to overwrite non-empty result directory/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
