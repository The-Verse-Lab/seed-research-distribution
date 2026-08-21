import { describe, expect, test } from "bun:test";
import { analyzeResearchTrials } from "../src/research/analysis.ts";
import type { LiveTrialResultV1, OracleQualificationV2 } from "../src/research/contracts.ts";
import { evaluatePilotGate, evaluateProviderSmoke, evaluateSmokeGate } from "../src/research/live/gates.ts";
import { renderResearchReport } from "../src/research/report.ts";

function trial(index: number, status: LiveTrialResultV1["modelAttempt"]["status"] = "valid"): LiveTrialResultV1 {
  const signal = index % 2 === 0;
  const branch = (kind: "candidate" | "silence", seed: number) => ({
    mechanicsSeed: seed,
    branch: kind,
    status: "completed" as const,
    taskSuccess: signal ? kind === "candidate" : true,
    groundingAccepted: true,
    endStateHash: "a".repeat(64),
    cost: { clockMinutes: 1, interventionBurden: kind === "candidate" ? 1 : 0 },
  });
  return {
    schemaVersion: 1, artifactKind: "seed.research.live-trial", trialId: `trial-${index}`,
    cellId: `cell-${index}`, scenarioId: `scenario-${index}`, family: `family-${Math.floor(index / 2) % 6}`,
    modality: index % 4 < 2 ? "informing" : "instrumental",
    expectedClass: signal ? "signal" : "noise",
    condition: { asymmetry: [0, 0.3, 0.7][index % 3] as 0 | 0.3 | 0.7, incentive: index % 4 < 2 ? "cooperative" : "mixed" },
    replicate: (index % 5) + 1,
    modelAttempt: {
      schemaVersion: 1, attemptId: `attempt-${index}`, provider: "fake", configuredModel: "fake-v1",
      returnedModel: "fake-v1", status, latencyMs: 1, requestId: `req-${index}`, responseId: `resp-${index}`,
      ...(status === "valid" ? {
        visibleOutput: '{"decision":{"choice":"intervene","candidateId":"candidate"}}',
        parsedDecision: { choice: "intervene" as const, candidateId: "candidate" },
        usage: { inputTokens: 10, outputTokens: 2 },
      } : {}),
    },
    parsedChoice: status === "valid" ? { choice: "intervene", candidateId: "candidate" } : { choice: "abstain" },
    grounding: { accepted: true, ...(status === "valid" ? { candidateId: "candidate" } : {}) },
    chosenBranches: [1, 2, 3, 4, 5].map((seed) => branch(status === "valid" ? "candidate" : "silence", seed)),
    silenceBranches: [1, 2, 3, 4, 5].map((seed) => branch("silence", seed)),
    taskSuccessRate: signal && status !== "valid" ? 0 : 1,
    regret: signal && status !== "valid" ? 1 : 0,
    ...(status === "valid" ? {} : { failureClassification: status }),
  };
}

const qualification = {
  schemaVersion: 2, artifactKind: "seed.research.oracle-qualification", suiteHash: "b".repeat(64),
  generatedAt: "2026-08-16T00:00:00.000Z", executionCount: 1440, qualified: true, failures: [],
  cells: Array.from({ length: 144 }, (_, index) => ({ cellId: `cell-${index}` })),
} as unknown as OracleQualificationV2;

function pilotRows(statusForIndex: (index: number) => LiveTrialResultV1["modelAttempt"]["status"] = () => "valid") {
  const rows: LiveTrialResultV1[] = [];
  let index = 0;
  for (const provider of ["google", "anthropic", "openai"] as const) {
    for (let cellIndex = 0; cellIndex < 144; cellIndex++) {
      for (let replicate = 1; replicate <= 5; replicate++) {
        const row = trial(index, statusForIndex(index));
        row.cellId = `cell-${cellIndex}`;
        row.replicate = replicate;
        row.modelAttempt.provider = provider;
        rows.push(row);
        index++;
      }
    }
  }
  return rows;
}

describe("research gates and report", () => {
  test("enforces all smoke validity, identity, provenance, and usage requirements", () => {
    const rows = Array.from({ length: 9 }, (_, index) => trial(index));
    expect(evaluateProviderSmoke(rows)).toEqual({ passed: true, failures: [] });
    expect(evaluateSmokeGate({
      trials: rows,
      qualification: { ...qualification, cells: [] },
      budget: { capUsd: "100", committedUsd: "100", reservedUsd: "0", availableUsd: "0", reservationCount: 0 },
    }).failures).toContain("total spend is not below the hard cap");
    rows[0]!.modelAttempt.returnedModel = "drifted";
    expect(evaluateProviderSmoke(rows).passed).toBe(false);
  });

  test("passes a complete qualifying pilot and renders the engineering caveat", () => {
    const rows = pilotRows();
    const analysis = analyzeResearchTrials(rows, {
      generatedAt: "2026-08-16T00:00:00.000Z", bootstrapSeed: 7, bootstrapResamples: 100,
    });
    const gate = evaluatePilotGate({
      trials: rows, analysis, qualification,
      budget: { capUsd: "100", committedUsd: "5", reservedUsd: "0", availableUsd: "95", reservationCount: 0 },
    });
    expect(gate).toEqual({ passed: true, failures: [] });
    const report = renderResearchReport({
      phase: "pilot", analysis, gate, suiteHash: qualification.suiteHash,
      qualificationExecutionCount: qualification.executionCount, committedUsd: "5",
    });
    expect(report).toContain("Engineering proof of concept");
    expect(report).toContain("By model");
    expect(report).toContain("Task-success delta");
    expect(report).toContain("Valid-response-only sensitivity");
    expect(report).toMatch(/Refusals 0 \(0\.00%\)/);
    expect(report).toContain("Family variance and power sizing");
    expect(report).toContain("PASSED");
  });

  test("fails rather than retrying or rewriting a low-validity pilot", () => {
    const rows = pilotRows((index) => index < 200 ? "timeout" : "valid");
    const analysis = analyzeResearchTrials(rows, {
      generatedAt: "2026-08-16T00:00:00.000Z", bootstrapSeed: 7, bootstrapResamples: 50,
    });
    const gate = evaluatePilotGate({
      trials: rows, analysis, qualification,
      budget: { capUsd: "100", committedUsd: "5", reservedUsd: "0", availableUsd: "95", reservationCount: 0 },
    });
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(" ")).toMatch(/validity rate/);
  });

  test("enforces exact preregistered validity, provider-error, and spend boundaries", () => {
    const analyze = (rows: LiveTrialResultV1[]) => analyzeResearchTrials(rows, {
      generatedAt: "2026-08-16T00:00:00.000Z",
      bootstrapSeed: 7,
      bootstrapResamples: 20,
    });
    const gate = (rows: LiveTrialResultV1[], committedUsd: string) => evaluatePilotGate({
      trials: rows,
      analysis: analyze(rows),
      qualification,
      budget: { capUsd: "100", committedUsd, reservedUsd: "0", availableUsd: "0", reservationCount: 0 },
    });

    const exactlyNinetyFivePercentValid = pilotRows((index) => index < 108 ? "invalid-schema" : "valid");
    expect(gate(exactlyNinetyFivePercentValid, "99.999999999").passed).toBe(true);

    const twentyOneProviderErrors = pilotRows((index) => index < 21 ? "provider-error" : "valid");
    expect(gate(twentyOneProviderErrors, "99.999999999").passed).toBe(true);
    const twentyTwoProviderErrors = pilotRows((index) => index < 22 ? "provider-error" : "valid");
    expect(gate(twentyTwoProviderErrors, "99.999999999").failures.join(" ")).toMatch(/provider error rate/);

    const allValid = pilotRows();
    expect(gate(allValid, "99.999999999").passed).toBe(true);
    expect(gate(allValid, "100").failures).toContain("total spend is not below the hard cap");
  });
});
