import { describe, expect, test } from "bun:test";
import { analyzeResearchTrials } from "../src/research/analysis.ts";
import type { LiveTrialResultV1 } from "../src/research/contracts.ts";

function trial(options: {
  id: string;
  family: string;
  modality: "informing" | "instrumental";
  expectedClass: "signal" | "noise";
  intervene: boolean;
  status?: LiveTrialResultV1["modelAttempt"]["status"];
  errorClass?: LiveTrialResultV1["modelAttempt"]["errorClass"];
  asymmetry?: 0 | 0.3 | 0.7;
  incentive?: "cooperative" | "mixed";
}): LiveTrialResultV1 {
  const status = options.status ?? "valid";
  const parsedChoice = options.intervene
    ? { choice: "intervene" as const, candidateId: "candidate.one" }
    : { choice: "abstain" as const };
  const branch = (mechanicsSeed: number, kind: "candidate" | "silence") => ({
    mechanicsSeed,
    branch: kind,
    status: "completed" as const,
    taskSuccess: kind === "candidate" && options.expectedClass === "signal",
    groundingAccepted: true,
    endStateHash: "a".repeat(64),
    cost: { clockMinutes: 1, interventionBurden: kind === "candidate" ? 1 : 0 },
  });
  return {
    schemaVersion: 1,
    artifactKind: "seed.research.live-trial",
    trialId: options.id,
    cellId: `cell.${options.id}`,
    scenarioId: `scenario.${options.id}`,
    family: options.family,
    modality: options.modality,
    expectedClass: options.expectedClass,
    condition: {
      asymmetry: options.asymmetry ?? 0.3,
      incentive: options.incentive ?? "cooperative",
    },
    replicate: 1,
    modelAttempt: {
      schemaVersion: 1,
      attemptId: `attempt.${options.id}`,
      provider: "fake",
      configuredModel: "fake-v1",
      status,
      latencyMs: 1,
      ...(options.errorClass ? { errorClass: options.errorClass } : {}),
      ...(status === "valid" ? { parsedDecision: parsedChoice, visibleOutput: JSON.stringify(parsedChoice) } : {}),
    },
    parsedChoice,
    grounding: {
      accepted: options.intervene && status === "valid",
      ...(options.intervene ? { candidateId: "candidate.one" } : {}),
    },
    chosenBranches: [1, 2, 3, 4, 5].map((seed) => branch(seed, options.intervene ? "candidate" : "silence")),
    silenceBranches: [1, 2, 3, 4, 5].map((seed) => branch(seed, "silence")),
    taskSuccessRate: options.intervene && options.expectedClass === "signal" && status === "valid" ? 1 : 0,
    regret: options.expectedClass === "signal" && !(options.intervene && status === "valid") ? 1 : 0,
    ...(status === "valid" ? {} : { failureClassification: status }),
  };
}

function balancedTrials(): LiveTrialResultV1[] {
  const rows: LiveTrialResultV1[] = [];
  for (const [familyIndex, family] of ["family-a", "family-b"].entries()) {
    for (const modality of ["informing", "instrumental"] as const) {
      for (const asymmetry of [0, 0.3, 0.7] as const) {
        for (const incentive of ["cooperative", "mixed"] as const) {
          const prefix = `${familyIndex}-${modality}-${asymmetry}-${incentive}`;
          rows.push(trial({
            id: `${prefix}-signal`, family, modality, asymmetry, incentive,
            expectedClass: "signal", intervene: familyIndex === 0,
          }));
          rows.push(trial({
            id: `${prefix}-noise`, family, modality, asymmetry, incentive,
            expectedClass: "noise", intervene: familyIndex === 0,
          }));
        }
      }
    }
  }
  return rows;
}

describe("research analysis", () => {
  test("emits an explicit empty analysis when a pilot fails before its first call", () => {
    const analysis = analyzeResearchTrials([], {
      generatedAt: "2026-08-16T00:00:00.000Z",
      bootstrapSeed: 1,
    });
    expect(analysis).toMatchObject({
      intentionToEvaluate: {
        trials: 0,
        hits: 0,
        misses: 0,
        falseAlarms: 0,
        correctRejections: 0,
        dPrime: null,
        criterion: null,
      },
      validResponseSensitivity: { trials: 0, dPrime: null, criterion: null },
      coverage: {
        totalTrials: 0,
        validTrials: 0,
        validityRate: 0,
        refusalRate: 0,
        timeoutRate: 0,
        rateLimitRate: 0,
        groundingFailureRate: 0,
        providerErrorRate: 0,
      },
      familyVariance: { familyCount: 0, meanDPrime: null, sampleVarianceDPrime: null },
    });
    expect(analysis.byModel).toEqual({});
    expect(analysis.byFamily).toEqual({});
  });

  test("computes known ITT counts, corrected metrics, slices, and deterministic family intervals", () => {
    const rows = balancedTrials();
    const options = {
      generatedAt: "2026-08-16T00:00:00.000Z",
      bootstrapSeed: 0x51eed123,
      bootstrapResamples: 500,
    };
    const first = analyzeResearchTrials(rows, options);
    const second = analyzeResearchTrials([...rows].reverse(), options);

    expect(first.intentionToEvaluate).toMatchObject({
      trials: 48,
      hits: 12,
      misses: 12,
      falseAlarms: 12,
      correctRejections: 12,
      dPrime: 0,
      criterion: 0,
      meanTaskSuccessDelta: 0.25,
    });
    expect(Object.keys(first.byModality)).toEqual(["informing", "instrumental"]);
    expect(Object.keys(first.byAsymmetry)).toEqual(["0", "0.3", "0.7"]);
    expect(Object.keys(first.byIncentive)).toEqual(["cooperative", "mixed"]);
    expect(first.intentionToEvaluate.confidenceIntervals).toEqual(
      second.intentionToEvaluate.confidenceIntervals,
    );
  });

  test("treats every first-attempt failure as a non-intervention in ITT and excludes it from sensitivity", () => {
    const rows = balancedTrials();
    const failed = rows[0]!;
    failed.modelAttempt.status = "timeout";
    failed.modelAttempt.parsedDecision = undefined;
    failed.failureClassification = "timeout";
    const result = analyzeResearchTrials(rows, {
      generatedAt: "2026-08-16T00:00:00.000Z",
      bootstrapSeed: 7,
      bootstrapResamples: 100,
    });
    expect(result.coverage).toMatchObject({
      totalTrials: 48,
      validTrials: 47,
      timeouts: 1,
      timeoutRate: 0.02083333,
    });
    expect(result.intentionToEvaluate.trials).toBe(48);
    expect(result.validResponseSensitivity.trials).toBe(47);
  });

  test("finalizes partial failed pilots with unavailable class-dependent cluster intervals", () => {
    const rows = [
      trial({
        id: "signal-only-family", family: "signal-only", modality: "informing",
        expectedClass: "signal", intervene: false,
      }),
      trial({
        id: "noise-only-family", family: "noise-only", modality: "instrumental",
        expectedClass: "noise", intervene: false,
      }),
    ];
    const result = analyzeResearchTrials(rows, {
      generatedAt: "2026-08-16T00:00:00.000Z",
      bootstrapSeed: 11,
      bootstrapResamples: 100,
    });
    expect(result.intentionToEvaluate.dPrime).not.toBeNull();
    expect(result.intentionToEvaluate.confidenceIntervals).toMatchObject({
      dPrime: null,
      criterion: null,
      meanTaskSuccess: { low: 0, high: 0 },
    });
    expect(result.familyVariance).toMatchObject({
      familyCount: 2,
      identifiableFamilyCount: 0,
      meanDPrime: null,
      sampleVarianceDPrime: null,
    });
    expect(result.powerSizing).toMatchObject({
      status: "unavailable",
      recommendedHeldOutFamilies: null,
    });
  });

  test("reports disjoint validation, grounding, drift, and provider failure categories", () => {
    const rows = [
      trial({ id: "invalid-json", family: "a", modality: "informing", expectedClass: "signal", intervene: false,
        status: "invalid-json", errorClass: "invalid-json" }),
      trial({ id: "invalid-schema", family: "a", modality: "informing", expectedClass: "noise", intervene: false,
        status: "invalid-schema", errorClass: "schema-validation-error" }),
      trial({ id: "grounding", family: "b", modality: "instrumental", expectedClass: "signal", intervene: true,
        status: "invalid-schema", errorClass: "grounding-error" }),
      trial({ id: "model-drift", family: "b", modality: "instrumental", expectedClass: "noise", intervene: false,
        status: "model-drift", errorClass: "returned-model-mismatch" }),
      trial({ id: "provider", family: "c", modality: "informing", expectedClass: "signal", intervene: false,
        status: "provider-error", errorClass: "provider-internal" }),
    ];
    const result = analyzeResearchTrials(rows, {
      generatedAt: "2026-08-16T00:00:00.000Z",
      bootstrapSeed: 5,
      bootstrapResamples: 20,
    });
    expect(result.coverage).toMatchObject({
      invalidJsonFailures: 1,
      invalidJsonFailureRate: 0.2,
      invalidSchemaFailures: 1,
      invalidSchemaFailureRate: 0.2,
      groundingFailures: 1,
      groundingFailureRate: 0.2,
      modelDrifts: 1,
      modelDriftRate: 0.2,
      providerErrors: 1,
      providerErrorRate: 0.2,
    });
  });

  test("rejects duplicate observations rather than rewriting them", () => {
    const rows = balancedTrials();
    expect(() => analyzeResearchTrials([rows[0]!, rows[0]!], {
      generatedAt: "2026-08-16T00:00:00.000Z",
      bootstrapSeed: 1,
      bootstrapResamples: 10,
    })).toThrow(/Duplicate live trial id/);
  });
});
