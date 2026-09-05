#!/usr/bin/env bun
/** Analyze stored first attempts, evaluate the phase gate, and freeze the checksummed package. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadResearchBenchmarkV2FromDir } from "./benchmark.ts";
import { OracleQualificationV2Schema } from "./contracts.ts";
import { DEFAULT_RESEARCH_WORLD_DIR, valueAfter } from "./cli-support.ts";
import { ResearchArtifactStoreV1 } from "./live/artifact-store.ts";
import { finalizeResearchLivePackage } from "./live/finalize.ts";
import { ResearchRunManifestV1Schema } from "./live/manifest.ts";
import { readStoredLiveTrials } from "./live/records.ts";
import type { ResearchTrialPhase } from "./live/scheduler.ts";

export interface ResearchAnalyzeCliArgs {
  packageDir?: string;
  phase?: ResearchTrialPhase;
  worldDir: string;
  help: boolean;
}

const USAGE = `Usage: bun run research:analyze -- --package <directory> [--phase smoke|pilot] [--world <directory>]

Analyze only stored public-safe first attempts. This command makes no provider calls.
It writes analysis.json and REPORT.md, then creates and verifies SHA256SUMS.
`;

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

export function parseResearchAnalyzeArgs(argv: readonly string[]): ResearchAnalyzeCliArgs {
  const parsed: ResearchAnalyzeCliArgs = { worldDir: DEFAULT_RESEARCH_WORLD_DIR, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--package") {
      parsed.packageDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--package=")) parsed.packageDir = arg.slice(10);
    else if (arg === "--world") {
      parsed.worldDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--world=")) parsed.worldDir = arg.slice(8);
    else if (arg === "--phase") {
      const phase = valueAfter(argv, index, arg);
      if (phase !== "smoke" && phase !== "pilot") throw new Error("--phase must be smoke or pilot");
      parsed.phase = phase;
      index++;
    } else if (arg.startsWith("--phase=")) {
      const phase = arg.slice(8);
      if (phase !== "smoke" && phase !== "pilot") throw new Error("--phase must be smoke or pilot");
      parsed.phase = phase;
    } else throw new Error(`Unknown research:analyze argument: ${arg}`);
  }
  if (!parsed.worldDir || (!parsed.help && !parsed.packageDir)) {
    throw new Error("--package is required and paths must be non-empty");
  }
  return parsed;
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function runResearchAnalyzeCli(argv: readonly string[]): Promise<void> {
  const args = parseResearchAnalyzeArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const directory = resolve(args.packageDir!);
  const loaded = await loadResearchBenchmarkV2FromDir(resolve(args.worldDir));
  const store = await ResearchArtifactStoreV1.open(directory);
  try {
    const entries = await store.verifyFinalized();
    console.log(`Already finalized and verified: ${entries.length} checksummed files in ${directory}`);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !/not finalized/.test(error.message)) throw error;
  }

  const [manifest, qualification, trials] = await Promise.all([
    json(join(directory, "manifest.json")).then((value) => ResearchRunManifestV1Schema.parse(value)),
    json(join(directory, "oracle-qualification.json")).then((value) => OracleQualificationV2Schema.parse(value)),
    readStoredLiveTrials(join(directory, "live-trials.jsonl")),
  ]);
  const observedPhases = new Set(trials.map((trial) => trial.phase));
  if (observedPhases.size > 1) throw new Error("A result package contains mixed smoke and pilot trials");
  const phase = args.phase ?? [...observedPhases][0];
  if (!phase) throw new Error("--phase is required for a zero-trial package");
  if (args.phase && observedPhases.size === 1 && !observedPhases.has(args.phase)) {
    throw new Error("--phase does not match the stored trials");
  }
  const finalized = await finalizeResearchLivePackage({ store, loaded, manifest, qualification, phase });
  console.log(`Analysis: ${finalized.analysis.coverage.totalTrials} first attempts`);
  console.log(`${phase === "smoke" ? "Provider smoke" : "Pilot"} gate: ${finalized.gate.passed ? "PASSED" : "FAILED"}`);
  console.log(`Checksums: ${finalized.package.checksumsPath}`);
  if (!finalized.gate.passed) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await runResearchAnalyzeCli(process.argv.slice(2));
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new Error("Research package is missing a required artifact", { cause: error });
    throw error;
  }
}
