import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadResearchBenchmarkV2FromDir } from "../src/research/benchmark.ts";
import { qualifyResearchBenchmarkV2 } from "../src/research/qualification.ts";

const DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));

describe("Benchmark v2 oracle qualification", () => {
  test("qualifies all 1,440 deterministic branches with stable task-success labels", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(DIR);
    const result = qualifyResearchBenchmarkV2(loaded, "2026-08-16T00:00:00.000Z");
    expect(result).toMatchObject({
      executionCount: 1440,
      qualified: true,
      failures: [],
    });
    expect(result.cells).toHaveLength(144);
    expect(result.cells.flatMap((cell) => cell.branches)).toHaveLength(1440);
    expect(result.cells.filter((cell) => cell.stableLabel === "signal")).toHaveLength(60);
    expect(result.cells.filter((cell) => cell.stableLabel === "noise")).toHaveLength(84);
    expect(result.cells.flatMap((cell) => cell.branches).some((branch) => branch.status === "structural-censor"))
      .toBe(false);
    expect(result.cells.every((cell) => cell.branches.filter((branch) => branch.branch === "candidate")
      .every((branch) => branch.groundingAccepted))).toBe(true);
  });

  test("keeps both type-matched control branches successful under every seed", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(DIR);
    const result = qualifyResearchBenchmarkV2(loaded, "2026-08-16T00:00:00.000Z");
    const controlIds = new Set(loaded.manifest.scenarios
      .filter((scenario) => scenario.rowKind.endsWith("control"))
      .map((scenario) => scenario.id));
    const controls = result.cells.filter((cell) => controlIds.has(cell.scenarioId));
    expect(controls).toHaveLength(72);
    expect(controls.every((cell) => cell.branches.every((branch) => branch.taskSuccess))).toBe(true);
  });

  test("is deterministic apart from declared generation time", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(DIR);
    const first = qualifyResearchBenchmarkV2(loaded, "2026-08-16T00:00:00.000Z");
    const second = qualifyResearchBenchmarkV2(loaded, "2026-08-17T00:00:00.000Z");
    expect({ ...first, generatedAt: "" }).toEqual({ ...second, generatedAt: "" });
  });
});
