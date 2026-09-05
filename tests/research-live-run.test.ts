import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  buildResearchDecisionPacket,
  expandResearchBenchmarkCells,
  loadResearchBenchmarkV2FromDir,
  type LoadedResearchBenchmarkV2,
} from "../src/research/benchmark.ts";
import type {
  OracleQualificationV2,
  ResearchDecision,
  ResearchProvider,
  ResearchProviderAttemptV1,
  ResearchProviderRequestV1,
} from "../src/research/contracts.ts";
import { ResearchArtifactStoreV1 } from "../src/research/live/artifact-store.ts";
import { ResearchBudget } from "../src/research/live/budget.ts";
import { finalizeResearchLivePackage } from "../src/research/live/finalize.ts";
import {
  buildResearchRunManifestV1,
  type ResearchRunManifestV1,
} from "../src/research/live/manifest.ts";
import {
  researchQualificationHash,
  runResearchLivePhase,
  type ResearchLiveProviderMap,
  type VerifiedResearchSmokeAuthorizationV1,
} from "../src/research/live/run.ts";
import type { LiveResearchProviderId } from "../src/research/live/scheduler.ts";
import {
  ANTHROPIC_RESEARCH_MODEL,
  GOOGLE_RESEARCH_MODEL,
  OPENAI_RESEARCH_MODEL,
} from "../src/research/providers/index.ts";
import { qualifyResearchBenchmarkV2 } from "../src/research/qualification.ts";

const WORLD_DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));
const GENERATED_AT = "2026-08-16T12:34:56.000Z";
const MODELS = {
  google: GOOGLE_RESEARCH_MODEL,
  anthropic: ANTHROPIC_RESEARCH_MODEL,
  openai: OPENAI_RESEARCH_MODEL,
} as const;

let loaded: LoadedResearchBenchmarkV2;
let qualification: OracleQualificationV2;
let manifest: ResearchRunManifestV1;
let pilotManifest: ResearchRunManifestV1;
let expectedClassByPacket: Map<string, "signal" | "noise">;

beforeAll(async () => {
  loaded = await loadResearchBenchmarkV2FromDir(WORLD_DIR);
  qualification = qualifyResearchBenchmarkV2(loaded, "2026-08-16T00:00:00.000Z");
  const qualificationByCell = new Map(qualification.cells.map((cell) => [cell.cellId, cell] as const));
  expectedClassByPacket = new Map();
  for (const cell of expandResearchBenchmarkCells(loaded)) {
    const packetId = buildResearchDecisionPacket(loaded, cell).packetId;
    const expectedClass = qualificationByCell.get(cell.cellId)!.expectedClass;
    const prior = expectedClassByPacket.get(packetId);
    if (prior && prior !== expectedClass) throw new Error(`Conflicting fake-provider packet label: ${packetId}`);
    expectedClassByPacket.set(packetId, expectedClass);
  }
  manifest = buildResearchRunManifestV1({
    localManifest: {
      schemaVersion: 1,
      artifactKind: "seed.research.local-model-manifest",
      providers: [
        { provider: "google", model: GOOGLE_RESEARCH_MODEL, apiKeyEnv: "GOOGLE_API_KEY" },
        { provider: "anthropic", model: ANTHROPIC_RESEARCH_MODEL, apiKeyEnv: "ANTHROPIC_API_KEY" },
        { provider: "openai", model: OPENAI_RESEARCH_MODEL, apiKeyEnv: "OPENAI_API_KEY" },
      ],
    },
    runId: "wakeward-live-run-test",
    generatedAt: GENERATED_AT,
    schedulerSeed: 0x51ee_d123,
    bootstrapSeed: 0x0b00_57a9,
    timeoutMs: 30_000,
    suiteHash: loaded.suiteHash,
    qualificationHash: researchQualificationHash(qualification),
    git: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
    runtime: { bun: "test", node: process.version },
  });
  pilotManifest = buildResearchRunManifestV1({
    localManifest: {
      schemaVersion: 1,
      artifactKind: "seed.research.local-model-manifest",
      providers: [
        { provider: "google", model: GOOGLE_RESEARCH_MODEL, apiKeyEnv: "GOOGLE_API_KEY" },
        { provider: "anthropic", model: ANTHROPIC_RESEARCH_MODEL, apiKeyEnv: "ANTHROPIC_API_KEY" },
        { provider: "openai", model: OPENAI_RESEARCH_MODEL, apiKeyEnv: "OPENAI_API_KEY" },
      ],
    },
    runId: "wakeward-live-run-test",
    generatedAt: GENERATED_AT,
    schedulerSeed: 0x51ee_d123,
    bootstrapSeed: 0x0b00_57a9,
    timeoutMs: 30_000,
    suiteHash: loaded.suiteHash,
    qualificationHash: researchQualificationHash(qualification),
    git: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
    runtime: { bun: "test", node: process.version },
    smokeReturnedModels: MODELS,
  });
});

class StrictFakeLiveProvider implements ResearchProvider {
  readonly model: string;
  readonly calls: ResearchProviderRequestV1[] = [];
  active = 0;
  maximumActive = 0;

  constructor(
    readonly providerId: LiveResearchProviderId,
    private readonly omitUsage = false,
    private readonly unsafeVisibleOnFirstCall = false,
    private readonly oversizedUsage = false,
  ) {
    this.model = MODELS[providerId];
  }

  async decide(request: ResearchProviderRequestV1): Promise<ResearchProviderAttemptV1> {
    this.calls.push(structuredClone(request));
    this.active++;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const expectedClass = expectedClassByPacket.get(request.packet.packetId);
      if (!expectedClass) throw new Error("Fake provider received an unknown public packet");
      const candidateId = request.packet.candidates[0]!.candidateId;
      const decision: ResearchDecision = expectedClass === "signal"
        ? { choice: "intervene", candidateId }
        : { choice: "abstain" };
      const visibleOutput = this.unsafeVisibleOnFirstCall && this.calls.length === 1
        ? JSON.stringify({ decision, reasoning_content: "must never be retained" })
        : JSON.stringify({ decision });
      return {
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        returnedModel: this.model,
        status: "valid",
        latencyMs: 1,
        requestId: `request-${request.attemptId}`,
        responseId: `response-${request.attemptId}`,
        visibleOutput,
        parsedDecision: decision,
        ...(!this.omitUsage
          ? { usage: this.oversizedUsage
              ? { inputTokens: 20_000, outputTokens: 256 }
              : { inputTokens: 100, outputTokens: 5 } }
          : {}),
        stopReason: "completed",
      };
    } finally {
      this.active--;
    }
  }
}

function fakeProviders(options: {
  omitUsageFor?: LiveResearchProviderId;
  unsafeVisibleFor?: LiveResearchProviderId;
  oversizedUsageFor?: LiveResearchProviderId | "all";
} = {}): {
  map: ResearchLiveProviderMap;
  instances: Record<LiveResearchProviderId, StrictFakeLiveProvider>;
} {
  const instances = {
    google: new StrictFakeLiveProvider(
      "google",
      options.omitUsageFor === "google",
      options.unsafeVisibleFor === "google",
      options.oversizedUsageFor === "google" || options.oversizedUsageFor === "all",
    ),
    anthropic: new StrictFakeLiveProvider(
      "anthropic",
      options.omitUsageFor === "anthropic",
      options.unsafeVisibleFor === "anthropic",
      options.oversizedUsageFor === "anthropic" || options.oversizedUsageFor === "all",
    ),
    openai: new StrictFakeLiveProvider(
      "openai",
      options.omitUsageFor === "openai",
      options.unsafeVisibleFor === "openai",
      options.oversizedUsageFor === "openai" || options.oversizedUsageFor === "all",
    ),
  };
  return { map: instances, instances };
}

function callCount(instances: Record<LiveResearchProviderId, StrictFakeLiveProvider>): number {
  return Object.values(instances).reduce((sum, provider) => sum + provider.calls.length, 0);
}

function verifiedSmokeAuthorization(): VerifiedResearchSmokeAuthorizationV1 {
  return {
    schemaVersion: 1,
    artifactKind: "seed.research.verified-smoke-authorization",
    gatePassed: true,
    suiteHash: loaded.suiteHash,
    qualificationHash: researchQualificationHash(qualification),
    smokeCommittedUsd: "0",
    returnedModels: { ...MODELS },
  };
}

describe("strict resumable live research orchestration", () => {
  test("runs the known nine-call smoke behavior once, stores atomic observations, and resumes byte-for-byte", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-smoke-"));
    try {
      const directory = join(scratch, "package");
      const store = await ResearchArtifactStoreV1.open(directory);
      const firstProviders = fakeProviders();
      const first = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: firstProviders.map,
        store,
      });

      expect(first).toMatchObject({
        mode: "smoke",
        phase: "smoke",
        scheduledTrialCount: 9,
        previouslyCompletedTrialCount: 0,
        dispatchedTrialCount: 9,
        completedTrialCount: 9,
        skippedTrialCount: 0,
        failures: [],
        gate: { passed: true, failures: [] },
      });
      expect(callCount(firstProviders.instances)).toBe(9);
      for (const provider of Object.values(firstProviders.instances)) {
        expect(provider.calls).toHaveLength(3);
        expect(provider.maximumActive).toBe(1);
      }
      expect(first.trials.map((trial) => trial.scheduleIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect(first.trials.every((trial) => trial.costBasis === "reported-usage")).toBe(true);
      expect(first.trials.every((trial) => trial.taskSuccessRate === 1 && trial.regret === 0)).toBe(true);
      expect(first.trials.filter((trial) => trial.expectedClass === "signal")
        .every((trial) => trial.parsedChoice.choice === "intervene")).toBe(true);
      expect(first.trials.filter((trial) => trial.expectedClass === "noise")
        .every((trial) => trial.parsedChoice.choice === "abstain")).toBe(true);
      expect(first.budget.reservationCount).toBe(0);
      expect(Number(first.budget.committedUsd)).toBeGreaterThan(0);

      const liveBefore = await readFile(join(directory, "live-trials.jsonl"), "utf8");
      const branchesBefore = await readFile(join(directory, "branch-results.jsonl"), "utf8");
      expect(liveBefore.trimEnd().split("\n")).toHaveLength(9);
      expect(branchesBefore.trimEnd().split("\n")).toHaveLength(90);
      expect(liveBefore).not.toContain("visibleOutput");

      const resumedStore = await ResearchArtifactStoreV1.open(directory);
      const resumedProviders = fakeProviders();
      const resumed = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: resumedProviders.map,
        store: resumedStore,
      });
      expect(resumed).toMatchObject({
        previouslyCompletedTrialCount: 9,
        dispatchedTrialCount: 0,
        completedTrialCount: 9,
        skippedTrialCount: 0,
        failures: [],
        gate: { passed: true, failures: [] },
      });
      expect(callCount(resumedProviders.instances)).toBe(0);
      expect(resumed.budget).toEqual(first.budget);
      expect(await readFile(join(directory, "live-trials.jsonl"), "utf8")).toBe(liveBefore);
      expect(await readFile(join(directory, "branch-results.jsonl"), "utf8")).toBe(branchesBefore);

      const finalized = await finalizeResearchLivePackage({
        store: resumedStore,
        loaded,
        manifest,
        qualification,
        phase: "smoke",
      });
      expect(finalized.gate).toEqual({ passed: true, failures: [] });
      expect(finalized.analysis.intentionToEvaluate).toMatchObject({
        trials: 9,
        hits: 6,
        misses: 0,
        falseAlarms: 0,
        correctRejections: 3,
        dPrime: 2.61558317,
        criterion: -0.15744221,
        meanTaskSuccess: 1,
        meanRegret: 0,
      });
      expect(await resumedStore.verifyFinalized()).toEqual(finalized.package.entries);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("recovers a durably dispatched unknown result as ITT interruption without recalling the provider", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-interrupted-"));
    try {
      const directory = join(scratch, "package");
      const firstStore = await ResearchArtifactStoreV1.open(directory);
      const firstProviders = fakeProviders({ unsafeVisibleFor: "google" });
      const interrupted = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: firstProviders.map,
        store: firstStore,
      });
      expect(interrupted).toMatchObject({
        dispatchedTrialCount: 7,
        completedTrialCount: 6,
        recoveredInterruptedTrialCount: 0,
        skippedTrialCount: 2,
        gate: { passed: false },
      });
      expect(interrupted.failures).toHaveLength(1);
      expect(interrupted.budget.reservationCount).toBe(1);
      const interruptedTrialId = interrupted.failures[0]!.trialId;
      expect(firstProviders.instances.google.calls).toHaveLength(1);
      expect(await firstStore.pendingProviderDispatches()).toHaveLength(1);

      const resumedStore = await ResearchArtifactStoreV1.open(directory);
      const resumedProviders = fakeProviders();
      const resumed = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: resumedProviders.map,
        store: resumedStore,
      });
      expect(resumed).toMatchObject({
        previouslyCompletedTrialCount: 6,
        recoveredInterruptedTrialCount: 1,
        dispatchedTrialCount: 2,
        completedTrialCount: 9,
        skippedTrialCount: 0,
        failures: [],
        gate: { passed: false },
      });
      expect(resumedProviders.instances.google.calls).toHaveLength(2);
      expect(resumedProviders.instances.google.calls
        .every((request) => request.attemptId !== `${interruptedTrialId}::attempt=1`)).toBe(true);
      expect(resumedProviders.instances.anthropic.calls).toHaveLength(0);
      expect(resumedProviders.instances.openai.calls).toHaveLength(0);
      const recovered = resumed.trials.find((trial) => trial.trialId === interruptedTrialId)!;
      expect(recovered).toMatchObject({
        costBasis: "projected-upper-bound",
        parsedChoice: { choice: "abstain" },
        failureClassification: "provider-error",
        modelAttempt: {
          provider: "google",
          status: "provider-error",
          errorClass: "interrupted-process",
        },
      });
      expect(recovered.visibleResponseArtifact).toBeUndefined();
      expect(resumed.budget.reservationCount).toBe(0);
      expect(await resumedStore.pendingProviderDispatches()).toEqual([]);
      expect((await readFile(join(directory, "branch-results.jsonl"), "utf8")).trimEnd().split("\n"))
        .toHaveLength(90);
      expect(await readFile(join(directory, "live-trials.jsonl"), "utf8")).not.toContain("reasoning_content");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("recovers an already-billable crash marker after the operator cap is exhausted", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-interrupted-cap-"));
    try {
      const directory = join(scratch, "package");
      const firstStore = await ResearchArtifactStoreV1.open(directory);
      const interrupted = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: fakeProviders({ unsafeVisibleFor: "google" }).map,
        store: firstStore,
      });
      expect(interrupted.completedTrialCount).toBe(6);
      expect(await firstStore.pendingProviderDispatches()).toHaveLength(1);

      const resumedProviders = fakeProviders();
      const resumed = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: resumedProviders.map,
        store: await ResearchArtifactStoreV1.open(directory),
        budget: new ResearchBudget({
          capUsd: "0.000000001",
          committedUsd: interrupted.budget.committedUsd,
        }),
      });
      expect(resumed).toMatchObject({
        recoveredInterruptedTrialCount: 1,
        dispatchedTrialCount: 0,
        completedTrialCount: 7,
        gate: { passed: false },
        budget: { reservedUsd: "0", reservationCount: 0, availableUsd: "0" },
      });
      expect(resumed.failures).toHaveLength(1);
      expect(resumed.failures[0]!.failureClass).toBe("budget-cap");
      expect(Number(resumed.budget.committedUsd)).toBeGreaterThan(Number(resumed.budget.capUsd));
      expect(callCount(resumedProviders.instances)).toBe(0);
      expect(await firstStore.pendingProviderDispatches()).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects understated resumable cost before another provider dispatch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-cost-resume-"));
    try {
      const directory = join(scratch, "package");
      const store = await ResearchArtifactStoreV1.open(directory);
      await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: fakeProviders().map,
        store,
      });
      const trialPath = join(directory, "live-trials.jsonl");
      const rows = (await readFile(trialPath, "utf8")).trimEnd().split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      rows[0]!.costUsd = "0";
      await writeFile(trialPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

      const resumedProviders = fakeProviders();
      await expect(runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: resumedProviders.map,
        store: await ResearchArtifactStoreV1.open(directory),
      })).rejects.toThrow(/cost does not match/);
      expect(callCount(resumedProviders.instances)).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("fails every full-mode provider closed at a tiny cap before any dispatch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-cap-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      const providers = fakeProviders();
      await expect(runResearchLivePhase({
        mode: "full",
        loaded,
        qualification,
        manifest,
        providers: providers.map,
        store,
      })).rejects.toThrow(/smoke authorization/);
      await expect(runResearchLivePhase({
        mode: "full",
        loaded,
        qualification,
        manifest,
        providers: providers.map,
        store,
        smokeAuthorization: verifiedSmokeAuthorization(),
      })).rejects.toThrow(/does not freeze the verified smoke model identity/);
      expect(callCount(providers.instances)).toBe(0);
      const result = await runResearchLivePhase({
        mode: "full",
        loaded,
        qualification,
        manifest: pilotManifest,
        providers: providers.map,
        store,
        budget: new ResearchBudget({ capUsd: "0.000000001" }),
        smokeAuthorization: verifiedSmokeAuthorization(),
      });
      expect(result).toMatchObject({
        mode: "full",
        phase: "pilot",
        scheduledTrialCount: 2160,
        dispatchedTrialCount: 0,
        completedTrialCount: 0,
        skippedTrialCount: 2157,
        gate: { passed: false },
      });
      expect(result.failures).toHaveLength(3);
      expect(result.failures.every((failure) => failure.failureClass === "budget-cap")).toBe(true);
      expect(result.budget).toMatchObject({ committedUsd: "0", reservedUsd: "0", reservationCount: 0 });
      expect(callCount(providers.instances)).toBe(0);
      expect(result.analysis).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("finalizes and reports a legitimately partial failed pilot", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-partial-pilot-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      const providers = fakeProviders({ oversizedUsageFor: "all" });
      const result = await runResearchLivePhase({
        mode: "full",
        loaded,
        qualification,
        manifest: pilotManifest,
        providers: providers.map,
        store,
        budget: new ResearchBudget({ capUsd: "0.12" }),
        smokeAuthorization: verifiedSmokeAuthorization(),
      });
      expect(result.completedTrialCount).toBeGreaterThan(0);
      expect(result.completedTrialCount).toBeLessThan(2160);
      expect(result.gate.passed).toBe(false);
      expect(await store.pendingProviderDispatches()).toEqual([]);

      const finalized = await finalizeResearchLivePackage({
        store,
        loaded,
        manifest: pilotManifest,
        qualification,
        phase: "pilot",
      });
      expect(finalized.analysis.coverage.totalTrials).toBe(result.completedTrialCount);
      expect(finalized.gate.passed).toBe(false);
      expect(finalized.gate.failures.join(" ")).toMatch(/pilot requires 2160 calls/);
      expect(await store.verifyFinalized()).toEqual(finalized.package.entries);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("uses the conservative projected bound when safe provider usage is absent", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-projection-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      const providers = fakeProviders({ omitUsageFor: "openai" });
      const result = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: providers.map,
        store,
      });
      expect(result.completedTrialCount).toBe(9);
      expect(result.trials.filter((trial) => trial.modelAttempt.provider === "openai")
        .every((trial) => trial.costBasis === "projected-upper-bound")).toBe(true);
      expect(result.trials.filter((trial) => trial.modelAttempt.provider !== "openai")
        .every((trial) => trial.costBasis === "reported-usage")).toBe(true);
      expect(result.gate.passed).toBe(false);
      expect(result.gate.failures.join(" ")).toMatch(/missing usage accounting/);
      expect(callCount(providers.instances)).toBe(9);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("records reported usage above a per-call reservation without hiding or recalling it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-observed-overage-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      const providers = fakeProviders({ oversizedUsageFor: "openai" });
      const result = await runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification,
        manifest,
        providers: providers.map,
        store,
      });
      expect(result.completedTrialCount).toBe(9);
      expect(providers.instances.openai.calls).toHaveLength(3);
      expect(result.trials.filter((trial) => trial.modelAttempt.provider === "openai"))
        .toHaveLength(3);
      expect(result.trials.filter((trial) => trial.modelAttempt.provider === "openai")
        .every((trial) => trial.costBasis === "reported-usage" && Number(trial.costUsd) > 0.1)).toBe(true);
      expect(result.budget.reservationCount).toBe(0);
      expect(await store.pendingProviderDispatches()).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects a non-green oracle before storing a manifest or calling a provider", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-qualification-"));
    try {
      const directory = join(scratch, "package");
      const store = await ResearchArtifactStoreV1.open(directory);
      const providers = fakeProviders();
      const badQualification = {
        ...structuredClone(qualification),
        qualified: false,
        failures: ["deliberate test failure"],
      };
      await expect(runResearchLivePhase({
        mode: "smoke",
        loaded,
        qualification: badQualification,
        manifest,
        providers: providers.map,
        store,
      })).rejects.toThrow(/green oracle qualification/);
      expect(callCount(providers.instances)).toBe(0);
      await expect(readFile(join(directory, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects semantically altered trial outcomes and costs before publishing analysis", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-run-semantic-integrity-"));
    try {
      const cases = [
        {
          name: "outcome",
          alter(row: Record<string, unknown>) {
            row.taskSuccessRate = Number(row.taskSuccessRate) === 1 ? 0 : 1;
          },
          pattern: /derived outcomes differ/,
        },
        {
          name: "cost",
          alter(row: Record<string, unknown>) {
            row.costUsd = "0.9";
          },
          pattern: /cost does not match/,
        },
      ];
      for (const testCase of cases) {
        const directory = join(scratch, testCase.name);
        const store = await ResearchArtifactStoreV1.open(directory);
        const providers = fakeProviders();
        await runResearchLivePhase({
          mode: "smoke",
          loaded,
          qualification,
          manifest,
          providers: providers.map,
          store,
        });
        const trialPath = join(directory, "live-trials.jsonl");
        const rows = (await readFile(trialPath, "utf8")).trimEnd().split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        testCase.alter(rows[0]!);
        await writeFile(trialPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        await expect(finalizeResearchLivePackage({
          store,
          loaded,
          manifest,
          qualification,
          phase: "smoke",
        })).rejects.toThrow(testCase.pattern);
        await expect(readFile(join(directory, "analysis.json"), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

});
