/**
 * Checksummed result artifacts for the bounded model-free research runner.
 *
 * Results contain observable inputs, grounded commands, state hashes, mechanical outcome vectors,
 * and aggregate paired deltas. They never contain hidden model reasoning.
 *
 * @author Runkai Zhang
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "../world/commands.ts";
import type { EmittedDelta } from "../events/deltas.ts";
import type { PlannedResearchEpisode, ResearchBranchKind } from "./artifacts.ts";
import { canonicalJson } from "./artifacts.ts";
import type { ResearchOutcomeMetric } from "./scenario.ts";

export const RESEARCH_RESULTS_SCHEMA_VERSION = 1 as const;
export const MODEL_FREE_RUNNER_ID = "model-free-scripted-v1" as const;

export interface ResearchMetricObservation {
  metric: ResearchOutcomeMetric;
  value: string | number | boolean;
  desiredSatisfied?: boolean;
  utility: number;
}

export interface ResearchSuffixAction {
  turn: number;
  kind: "move" | "caseAction";
  targetId: string;
  accepted: boolean;
  beforeStateHash: string;
  afterStateHash: string;
}

export interface ResearchInterventionReceipt {
  kind: "inform" | "act" | "none";
  grounding: "accepted" | "rejected" | "no-op";
  reasonCode: string;
  factsAdded: string[];
  command?: Command;
  deltas: EmittedDelta[];
}

export interface ResearchEpisodeResult {
  schemaVersion: typeof RESEARCH_RESULTS_SCHEMA_VERSION;
  artifactKind: "seed.research.episode-result";
  planId: string;
  planHash: string;
  sourceDigest: string;
  episodeId: string;
  pairingId: string;
  sharedPrefixId: string;
  scenarioId: string;
  family: string;
  opportunityKind: PlannedResearchEpisode["opportunityKind"];
  branch: ResearchBranchKind;
  condition: PlannedResearchEpisode["condition"];
  runnerId: typeof MODEL_FREE_RUNNER_ID;
  runnerStatus: "completed" | "policy-withheld" | "blocked" | "horizon-exhausted" | "error";
  runnerNote?: string;
  externalModelCalls: 0;
  stubGatewayRequests: { complete: number; stream: number; embed: number };
  sharedPrefixHash: string;
  branchStartHash: string;
  endStateHash: string;
  playerKnownFactIdsBefore: string[];
  playerKnownFactIdsAfter: string[];
  intervention: ResearchInterventionReceipt;
  suffix: {
    horizonTurns: number;
    turnsExecuted: number;
    waypointLocationIds: string[];
    requiredFactIds: string[];
    missingRequiredFactIds: string[];
    actions: ResearchSuffixAction[];
  };
  outcome: {
    score: number;
    desiredMetricsSatisfied: number;
    desiredMetricsTotal: number;
    metrics: ResearchMetricObservation[];
  };
}

export interface ResearchPairResult {
  pairingId: string;
  scenarioId: string;
  family: string;
  opportunityKind: "informing" | "instrumental";
  condition: PlannedResearchEpisode["condition"];
  interventionEpisodeId: string;
  silenceEpisodeId: string;
  interventionScore: number;
  silenceScore: number;
  comparisonStatus: "resolved" | "censored";
  censorReason?: string;
  utilityDelta: number | null;
  verdict: "positive" | "neutral" | "negative" | "censored";
}

export interface ResearchAggregateGroup {
  key: string;
  pairs: number;
  positive: number;
  neutral: number;
  negative: number;
  meanUtilityDelta: number;
}

export interface ResearchCensorGroup {
  reason: string;
  pairs: number;
  scenarioIds: string[];
}

export interface ResearchResultsArtifact {
  schemaVersion: typeof RESEARCH_RESULTS_SCHEMA_VERSION;
  artifactKind: "seed.research.results";
  resultHash: string;
  runId: string;
  generatedAt: string;
  plan: { planId: string; planHash: string; sourceDigest: string };
  runner: {
    id: typeof MODEL_FREE_RUNNER_ID;
    policy: "scripted-waypoints-v1";
    status: "completed" | "completed-with-blocked-episodes";
    externalModelCalls: 0;
    note: string;
  };
  scope: {
    scenarioIds: string[];
    plannedEpisodes: number;
    executedEpisodes: number;
  };
  summary: {
    completedEpisodes: number;
    policyWithheldEpisodes: number;
    blockedEpisodes: number;
    horizonExhaustedEpisodes: number;
    erroredEpisodes: number;
    pairCount: number;
    resolvedPairCount: number;
    censoredPairCount: number;
    positivePairs: number;
    neutralPairs: number;
    negativePairs: number;
    meanUtilityDelta: number;
    byFamily: ResearchAggregateGroup[];
    byOpportunityKind: ResearchAggregateGroup[];
    byAsymmetry: ResearchAggregateGroup[];
    byIncentive: ResearchAggregateGroup[];
    censoredByReason: ResearchCensorGroup[];
  };
  pairs: ResearchPairResult[];
  episodes: ResearchEpisodeResult[];
}

export interface ResearchResultsPaths {
  directory: string;
  results: string;
  episodes: string;
  readme: string;
  checksums: string;
}

const RESULTS_FILE = "experiment-results.json";
const EPISODES_FILE = "episode-results.jsonl";
const README_FILE = "README.md";
const CHECKSUM_FILE = "SHA256SUMS";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(rows: readonly number[]): number {
  return rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row, 0) / rows.length;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function aggregate(pairs: readonly ResearchPairResult[], keyOf: (pair: ResearchPairResult) => string): ResearchAggregateGroup[] {
  const grouped = new Map<string, ResearchPairResult[]>();
  for (const pair of pairs) {
    const key = keyOf(pair);
    const rows = grouped.get(key) ?? [];
    rows.push(pair);
    grouped.set(key, rows);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => ({
      key,
      pairs: rows.length,
      positive: rows.filter((row) => row.verdict === "positive").length,
      neutral: rows.filter((row) => row.verdict === "neutral").length,
      negative: rows.filter((row) => row.verdict === "negative").length,
      meanUtilityDelta: rounded(mean(rows.map((row) => {
        if (row.utilityDelta === null) throw new Error(`Censored pair ${row.pairingId} reached resolved aggregation`);
        return row.utilityDelta;
      }))),
    }));
}

function censorGroups(pairs: readonly ResearchPairResult[]): ResearchCensorGroup[] {
  const grouped = new Map<string, ResearchPairResult[]>();
  for (const pair of pairs) {
    if (pair.comparisonStatus !== "censored") continue;
    const reason = pair.censorReason ?? "unspecified";
    const rows = grouped.get(reason) ?? [];
    rows.push(pair);
    grouped.set(reason, rows);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, rows]) => ({
      reason,
      pairs: rows.length,
      scenarioIds: [...new Set(rows.map((row) => row.scenarioId))].sort(),
    }));
}

function comparisonBlocker(row: ResearchEpisodeResult): string | null {
  if (row.runnerStatus === "blocked" || row.runnerStatus === "horizon-exhausted" || row.runnerStatus === "error") {
    return `${row.branch}:${row.runnerStatus}:${row.runnerNote ?? "unspecified"}`;
  }
  return null;
}

export function researchStateHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function buildResearchResultsArtifact(options: {
  runId: string;
  generatedAt: string;
  planId: string;
  planHash: string;
  sourceDigest: string;
  scenarioIds: string[];
  plannedEpisodes: number;
  episodes: ResearchEpisodeResult[];
}): ResearchResultsArtifact {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.runId)) {
    throw new Error("Research result run id must be 1-128 portable filename characters");
  }
  const generatedAt = new Date(options.generatedAt);
  if (!Number.isFinite(generatedAt.valueOf())) throw new Error("Research result generatedAt must be an ISO timestamp");

  const byPair = new Map<string, ResearchEpisodeResult[]>();
  for (const episode of options.episodes) {
    if (episode.opportunityKind === "control") continue;
    const rows = byPair.get(episode.pairingId) ?? [];
    rows.push(episode);
    byPair.set(episode.pairingId, rows);
  }
  const pairs: ResearchPairResult[] = [...byPair]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pairingId, rows]) => {
      const intervention = rows.find((row) => row.branch === "intervention");
      const silence = rows.find((row) => row.branch === "silence");
      if (!intervention || !silence || rows.length !== 2) {
        throw new Error(`Research result pair "${pairingId}" is not one intervention plus one silence branch`);
      }
      const blockers = [comparisonBlocker(intervention), comparisonBlocker(silence)].filter(
        (row): row is string => row !== null,
      );
      const comparisonStatus = blockers.length === 0 ? "resolved" as const : "censored" as const;
      const utilityDelta = comparisonStatus === "resolved"
        ? rounded(intervention.outcome.score - silence.outcome.score)
        : null;
      return {
        pairingId,
        scenarioId: intervention.scenarioId,
        family: intervention.family,
        opportunityKind: intervention.opportunityKind as "informing" | "instrumental",
        condition: structuredClone(intervention.condition),
        interventionEpisodeId: intervention.episodeId,
        silenceEpisodeId: silence.episodeId,
        interventionScore: intervention.outcome.score,
        silenceScore: silence.outcome.score,
        comparisonStatus,
        ...(blockers.length > 0 ? { censorReason: blockers.join(" | ") } : {}),
        utilityDelta,
        verdict: comparisonStatus === "censored"
          ? "censored" as const
          : utilityDelta! > 0
            ? "positive" as const
            : utilityDelta! < 0
              ? "negative" as const
              : "neutral" as const,
      };
    });

  const resolvedPairs = pairs.filter((row) => row.comparisonStatus === "resolved");

  const blocked = options.episodes.filter((row) => row.runnerStatus === "blocked").length;
  const exhausted = options.episodes.filter((row) => row.runnerStatus === "horizon-exhausted").length;
  const errors = options.episodes.filter((row) => row.runnerStatus === "error").length;
  const base = {
    schemaVersion: RESEARCH_RESULTS_SCHEMA_VERSION,
    artifactKind: "seed.research.results" as const,
    runId: options.runId,
    generatedAt: generatedAt.toISOString(),
    plan: { planId: options.planId, planHash: options.planHash, sourceDigest: options.sourceDigest },
    runner: {
      id: MODEL_FREE_RUNNER_ID,
      policy: "scripted-waypoints-v1" as const,
      status: blocked + exhausted + errors > 0 ? "completed-with-blocked-episodes" as const : "completed" as const,
      externalModelCalls: 0 as const,
      note: "Model-free scripted-policy run. It measures the authored substrate and oracle intervention value, not live-agent decision quality.",
    },
    scope: {
      scenarioIds: [...options.scenarioIds].sort(),
      plannedEpisodes: options.plannedEpisodes,
      executedEpisodes: options.episodes.length,
    },
    summary: {
      completedEpisodes: options.episodes.filter((row) => row.runnerStatus === "completed").length,
      policyWithheldEpisodes: options.episodes.filter((row) => row.runnerStatus === "policy-withheld").length,
      blockedEpisodes: blocked,
      horizonExhaustedEpisodes: exhausted,
      erroredEpisodes: errors,
      pairCount: pairs.length,
      resolvedPairCount: resolvedPairs.length,
      censoredPairCount: pairs.length - resolvedPairs.length,
      positivePairs: resolvedPairs.filter((row) => row.verdict === "positive").length,
      neutralPairs: resolvedPairs.filter((row) => row.verdict === "neutral").length,
      negativePairs: resolvedPairs.filter((row) => row.verdict === "negative").length,
      meanUtilityDelta: rounded(mean(resolvedPairs.map((row) => row.utilityDelta!))),
      byFamily: aggregate(resolvedPairs, (row) => row.family),
      byOpportunityKind: aggregate(resolvedPairs, (row) => row.opportunityKind),
      byAsymmetry: aggregate(resolvedPairs, (row) => String(row.condition.asymmetry)),
      byIncentive: aggregate(resolvedPairs, (row) => row.condition.incentive),
      censoredByReason: censorGroups(pairs),
    },
    pairs,
    episodes: options.episodes,
  };
  return { ...base, resultHash: sha256(canonicalJson(base)) };
}

export function renderResearchResultsMarkdown(artifact: ResearchResultsArtifact): string {
  const s = artifact.summary;
  const groupLines = (rows: ResearchAggregateGroup[]) =>
    rows.map((row) => `- ${row.key}: ${row.positive} positive / ${row.neutral} neutral / ${row.negative} negative; mean Δ ${row.meanUtilityDelta}`);
  return [
    `# Seed research results — ${artifact.runId}`,
    "",
    "> **Model-free scripted-policy result.** This is executable substrate evidence, not live-agent performance or a d-prime/criterion estimate.",
    "",
    "## Identity",
    "",
    `- Result SHA-256: \`${artifact.resultHash}\``,
    `- Plan: \`${artifact.plan.planId}\``,
    `- Plan SHA-256: \`${artifact.plan.planHash}\``,
    `- Source SHA-256: \`${artifact.plan.sourceDigest}\``,
    `- Runner: \`${artifact.runner.id}\``,
    `- Generated: ${artifact.generatedAt}`,
    "",
    "## Execution",
    "",
    `- ${artifact.scope.executedEpisodes}/${artifact.scope.plannedEpisodes} selected episodes executed`,
    `- ${s.completedEpisodes} completed · ${s.policyWithheldEpisodes} policy-withheld · ${s.blockedEpisodes} blocked · ${s.horizonExhaustedEpisodes} horizon-exhausted · ${s.erroredEpisodes} errors`,
    `- External model calls: ${artifact.runner.externalModelCalls}`,
    "",
    "## Paired results",
    "",
    `- ${s.pairCount} matched intervention/silence pairs: ${s.resolvedPairCount} resolved · ${s.censoredPairCount} censored`,
    `- ${s.positivePairs} positive · ${s.neutralPairs} neutral · ${s.negativePairs} negative`,
    `- Mean paired utility delta across resolved pairs: ${s.meanUtilityDelta}`,
    "",
    "### By family (resolved pairs only)",
    "",
    ...groupLines(s.byFamily),
    "",
    "### By opportunity kind (resolved pairs only)",
    "",
    ...groupLines(s.byOpportunityKind),
    "",
    "### By asymmetry (resolved pairs only)",
    "",
    ...groupLines(s.byAsymmetry),
    "",
    "### Censored comparisons",
    "",
    ...(s.censoredByReason.length === 0
      ? ["- None"]
      : s.censoredByReason.map((row) => `- ${row.pairs} pair(s): ${row.reason} [${row.scenarioIds.join(", ")}]`)),
    "",
    "## Interpretation boundary",
    "",
    "The runner applies the authored intervention or silence at one shared state, then drives both suffixes with the same deterministic waypoint policy and seed. Informing branches gate that policy on explicit facts; instrumental branches ground through the closed NPC-action table. Results can reveal whether scenarios and metrics produce a mechanical counterfactual difference. They cannot show whether a model chooses the intervention, estimate a model's criterion, or substitute for live-model validation.",
    "",
    "## Files",
    "",
    `- \`${RESULTS_FILE}\` — aggregate artifact plus paired and episode records`,
    `- \`${EPISODES_FILE}\` — one episode result per line`,
    `- \`${CHECKSUM_FILE}\` — package checksums`,
    "",
  ].join("\n");
}

/** Write into a missing or empty directory; never overwrite a prior result package. */
export async function writeResearchResultsArtifacts(
  outputDir: string,
  artifact: ResearchResultsArtifact,
): Promise<ResearchResultsPaths> {
  const directory = resolve(outputDir);
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) throw new Error(`Refusing to overwrite non-empty result directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  const files = new Map<string, string>([
    [RESULTS_FILE, `${JSON.stringify(artifact, null, 2)}\n`],
    [EPISODES_FILE, `${artifact.episodes.map((row) => JSON.stringify(row)).join("\n")}\n`],
    [README_FILE, renderResearchResultsMarkdown(artifact)],
  ]);
  await Promise.all([...files].map(([name, contents]) => writeFile(resolve(directory, name), contents, "utf8")));
  const checksums = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contents]) => `${sha256(contents)}  ${name}`)
    .join("\n");
  await writeFile(resolve(directory, CHECKSUM_FILE), `${checksums}\n`, "utf8");
  return {
    directory,
    results: resolve(directory, RESULTS_FILE),
    episodes: resolve(directory, EPISODES_FILE),
    readme: resolve(directory, README_FILE),
    checksums: resolve(directory, CHECKSUM_FILE),
  };
}
