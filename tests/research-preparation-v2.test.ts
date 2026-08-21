import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { loadResearchBenchmarkV2FromDir } from "../src/research/benchmark.ts";
import {
  buildResearchPreparationV2,
  researchPreparationSourceV2,
  writeResearchPreparationV2,
} from "../src/research/preparation.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIR = join(ROOT, "worlds/wakeward-isles");

async function fixture() {
  const loaded = await loadResearchBenchmarkV2FromDir(DIR);
  const sourceFiles = await Promise.all(["world.json", "research.json"].map(async (name) =>
    researchPreparationSourceV2(`worlds/wakeward-isles/${name}`, await readFile(join(DIR, name)))
  ));
  return { loaded, sourceFiles };
}

describe("Research Benchmark v2 preparation", () => {
  test("freezes 144 exact packets while remaining explicitly not-run", async () => {
    const { loaded, sourceFiles } = await fixture();
    const artifact = buildResearchPreparationV2(loaded, {
      generatedAt: "2026-08-16T00:00:00.000Z",
      sourceFiles,
      repositoryCommit: "test-commit",
      repositoryDirty: false,
      bun: "1.3.14",
      node: "v22",
    });
    expect(artifact).toMatchObject({
      schemaVersion: 2,
      execution: { status: "not-run", modelCalls: 0, mechanicalExecutions: 0 },
      design: { scenarioCount: 24, conditionCellCount: 144, qualificationExecutionCount: 1440 },
    });
    expect(artifact.cells).toHaveLength(144);
    expect(new Set(artifact.cells.map((cell) => cell.packetId)).size).toBe(144);
    expect(JSON.stringify(artifact)).not.toMatch(/expectedClass|taskSuccess|oracleOutcome|winner/);

    const regenerated = buildResearchPreparationV2(loaded, {
      generatedAt: "2026-08-17T00:00:00.000Z",
      sourceFiles: [...sourceFiles].reverse(),
      repositoryCommit: "other",
      repositoryDirty: true,
    });
    expect(regenerated.planHash).toBe(artifact.planHash);
    expect(regenerated.planId).toBe(artifact.planId);
  });

  test("writes a non-overwriting package with verified checksums", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-prep-v2-"));
    try {
      const { loaded, sourceFiles } = await fixture();
      const artifact = buildResearchPreparationV2(loaded, {
        generatedAt: "2026-08-16T00:00:00.000Z",
        sourceFiles,
      });
      const paths = await writeResearchPreparationV2(join(scratch, "package"), loaded, artifact);
      expect((await readFile(paths.packets, "utf8")).trim().split("\n")).toHaveLength(144);
      for (const line of (await readFile(paths.checksums, "utf8")).trim().split("\n")) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line)!;
        expect(createHash("sha256").update(await readFile(join(paths.directory, match[2]!))).digest("hex"))
          .toBe(match[1]!);
      }
      await expect(writeResearchPreparationV2(paths.directory, loaded, artifact)).rejects.toThrow(/Refusing to overwrite/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
