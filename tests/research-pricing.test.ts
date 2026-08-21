import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  buildResearchDecisionPacket,
  expandResearchBenchmarkCells,
  loadResearchBenchmarkV2FromDir,
} from "../src/research/benchmark.ts";
import { ResearchBudgetExceededError } from "../src/research/live/budget.ts";
import {
  RESEARCH_PRICING_SNAPSHOT_V1,
  RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND,
  calculateActualResearchCost,
  projectResearchCallCost,
  projectResearchPilotCost,
} from "../src/research/live/pricing.ts";
import { renderResearchPrompt } from "../src/research/prompt.ts";

const WORLD_DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));

describe("research pricing", () => {
  test("freezes the official 2026-08-21 standard pricing snapshot", () => {
    expect(RESEARCH_PRICING_SNAPSHOT_V1.providers.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      input: entry.inputUsdPerMillionTokens,
      output: entry.outputUsdPerMillionTokens,
      sourceUrl: entry.sourceUrl,
      retrievedDate: entry.retrievedDate,
    }))).toEqual([
      {
        provider: "google",
        model: "gemini-3.5-flash-lite",
        input: "0.30",
        output: "2.50",
        sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
        retrievedDate: "2026-08-21",
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        input: "2.00",
        output: "10.00",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        retrievedDate: "2026-08-21",
      },
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        input: "5.00",
        output: "30.00",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
        retrievedDate: "2026-08-21",
      },
    ]);
    expect(Object.isFrozen(RESEARCH_PRICING_SNAPSHOT_V1)).toBe(true);
    expect(Object.isFrozen(RESEARCH_PRICING_SNAPSHOT_V1.providers)).toBe(true);
  });

  test("charges safe actual usage at full uncached input and output rates", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 900_000 };
    expect(calculateActualResearchCost("google", usage)).toMatchObject({
      inputCostNanoUsd: "300000000",
      outputCostNanoUsd: "2500000000",
      totalCostNanoUsd: "2800000000",
      totalCostUsd: "2.8",
    });
    expect(calculateActualResearchCost("anthropic", usage).totalCostUsd).toBe("12");
    expect(calculateActualResearchCost("openai", usage).totalCostUsd).toBe("35");
    expect(() => calculateActualResearchCost("openai", {
      inputTokens: 10,
      outputTokens: 1,
      cachedInputTokens: 11,
    })).toThrow(/cannot exceed inputTokens/);
  });

  test("projects prompt bytes, billable structured-output overhead, and 256 output tokens", () => {
    const projected = projectResearchCallCost("google", "é");
    expect(projected).toMatchObject({
      basis: "prompt-bytes-plus-fixed-overhead-bound",
      promptUtf8Bytes: 2,
      inputOverheadTokenBound: RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND,
      inputTokens: 12_002,
      outputTokens: 256,
      maxOutputTokens: 256,
      inputCostNanoUsd: "3600600",
      outputCostNanoUsd: "640000",
      totalCostNanoUsd: "4240600",
      totalCostUsd: "0.0042406",
    });
  });

  test("projects the real 144-cell benchmark as 2,160 calls below the USD 100 cap", async () => {
    const loaded = await loadResearchBenchmarkV2FromDir(WORLD_DIR);
    const prompts = expandResearchBenchmarkCells(loaded).map((cell) =>
      renderResearchPrompt(buildResearchDecisionPacket(loaded, cell))
    );

    const projection = projectResearchPilotCost(prompts);

    expect(prompts).toHaveLength(144);
    expect(projection).toMatchObject({
      hardCapUsd: "100",
      cellCount: 144,
      providerCount: 3,
      replicatesPerCell: 5,
      callCount: 2_160,
      maxOutputTokens: 256,
      inputOverheadTokenBound: 12_000,
    });
    expect(Object.values(projection.byProvider).map((row) => row.callCount)).toEqual([720, 720, 720]);
    expect(Number(projection.totalCostUsd)).toBeGreaterThan(0);
    expect(Number(projection.totalCostUsd)).toBeLessThan(100);
    expect(projectResearchPilotCost(prompts)).toEqual(projection);
    expect(() => projectResearchPilotCost(prompts, "100", "20")).toThrow(ResearchBudgetExceededError);
    expect(() => projectResearchPilotCost(prompts, "100", "19")).not.toThrow();
  });

  test("fails closed when a full pilot projection would exceed its cap", () => {
    const oversizedPrompts = Array.from({ length: 144 }, () => "x".repeat(30_000));
    expect(() => projectResearchPilotCost(oversizedPrompts)).toThrow(ResearchBudgetExceededError);
    expect(() => projectResearchPilotCost(Array.from({ length: 143 }, () => "small")))
      .toThrow(/exactly 144 cell prompts/);
  });
});
