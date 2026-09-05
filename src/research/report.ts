/** Human-readable proof-of-concept report renderer. */
import type { ResearchAnalysisSliceV1, ResearchAnalysisV1 } from "./contracts.ts";
import type { ResearchGateResult } from "./live/gates.ts";

function number(value: number | null): string {
  return value === null ? "not identifiable" : value.toFixed(4);
}

function countAndRate(count: number, rate: number): string {
  return `${count} (${(rate * 100).toFixed(2)}%)`;
}

function sliceRow(label: string, slice: ResearchAnalysisSliceV1): string {
  return `| ${label} | ${slice.trials} | ${slice.hits} | ${slice.misses} | ${slice.falseAlarms} | ` +
    `${slice.correctRejections} | ${number(slice.dPrime)} | ${number(slice.criterion)} | ` +
    `${slice.meanTaskSuccess.toFixed(4)} | ${slice.meanTaskSuccessDelta.toFixed(4)} | ` +
    `${slice.meanRegret.toFixed(4)} |`;
}

function sliceTable(values: Record<string, ResearchAnalysisSliceV1>): string {
  return [
    "| Slice | N | Hits | Misses | False alarms | Correct rejections | d-prime | Criterion | Task success | Task-success delta | Regret |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(values).map(([label, slice]) => sliceRow(label, slice)),
  ].join("\n");
}

export function renderResearchReport(options: {
  phase: "smoke" | "pilot";
  analysis: ResearchAnalysisV1;
  gate: ResearchGateResult;
  suiteHash: string;
  qualificationExecutionCount: number;
  committedUsd: string;
}): string {
  const { analysis } = options;
  const ci = analysis.intentionToEvaluate.confidenceIntervals;
  return `# Seed Research Benchmark v2 report\n\n` +
    `> **Engineering proof of concept.** These six authored families are not publication-grade ` +
    `independent evidence. Confirmatory inference requires a preregistered held-out-family expansion.\n\n` +
    `- Suite SHA-256: \`${options.suiteHash}\`\n` +
    `- Deterministic oracle executions: ${options.qualificationExecutionCount}\n` +
    `- First-attempt trials: ${analysis.coverage.totalTrials}\n` +
    `- Valid responses: ${analysis.coverage.validTrials} (${(analysis.coverage.validityRate * 100).toFixed(2)}%)\n` +
    `- Recorded spend: USD ${options.committedUsd}\n` +
    `- ${options.phase === "smoke" ? "Provider smoke" : "Pilot"} gate: ` +
    `**${options.gate.passed ? "PASSED" : "FAILED"}**\n\n` +
    (options.gate.failures.length ? `Gate failures:\n${options.gate.failures.map((failure) => `- ${failure}`).join("\n")}\n\n` : "") +
    `## Intention-to-evaluate\n\n` +
    `${sliceTable({ overall: analysis.intentionToEvaluate })}\n\n` +
    (ci ? `Family-cluster 95% intervals: d-prime ${ci.dPrime?.low ?? "n/a"} to ${ci.dPrime?.high ?? "n/a"}; ` +
      `criterion ${ci.criterion?.low ?? "n/a"} to ${ci.criterion?.high ?? "n/a"}; ` +
      `task success ${ci.meanTaskSuccess?.low ?? "n/a"} to ${ci.meanTaskSuccess?.high ?? "n/a"}; ` +
      `task-success delta ${ci.meanTaskSuccessDelta?.low ?? "n/a"} to ${ci.meanTaskSuccessDelta?.high ?? "n/a"}; ` +
      `regret ${ci.meanRegret?.low ?? "n/a"} to ${ci.meanRegret?.high ?? "n/a"}.\n\n` : "") +
    `## Valid-response-only sensitivity\n\n` +
    `${sliceTable({ overall: analysis.validResponseSensitivity })}\n\n` +
    `## By model\n\n${sliceTable(analysis.byModel)}\n\n` +
    `## By modality\n\n${sliceTable(analysis.byModality)}\n\n` +
    `## By asymmetry\n\n${sliceTable(analysis.byAsymmetry)}\n\n` +
    `## By incentive\n\n${sliceTable(analysis.byIncentive)}\n\n` +
    `## Coverage and failures\n\n` +
    `Refusals ${countAndRate(analysis.coverage.refusals, analysis.coverage.refusalRate)}; ` +
    `timeouts ${countAndRate(analysis.coverage.timeouts, analysis.coverage.timeoutRate)}; ` +
    `rate limits ${countAndRate(analysis.coverage.rateLimits, analysis.coverage.rateLimitRate)}; ` +
    `invalid JSON ${countAndRate(analysis.coverage.invalidJsonFailures, analysis.coverage.invalidJsonFailureRate)}; ` +
    `invalid schema ${countAndRate(analysis.coverage.invalidSchemaFailures, analysis.coverage.invalidSchemaFailureRate)}; ` +
    `model drift ${countAndRate(analysis.coverage.modelDrifts, analysis.coverage.modelDriftRate)}; ` +
    `grounding failures ${countAndRate(analysis.coverage.groundingFailures, analysis.coverage.groundingFailureRate)}; ` +
    `provider errors ${countAndRate(analysis.coverage.providerErrors, analysis.coverage.providerErrorRate)}.\n\n` +
    `## Family variance and power sizing\n\n` +
    `Across ${analysis.familyVariance.familyCount} observed families ` +
    `(${analysis.familyVariance.identifiableFamilyCount} with identifiable d-prime), mean family d-prime is ` +
    `${number(analysis.familyVariance.meanDPrime)} and sample variance is ` +
    `${number(analysis.familyVariance.sampleVarianceDPrime)}. ${analysis.powerSizing.note}\n`;
}
