/**
 * Versioned, model-free preparation artifacts for Wakeward research runs.
 *
 * This module deliberately stops before execution. It expands the validated research suite into
 * stable condition cells and planned branch records, captures content/repository provenance, and
 * writes a checksummed package that a future counterfactual runner can consume. No model is called,
 * no outcome is fabricated, and scenario strata are never promoted into value labels.
 *
 * @author Runkai Zhang
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  LoadedResearchSuite,
  ResearchCondition,
  ResearchIntervention,
  ResearchOutcomeMetric,
  ResearchScenario,
} from "./scenario.ts";

export const RESEARCH_PREPARATION_SCHEMA_VERSION = 1 as const;

export interface ResearchSourceFile {
  /** Portable, repository-relative path when the caller can provide one. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface ResearchRepositoryProvenance {
  commit: string | null;
  /** `null` means the caller could not inspect a repository. */
  dirty: boolean | null;
}

export interface ResearchRuntimeProvenance {
  bun: string | null;
  node: string;
}

export type ResearchBranchKind = "intervention" | "silence";

export interface PlannedResearchEpisode {
  episodeId: string;
  pairingId: string;
  sharedPrefixId: string;
  scenarioId: string;
  opportunityId: string;
  family: string;
  opportunityKind: ResearchScenario["opportunityKind"];
  pairedScenarioId: string;
  controlScenarioId: string;
  tags: string[];
  branch: ResearchBranchKind;
  condition: ResearchCondition;
  setup: ResearchScenario["setup"];
  relevantFactIds: string[];
  playerKnownFactIds: string[];
  companionKnownFactIds: string[];
  companionGoals: string[];
  plannedIntervention: ResearchIntervention;
  rollout: ResearchScenario["rollout"];
  suffixHorizonTurns: number;
  interventionBudget: number;
  outcomeMetrics: ResearchOutcomeMetric[];
  status: "planned";
}

export interface ResearchConditionCell {
  cellId: string;
  scenarioId: string;
  opportunityId: string;
  family: string;
  opportunityKind: ResearchScenario["opportunityKind"];
  pairedScenarioId: string;
  controlScenarioId: string;
  condition: ResearchCondition;
  episodes: PlannedResearchEpisode[];
}

export interface ResearchPreparationArtifact {
  schemaVersion: typeof RESEARCH_PREPARATION_SCHEMA_VERSION;
  artifactKind: "seed.research.preparation";
  artifactHash: string;
  planId: string;
  /** Stable across generation time, run id, repository dirtiness, and runtime versions. */
  planHash: string;
  runId: string;
  generatedAt: string;
  execution: {
    status: "not-run";
    runnerStatus: "available-model-free-scripted-v1";
    modelCalls: 0;
    outcomeRecords: 0;
    note: string;
  };
  source: {
    worldDir: string;
    worldId: string;
    campaignId: string;
    suiteVersion: number;
    sourceDigest: string;
    files: ResearchSourceFile[];
    repository: ResearchRepositoryProvenance;
    runtime: ResearchRuntimeProvenance;
  };
  design: {
    companionId: string;
    asymmetryLevels: ResearchCondition["asymmetry"][];
    incentives: ResearchCondition["incentive"][];
    scenarioCount: number;
    conditionCellCount: number;
    plannedEpisodeCount: number;
    interventionEpisodeCount: number;
    silenceEpisodeCount: number;
  };
  cells: ResearchConditionCell[];
}

export interface BuildResearchPreparationOptions {
  runId: string;
  generatedAt: string;
  worldDir: string;
  sourceFiles: ResearchSourceFile[];
  repository?: Partial<ResearchRepositoryProvenance>;
  runtime?: Partial<ResearchRuntimeProvenance>;
}

export interface ResearchPreparationPaths {
  directory: string;
  plan: string;
  episodes: string;
  readme: string;
  checksums: string;
}

const PLAN_FILE = "experiment-plan.json";
const EPISODES_FILE = "episodes.jsonl";
const README_FILE = "README.md";
const CHECKSUM_FILE = "SHA256SUMS";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable JSON for identifiers and hashes; arrays retain authored order, object keys do not. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => canonicalJson(row)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
  return `{${entries.map(([key, row]) => `${JSON.stringify(key)}:${canonicalJson(row)}`).join(",")}}`;
}

export function researchSourceFile(path: string, contents: string | Uint8Array): ResearchSourceFile {
  return {
    path,
    sha256: sha256(contents),
    bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength,
  };
}

function validatedSourceFiles(files: readonly ResearchSourceFile[]): ResearchSourceFile[] {
  if (files.length === 0) throw new Error("Research preparation requires at least one source file");
  const paths = new Set<string>();
  return [...files]
    .map((file) => {
      if (!file.path || file.path.startsWith("/") || file.path.includes("\\")) {
        throw new Error(`Research source path must be portable and relative: "${file.path}"`);
      }
      if (paths.has(file.path)) throw new Error(`Research source path is duplicated: "${file.path}"`);
      paths.add(file.path);
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Research source hash is not SHA-256: "${file.path}"`);
      }
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        throw new Error(`Research source byte count is invalid: "${file.path}"`);
      }
      return { ...file };
    })
    .sort((left, right) => compareText(left.path, right.path));
}

function conditionId(scenario: ResearchScenario, condition: ResearchCondition): string {
  return `${scenario.id}::asymmetry=${condition.asymmetry}::incentive=${condition.incentive}::seed=${condition.seed}`;
}

function branchesFor(scenario: ResearchScenario): ResearchBranchKind[] {
  return scenario.opportunityKind === "control" ? ["silence"] : ["intervention", "silence"];
}

function plannedEpisode(
  loaded: LoadedResearchSuite,
  scenario: ResearchScenario,
  condition: ResearchCondition,
  cellId: string,
  branch: ResearchBranchKind,
): PlannedResearchEpisode {
  const mask = scenario.factMasks[String(condition.asymmetry) as "0" | "0.3" | "0.7"];
  return {
    episodeId: `${cellId}::branch=${branch}`,
    pairingId: cellId,
    sharedPrefixId: `${cellId}::prefix`,
    scenarioId: scenario.id,
    opportunityId: scenario.opportunityId,
    family: scenario.family,
    opportunityKind: scenario.opportunityKind,
    pairedScenarioId: scenario.pairedScenarioId,
    controlScenarioId: scenario.controlScenarioId,
    tags: [...scenario.tags],
    branch,
    condition: structuredClone(condition),
    setup: structuredClone(scenario.setup),
    relevantFactIds: [...scenario.relevantFactIds],
    playerKnownFactIds: [...mask.playerKnownFactIds],
    companionKnownFactIds: [...mask.companionKnownFactIds],
    companionGoals: [
      ...loaded.manifest.sharedCompanionGoals,
      ...scenario.incentiveGoals[condition.incentive],
    ],
    plannedIntervention:
      branch === "intervention" ? structuredClone(scenario.intervention) : { kind: "none" },
    rollout: structuredClone(scenario.rollout),
    suffixHorizonTurns: scenario.suffixHorizonTurns,
    interventionBudget: branch === "intervention" ? scenario.interventionBudget : 0,
    outcomeMetrics: structuredClone(scenario.outcomeMetrics),
    status: "planned",
  };
}

/** Expand a validated suite into a versioned plan without executing or scoring an episode. */
export function buildResearchPreparation(
  loaded: LoadedResearchSuite,
  options: BuildResearchPreparationOptions,
): ResearchPreparationArtifact {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.runId)) {
    throw new Error("Research run id must be 1-128 portable filename characters");
  }
  const parsedAt = new Date(options.generatedAt);
  if (!Number.isFinite(parsedAt.valueOf())) throw new Error("Research generatedAt must be an ISO timestamp");

  const files = validatedSourceFiles(options.sourceFiles);
  const sourceDigest = sha256(canonicalJson(files));
  const scenarios = [...loaded.manifest.scenarios].sort((left, right) => compareText(left.id, right.id));
  const cells: ResearchConditionCell[] = [];
  for (const scenario of scenarios) {
    for (const asymmetry of loaded.manifest.asymmetryLevels) {
      for (const incentive of loaded.manifest.incentives) {
        const condition: ResearchCondition = { asymmetry, incentive, seed: scenario.rngSeed };
        const cellId = conditionId(scenario, condition);
        cells.push({
          cellId,
          scenarioId: scenario.id,
          opportunityId: scenario.opportunityId,
          family: scenario.family,
          opportunityKind: scenario.opportunityKind,
          pairedScenarioId: scenario.pairedScenarioId,
          controlScenarioId: scenario.controlScenarioId,
          condition: structuredClone(condition),
          episodes: branchesFor(scenario).map((branch) =>
            plannedEpisode(loaded, scenario, condition, cellId, branch)
          ),
        });
      }
    }
  }

  const episodes = cells.flatMap((cell) => cell.episodes);
  const planCore = {
    schemaVersion: RESEARCH_PREPARATION_SCHEMA_VERSION,
    sourceDigest,
    worldId: loaded.manifest.worldId,
    campaignId: loaded.manifest.campaignId,
    suiteVersion: loaded.manifest.version,
    companionId: loaded.manifest.companionId,
    asymmetryLevels: loaded.manifest.asymmetryLevels,
    incentives: loaded.manifest.incentives,
    cells,
  };
  const planHash = sha256(canonicalJson(planCore));
  const base = {
    schemaVersion: RESEARCH_PREPARATION_SCHEMA_VERSION,
    artifactKind: "seed.research.preparation" as const,
    planId: `seed-plan-${planHash.slice(0, 16)}`,
    planHash,
    runId: options.runId,
    generatedAt: parsedAt.toISOString(),
    execution: {
      status: "not-run" as const,
      runnerStatus: "available-model-free-scripted-v1" as const,
      modelCalls: 0 as const,
      outcomeRecords: 0 as const,
      note: "Preparation only: the model-free scripted runner is available, but no episode or outcome in this package has run.",
    },
    source: {
      worldDir: options.worldDir,
      worldId: loaded.manifest.worldId,
      campaignId: loaded.manifest.campaignId,
      suiteVersion: loaded.manifest.version,
      sourceDigest,
      files,
      repository: {
        commit: options.repository?.commit ?? null,
        dirty: options.repository?.dirty ?? null,
      },
      runtime: {
        bun: options.runtime?.bun ?? null,
        node: options.runtime?.node ?? process.version,
      },
    },
    design: {
      companionId: loaded.manifest.companionId,
      asymmetryLevels: [...loaded.manifest.asymmetryLevels],
      incentives: [...loaded.manifest.incentives],
      scenarioCount: scenarios.length,
      conditionCellCount: cells.length,
      plannedEpisodeCount: episodes.length,
      interventionEpisodeCount: episodes.filter((row) => row.branch === "intervention").length,
      silenceEpisodeCount: episodes.filter((row) => row.branch === "silence").length,
    },
    cells,
  };
  return { ...base, artifactHash: sha256(canonicalJson(base)) };
}

export function researchPreparationJson(artifact: ResearchPreparationArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function researchEpisodesJsonl(artifact: ResearchPreparationArtifact): string {
  return `${artifact.cells
    .flatMap((cell) => cell.episodes)
    .map((episode) =>
      JSON.stringify({
        schemaVersion: artifact.schemaVersion,
        artifactKind: "seed.research.planned-episode",
        planId: artifact.planId,
        planHash: artifact.planHash,
        sourceDigest: artifact.source.sourceDigest,
        ...episode,
      })
    )
    .join("\n")}\n`;
}

export function renderResearchPreparationMarkdown(artifact: ResearchPreparationArtifact): string {
  const commit = artifact.source.repository.commit ?? "unavailable";
  const dirty = artifact.source.repository.dirty;
  const repoState = dirty === null ? "unknown" : dirty ? "dirty" : "clean";
  const familyCount = new Set(artifact.cells.map((cell) => cell.family)).size;
  return [
    `# Seed research preparation — ${artifact.runId}`,
    "",
    "> **Status: NOT RUN.** This package schedules conditions and branches only. It contains no model output or research result.",
    "",
    "## Identity",
    "",
    `- Plan: \`${artifact.planId}\``,
    `- Plan SHA-256: \`${artifact.planHash}\``,
    `- Artifact SHA-256: \`${artifact.artifactHash}\``,
    `- Source SHA-256: \`${artifact.source.sourceDigest}\``,
    `- Repository: \`${commit}\` (${repoState})`,
    `- Generated: ${artifact.generatedAt}`,
    "",
    "## Design inventory",
    "",
    `- ${artifact.design.scenarioCount} scenarios across ${familyCount} task families`,
    `- ${artifact.design.conditionCellCount} scenario × asymmetry × incentive cells`,
    `- ${artifact.design.plannedEpisodeCount} planned episodes: ${artifact.design.interventionEpisodeCount} intervention + ${artifact.design.silenceEpisodeCount} silence`,
    `- Asymmetry levels: ${artifact.design.asymmetryLevels.join(", ")}`,
    `- Incentives: ${artifact.design.incentives.join(", ")}`,
    "",
    "Control cells schedule silence only. Informing and instrumental cells share a prefix ID and schedule matched intervention/silence suffixes on the same fixed seed. Scenario tags remain strata, not value labels.",
    "",
    "## Files",
    "",
    `- \`${PLAN_FILE}\` — complete versioned plan and provenance`,
    `- \`${EPISODES_FILE}\` — one scheduler-friendly planned episode per line`,
    `- \`${CHECKSUM_FILE}\` — SHA-256 checksums for this package`,
    "",
    "Diagnostics and future result artifacts may record stable inputs, grounding, reason codes, and mechanical outcomes. They must not record hidden chain-of-thought.",
    "",
  ].join("\n");
}

/** Write into a missing or empty directory; never overwrite a prior preparation package. */
export async function writeResearchPreparationArtifacts(
  outputDir: string,
  artifact: ResearchPreparationArtifact,
): Promise<ResearchPreparationPaths> {
  const directory = resolve(outputDir);
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) throw new Error(`Refusing to overwrite non-empty artifact directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });

  const files = new Map<string, string>([
    [PLAN_FILE, researchPreparationJson(artifact)],
    [EPISODES_FILE, researchEpisodesJsonl(artifact)],
    [README_FILE, renderResearchPreparationMarkdown(artifact)],
  ]);
  await Promise.all([...files].map(([name, contents]) => writeFile(resolve(directory, name), contents, "utf8")));
  const checksums = [...files]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, contents]) => `${sha256(contents)}  ${name}`)
    .join("\n");
  await writeFile(resolve(directory, CHECKSUM_FILE), `${checksums}\n`, "utf8");

  return {
    directory,
    plan: resolve(directory, PLAN_FILE),
    episodes: resolve(directory, EPISODES_FILE),
    readme: resolve(directory, README_FILE),
    checksums: resolve(directory, CHECKSUM_FILE),
  };
}
