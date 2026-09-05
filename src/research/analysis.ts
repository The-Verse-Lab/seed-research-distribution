/** Deterministic analysis for first-attempt research trials. */
import type {
  LiveTrialResultV1,
  ResearchAnalysisSliceV1,
  ResearchAnalysisV1,
} from "./contracts.ts";
import {
  familyClusterBootstrap,
  estimateHeldOutFamilySampleSize,
  signalDetectionMetrics,
  type ConfusionCounts,
  type FamilyConfusionCounts,
} from "./statistics.ts";

export interface AnalyzeResearchTrialsOptions {
  generatedAt: string;
  /** Recorded unsigned seed for all family-cluster intervals. */
  bootstrapSeed: number;
  /** Defaults to the preregistered 10,000 family resamples. */
  bootstrapResamples?: number;
}

interface NumericClusterRow {
  family: string;
  taskSuccess: number;
  taskSuccessDelta: number;
  regret: number;
}

function emptyCounts(): ConfusionCounts {
  return { hits: 0, misses: 0, falseAlarms: 0, correctRejections: 0 };
}

function interventionSelected(trial: LiveTrialResultV1): boolean {
  return trial.modelAttempt.status === "valid" &&
    trial.parsedChoice.choice === "intervene" &&
    trial.grounding.accepted;
}

function countsFor(trials: readonly LiveTrialResultV1[]): ConfusionCounts {
  const counts = emptyCounts();
  for (const trial of trials) {
    const selected = interventionSelected(trial);
    if (trial.expectedClass === "signal") {
      if (selected) counts.hits++;
      else counts.misses++;
    } else if (selected) counts.falseAlarms++;
    else counts.correctRejections++;
  }
  return counts;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function taskSuccessDelta(trial: LiveTrialResultV1): number {
  return average(trial.chosenBranches.map((branch) => Number(branch.taskSuccess))) -
    average(trial.silenceBranches.map((branch) => Number(branch.taskSuccess)));
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lower = sorted[low]!;
  const upper = sorted[high]!;
  return lower + (upper - lower) * (position - low);
}

function meanIntervals(
  rows: readonly NumericClusterRow[],
  seed: number,
  resamples: number,
): Record<string, { low: number; high: number }> {
  const grouped = new Map<string, NumericClusterRow[]>();
  for (const row of rows) {
    const familyRows = grouped.get(row.family) ?? [];
    familyRows.push(row);
    grouped.set(row.family, familyRows);
  }
  const families = [...grouped].sort(([left], [right]) => left.localeCompare(right));
  if (families.length === 0) throw new Error("Analysis requires at least one family");
  const random = mulberry32(seed ^ 0xa5a5_5a5a);
  const success: number[] = [];
  const successDelta: number[] = [];
  const regret: number[] = [];
  for (let replicate = 0; replicate < resamples; replicate++) {
    const sampled: NumericClusterRow[] = [];
    for (let draw = 0; draw < families.length; draw++) {
      const family = families[Math.floor(random() * families.length)]!;
      sampled.push(...family[1]);
    }
    success.push(average(sampled.map((row) => row.taskSuccess)));
    successDelta.push(average(sampled.map((row) => row.taskSuccessDelta)));
    regret.push(average(sampled.map((row) => row.regret)));
  }
  success.sort((left, right) => left - right);
  successDelta.sort((left, right) => left - right);
  regret.sort((left, right) => left - right);
  return {
    meanTaskSuccess: { low: rounded(quantile(success, 0.025)), high: rounded(quantile(success, 0.975)) },
    meanTaskSuccessDelta: {
      low: rounded(quantile(successDelta, 0.025)),
      high: rounded(quantile(successDelta, 0.975)),
    },
    meanRegret: { low: rounded(quantile(regret, 0.025)), high: rounded(quantile(regret, 0.975)) },
  };
}

function analyzedSlice(
  trials: readonly LiveTrialResultV1[],
  options?: { bootstrapSeed: number; bootstrapResamples: number },
): ResearchAnalysisSliceV1 {
  const counts = countsFor(trials);
  const identifiable = counts.hits + counts.misses > 0 && counts.falseAlarms + counts.correctRejections > 0;
  const metrics = identifiable ? signalDetectionMetrics(counts) : null;
  const slice: ResearchAnalysisSliceV1 = {
    trials: trials.length,
    ...counts,
    dPrime: metrics ? rounded(metrics.dPrime) : null,
    criterion: metrics ? rounded(metrics.criterion) : null,
    meanTaskSuccess: rounded(average(trials.map((trial) => trial.taskSuccessRate))),
    meanTaskSuccessDelta: rounded(average(trials.map(taskSuccessDelta))),
    meanRegret: rounded(average(trials.map((trial) => trial.regret))),
  };
  if (!options || trials.length === 0) return slice;

  const rows: FamilyConfusionCounts[] = [...new Set(trials.map((trial) => trial.family))]
    .sort()
    .map((family) => ({
      family,
      counts: countsFor(trials.filter((trial) => trial.family === family)),
    }));
  const bootstrap = metrics
    ? familyClusterBootstrap(rows, {
      seed: options.bootstrapSeed,
      resamples: options.bootstrapResamples,
    })
    : null;
  slice.confidenceIntervals = {
    dPrime: bootstrap?.dPrime
      ? { low: rounded(bootstrap.dPrime.lower), high: rounded(bootstrap.dPrime.upper) }
      : null,
    criterion: bootstrap?.criterion
      ? { low: rounded(bootstrap.criterion.lower), high: rounded(bootstrap.criterion.upper) }
      : null,
    ...meanIntervals(
      trials.map((trial) => ({
        family: trial.family,
        taskSuccess: trial.taskSuccessRate,
        taskSuccessDelta: taskSuccessDelta(trial),
        regret: trial.regret,
      })),
      options.bootstrapSeed,
      options.bootstrapResamples,
    ),
  };
  return slice;
}

function groupSlices(
  trials: readonly LiveTrialResultV1[],
  keyOf: (trial: LiveTrialResultV1) => string,
): Record<string, ResearchAnalysisSliceV1> {
  const groups = new Map<string, LiveTrialResultV1[]>();
  for (const trial of trials) {
    const key = keyOf(trial);
    const rows = groups.get(key) ?? [];
    rows.push(trial);
    groups.set(key, rows);
  }
  return Object.fromEntries(
    [...groups].sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rows]) => [key, analyzedSlice(rows)]),
  );
}

/**
 * Build the preregistered ITT analysis and the valid-response-only sensitivity.
 * Any non-valid first attempt is a non-intervention in ITT; observations are never retried.
 */
export function analyzeResearchTrials(
  trialValues: readonly LiveTrialResultV1[],
  options: AnalyzeResearchTrialsOptions,
): ResearchAnalysisV1 {
  const generatedAt = new Date(options.generatedAt);
  if (!Number.isFinite(generatedAt.valueOf())) throw new Error("Analysis generatedAt must be an ISO timestamp");
  if (!Number.isInteger(options.bootstrapSeed) || options.bootstrapSeed < 0 || options.bootstrapSeed > 0xffff_ffff) {
    throw new Error("Analysis bootstrapSeed must be an unsigned 32-bit integer");
  }
  const bootstrapResamples = options.bootstrapResamples ?? 10_000;
  if (!Number.isSafeInteger(bootstrapResamples) || bootstrapResamples <= 0) {
    throw new Error("Analysis bootstrapResamples must be a positive safe integer");
  }
  const trials = trialValues.map((trial) => structuredClone(trial));
  const ids = new Set<string>();
  for (const trial of trials) {
    if (ids.has(trial.trialId)) throw new Error(`Duplicate live trial id: ${trial.trialId}`);
    ids.add(trial.trialId);
  }
  const valid = trials.filter((trial) => trial.modelAttempt.status === "valid");

  const refusals = trials.filter((trial) => trial.modelAttempt.status === "refusal").length;
  const timeouts = trials.filter((trial) => trial.modelAttempt.status === "timeout").length;
  const rateLimits = trials.filter((trial) => trial.modelAttempt.status === "rate-limit").length;
  const groundingFailures = trials.filter((trial) =>
    trial.modelAttempt.status === "invalid-schema" &&
    (trial.modelAttempt.errorClass === "grounding-error" ||
      (!trial.grounding.accepted && trial.parsedChoice.choice === "intervene"))
  ).length;
  const invalidJsonFailures = trials.filter((trial) => trial.modelAttempt.status === "invalid-json").length;
  const invalidSchemaFailures = trials.filter((trial) =>
    trial.modelAttempt.status === "invalid-schema" &&
    trial.modelAttempt.errorClass !== "grounding-error" &&
    !(!trial.grounding.accepted && trial.parsedChoice.choice === "intervene")
  ).length;
  const modelDrifts = trials.filter((trial) => trial.modelAttempt.status === "model-drift").length;
  const providerErrors = trials.filter((trial) => trial.modelAttempt.status === "provider-error").length;
  const outputTruncations = trials.filter((trial) =>
    trial.modelAttempt.errorClass === "output-truncated"
  ).length;
  const rate = (count: number): number => trials.length === 0 ? 0 : rounded(count / trials.length);
  const byFamily = groupSlices(trials, (trial) => trial.family);
  const familyDPrimes = Object.values(byFamily)
    .map((slice) => slice.dPrime)
    .filter((value): value is number => value !== null);
  const familyMean = familyDPrimes.length === 0 ? null : average(familyDPrimes);
  const familyVariance = familyMean === null || familyDPrimes.length < 2
    ? null
    : familyDPrimes.reduce((sum, value) => sum + (value - familyMean) ** 2, 0) / (familyDPrimes.length - 1);
  const powerSizing = estimateHeldOutFamilySampleSize(familyDPrimes);
  return {
    schemaVersion: 1,
    artifactKind: "seed.research.analysis",
    generatedAt: generatedAt.toISOString(),
    intentionToEvaluate: analyzedSlice(trials, {
      bootstrapSeed: options.bootstrapSeed,
      bootstrapResamples,
    }),
    validResponseSensitivity: analyzedSlice(valid),
    byModel: groupSlices(trials, (trial) => trial.modelAttempt.configuredModel),
    byModality: groupSlices(trials, (trial) => trial.modality),
    byAsymmetry: groupSlices(trials, (trial) => String(trial.condition.asymmetry)),
    byIncentive: groupSlices(trials, (trial) => trial.condition.incentive),
    byFamily,
    coverage: {
      totalTrials: trials.length,
      validTrials: valid.length,
      validityRate: trials.length === 0 ? 0 : rounded(valid.length / trials.length),
      refusals,
      refusalRate: rate(refusals),
      timeouts,
      timeoutRate: rate(timeouts),
      rateLimits,
      rateLimitRate: rate(rateLimits),
      invalidJsonFailures,
      invalidJsonFailureRate: rate(invalidJsonFailures),
      invalidSchemaFailures,
      invalidSchemaFailureRate: rate(invalidSchemaFailures),
      modelDrifts,
      modelDriftRate: rate(modelDrifts),
      groundingFailures,
      groundingFailureRate: rate(groundingFailures),
      providerErrors,
      providerErrorRate: rate(providerErrors),
      outputTruncations,
      outputTruncationRate: rate(outputTruncations),
    },
    familyVariance: {
      familyCount: Object.keys(byFamily).length,
      identifiableFamilyCount: familyDPrimes.length,
      meanDPrime: familyMean === null ? null : rounded(familyMean),
      sampleVarianceDPrime: familyVariance === null ? null : rounded(familyVariance),
    },
    powerSizing: {
      status: powerSizing.status,
      currentFamilyCount: Object.keys(byFamily).length,
      identifiableFamilyCount: familyDPrimes.length,
      alpha: powerSizing.alpha,
      targetPower: powerSizing.targetPower,
      method: powerSizing.method,
      recommendedHeldOutFamilies: powerSizing.recommendedFamilies,
      note: powerSizing.status === "estimated"
        ? `Exploratory two-sided normal approximation recommends ${powerSizing.recommendedFamilies} independent held-out families at alpha 0.05 and 80% power; preregister and do not treat the six authored families as confirmatory evidence.`
        : `Held-out-family sizing is unavailable (${powerSizing.reason}); preregister an expansion and do not treat the six authored families as confirmatory evidence.`,
    },
  };
}
