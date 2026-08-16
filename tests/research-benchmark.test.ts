import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  buildResearchDecisionPacket,
  expandResearchBenchmarkCells,
  loadResearchBenchmarkV2FromDir,
  WAKEWARD_FAMILIES,
  wakewardMechanicsSeed,
} from "../src/research/benchmark.ts";
import { assertPromptIsolation, renderResearchPrompt } from "../src/research/prompt.ts";

const DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));

describe("Wakeward Research Benchmark v2", () => {
  test("loads six four-row families and expands exactly 144 model-called cells", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(DIR);
    const cells = expandResearchBenchmarkCells(loaded);
    expect(loaded.manifest.scenarios).toHaveLength(24);
    expect(cells).toHaveLength(24 * 3 * 2);
    expect(new Set(cells.map((cell) => cell.cellId)).size).toBe(144);

    for (const family of WAKEWARD_FAMILIES) {
      const rows = loaded.manifest.scenarios.filter((scenario) => scenario.family === family);
      expect(rows.map((scenario) => scenario.rowKind).sort()).toEqual([
        "informing-control",
        "informing-opportunity",
        "instrumental-control",
        "instrumental-opportunity",
      ]);
      expect([...(loaded.manifest.seedPanels[family] ?? [])]).toEqual(
        Array.from({ length: 5 }, (_, index) => wakewardMechanicsSeed(family, index)),
      );
    }
  });

  test("uses exact public bytes with one closed candidate and no private experiment fields", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(DIR);
    for (const cell of expandResearchBenchmarkCells(loaded)) {
      const packet = buildResearchDecisionPacket(loaded, cell);
      expect(packet.candidates).toHaveLength(1);
      expect(packet.companionKnownFacts.map((fact) => fact.id)).toEqual(cell.scenario.relevantFactIds);
      expect(packet.playerKnownFacts.map((fact) => fact.id)).toEqual(
        [...cell.scenario.factMasks[String(cell.condition.asymmetry) as "0" | "0.3" | "0.7"]].sort(),
      );
      const prompt = renderResearchPrompt(packet);
      expect(() => assertPromptIsolation(prompt)).not.toThrow();
      expect(prompt).not.toContain(cell.scenario.id);
      expect(prompt).not.toContain('"family":');
      expect(prompt).not.toMatch(/expectedClass|oracle|controlStatus|suffixSteps|taskSuccess/);
    }
  });

  test("holds mechanics fixed across incentive and changes only masks across asymmetry", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(DIR);
    const cells = expandResearchBenchmarkCells(loaded);
    const scenarioId = "scenario.clear-glass.instrumental-opportunity";
    const cooperative = cells.find((cell) =>
      cell.scenario.id === scenarioId && cell.condition.asymmetry === 0.7 && cell.condition.incentive === "cooperative"
    )!;
    const mixed = cells.find((cell) =>
      cell.scenario.id === scenarioId && cell.condition.asymmetry === 0.7 && cell.condition.incentive === "mixed"
    )!;
    const low = cells.find((cell) =>
      cell.scenario.id === scenarioId && cell.condition.asymmetry === 0 && cell.condition.incentive === "cooperative"
    )!;
    expect(cooperative.scenario).toEqual(mixed.scenario);
    expect(buildResearchDecisionPacket(loaded, cooperative).controlledGoals)
      .not.toEqual(buildResearchDecisionPacket(loaded, mixed).controlledGoals);

    const highPacket = buildResearchDecisionPacket(loaded, cooperative);
    const lowPacket = buildResearchDecisionPacket(loaded, low);
    const withoutFacts = (value: typeof highPacket) => ({
      ...value,
      packetId: "",
      playerKnownFacts: [],
    });
    expect(withoutFacts(highPacket)).toEqual(withoutFacts(lowPacket));
    expect(highPacket.playerKnownFacts).toHaveLength(1);
    expect(lowPacket.playerKnownFacts).toHaveLength(3);
  });
});
