/** Checksummed, explicitly not-run preparation artifact for Research Benchmark v2. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildResearchDecisionPacket,
  expandResearchBenchmarkCells,
  type LoadedResearchBenchmarkV2,
} from "./benchmark.ts";
import { renderResearchPrompt } from "./prompt.ts";
import { canonicalResearchJson } from "./world/state.ts";

export interface ResearchPreparationSourceV2 {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ResearchPreparationV2 {
  schemaVersion: 2;
  artifactKind: "seed.research.preparation";
  planId: string;
  planHash: string;
  generatedAt: string;
  execution: {
    status: "not-run";
    modelCalls: 0;
    mechanicalExecutions: 0;
    note: string;
  };
  source: {
    suiteHash: string;
    files: ResearchPreparationSourceV2[];
    repositoryCommit: string | null;
    repositoryDirty: boolean | null;
    bun: string | null;
    node: string;
  };
  design: {
    scenarioCount: 24;
    conditionCellCount: 144;
    qualificationExecutionCount: 1440;
    pilotCallsPerModel: 720;
    pilotCallCount: 2160;
    mechanicsSeedsPerFamily: 5;
  };
  cells: Array<{
    cellId: string;
    scenarioId: string;
    family: string;
    modality: "informing" | "instrumental";
    rowKind: string;
    condition: { asymmetry: 0 | 0.3 | 0.7; incentive: "cooperative" | "mixed" };
    packetId: string;
    promptHash: string;
    candidateId: string;
    mechanicsSeeds: [number, number, number, number, number];
  }>;
}

export interface BuildResearchPreparationV2Options {
  generatedAt: string;
  sourceFiles: ResearchPreparationSourceV2[];
  repositoryCommit?: string | null;
  repositoryDirty?: boolean | null;
  bun?: string | null;
  node?: string;
}

export interface ResearchPreparationV2Paths {
  directory: string;
  plan: string;
  packets: string;
  readme: string;
  checksums: string;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedSources(sources: readonly ResearchPreparationSourceV2[]): ResearchPreparationSourceV2[] {
  if (sources.length === 0) throw new Error("Research preparation requires source provenance");
  const paths = new Set<string>();
  return sources.map((source) => {
    if (!source.path || source.path.startsWith("/") || source.path.includes("\\")) {
      throw new Error(`Research source path must be portable and relative: ${source.path}`);
    }
    if (paths.has(source.path)) throw new Error(`Duplicate research source: ${source.path}`);
    paths.add(source.path);
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error(`Invalid source SHA-256: ${source.path}`);
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 0) throw new Error(`Invalid source size: ${source.path}`);
    return structuredClone(source);
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function researchPreparationSourceV2(path: string, contents: string | Uint8Array): ResearchPreparationSourceV2 {
  return {
    path,
    sha256: digest(contents),
    bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength,
  };
}

/** Expands packets and hashes only; it never executes a branch or calls a provider. */
export function buildResearchPreparationV2(
  loaded: LoadedResearchBenchmarkV2,
  options: BuildResearchPreparationV2Options,
): ResearchPreparationV2 {
  const generatedAt = new Date(options.generatedAt);
  if (!Number.isFinite(generatedAt.valueOf())) throw new Error("Preparation generatedAt must be an ISO timestamp");
  const cells = expandResearchBenchmarkCells(loaded).map((cell) => {
    const packet = buildResearchDecisionPacket(loaded, cell);
    const prompt = renderResearchPrompt(packet);
    return {
      cellId: cell.cellId,
      scenarioId: cell.scenario.id,
      family: cell.scenario.family,
      modality: cell.scenario.modality,
      rowKind: cell.scenario.rowKind,
      condition: structuredClone(cell.condition),
      packetId: packet.packetId,
      promptHash: digest(prompt),
      candidateId: cell.scenario.candidate.candidateId,
      mechanicsSeeds: structuredClone(loaded.manifest.seedPanels[cell.scenario.family]!),
    };
  });
  const sources = sortedSources(options.sourceFiles);
  const planCore = {
    schemaVersion: 2,
    suiteHash: loaded.suiteHash,
    files: sources,
    design: {
      scenarioCount: 24,
      conditionCellCount: 144,
      qualificationExecutionCount: 1440,
      pilotCallsPerModel: 720,
      pilotCallCount: 2160,
      mechanicsSeedsPerFamily: 5,
    } as const,
    cells,
  };
  const planHash = digest(canonicalResearchJson(planCore));
  return {
    schemaVersion: 2,
    artifactKind: "seed.research.preparation",
    planId: `seed-research-v2-${planHash.slice(0, 16)}`,
    planHash,
    generatedAt: generatedAt.toISOString(),
    execution: {
      status: "not-run",
      modelCalls: 0,
      mechanicalExecutions: 0,
      note: "Preparation only. No provider call, oracle execution, or result is represented here.",
    },
    source: {
      suiteHash: loaded.suiteHash,
      files: sources,
      repositoryCommit: options.repositoryCommit ?? null,
      repositoryDirty: options.repositoryDirty ?? null,
      bun: options.bun ?? process.versions.bun ?? null,
      node: options.node ?? process.version,
    },
    design: planCore.design,
    cells,
  };
}

export function researchPreparationPacketsJsonl(
  loaded: LoadedResearchBenchmarkV2,
): string {
  return `${expandResearchBenchmarkCells(loaded).map((cell) => canonicalResearchJson({
    cellId: cell.cellId,
    packet: buildResearchDecisionPacket(loaded, cell),
  })).join("\n")}\n`;
}

function preparationReadme(artifact: ResearchPreparationV2): string {
  return `# Seed Research Benchmark v2 preparation\n\n` +
    `Status: **NOT RUN**. Model calls: **0**. Mechanical executions: **0**.\n\n` +
    `Plan: \`${artifact.planId}\`\n\n` +
    `The package freezes ${artifact.design.scenarioCount} scenarios and ` +
    `${artifact.design.conditionCellCount} exact public decision packets. Qualification and live results are separate artifacts.\n`;
}

async function assertEmpty(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) throw new Error(`Refusing to overwrite non-empty preparation directory: ${directory}`);
}

export async function writeResearchPreparationV2(
  directoryValue: string,
  loaded: LoadedResearchBenchmarkV2,
  artifact: ResearchPreparationV2,
): Promise<ResearchPreparationV2Paths> {
  const directory = resolve(directoryValue);
  await assertEmpty(directory);
  const plan = join(directory, "experiment-plan.json");
  const packets = join(directory, "decision-packets.jsonl");
  const readme = join(directory, "README.md");
  const checksums = join(directory, "SHA256SUMS");
  const values = new Map<string, string>([
    ["experiment-plan.json", `${canonicalResearchJson(artifact)}\n`],
    ["decision-packets.jsonl", researchPreparationPacketsJsonl(loaded)],
    ["README.md", preparationReadme(artifact)],
  ]);
  for (const [name, value] of values) await writeFile(join(directory, name), value, { encoding: "utf8", flag: "wx" });
  const checksumText = `${[...values].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${digest(value)}  ${name}`).join("\n")}\n`;
  await writeFile(checksums, checksumText, { encoding: "utf8", flag: "wx" });
  // Re-read to catch any surprising filesystem transformation before returning the package.
  for (const [name, value] of values) {
    if (digest(await readFile(join(directory, name))) !== digest(value)) throw new Error(`Preparation checksum mismatch: ${name}`);
  }
  return { directory, plan, packets, readme, checksums };
}
