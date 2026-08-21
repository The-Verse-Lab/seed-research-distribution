import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FAMILY_BOOTSTRAP_RESAMPLES,
  criterion,
  dPrime,
  estimateHeldOutFamilySampleSize,
  familyClusterBootstrap,
  hautusCorrectedRates,
  inverseStandardNormalCdf,
  signalDetectionMetrics,
  type FamilyConfusionCounts,
} from "../src/research/statistics.ts";

describe("signal-detection statistics", () => {
  test("computes Hautus-corrected rates, d-prime, and criterion for a known matrix", () => {
    const counts = { hits: 40, misses: 10, falseAlarms: 5, correctRejections: 45 };
    const rates = hautusCorrectedRates(counts);
    const metrics = signalDetectionMetrics(counts);

    expect(rates.hitRate).toBe(40.5 / 51);
    expect(rates.falseAlarmRate).toBe(5.5 / 51);
    expect(metrics.dPrime).toBeCloseTo(2.0588724238794884, 7);
    expect(metrics.criterion).toBeCloseTo(0.20864412360736379, 7);
    expect(dPrime(counts)).toBe(metrics.dPrime);
    expect(criterion(counts)).toBe(metrics.criterion);
    expect(inverseStandardNormalCdf(0.5)).toBeCloseTo(0, 12);
    expect(inverseStandardNormalCdf(0.975)).toBeCloseTo(1.959963984540054, 7);
  });

  test("keeps zero-hit and zero-false-alarm extremes finite", () => {
    for (const counts of [
      { hits: 0, misses: 20, falseAlarms: 0, correctRejections: 20 },
      { hits: 20, misses: 0, falseAlarms: 0, correctRejections: 20 },
    ]) {
      const metrics = signalDetectionMetrics(counts);
      expect(metrics.hitRate).toBeGreaterThan(0);
      expect(metrics.hitRate).toBeLessThan(1);
      expect(metrics.falseAlarmRate).toBeGreaterThan(0);
      expect(metrics.falseAlarmRate).toBeLessThan(1);
      expect(Number.isFinite(metrics.dPrime)).toBe(true);
      expect(Number.isFinite(metrics.criterion)).toBe(true);
    }
  });

  test("rejects invalid or unidentifiable confusion matrices", () => {
    expect(() => signalDetectionMetrics({ hits: -1, misses: 1, falseAlarms: 1, correctRejections: 1 }))
      .toThrow(/non-negative safe integer/);
    expect(() => signalDetectionMetrics({ hits: 0.5, misses: 1, falseAlarms: 1, correctRejections: 1 }))
      .toThrow(/non-negative safe integer/);
    expect(() => signalDetectionMetrics({ hits: 0, misses: 0, falseAlarms: 1, correctRejections: 1 }))
      .toThrow(/signal-present/);
    expect(() => signalDetectionMetrics({ hits: 1, misses: 1, falseAlarms: 0, correctRejections: 0 }))
      .toThrow(/signal-absent/);
    expect(() => inverseStandardNormalCdf(0)).toThrow(/strictly between/);
  });
});

const FAMILY_ROWS: FamilyConfusionCounts[] = [
  { family: "cold-passage", counts: { hits: 8, misses: 2, falseAlarms: 1, correctRejections: 9 } },
  { family: "second-bell", counts: { hits: 6, misses: 4, falseAlarms: 3, correctRejections: 7 } },
  { family: "clear-glass", counts: { hits: 9, misses: 1, falseAlarms: 2, correctRejections: 8 } },
];

describe("family-cluster bootstrap", () => {
  test("defaults to 10,000 resamples and is deterministic for a recorded seed", () => {
    const first = familyClusterBootstrap(FAMILY_ROWS, { seed: 0x51eed123 });
    const second = familyClusterBootstrap([...FAMILY_ROWS].reverse(), { seed: 0x51eed123 });

    expect(first.resamples).toBe(DEFAULT_FAMILY_BOOTSTRAP_RESAMPLES);
    expect(first.familyCount).toBe(3);
    expect(second).toEqual(first);
    expect(first.dPrime).toMatchObject({ method: "percentile", level: 0.95 });
    expect(first.criterion).toMatchObject({ method: "percentile", level: 0.95 });
    expect(first.dPrime!.lower).toBeLessThanOrEqual(first.estimate.dPrime);
    expect(first.dPrime!.upper).toBeGreaterThanOrEqual(first.estimate.dPrime);
  });

  test("aggregates duplicate family rows before resampling whole clusters", () => {
    const split: FamilyConfusionCounts[] = [
      { family: "family-a", counts: { hits: 3, misses: 1, falseAlarms: 1, correctRejections: 3 } },
      { family: "family-a", counts: { hits: 5, misses: 1, falseAlarms: 0, correctRejections: 4 } },
      { family: "family-b", counts: { hits: 2, misses: 6, falseAlarms: 5, correctRejections: 3 } },
    ];
    const aggregated: FamilyConfusionCounts[] = [
      { family: "family-a", counts: { hits: 8, misses: 2, falseAlarms: 1, correctRejections: 7 } },
      { family: "family-b", counts: { hits: 2, misses: 6, falseAlarms: 5, correctRejections: 3 } },
    ];

    const options = { seed: 73, resamples: 2_000 };
    expect(familyClusterBootstrap(split, options)).toEqual(familyClusterBootstrap(aggregated, options));
  });

  test("marks signal-detection intervals unavailable when whole-family resamples can lack a class", () => {
    const partialFamilies: FamilyConfusionCounts[] = [
      { family: "signal-only", counts: { hits: 3, misses: 1, falseAlarms: 0, correctRejections: 0 } },
      { family: "noise-only", counts: { hits: 0, misses: 0, falseAlarms: 1, correctRejections: 3 } },
    ];
    const result = familyClusterBootstrap(partialFamilies, { seed: 19, resamples: 100 });
    expect(result.estimate.dPrime).toBeFinite();
    expect(result.dPrime).toBeNull();
    expect(result.criterion).toBeNull();
  });
});

describe("held-out-family power sizing", () => {
  test("deterministically sizes a two-sided 5% test at 80% target power", () => {
    expect(estimateHeldOutFamilySampleSize([0.4, 0.8, 1.2, 1.6])).toEqual({
      status: "estimated",
      familyCount: 4,
      meanEffect: 1,
      sampleVariance: 0.26666666666666666,
      alpha: 0.05,
      targetPower: 0.8,
      recommendedFamilies: 3,
      method: "two-sided-normal-approximation",
    });
  });

  test("reports unavailable sizing instead of inventing variance or an effect", () => {
    expect(estimateHeldOutFamilySampleSize([0.5])).toMatchObject({
      status: "unavailable",
      recommendedFamilies: null,
      reason: "fewer-than-two-identifiable-families",
    });
    expect(estimateHeldOutFamilySampleSize([0, 0, 0])).toMatchObject({
      status: "unavailable",
      recommendedFamilies: null,
      reason: "zero-observed-effect",
    });
  });
});
