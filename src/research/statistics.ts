/**
 * Pure signal-detection statistics for research analysis.
 *
 * Counts receive the uniform Hautus loglinear correction (0.5 is added to every
 * confusion-matrix cell). Family bootstrap rows are aggregated before sampling,
 * so every resample draws whole families rather than individual observations.
 */

export interface ConfusionCounts {
  hits: number;
  misses: number;
  falseAlarms: number;
  correctRejections: number;
}

export interface SignalDetectionRates {
  hitRate: number;
  falseAlarmRate: number;
}

export interface SignalDetectionMetrics extends SignalDetectionRates {
  dPrime: number;
  criterion: number;
}

/** One or more count rows may share a family; they are combined into one cluster. */
export interface FamilyConfusionCounts {
  family: string;
  counts: ConfusionCounts;
}

export interface PercentileConfidenceInterval {
  method: "percentile";
  level: 0.95;
  lower: number;
  upper: number;
}

export interface FamilyClusterBootstrapOptions {
  /** Unsigned 32-bit seed recorded with the analysis artifact. */
  seed: number;
  /** Defaults to the preregistered 10,000 resamples. */
  resamples?: number;
}

export interface FamilyClusterBootstrapResult {
  seed: number;
  resamples: number;
  familyCount: number;
  estimate: SignalDetectionMetrics;
  /** Unavailable when a whole-family resample can contain only one class. */
  dPrime: PercentileConfidenceInterval | null;
  /** Unavailable when a whole-family resample can contain only one class. */
  criterion: PercentileConfidenceInterval | null;
}

export interface HeldOutFamilyPowerEstimate {
  status: "estimated" | "unavailable";
  familyCount: number;
  meanEffect: number | null;
  sampleVariance: number | null;
  alpha: 0.05;
  targetPower: 0.8;
  recommendedFamilies: number | null;
  method: "two-sided-normal-approximation";
  reason?: "fewer-than-two-identifiable-families" | "zero-observed-effect" | "estimate-exceeds-safe-integer-range";
}

export const DEFAULT_FAMILY_BOOTSTRAP_RESAMPLES = 10_000;

const COUNT_FIELDS = ["hits", "misses", "falseAlarms", "correctRejections"] as const;
const MIN_OPEN_PROBABILITY = Number.EPSILON / 2;

function assertCountsShape(counts: ConfusionCounts, label = "Confusion counts"): void {
  for (const field of COUNT_FIELDS) {
    const value = counts[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label}.${field} must be a non-negative safe integer`);
    }
  }
}

function assertUsableCounts(counts: ConfusionCounts, label = "Confusion counts"): void {
  assertCountsShape(counts, label);
  if (counts.hits + counts.misses === 0) {
    throw new RangeError(`${label} must contain at least one signal-present trial`);
  }
  if (counts.falseAlarms + counts.correctRejections === 0) {
    throw new RangeError(`${label} must contain at least one signal-absent trial`);
  }
}

function hasBothClasses(counts: ConfusionCounts): boolean {
  return counts.hits + counts.misses > 0 && counts.falseAlarms + counts.correctRejections > 0;
}

function openProbability(value: number): number {
  return Math.min(1 - MIN_OPEN_PROBABILITY, Math.max(MIN_OPEN_PROBABILITY, value));
}

/**
 * Uniform Hautus/loglinear correction:
 * H=(hits+0.5)/(hits+misses+1), F=(falseAlarms+0.5)/(falseAlarms+CR+1).
 */
export function hautusCorrectedRates(counts: ConfusionCounts): SignalDetectionRates {
  assertUsableCounts(counts);
  return {
    hitRate: openProbability((counts.hits + 0.5) / (counts.hits + counts.misses + 1)),
    falseAlarmRate: openProbability(
      (counts.falseAlarms + 0.5) / (counts.falseAlarms + counts.correctRejections + 1),
    ),
  };
}

/**
 * Inverse CDF of the standard normal distribution.
 *
 * Peter J. Acklam's rational approximation is evaluated separately in the two
 * tails and center. `log1p` avoids cancellation in the upper tail.
 */
export function inverseStandardNormalCdf(probability: number): number {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new RangeError("Standard-normal probability must be finite and strictly between 0 and 1");
  }

  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ] as const;

  const lowerTail = 0.02425;
  if (probability < lowerTail) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > 1 - lowerTail) {
    const q = Math.sqrt(-2 * Math.log1p(-probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Compute corrected rates, d-prime, and response criterion from one matrix. */
export function signalDetectionMetrics(counts: ConfusionCounts): SignalDetectionMetrics {
  const rates = hautusCorrectedRates(counts);
  const hitZ = inverseStandardNormalCdf(rates.hitRate);
  const falseAlarmZ = inverseStandardNormalCdf(rates.falseAlarmRate);
  return {
    ...rates,
    dPrime: hitZ - falseAlarmZ,
    criterion: -0.5 * (hitZ + falseAlarmZ),
  };
}

export function dPrime(counts: ConfusionCounts): number {
  return signalDetectionMetrics(counts).dPrime;
}

export function criterion(counts: ConfusionCounts): number {
  return signalDetectionMetrics(counts).criterion;
}

function emptyCounts(): ConfusionCounts {
  return { hits: 0, misses: 0, falseAlarms: 0, correctRejections: 0 };
}

function addCounts(target: ConfusionCounts, source: ConfusionCounts, label: string): void {
  for (const field of COUNT_FIELDS) {
    const value = target[field] + source[field];
    if (!Number.isSafeInteger(value)) throw new RangeError(`${label}.${field} exceeds safe-integer range`);
    target[field] = value;
  }
}

function aggregateFamilies(rows: readonly FamilyConfusionCounts[]): Array<{ family: string; counts: ConfusionCounts }> {
  if (rows.length === 0) throw new RangeError("Family-cluster bootstrap requires at least one family row");
  const grouped = new Map<string, ConfusionCounts>();
  for (const [index, row] of rows.entries()) {
    if (typeof row.family !== "string" || row.family.length === 0) {
      throw new RangeError(`Family row ${index} must have a non-empty family id`);
    }
    assertCountsShape(row.counts, `Family ${JSON.stringify(row.family)}`);
    const counts = grouped.get(row.family) ?? emptyCounts();
    addCounts(counts, row.counts, `Family ${JSON.stringify(row.family)}`);
    grouped.set(row.family, counts);
  }

  const families = [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([family, counts]) => ({
    family,
    counts,
  }));
  return families;
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
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function interval95(values: number[]): PercentileConfidenceInterval {
  values.sort((left, right) => left - right);
  return {
    method: "percentile",
    level: 0.95,
    lower: quantile(values, 0.025),
    upper: quantile(values, 0.975),
  };
}

/**
 * Deterministic percentile family-cluster bootstrap.
 *
 * Each replicate samples `familyCount` whole families with replacement, sums
 * their confusion matrices, and recomputes both signal-detection statistics.
 */
export function familyClusterBootstrap(
  rows: readonly FamilyConfusionCounts[],
  options: FamilyClusterBootstrapOptions,
): FamilyClusterBootstrapResult {
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) {
    throw new RangeError("Bootstrap seed must be an unsigned 32-bit integer");
  }
  const resamples = options.resamples ?? DEFAULT_FAMILY_BOOTSTRAP_RESAMPLES;
  if (!Number.isSafeInteger(resamples) || resamples <= 0) {
    throw new RangeError("Bootstrap resamples must be a positive safe integer");
  }

  const families = aggregateFamilies(rows);
  const totals = emptyCounts();
  for (const family of families) addCounts(totals, family.counts, "Combined confusion counts");
  const estimate = signalDetectionMetrics(totals);
  // If any family lacks a class, a valid whole-family resample can be
  // unidentifiable (for example, repeatedly drawing a signal-only family).
  // A conditional interval over only identifiable replicates would fabricate
  // precision, so the signal-detection intervals are explicitly unavailable.
  const intervalsIdentifiable = families.every((family) => hasBothClasses(family.counts));
  const random = mulberry32(options.seed);
  const dPrimeSamples: number[] = [];
  const criterionSamples: number[] = [];

  for (let replicate = 0; replicate < resamples; replicate++) {
    const sampled = emptyCounts();
    for (let draw = 0; draw < families.length; draw++) {
      const family = families[Math.floor(random() * families.length)]!;
      addCounts(sampled, family.counts, `Bootstrap replicate ${replicate}`);
    }
    if (intervalsIdentifiable) {
      const metrics = signalDetectionMetrics(sampled);
      dPrimeSamples.push(metrics.dPrime);
      criterionSamples.push(metrics.criterion);
    }
  }

  return {
    seed: options.seed,
    resamples,
    familyCount: families.length,
    estimate,
    dPrime: intervalsIdentifiable ? interval95(dPrimeSamples) : null,
    criterion: intervalsIdentifiable ? interval95(criterionSamples) : null,
  };
}

/**
 * Exploratory held-out-family sizing from the observed between-family d-prime
 * distribution. This is deliberately a transparent normal approximation, not
 * a claim that the six authored families are publication-grade evidence.
 */
export function estimateHeldOutFamilySampleSize(
  familyEffects: readonly number[],
): HeldOutFamilyPowerEstimate {
  for (const effect of familyEffects) {
    if (!Number.isFinite(effect)) throw new RangeError("Family effects must be finite numbers");
  }
  const base = {
    familyCount: familyEffects.length,
    alpha: 0.05 as const,
    targetPower: 0.8 as const,
    method: "two-sided-normal-approximation" as const,
  };
  if (familyEffects.length < 2) {
    return {
      ...base,
      status: "unavailable",
      meanEffect: familyEffects.length === 0 ? null : familyEffects[0]!,
      sampleVariance: null,
      recommendedFamilies: null,
      reason: "fewer-than-two-identifiable-families",
    };
  }
  const meanEffect = familyEffects.reduce((sum, value) => sum + value, 0) / familyEffects.length;
  const sampleVariance = familyEffects.reduce((sum, value) => sum + (value - meanEffect) ** 2, 0) /
    (familyEffects.length - 1);
  if (meanEffect === 0) {
    return {
      ...base,
      status: "unavailable",
      meanEffect,
      sampleVariance,
      recommendedFamilies: null,
      reason: "zero-observed-effect",
    };
  }
  const alphaCriticalValue = inverseStandardNormalCdf(1 - base.alpha / 2);
  const powerCriticalValue = inverseStandardNormalCdf(base.targetPower);
  const rawFamilies = ((alphaCriticalValue + powerCriticalValue) ** 2 * sampleVariance) / meanEffect ** 2;
  const recommendedFamilies = Math.max(2, Math.ceil(rawFamilies));
  if (!Number.isSafeInteger(recommendedFamilies)) {
    return {
      ...base,
      status: "unavailable",
      meanEffect,
      sampleVariance,
      recommendedFamilies: null,
      reason: "estimate-exceeds-safe-integer-range",
    };
  }
  return {
    ...base,
    status: "estimated",
    meanEffect,
    sampleVariance,
    recommendedFamilies,
  };
}
