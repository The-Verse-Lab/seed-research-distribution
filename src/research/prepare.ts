#!/usr/bin/env bun
/** Freeze exact Benchmark v2 packets and provenance without executing mechanics or models. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadResearchBenchmarkV2FromDir } from "./benchmark.ts";
import {
  buildResearchPreparationV2,
  researchPreparationSourceV2,
  writeResearchPreparationV2,
} from "./preparation.ts";
import {
  DEFAULT_RESEARCH_WORLD_DIR,
  defaultArtifactDirectory,
  generatedRunId,
  portablePath,
  repositoryProvenance,
  valueAfter,
} from "./cli-support.ts";

export interface ResearchPreparationCliArgs {
  worldDir: string;
  outputDir?: string;
  runId?: string;
  help: boolean;
}

const USAGE = `Usage: bun run research:prepare -- [options]

Freeze the 144 exact public packets in a checksummed, explicitly NOT RUN package.
This command makes zero provider calls and executes zero mechanical branches.

Options:
  --world <directory>  default worlds/wakeward-isles
  --out <directory>    default research-artifacts/prep-<timestamp>
  --run-id <id>        optional portable output identifier
  --help
`;

export function parseResearchPreparationArgs(argv: readonly string[]): ResearchPreparationCliArgs {
  const parsed: ResearchPreparationCliArgs = { worldDir: DEFAULT_RESEARCH_WORLD_DIR, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--world") {
      parsed.worldDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--world=")) parsed.worldDir = arg.slice(8);
    else if (arg === "--out") {
      parsed.outputDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--out=")) parsed.outputDir = arg.slice(6);
    else if (arg === "--run-id") {
      parsed.runId = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--run-id=")) parsed.runId = arg.slice(9);
    else throw new Error(`Unknown research:prepare argument: ${arg}`);
  }
  if (!parsed.worldDir || parsed.outputDir === "" || parsed.runId === "") throw new Error("CLI paths and IDs must be non-empty");
  return parsed;
}

export async function runResearchPreparationCli(
  argv: readonly string[],
  generatedAt = new Date().toISOString(),
): Promise<void> {
  const args = parseResearchPreparationArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const worldDir = resolve(args.worldDir);
  const runId = args.runId ?? generatedRunId("prep", generatedAt);
  const outputDir = resolve(args.outputDir ?? defaultArtifactDirectory(runId));
  const loaded = await loadResearchBenchmarkV2FromDir(worldDir);
  const sourceFiles = await Promise.all(["world.json", "research.json"].map(async (name) => {
    const path = resolve(worldDir, name);
    return researchPreparationSourceV2(portablePath(path), await readFile(path));
  }));
  const repository = repositoryProvenance();
  const artifact = buildResearchPreparationV2(loaded, {
    generatedAt,
    sourceFiles,
    repositoryCommit: repository.commit,
    repositoryDirty: repository.dirty,
    bun: process.versions.bun ?? null,
    node: process.version,
  });
  const paths = await writeResearchPreparationV2(outputDir, loaded, artifact);
  console.log(`Prepared ${artifact.planId}`);
  console.log("Status: NOT RUN (0 provider calls; 0 mechanical executions)");
  console.log(`Packets: ${artifact.design.conditionCellCount}; artifacts: ${paths.directory}`);
}

if (import.meta.main) await runResearchPreparationCli(process.argv.slice(2));
