import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  expandResearchBenchmarkCells,
  loadResearchBenchmarkV2FromDir,
  type LoadedResearchBenchmarkV2,
  type ResearchBenchmarkCellV2,
} from "../src/research/benchmark.ts";
import type {
  OracleQualificationCellV2,
  OracleQualificationV2,
  ResearchDecision,
  ResearchProvider,
  ResearchProviderAttemptV1,
  ResearchProviderRequestV1,
} from "../src/research/contracts.ts";
import { executeLiveTrial } from "../src/research/live/trial.ts";
import { qualifyResearchBenchmarkV2 } from "../src/research/qualification.ts";

const DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));
let loaded: LoadedResearchBenchmarkV2;
let qualification: OracleQualificationV2;
let cell: ResearchBenchmarkCellV2;
let oracleCell: OracleQualificationCellV2;

beforeAll(async () => {
  loaded = await loadResearchBenchmarkV2FromDir(DIR);
  qualification = qualifyResearchBenchmarkV2(loaded, "2026-08-16T00:00:00.000Z");
  cell = expandResearchBenchmarkCells(loaded).find((entry) =>
    entry.scenario.id === "scenario.cold-passage.instrumental-opportunity" &&
    entry.condition.asymmetry === 0.7 && entry.condition.incentive === "cooperative"
  )!;
  oracleCell = qualification.cells.find((entry) => entry.cellId === cell.cellId)!;
});

class FakeProvider implements ResearchProvider {
  readonly providerId = "fake" as const;
  readonly model = "fake-v1";
  calls: ResearchProviderRequestV1[] = [];

  constructor(private readonly decision: ResearchDecision | "timeout") {}

  decide(request: ResearchProviderRequestV1): Promise<ResearchProviderAttemptV1> {
    this.calls.push(structuredClone(request));
    if (this.decision === "timeout") {
      return Promise.resolve({
        schemaVersion: 1 as const,
        attemptId: request.attemptId,
        provider: "fake" as const,
        configuredModel: this.model,
        status: "timeout" as const,
        latencyMs: request.timeoutMs,
        errorClass: "timeout",
      });
    }
    return Promise.resolve({
      schemaVersion: 1 as const,
      attemptId: request.attemptId,
      provider: "fake" as const,
      configuredModel: this.model,
      returnedModel: this.model,
      status: "valid" as const,
      latencyMs: 1,
      visibleOutput: JSON.stringify({ decision: this.decision }),
      parsedDecision: this.decision,
      usage: { inputTokens: 100, outputTokens: 5 },
      stopReason: "completed",
    });
  }
}

describe("one-shot live trial replay", () => {
  test("calls the provider once and replays a grounded intervention over all five seeds", async () => {
    const provider = new FakeProvider({ choice: "intervene", candidateId: cell.scenario.candidate.candidateId });
    const executed = await executeLiveTrial({
      loaded, cell, qualification: oracleCell, provider,
      trialId: "trial-intervene", replicate: 1, timeoutMs: 1000,
    });
    expect(provider.calls).toHaveLength(1);
    expect(executed.result).toMatchObject({
      parsedChoice: { choice: "intervene" },
      grounding: { accepted: true },
      taskSuccessRate: 1,
      regret: 0,
    });
    expect(executed.result.chosenBranches).toHaveLength(5);
    expect(executed.result.silenceBranches).toHaveLength(5);
    expect(executed.result.chosenBranches.every((branch) => branch.branch === "candidate" && branch.taskSuccess))
      .toBe(true);
    expect(executed.prompt).not.toMatch(/expectedClass|oracle|structuralCensor|suffixSteps/);
  });

  test("scores abstention on a signal as full regret without another model call", async () => {
    const provider = new FakeProvider({ choice: "abstain" });
    const executed = await executeLiveTrial({
      loaded, cell, qualification: oracleCell, provider,
      trialId: "trial-abstain", replicate: 2, timeoutMs: 1000,
    });
    expect(provider.calls).toHaveLength(1);
    expect(executed.result.taskSuccessRate).toBe(0);
    expect(executed.result.regret).toBe(1);
    expect(executed.result.grounding.accepted).toBe(true);
    expect(executed.result.chosenBranches.every((branch) => branch.branch === "silence")).toBe(true);
  });

  test("turns a first-attempt timeout into an ITT abstention and never retries", async () => {
    const provider = new FakeProvider("timeout");
    const executed = await executeLiveTrial({
      loaded, cell, qualification: oracleCell, provider,
      trialId: "trial-timeout", replicate: 3, timeoutMs: 5,
    });
    expect(provider.calls).toHaveLength(1);
    expect(executed.result).toMatchObject({
      parsedChoice: { choice: "abstain" },
      failureClassification: "timeout",
      taskSuccessRate: 0,
      regret: 1,
    });
    expect(executed.visibleOutput).toBeUndefined();
  });

  test("re-grounds a custom provider decision at the public seam and fails unknown candidates closed", async () => {
    const provider = new FakeProvider({ choice: "intervene", candidateId: "candidate.not-offered" });
    const executed = await executeLiveTrial({
      loaded, cell, qualification: oracleCell, provider,
      trialId: "trial-unknown-candidate", replicate: 4, timeoutMs: 1000,
    });
    expect(provider.calls).toHaveLength(1);
    expect(executed.result).toMatchObject({
      modelAttempt: { status: "invalid-schema", errorClass: "grounding-error" },
      parsedChoice: { choice: "abstain" },
      grounding: { accepted: false, reason: "candidate-id-not-offered" },
      failureClassification: "invalid-schema",
      taskSuccessRate: 0,
      regret: 1,
    });
  });
});
