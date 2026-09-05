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

  /**
   * Row-identifying prose is invisible to `assertPromptIsolation`, which matches a fixed forbidden
   * vocabulary, and to the packet key audit, which matches key names. Goal text and candidate
   * descriptions therefore need their own equality checks: an opportunity row and its type-matched
   * control must be indistinguishable from any channel except the fact ledger and the mechanics.
   */
  test("no packet channel distinguishes an opportunity row from its type-matched control", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(DIR);
    const cells = expandResearchBenchmarkCells(loaded);
    const controlDescriptions = new Set<string>();

    for (const family of WAKEWARD_FAMILIES) {
      for (const incentive of ["cooperative", "mixed"] as const) {
        const goalSets = cells
          .filter((cell) => cell.scenario.family === family && cell.condition.incentive === incentive)
          .map((cell) => JSON.stringify(buildResearchDecisionPacket(loaded, cell).controlledGoals));
        expect(goalSets).not.toHaveLength(0);
        expect(new Set(goalSets).size).toBe(1);
      }

      const rows = loaded.manifest.scenarios.filter((scenario) => scenario.family === family);
      const byKind = (kind: string) => rows.find((scenario) => scenario.rowKind === kind)!;
      // An informing control offers a disclosure the player already holds, so the two informing
      // rows must read identically; only the fact mask may separate them.
      expect(byKind("informing-control").candidate.description)
        .toBe(byKind("informing-opportunity").candidate.description);
      controlDescriptions.add(byKind("instrumental-control").candidate.description);
    }

    // A control candidate repeated verbatim across families would be a standing tell.
    expect(controlDescriptions.size).toBe(WAKEWARD_FAMILIES.length);

    const goalsByFamily = WAKEWARD_FAMILIES.map((family) =>
      JSON.stringify(loaded.manifest.familyGoals[family])
    );
    expect(new Set(goalsByFamily).size).toBe(WAKEWARD_FAMILIES.length);
  });
});
