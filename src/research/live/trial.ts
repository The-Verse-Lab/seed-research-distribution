/** One model call followed by deterministic five-seed mechanical replay. */
import {
  LiveTrialResultV1Schema,
  ResearchProviderAttemptV1Schema,
  parseResearchDecision,
  type LiveTrialResultV1,
  type OracleQualificationCellV2,
  type ResearchDecision,
  type ResearchProvider,
  type ResearchProviderAttemptV1,
  type ResearchProviderErrorClassV1,
} from "../contracts.ts";
import {
  buildResearchDecisionPacket,
  type LoadedResearchBenchmarkV2,
  type ResearchBenchmarkCellV2,
} from "../benchmark.ts";
import { assertPromptIsolation, renderResearchPrompt } from "../prompt.ts";
import { executeResearchBranch } from "../qualification.ts";

export interface ExecuteLiveTrialOptions {
  loaded: LoadedResearchBenchmarkV2;
  cell: ResearchBenchmarkCellV2;
  qualification: OracleQualificationCellV2;
  provider: ResearchProvider;
  trialId: string;
  replicate: number;
  timeoutMs: number;
}

export interface ExecutedLiveTrial {
  result: LiveTrialResultV1;
  prompt: string;
  visibleOutput?: string;
}

function failureAttempt(
  attempt: ResearchProviderAttemptV1,
  status: "invalid-schema",
  errorClass: ResearchProviderErrorClassV1,
): ResearchProviderAttemptV1 {
  return ResearchProviderAttemptV1Schema.parse({
    ...attempt,
    status,
    parsedDecision: undefined,
    errorClass,
  });
}

function normalizedDecision(
  attemptValue: ResearchProviderAttemptV1,
  candidateIds: ReadonlySet<string>,
): {
  attempt: ResearchProviderAttemptV1;
  decision: ResearchDecision;
  groundingRejected: boolean;
} {
  const attempt = ResearchProviderAttemptV1Schema.parse(attemptValue);
  if (attempt.status !== "valid") return { attempt, decision: { choice: "abstain" }, groundingRejected: false };
  if (!attempt.parsedDecision) {
    return {
      attempt: failureAttempt(attempt, "invalid-schema", "missing-parsed-decision"),
      decision: { choice: "abstain" },
      groundingRejected: false,
    };
  }
  try {
    return {
      attempt,
      decision: parseResearchDecision(attempt.parsedDecision, candidateIds),
      groundingRejected: false,
    };
  } catch {
    return {
      attempt: failureAttempt(attempt, "invalid-schema", "grounding-error"),
      decision: { choice: "abstain" },
      groundingRejected: true,
    };
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Exactly one provider decision; all later work is local and deterministic. */
export async function executeLiveTrial(options: ExecuteLiveTrialOptions): Promise<ExecutedLiveTrial> {
  if (options.qualification.cellId !== options.cell.cellId) {
    throw new Error("Live trial cell does not match its qualified oracle cell");
  }
  if (options.qualification.stableLabel !== options.qualification.expectedClass) {
    throw new Error("Live trial cannot use an unstable qualification label");
  }
  if (!Number.isInteger(options.replicate) || options.replicate <= 0) {
    throw new Error("Live trial replicate must be a positive integer");
  }
  if (!options.trialId) throw new Error("Live trial id must be non-empty");

  const packet = buildResearchDecisionPacket(options.loaded, options.cell);
  const prompt = renderResearchPrompt(packet);
  assertPromptIsolation(prompt);
  const attemptId = `${options.trialId}::attempt=1`;
  let rawAttempt: ResearchProviderAttemptV1;
  try {
    rawAttempt = await options.provider.decide({
      attemptId,
      prompt,
      packet,
      timeoutMs: options.timeoutMs,
    });
  } catch {
    // A thrown adapter/runtime error is still the sole first attempt. Never retry or retain its text.
    rawAttempt = ResearchProviderAttemptV1Schema.parse({
      schemaVersion: 1,
      attemptId,
      provider: options.provider.providerId,
      configuredModel: options.provider.model,
      status: "provider-error",
      latencyMs: 0,
      errorClass: "runtime-provider-exception",
    });
  }
  const normalized = normalizedDecision(
    rawAttempt,
    new Set(packet.candidates.map((candidate) => candidate.candidateId)),
  );
  const decision = normalized.decision;
  const seeds = options.loaded.manifest.seedPanels[options.cell.scenario.family]!;
  const chosenBranch = decision.choice === "intervene" ? "candidate" as const : "silence" as const;
  const chosenBranches = seeds.map((seed) =>
    executeResearchBranch(options.loaded, options.cell, seed, chosenBranch)
  );
  const silenceBranches = seeds.map((seed) =>
    executeResearchBranch(options.loaded, options.cell, seed, "silence")
  );
  const candidateGrounded = !normalized.groundingRejected &&
    (chosenBranch === "silence" || chosenBranches.every((branch) => branch.groundingAccepted));
  const oracleCandidate = options.qualification.branches.filter((branch) => branch.branch === "candidate");
  const oracleSilence = options.qualification.branches.filter((branch) => branch.branch === "silence");
  if (oracleCandidate.length !== 5 || oracleSilence.length !== 5) {
    throw new Error("Qualified oracle cell does not contain five matched branch pairs");
  }
  const regret = mean(chosenBranches.map((branch, index) => {
    const best = Math.max(Number(oracleCandidate[index]!.taskSuccess), Number(oracleSilence[index]!.taskSuccess));
    return best - Number(branch.taskSuccess);
  }));
  const failureClassification = normalized.attempt.status !== "valid"
    ? normalized.attempt.status
    : !candidateGrounded
      ? "invalid-schema" as const
      : undefined;

  const result = LiveTrialResultV1Schema.parse({
    schemaVersion: 1,
    artifactKind: "seed.research.live-trial",
    trialId: options.trialId,
    cellId: options.cell.cellId,
    scenarioId: options.cell.scenario.id,
    family: options.cell.scenario.family,
    modality: options.cell.scenario.modality,
    expectedClass: options.qualification.expectedClass,
    condition: structuredClone(options.cell.condition),
    replicate: options.replicate,
    modelAttempt: normalized.attempt,
    parsedChoice: decision,
    grounding: {
      accepted: candidateGrounded,
      ...(decision.choice === "intervene" ? { candidateId: decision.candidateId } : {}),
      ...(!candidateGrounded
        ? { reason: normalized.groundingRejected ? "candidate-id-not-offered" : "authored-candidate-rejected" }
        : {}),
    },
    chosenBranches,
    silenceBranches,
    taskSuccessRate: mean(chosenBranches.map((branch) => Number(branch.taskSuccess))),
    regret,
    ...(failureClassification ? { failureClassification } : {}),
  });
  return {
    result,
    prompt,
    ...(normalized.attempt.visibleOutput === undefined ? {} : { visibleOutput: normalized.attempt.visibleOutput }),
  };
}
