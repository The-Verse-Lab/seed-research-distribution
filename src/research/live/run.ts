/** Strict, resumable orchestration for smoke and full live research phases. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { analyzeResearchTrials } from "../analysis.ts";
import {
  buildResearchDecisionPacket,
  expandResearchBenchmarkCells,
  type LoadedResearchBenchmarkV2,
  type ResearchBenchmarkCellV2,
} from "../benchmark.ts";
import {
  OracleQualificationV2Schema,
  type OracleQualificationCellV2,
  type OracleQualificationV2,
  type ResearchAnalysisV1,
  type ResearchProvider,
} from "../contracts.ts";
import { assertPromptIsolation, renderResearchPrompt } from "../prompt.ts";
import { hashResearchValue } from "../world/state.ts";
import { ResearchArtifactStoreV1 } from "./artifact-store.ts";
import {
  ResearchBudget,
  ResearchBudgetExceededError,
  normalizeUsd,
  sumUsd,
  type ResearchBudgetSnapshot,
} from "./budget.ts";
import {
  assertResearchPhaseTrialIntegrity,
  evaluatePilotGate,
  evaluateSmokeGate,
  type ResearchGateResult,
} from "./gates.ts";
import {
  assertStoredResearchContentIntegrity,
  assertStoredResearchCostAccounting,
} from "./integrity.ts";
import {
  ResearchRunManifestV1Schema,
  type ResearchRunManifestV1,
} from "./manifest.ts";
import {
  calculateActualResearchCost,
  projectResearchCallCost,
  projectResearchPilotCost,
} from "./pricing.ts";
import {
  ContentAddressedArtifactSchema,
  readStoredLiveTrials,
  storedBranchResults,
  toStoredLiveTrial,
  type StoredLiveTrialV1,
} from "./records.ts";
import {
  LIVE_RESEARCH_PROVIDER_IDS,
  coordinateResearchTrials,
  createLiveResearchSchedule,
  createResearchSmokeTrials,
  pendingLiveResearchTrials,
  type LiveResearchProviderId,
  type ResearchTrialPhase,
  type ScheduledResearchTrialV1,
} from "./scheduler.ts";
import { executeLiveTrial } from "./trial.ts";
import { assertCurrentOracleQualification } from "../qualification.ts";

export type ResearchLiveRunMode = "smoke" | "full";

export type ResearchLiveProviderMap = Readonly<Record<LiveResearchProviderId, ResearchProvider>>;

/**
 * Authorization derived by the CLI only after it verifies and gates a separate immutable smoke
 * package. This runner binds that authorization to the exact suite, qualification, and models;
 * verification of the smoke package's SHA256SUMS remains the caller's responsibility.
 */
export interface VerifiedResearchSmokeAuthorizationV1 {
  schemaVersion: 1;
  artifactKind: "seed.research.verified-smoke-authorization";
  gatePassed: true;
  suiteHash: string;
  qualificationHash: string;
  /** Exact safe spend committed by the separately finalized smoke package. */
  smokeCommittedUsd: string;
  returnedModels: Readonly<Record<LiveResearchProviderId, string>>;
}

export interface RunResearchLivePhaseOptions {
  mode: ResearchLiveRunMode;
  loaded: LoadedResearchBenchmarkV2;
  qualification: OracleQualificationV2;
  manifest: ResearchRunManifestV1;
  providers: ResearchLiveProviderMap;
  store: ResearchArtifactStoreV1;
  /** Primarily useful for a stricter operator cap. Defaults to the manifest's USD 100 cap. */
  budget?: ResearchBudget;
  /** Required for full mode; the smoke and pilot packages remain separate and immutable. */
  smokeAuthorization?: VerifiedResearchSmokeAuthorizationV1;
}

export interface ResearchLiveOrchestrationFailureV1 {
  trialId: string;
  providerId: LiveResearchProviderId;
  scheduleIndex: number;
  failureClass: "budget-cap" | "orchestration-error";
}

export interface ResearchLivePhaseResultV1 {
  schemaVersion: 1;
  mode: ResearchLiveRunMode;
  phase: ResearchTrialPhase;
  scheduledTrialCount: number;
  previouslyCompletedTrialCount: number;
  recoveredInterruptedTrialCount: number;
  dispatchedTrialCount: number;
  completedTrialCount: number;
  skippedTrialCount: number;
  trials: StoredLiveTrialV1[];
  failures: ResearchLiveOrchestrationFailureV1[];
  budget: ResearchBudgetSnapshot;
  analysis?: ResearchAnalysisV1;
  gate: ResearchGateResult;
}

const ProviderDispatchMarkerV1Schema = z.object({
  schemaVersion: z.literal(1),
  artifactKind: z.literal("seed.research.provider-dispatch-marker"),
  attemptNumber: z.literal(1),
  trialId: z.string().min(1),
  providerId: z.enum(LIVE_RESEARCH_PROVIDER_IDS),
  configuredModel: z.string().min(1),
  phase: z.enum(["smoke", "pilot"]),
  scheduleIndex: z.number().int().nonnegative(),
  cellId: z.string().min(1),
  scenarioId: z.string().min(1),
  replicate: z.number().int().positive(),
  promptArtifact: ContentAddressedArtifactSchema,
  projectedCostUsd: z.string().regex(/^\d+(?:\.\d{1,9})?$/),
}).strict();

type ProviderDispatchMarkerV1 = z.infer<typeof ProviderDispatchMarkerV1Schema>;

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/** Hash of the canonical qualification value referenced by the redacted run manifest. */
export function researchQualificationHash(qualificationValue: unknown): string {
  const qualification = OracleQualificationV2Schema.parse(qualificationValue);
  return hashResearchValue(qualification);
}

function assertQualificationGreen(
  loaded: LoadedResearchBenchmarkV2,
  qualificationValue: OracleQualificationV2,
): OracleQualificationV2 {
  const parsed = OracleQualificationV2Schema.parse(qualificationValue);
  if (!parsed.qualified || parsed.failures.length > 0) {
    throw new Error("Live research requires a green oracle qualification");
  }
  const qualification = assertCurrentOracleQualification(loaded, parsed);
  if (qualification.suiteHash !== loaded.suiteHash) {
    throw new Error("Oracle qualification suite hash does not match the loaded benchmark");
  }
  return qualification;
}

function assertRunInputs(options: RunResearchLivePhaseOptions): {
  manifest: ResearchRunManifestV1;
  qualification: OracleQualificationV2;
  cells: ResearchBenchmarkCellV2[];
  qualificationByCell: Map<string, OracleQualificationCellV2>;
} {
  const qualification = assertQualificationGreen(options.loaded, options.qualification);
  const manifest = ResearchRunManifestV1Schema.parse(options.manifest);
  if (manifest.source.suiteHash !== options.loaded.suiteHash) {
    throw new Error("Run manifest suite hash does not match the loaded benchmark");
  }
  if (manifest.source.qualificationHash !== researchQualificationHash(qualification)) {
    throw new Error("Run manifest qualification hash does not match the oracle qualification");
  }

  if (options.mode === "full") {
    const authorization = options.smokeAuthorization;
    if (!authorization || authorization.schemaVersion !== 1 ||
      authorization.artifactKind !== "seed.research.verified-smoke-authorization" ||
      authorization.gatePassed !== true || !authorization.returnedModels ||
      typeof authorization.returnedModels !== "object") {
      throw new Error("Full live research requires caller-verified smoke authorization");
    }
    if (authorization.suiteHash !== options.loaded.suiteHash ||
      authorization.qualificationHash !== manifest.source.qualificationHash) {
      throw new Error("Smoke authorization does not match the full-run benchmark provenance");
    }
    if (normalizeUsd(authorization.smokeCommittedUsd) !== authorization.smokeCommittedUsd ||
      normalizeUsd(manifest.budget.priorCommittedUsd) !== authorization.smokeCommittedUsd) {
      throw new Error("Full-run manifest does not carry the exact verified smoke spend");
    }
  }

  for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) {
    const provider = options.providers[providerId];
    const manifestProvider = manifest.providers.find((entry) => entry.provider === providerId)!;
    if (!provider || provider.providerId !== providerId) {
      throw new Error(`Research provider map identity mismatch: ${providerId}`);
    }
    if (provider.model !== manifestProvider.configuredModel) {
      throw new Error(`Research provider model does not match the run manifest: ${providerId}`);
    }
    if (options.mode === "full" &&
      options.smokeAuthorization!.returnedModels[providerId] !== manifestProvider.configuredModel) {
      throw new Error(`Smoke authorization model identity does not match the full run: ${providerId}`);
    }
    if (options.mode === "full" &&
      manifestProvider.smokeReturnedModel !== options.smokeAuthorization!.returnedModels[providerId]) {
      throw new Error(`Full-run manifest does not freeze the verified smoke model identity: ${providerId}`);
    }
  }

  const cells = expandResearchBenchmarkCells(options.loaded);
  const qualificationByCell = new Map(qualification.cells.map((cell) => [cell.cellId, cell] as const));
  if (qualificationByCell.size !== cells.length || cells.some((cell) => !qualificationByCell.has(cell.cellId))) {
    throw new Error("Oracle qualification does not exactly cover the benchmark cells");
  }
  return { manifest, qualification, cells, qualificationByCell };
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function ensureFixedJson(
  store: ResearchArtifactStoreV1,
  filename: string,
  value: unknown,
  write: () => Promise<void>,
): Promise<void> {
  const path = join(store.directory, filename);
  let existing = await readJsonIfPresent(path);
  if (existing === undefined) {
    try {
      await write();
      return;
    } catch (error) {
      // Another opener can win the exclusive publication race. Verify its bytes below.
      if (!(error instanceof Error) || !/Refusing to overwrite immutable artifact/.test(error.message)) throw error;
      existing = await readJsonIfPresent(path);
    }
  }
  if (existing === undefined || hashResearchValue(existing) !== hashResearchValue(value)) {
    throw new Error(`Existing immutable ${filename} does not match this live run`);
  }
}

function phaseFor(mode: ResearchLiveRunMode): ResearchTrialPhase {
  return mode === "smoke" ? "smoke" : "pilot";
}

function scheduleFor(
  mode: ResearchLiveRunMode,
  cells: readonly ResearchBenchmarkCellV2[],
  schedulerSeed: number,
): ScheduledResearchTrialV1[] {
  return mode === "smoke"
    ? createResearchSmokeTrials(cells)
    : [...createLiveResearchSchedule(cells, schedulerSeed).trials];
}

function validateStoredTrials(
  stored: readonly StoredLiveTrialV1[],
  cells: readonly ResearchBenchmarkCellV2[],
  schedulerSeed: number,
  manifest: ResearchRunManifestV1,
): void {
  const schedules = [
    ...createResearchSmokeTrials(cells),
    ...createLiveResearchSchedule(cells, schedulerSeed).trials,
  ];
  const scheduledById = new Map(schedules.map((trial) => [trial.trialId, trial] as const));
  for (const row of stored) {
    const scheduled = scheduledById.get(row.trialId);
    const configuredModel = scheduled
      ? manifest.providers.find((provider) => provider.provider === scheduled.providerId)?.configuredModel
      : undefined;
    if (!scheduled || row.phase !== scheduled.phase || row.scheduleIndex !== scheduled.scheduleIndex ||
      row.cellId !== scheduled.cellId || row.scenarioId !== scheduled.scenarioId ||
      row.replicate !== scheduled.replicate || row.modelAttempt.provider !== scheduled.providerId ||
      row.modelAttempt.configuredModel !== configuredModel) {
      throw new Error(`Stored trial does not match the frozen live schedule: ${row.trialId}`);
    }
  }
}

function reconstructedCommittedUsd(stored: readonly StoredLiveTrialV1[]): string {
  return sumUsd(stored.map((trial) => trial.costUsd));
}

function resolveBudget(
  supplied: ResearchBudget | undefined,
  manifest: ResearchRunManifestV1,
  stored: readonly StoredLiveTrialV1[],
): ResearchBudget {
  const committedUsd = sumUsd([manifest.budget.priorCommittedUsd, reconstructedCommittedUsd(stored)]);
  if (!supplied) return new ResearchBudget({ capUsd: manifest.budget.hardCapUsd, committedUsd });
  const snapshot = supplied.snapshot();
  if (snapshot.reservationCount !== 0) throw new Error("Live research cannot start with unresolved budget reservations");
  if (normalizeUsd(snapshot.committedUsd) !== normalizeUsd(committedUsd)) {
    throw new Error("Supplied budget committed spend does not match resumable stored trials");
  }
  const capProbe = new ResearchBudget({ capUsd: manifest.budget.hardCapUsd });
  try {
    capProbe.reserve("operator-cap", snapshot.capUsd);
  } catch (error) {
    if (error instanceof ResearchBudgetExceededError) {
      throw new Error("Supplied operator budget exceeds the manifest hard cap");
    }
    throw error;
  }
  return supplied;
}

function sameContentAddress(
  left: z.infer<typeof ContentAddressedArtifactSchema>,
  right: z.infer<typeof ContentAddressedArtifactSchema>,
): boolean {
  return left.sha256 === right.sha256 && left.path === right.path && left.bytes === right.bytes;
}

async function recoverInterruptedProviderDispatches(options: {
  loaded: LoadedResearchBenchmarkV2;
  store: ResearchArtifactStoreV1;
  manifest: ResearchRunManifestV1;
  schedule: readonly ScheduledResearchTrialV1[];
  cellById: ReadonlyMap<string, ResearchBenchmarkCellV2>;
  qualificationByCell: ReadonlyMap<string, OracleQualificationCellV2>;
  budget: ResearchBudget;
}): Promise<number> {
  const scheduledById = new Map(options.schedule.map((trial) => [trial.trialId, trial] as const));
  const pending = await options.store.pendingProviderDispatches();
  let recovered = 0;
  for (const markerValue of pending) {
    const marker: ProviderDispatchMarkerV1 = ProviderDispatchMarkerV1Schema.parse(markerValue);
    const scheduled = scheduledById.get(marker.trialId);
    const configuredModel = options.manifest.providers
      .find((provider) => provider.provider === marker.providerId)?.configuredModel;
    if (!scheduled || scheduled.providerId !== marker.providerId || scheduled.phase !== marker.phase ||
      scheduled.scheduleIndex !== marker.scheduleIndex || scheduled.cellId !== marker.cellId ||
      scheduled.scenarioId !== marker.scenarioId || scheduled.replicate !== marker.replicate ||
      marker.configuredModel !== configuredModel) {
      throw new Error(`Interrupted provider dispatch does not match the frozen schedule: ${marker.trialId}`);
    }
    const cell = options.cellById.get(marker.cellId);
    const oracleCell = options.qualificationByCell.get(marker.cellId);
    if (!cell || !oracleCell) {
      throw new Error(`Interrupted provider dispatch has no qualified cell: ${marker.trialId}`);
    }

    const prompt = renderResearchPrompt(buildResearchDecisionPacket(options.loaded, cell));
    assertPromptIsolation(prompt);
    const promptArtifact = await options.store.storePrompt(prompt);
    const projected = projectResearchCallCost(marker.providerId, prompt);
    if (!sameContentAddress(promptArtifact, marker.promptArtifact) ||
      normalizeUsd(marker.projectedCostUsd) !== normalizeUsd(projected.totalCostUsd)) {
      throw new Error(`Interrupted provider dispatch provenance mismatch: ${marker.trialId}`);
    }

    // This local sentinel exists only to reuse the deterministic trial/branch construction path.
    // It is not the configured provider adapter and performs no I/O or network dispatch.
    const interruptedProvider: ResearchProvider = {
      providerId: marker.providerId,
      model: marker.configuredModel,
      decide(request) {
        return Promise.resolve({
          schemaVersion: 1,
          attemptId: request.attemptId,
          provider: marker.providerId,
          configuredModel: marker.configuredModel,
          status: "provider-error",
          latencyMs: 0,
          errorClass: "interrupted-process",
        });
      },
    };
    const executed = await executeLiveTrial({
      loaded: options.loaded,
      cell,
      qualification: oracleCell,
      provider: interruptedProvider,
      trialId: marker.trialId,
      replicate: marker.replicate,
      timeoutMs: options.manifest.design.timeoutMs,
    });
    if (executed.prompt !== prompt || executed.visibleOutput !== undefined ||
      executed.result.modelAttempt.status !== "provider-error" ||
      executed.result.modelAttempt.errorClass !== "interrupted-process" ||
      executed.result.parsedChoice.choice !== "abstain") {
      throw new Error(`Interrupted provider dispatch did not produce the required ITT failure: ${marker.trialId}`);
    }
    const storedTrial = toStoredLiveTrial({
      trial: executed.result,
      phase: marker.phase,
      scheduleIndex: marker.scheduleIndex,
      promptArtifact,
      costUsd: marker.projectedCostUsd,
      costBasis: "projected-upper-bound",
    });
    // The marker proves the sole provider attempt was already dispatched by a prior process.
    // Account for that exposure without asking the cap ledger to authorize a second request.
    options.budget.recordPreviouslyDispatched(marker.trialId, marker.projectedCostUsd);
    await options.store.appendCompletedTrial(storedTrial, storedBranchResults(executed.result));
    recovered++;
  }
  return recovered;
}

function withAdditionalGateFailures(
  gate: ResearchGateResult,
  failures: readonly ResearchLiveOrchestrationFailureV1[],
  budget: ResearchBudgetSnapshot,
): ResearchGateResult {
  const messages = [...gate.failures];
  if (failures.length > 0) messages.push(`${failures.length} first-attempt orchestration failures`);
  if (budget.reservationCount > 0) messages.push(`${budget.reservationCount} unresolved budget reservations`);
  return { passed: gate.passed && messages.length === 0, failures: messages };
}

function evaluateCompletedPhase(
  mode: ResearchLiveRunMode,
  trials: readonly StoredLiveTrialV1[],
  qualification: OracleQualificationV2,
  manifest: ResearchRunManifestV1,
  budget: ResearchBudgetSnapshot,
  failures: readonly ResearchLiveOrchestrationFailureV1[],
): { gate: ResearchGateResult; analysis?: ResearchAnalysisV1 } {
  if (mode === "smoke") {
    return {
      gate: withAdditionalGateFailures(
        evaluateSmokeGate({ trials, qualification, budget }),
        failures,
        budget,
      ),
    };
  }
  if (trials.length === 0) {
    return {
      gate: withAdditionalGateFailures(
        { passed: false, failures: ["pilot requires 2160 calls, observed 0"] },
        failures,
        budget,
      ),
    };
  }
  const analysis = analyzeResearchTrials(trials, {
    generatedAt: manifest.generatedAt,
    bootstrapSeed: manifest.design.bootstrapSeed,
    bootstrapResamples: manifest.design.bootstrapResamples,
  });
  return {
    analysis,
    gate: withAdditionalGateFailures(
      evaluatePilotGate({ trials, analysis, qualification, budget }),
      failures,
      budget,
    ),
  };
}

/**
 * Execute each still-pending first attempt exactly once. The scheduler permits one in-flight
 * request per provider; the global budget reservation happens before the sole provider dispatch.
 */
export async function runResearchLivePhase(
  options: RunResearchLivePhaseOptions,
): Promise<ResearchLivePhaseResultV1> {
  const { manifest, qualification, cells, qualificationByCell } = assertRunInputs(options);
  const phase = phaseFor(options.mode);
  // Gate every live phase on the exact 144-prompt, 2,160-call upper bound, even smoke. This
  // prevents a successful nine-call probe from authorizing a pilot that cannot fit the hard cap.
  projectResearchPilotCost(
    cells.map((cell) => renderResearchPrompt(buildResearchDecisionPacket(options.loaded, cell))),
    manifest.budget.hardCapUsd,
    manifest.budget.priorCommittedUsd,
  );
  await ensureFixedJson(options.store, "manifest.json", manifest, () => options.store.writeManifest(manifest));
  await ensureFixedJson(
    options.store,
    "oracle-qualification.json",
    qualification,
    () => options.store.writeOracleQualification(qualification),
  );

  const storedBefore = await readStoredLiveTrials(join(options.store.directory, "live-trials.jsonl"));
  if (storedBefore.some((trial) => trial.phase !== phase)) {
    throw new Error(`A ${phase} package cannot contain observations from another phase`);
  }
  validateStoredTrials(storedBefore, cells, manifest.design.schedulerSeed, manifest);
  if ((await options.store.pendingProviderDispatches()).length === 0) {
    await options.store.validateCompletedArtifacts();
  }
  assertResearchPhaseTrialIntegrity({ trials: storedBefore, qualification, manifest, phase });
  await assertStoredResearchCostAccounting(options.store, storedBefore);
  await assertStoredResearchContentIntegrity(options.store, options.loaded, storedBefore);
  const budget = resolveBudget(options.budget, manifest, storedBefore);
  const schedule = scheduleFor(options.mode, cells, manifest.design.schedulerSeed);
  const phaseBefore = storedBefore.filter((trial) => trial.phase === phase);
  const cellById = new Map(cells.map((cell) => [cell.cellId, cell] as const));
  const recoveredInterruptedTrialCount = await recoverInterruptedProviderDispatches({
    loaded: options.loaded,
    store: options.store,
    manifest,
    schedule,
    cellById,
    qualificationByCell,
    budget,
  });
  const storedAfterRecovery = await readStoredLiveTrials(join(options.store.directory, "live-trials.jsonl"));
  validateStoredTrials(storedAfterRecovery, cells, manifest.design.schedulerSeed, manifest);
  await options.store.validateCompletedArtifacts();
  assertResearchPhaseTrialIntegrity({ trials: storedAfterRecovery, qualification, manifest, phase });
  await assertStoredResearchCostAccounting(options.store, storedAfterRecovery);
  await assertStoredResearchContentIntegrity(options.store, options.loaded, storedAfterRecovery);
  const pending = pendingLiveResearchTrials(
    schedule,
    new Set(storedAfterRecovery.map((trial) => trial.trialId)),
  );

  let dispatchedTrialCount = 0;
  const coordinated = await coordinateResearchTrials(pending, async (scheduled) => {
    const cell = cellById.get(scheduled.cellId);
    const oracleCell = qualificationByCell.get(scheduled.cellId);
    if (!cell || !oracleCell) throw new Error(`Scheduled research cell is not qualified: ${scheduled.cellId}`);
    const provider = options.providers[scheduled.providerId];
    const prompt = renderResearchPrompt(buildResearchDecisionPacket(options.loaded, cell));
    assertPromptIsolation(prompt);
    const projected = projectResearchCallCost(scheduled.providerId, prompt);
    budget.reserve(scheduled.trialId, projected.totalCostUsd);
    let dispatched = false;
    try {
      const promptArtifact = await options.store.storePrompt(prompt);
      await options.store.beginProviderDispatch({
        schemaVersion: 1,
        artifactKind: "seed.research.provider-dispatch-marker",
        attemptNumber: 1,
        trialId: scheduled.trialId,
        providerId: scheduled.providerId,
        configuredModel: provider.model,
        phase: scheduled.phase,
        scheduleIndex: scheduled.scheduleIndex,
        cellId: scheduled.cellId,
        scenarioId: scheduled.scenarioId,
        replicate: scheduled.replicate,
        promptArtifact,
        projectedCostUsd: projected.totalCostUsd,
      } satisfies ProviderDispatchMarkerV1);
      dispatched = true;
      dispatchedTrialCount++;
      const executed = await executeLiveTrial({
        loaded: options.loaded,
        cell,
        qualification: oracleCell,
        provider,
        trialId: scheduled.trialId,
        replicate: scheduled.replicate,
        timeoutMs: manifest.design.timeoutMs,
      });
      if (executed.prompt !== prompt) throw new Error("Executed prompt differs from the projected public bytes");
      if (executed.result.modelAttempt.provider !== scheduled.providerId ||
        executed.result.modelAttempt.configuredModel !== provider.model) {
        throw new Error("Provider attempt identity does not match the frozen schedule");
      }

      const actual = executed.result.modelAttempt.usage
        ? calculateActualResearchCost(scheduled.providerId, executed.result.modelAttempt.usage)
        : undefined;
      const costUsd = actual?.totalCostUsd ?? projected.totalCostUsd;
      const visibleResponseArtifact = executed.visibleOutput === undefined
        ? undefined
        : await options.store.storeVisibleResponse(executed.visibleOutput);
      const storedTrial = toStoredLiveTrial({
        trial: executed.result,
        phase: scheduled.phase,
        scheduleIndex: scheduled.scheduleIndex,
        promptArtifact,
        ...(visibleResponseArtifact ? { visibleResponseArtifact } : {}),
        costUsd,
        costBasis: actual ? "reported-usage" : "projected-upper-bound",
      });
      await options.store.appendCompletedTrial(storedTrial, storedBranchResults(executed.result));
      if (actual) budget.commitObserved(scheduled.trialId, costUsd);
      else budget.commit(scheduled.trialId, costUsd);
      return storedTrial;
    } catch (error) {
      // Releasing is safe only before the sole provider call could have been billed.
      if (!dispatched && budget.hasReservation(scheduled.trialId)) budget.release(scheduled.trialId);
      throw error;
    }
  });

  const storedAfter = await readStoredLiveTrials(join(options.store.directory, "live-trials.jsonl"));
  validateStoredTrials(storedAfter, cells, manifest.design.schedulerSeed, manifest);
  // A post-dispatch orchestration failure deliberately leaves one durable unknown-result marker.
  // The next resume converts it to an ITT interruption before full referential validation.
  if ((await options.store.pendingProviderDispatches()).length === 0) {
    await options.store.validateCompletedArtifacts();
  }
  assertResearchPhaseTrialIntegrity({ trials: storedAfter, qualification, manifest, phase });
  await assertStoredResearchCostAccounting(options.store, storedAfter);
  await assertStoredResearchContentIntegrity(options.store, options.loaded, storedAfter);
  const scheduledIds = new Set(schedule.map((trial) => trial.trialId));
  const phaseTrials = storedAfter
    .filter((trial) => scheduledIds.has(trial.trialId))
    .sort((left, right) => left.scheduleIndex - right.scheduleIndex);
  const failures: ResearchLiveOrchestrationFailureV1[] = coordinated.failures.map(({ trial, error }) => ({
    trialId: trial.trialId,
    providerId: trial.providerId,
    scheduleIndex: trial.scheduleIndex,
    failureClass: error instanceof ResearchBudgetExceededError ? "budget-cap" : "orchestration-error",
  }));
  const budgetSnapshot = budget.snapshot();
  const evaluated = evaluateCompletedPhase(
    options.mode,
    phaseTrials,
    qualification,
    manifest,
    budgetSnapshot,
    failures,
  );
  return {
    schemaVersion: 1,
    mode: options.mode,
    phase,
    scheduledTrialCount: schedule.length,
    previouslyCompletedTrialCount: phaseBefore.length,
    recoveredInterruptedTrialCount,
    dispatchedTrialCount,
    completedTrialCount: phaseTrials.length,
    skippedTrialCount: coordinated.skipped.length,
    trials: phaseTrials,
    failures,
    budget: budgetSnapshot,
    ...(evaluated.analysis ? { analysis: evaluated.analysis } : {}),
    gate: evaluated.gate,
  };
}
