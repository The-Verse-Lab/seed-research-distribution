/** Preregistered smoke and pilot advancement gates. */
import type {
  LiveTrialResultV1,
  OracleQualificationCellV2,
  OracleQualificationV2,
  ResearchAnalysisV1,
} from "../contracts.ts";
import { canonicalResearchJson } from "../world/state.ts";
import { compareUsd, type ResearchBudgetSnapshot } from "./budget.ts";
import type { ResearchRunManifestV1 } from "./manifest.ts";
import type { StoredLiveTrialV1 } from "./records.ts";
import {
  deterministicResearchShuffle,
  LIVE_RESEARCH_PROVIDER_IDS,
  LIVE_RESEARCH_REPLICATES,
  researchTrialId,
  type LiveResearchProviderId,
} from "./scheduler.ts";

export interface ResearchGateResult {
  passed: boolean;
  failures: string[];
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The three preregistered smoke cells, selected from the immutable qualification metadata. */
export function selectQualifiedResearchSmokeCells(
  qualification: OracleQualificationV2,
): readonly OracleQualificationCellV2[] {
  const cells = [...qualification.cells].sort((left, right) => compareCodePoints(left.cellId, right.cellId));
  const find = (
    predicate: (cell: OracleQualificationCellV2) => boolean,
    label: string,
  ): OracleQualificationCellV2 => {
    const cell = cells.find(predicate);
    if (!cell) throw new Error(`Oracle qualification has no ${label} smoke cell`);
    return cell;
  };
  return [
    find(
      (cell) => cell.scenarioId.endsWith(".informing-opportunity") &&
        cell.modality === "informing" && cell.condition.asymmetry !== 0,
      "informing signal",
    ),
    find(
      (cell) => cell.scenarioId.endsWith(".instrumental-opportunity") &&
        cell.modality === "instrumental",
      "instrumental signal",
    ),
    find((cell) => cell.scenarioId.endsWith("-control"), "negative control"),
  ];
}

function matrixKey(providerId: string, cellId: string, replicate: number): string {
  return `${providerId}\0${cellId}\0${replicate}`;
}

interface ExpectedPhaseTrial {
  providerId: LiveResearchProviderId;
  cell: OracleQualificationCellV2;
  replicate: number;
  trialId: string;
  scheduleIndex: number;
}

function expectedPhaseTrials(
  qualification: OracleQualificationV2,
  manifest: ResearchRunManifestV1,
  phase: "smoke" | "pilot",
): Map<string, ExpectedPhaseTrial> {
  const cells = phase === "smoke"
    ? selectQualifiedResearchSmokeCells(qualification)
    : [...qualification.cells].sort((left, right) => compareCodePoints(left.cellId, right.cellId));
  const drafts: Omit<ExpectedPhaseTrial, "scheduleIndex">[] = [];
  if (phase === "smoke") {
    for (const cell of cells) {
      for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) {
        drafts.push({
          providerId,
          cell,
          replicate: 1,
          trialId: researchTrialId("smoke", providerId, cell.cellId, 1),
        });
      }
    }
  } else {
    for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) {
      for (const cell of cells) {
        for (let replicate = 1; replicate <= LIVE_RESEARCH_REPLICATES; replicate++) {
          drafts.push({
            providerId,
            cell,
            replicate,
            trialId: researchTrialId("pilot", providerId, cell.cellId, replicate),
          });
        }
      }
    }
  }
  const ordered = phase === "smoke"
    ? drafts
    : deterministicResearchShuffle(drafts, manifest.design.schedulerSeed);
  return new Map(ordered.map((draft, scheduleIndex) => [
    matrixKey(draft.providerId, draft.cell.cellId, draft.replicate),
    { ...draft, scheduleIndex },
  ] as const));
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalResearchJson(left) === canonicalResearchJson(right);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Reject any completed observation whose frozen identity, metadata, deterministic replay, or
 * derived score differs from the preregistered oracle. Missing trials remain a gate failure so a
 * legitimately interrupted/failed phase can still be finalized and reported.
 */
export function assertResearchPhaseTrialIntegrity(options: {
  trials: readonly StoredLiveTrialV1[];
  qualification: OracleQualificationV2;
  manifest: ResearchRunManifestV1;
  phase: "smoke" | "pilot";
}): void {
  const expected = expectedPhaseTrials(options.qualification, options.manifest, options.phase);
  const configuredModels = new Map(options.manifest.providers.map((provider) => [
    provider.provider,
    provider.configuredModel,
  ] as const));
  for (const trial of options.trials) {
    const providerId = trial.modelAttempt.provider;
    const scheduled = expected.get(matrixKey(providerId, trial.cellId, trial.replicate));
    if (!scheduled) throw new Error(`Stored trial is outside the ${options.phase} matrix: ${trial.trialId}`);
    const cell = scheduled.cell;
    if (trial.phase !== options.phase || trial.trialId !== scheduled.trialId ||
      trial.scheduleIndex !== scheduled.scheduleIndex || trial.scenarioId !== cell.scenarioId ||
      trial.family !== cell.family || trial.modality !== cell.modality ||
      trial.expectedClass !== cell.expectedClass || !sameValue(trial.condition, cell.condition)) {
      throw new Error(`Stored trial metadata does not match the frozen ${options.phase} schedule: ${trial.trialId}`);
    }
    const configuredModel = configuredModels.get(providerId as LiveResearchProviderId);
    if (!configuredModel || trial.modelAttempt.configuredModel !== configuredModel ||
      trial.modelAttempt.attemptId !== `${trial.trialId}::attempt=1`) {
      throw new Error(`Stored trial provider identity does not match the run manifest: ${trial.trialId}`);
    }
    if (trial.modelAttempt.status === "valid" &&
      (trial.modelAttempt.returnedModel !== configuredModel || !trial.modelAttempt.parsedDecision ||
        !sameValue(trial.modelAttempt.parsedDecision, trial.parsedChoice))) {
      throw new Error(`Valid stored attempt does not preserve its exact decision/model identity: ${trial.trialId}`);
    }
    if (trial.modelAttempt.status !== "valid" && trial.parsedChoice.choice !== "abstain") {
      throw new Error(`Failed first attempt is not an ITT abstention: ${trial.trialId}`);
    }
    if ((trial.costBasis === "reported-usage") !== Boolean(trial.modelAttempt.usage)) {
      throw new Error(`Stored trial cost basis does not match safe provider usage: ${trial.trialId}`);
    }
    if (trial.modelAttempt.status === "valid" && !trial.visibleResponseArtifact) {
      throw new Error(`Valid stored attempt is missing its visible response artifact: ${trial.trialId}`);
    }

    const candidate = cell.branches.filter((branch) => branch.branch === "candidate");
    const silence = cell.branches.filter((branch) => branch.branch === "silence");
    const chosen = trial.parsedChoice.choice === "intervene" ? candidate : silence;
    if (candidate.length !== 5 || silence.length !== 5 ||
      !sameValue(trial.chosenBranches, chosen) || !sameValue(trial.silenceBranches, silence)) {
      throw new Error(`Stored trial deterministic replay differs from the qualified oracle: ${trial.trialId}`);
    }
    const expectedSuccess = mean(chosen.map((branch) => Number(branch.taskSuccess)));
    const expectedRegret = mean(chosen.map((branch, index) =>
      Math.max(Number(candidate[index]!.taskSuccess), Number(silence[index]!.taskSuccess)) -
      Number(branch.taskSuccess)
    ));
    if (trial.taskSuccessRate !== expectedSuccess || trial.regret !== expectedRegret) {
      throw new Error(`Stored trial derived outcomes differ from deterministic replay: ${trial.trialId}`);
    }
    const groundingAccepted = trial.modelAttempt.errorClass !== "grounding-error" &&
      (trial.parsedChoice.choice === "abstain" || chosen.every((branch) => branch.groundingAccepted));
    if (trial.grounding.accepted !== groundingAccepted ||
      (trial.parsedChoice.choice === "intervene"
        ? trial.grounding.candidateId !== trial.parsedChoice.candidateId
        : trial.grounding.candidateId !== undefined)) {
      throw new Error(`Stored trial grounding receipt is inconsistent: ${trial.trialId}`);
    }
    const expectedFailure = trial.modelAttempt.status !== "valid"
      ? trial.modelAttempt.status
      : groundingAccepted ? undefined : "invalid-schema";
    if (trial.failureClassification !== expectedFailure) {
      throw new Error(`Stored trial failure classification is inconsistent: ${trial.trialId}`);
    }
  }
}

function exactMatrixFailures(
  trials: readonly LiveTrialResultV1[],
  qualification: OracleQualificationV2,
  phase: "smoke" | "pilot",
): string[] {
  const failures: string[] = [];
  if (qualification.cells.length !== 144) {
    return [`${phase} matrix requires 144 qualified cells, observed ${qualification.cells.length}`];
  }
  const cells = phase === "smoke"
    ? selectQualifiedResearchSmokeCells(qualification)
    : qualification.cells;
  const replicates = phase === "smoke" ? [1] : Array.from({ length: LIVE_RESEARCH_REPLICATES }, (_, i) => i + 1);
  const expected = new Set<string>();
  for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) {
    for (const cell of cells) {
      for (const replicate of replicates) expected.add(matrixKey(providerId, cell.cellId, replicate));
    }
  }

  const observed = new Set<string>();
  let unexpected = 0;
  let duplicates = 0;
  for (const trial of trials) {
    const providerId = trial.modelAttempt.provider as LiveResearchProviderId;
    const key = matrixKey(providerId, trial.cellId, trial.replicate);
    if (!expected.has(key)) unexpected++;
    if (observed.has(key)) duplicates++;
    observed.add(key);
  }
  const missing = [...expected].filter((key) => !observed.has(key)).length;
  if (unexpected > 0) failures.push(`${phase} matrix has ${unexpected} unexpected provider/cell/replicate trial(s)`);
  if (duplicates > 0) failures.push(`${phase} matrix has ${duplicates} duplicate provider/cell/replicate trial(s)`);
  if (missing > 0) failures.push(`${phase} matrix is missing ${missing} provider/cell/replicate trial(s)`);
  return failures;
}

export function evaluateProviderSmoke(
  trials: readonly LiveTrialResultV1[],
  qualification?: OracleQualificationV2,
): ResearchGateResult {
  const failures: string[] = [];
  if (trials.length !== 9) failures.push(`smoke requires 9 calls, observed ${trials.length}`);
  if (qualification) failures.push(...exactMatrixFailures(trials, qualification, "smoke"));
  if (new Set(trials.map((trial) => trial.trialId)).size !== trials.length) failures.push("smoke trial IDs are not unique");
  for (const trial of trials) {
    const attempt = trial.modelAttempt;
    if (attempt.status !== "valid" || !attempt.parsedDecision) failures.push(`${trial.trialId}: invalid schema or response`);
    if (attempt.returnedModel !== attempt.configuredModel) failures.push(`${trial.trialId}: returned model identity drift`);
    if (!attempt.requestId && !attempt.responseId) failures.push(`${trial.trialId}: missing request/response provenance ID`);
    if (!attempt.usage) failures.push(`${trial.trialId}: missing usage accounting`);
    if (JSON.stringify(attempt).match(/reasoning_content|chain.of.thought|<think>|encrypted_content/i)) {
      failures.push(`${trial.trialId}: private reasoning leakage`);
    }
    if (trial.chosenBranches.some((branch) => branch.status === "structural-censor") ||
      trial.silenceBranches.some((branch) => branch.status === "structural-censor")) {
      failures.push(`${trial.trialId}: structural censor`);
    }
  }
  return { passed: failures.length === 0, failures };
}

/** Exact finalized smoke gate, including the cumulative hard-cap boundary. */
export function evaluateSmokeGate(options: {
  trials: readonly LiveTrialResultV1[];
  qualification: OracleQualificationV2;
  budget: ResearchBudgetSnapshot;
}): ResearchGateResult {
  const gate = evaluateProviderSmoke(options.trials, options.qualification);
  const failures = [...gate.failures];
  if (compareUsd(options.budget.committedUsd, options.budget.capUsd) >= 0) {
    failures.push("total spend is not below the hard cap");
  }
  if (options.budget.reservationCount !== 0) {
    failures.push("budget still has unresolved request reservations");
  }
  return { passed: failures.length === 0, failures };
}

export function evaluatePilotGate(options: {
  trials: readonly LiveTrialResultV1[];
  analysis: ResearchAnalysisV1;
  qualification: OracleQualificationV2;
  budget: ResearchBudgetSnapshot;
}): ResearchGateResult {
  const failures: string[] = [];
  if (!options.qualification.qualified || options.qualification.failures.length > 0) {
    failures.push("oracle qualification is not green");
  }
  if (options.trials.length !== 2160) failures.push(`pilot requires 2160 calls, observed ${options.trials.length}`);
  failures.push(...exactMatrixFailures(options.trials, options.qualification, "pilot"));
  if (options.analysis.coverage.validityRate < 0.95) {
    failures.push(`validity rate ${options.analysis.coverage.validityRate} is below 0.95`);
  }
  const providerErrorRate = options.analysis.coverage.totalTrials === 0
    ? 1
    : options.analysis.coverage.providerErrors / options.analysis.coverage.totalTrials;
  if (providerErrorRate >= 0.01) failures.push(`provider error rate ${providerErrorRate} is not below 0.01`);
  const structural = options.trials.flatMap((trial) => [...trial.chosenBranches, ...trial.silenceBranches])
    .filter((branch) => branch.status === "structural-censor").length;
  if (structural > 0) failures.push(`${structural} structural censors/state mismatches`);
  if (compareUsd(options.budget.committedUsd, options.budget.capUsd) >= 0) {
    failures.push("total spend is not below the hard cap");
  }
  if (options.budget.reservationCount !== 0) failures.push("budget still has unresolved request reservations");
  return { passed: failures.length === 0, failures };
}
