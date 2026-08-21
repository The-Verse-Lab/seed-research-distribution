import { describe, expect, test } from "bun:test";
import type { LiveTrialResultV1 } from "../src/research/contracts.ts";
import {
  parseStoredLiveTrialsJsonl,
  storedBranchResults,
  toStoredLiveTrial,
} from "../src/research/live/records.ts";

function fixture(): LiveTrialResultV1 {
  const branch = (seed: number, kind: "candidate" | "silence") => ({
    mechanicsSeed: seed, branch: kind, status: "completed" as const, taskSuccess: kind === "candidate",
    groundingAccepted: true, endStateHash: "a".repeat(64),
    cost: { clockMinutes: 10, interventionBurden: kind === "candidate" ? 1 : 0 },
  });
  return {
    schemaVersion: 1, artifactKind: "seed.research.live-trial", trialId: "trial-1", cellId: "cell-1",
    scenarioId: "scenario-1", family: "family-1", modality: "instrumental", expectedClass: "signal",
    condition: { asymmetry: 0.7, incentive: "cooperative" }, replicate: 1,
    modelAttempt: {
      schemaVersion: 1, attemptId: "attempt-1", provider: "fake", configuredModel: "fake-v1",
      returnedModel: "fake-v1", status: "valid", latencyMs: 1,
      visibleOutput: '{"decision":{"choice":"intervene","candidateId":"candidate.v2.001"}}',
      parsedDecision: { choice: "intervene", candidateId: "candidate.v2.001" },
    },
    parsedChoice: { choice: "intervene", candidateId: "candidate.v2.001" },
    grounding: { accepted: true, candidateId: "candidate.v2.001" },
    chosenBranches: [1, 2, 3, 4, 5].map((seed) => branch(seed, "candidate")),
    silenceBranches: [1, 2, 3, 4, 5].map((seed) => branch(seed, "silence")),
    taskSuccessRate: 1, regret: 0,
  };
}

describe("safe stored live records", () => {
  test("replaces duplicated visible bytes with a content-addressed reference", () => {
    const trial = fixture();
    const promptArtifact = { sha256: "b".repeat(64), path: `prompts/${"b".repeat(64)}.txt`, bytes: 100 };
    const visibleResponseArtifact = { sha256: "c".repeat(64), path: `responses/${"c".repeat(64)}.json`, bytes: 70 };
    const stored = toStoredLiveTrial({
      trial, phase: "pilot", scheduleIndex: 4, promptArtifact, visibleResponseArtifact,
      costUsd: "0.00042", costBasis: "reported-usage",
    });
    expect(stored.modelAttempt.visibleOutput).toBeUndefined();
    expect(stored.visibleResponseArtifact).toEqual(visibleResponseArtifact);
    expect(trial.modelAttempt.visibleOutput).toBeDefined();
    expect(parseStoredLiveTrialsJsonl(`${JSON.stringify(stored)}\n`)).toEqual([stored]);
  });

  test("emits ten stable, unique branch records for each completed call", () => {
    const rows = storedBranchResults(fixture());
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((row) => row.branchResultId)).size).toBe(10);
    expect(rows.filter((row) => row.role === "chosen")).toHaveLength(5);
    expect(rows.filter((row) => row.role === "forced-silence")).toHaveLength(5);
    expect(storedBranchResults(fixture())).toEqual(rows);
  });

  test("rejects truncated or duplicate completed observations", () => {
    const stored = toStoredLiveTrial({
      trial: fixture(), phase: "pilot", scheduleIndex: 0,
      promptArtifact: { sha256: "b".repeat(64), path: `prompts/${"b".repeat(64)}.txt`, bytes: 1 },
      costUsd: "0.1", costBasis: "projected-upper-bound",
    });
    const line = JSON.stringify(stored);
    expect(() => parseStoredLiveTrialsJsonl(line)).toThrow(/Truncated/);
    expect(() => parseStoredLiveTrialsJsonl(`${line}\n${line}\n`)).toThrow(/Duplicate/);
  });
});
