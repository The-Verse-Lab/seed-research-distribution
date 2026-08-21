#!/usr/bin/env bun
/** Execute and checksum the 1,440-branch, zero-model-call Benchmark v2 oracle qualification. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadResearchBenchmarkV2FromDir } from "./benchmark.ts";
import type { OracleQualificationV2 } from "./contracts.ts";
import {
  DEFAULT_RESEARCH_WORLD_DIR,
  defaultArtifactDirectory,
  generatedRunId,
  valueAfter,
} from "./cli-support.ts";
import { qualifyResearchBenchmarkV2 } from "./qualification.ts";
import { canonicalResearchJson } from "./world/state.ts";

export interface ResearchQualificationCliArgs {
  worldDir: string;
  outputDir?: string;
  runId?: string;
  help: boolean;
}

export interface ResearchQualificationPackage {
  directory: string;
  qualificationPath: string;
  checksumsPath: string;
  qualification: OracleQualificationV2;
}

const USAGE = `Usage: bun run research:qualify -- [options]

Execute exactly 24 scenarios x 6 conditions x 2 branches x 5 seeds locally.
No hosted model is contacted. research:run is an alias for this command.

Options:
  --world <directory>  default worlds/wakeward-isles
  --out <directory>    default research-artifacts/qualification-<timestamp>
  --run-id <id>        optional portable output identifier
  --help
`;

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseResearchQualificationArgs(argv: readonly string[]): ResearchQualificationCliArgs {
  const parsed: ResearchQualificationCliArgs = { worldDir: DEFAULT_RESEARCH_WORLD_DIR, help: false };
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
    else throw new Error(`Unknown research:qualify argument: ${arg}`);
  }
  if (!parsed.worldDir || parsed.outputDir === "" || parsed.runId === "") throw new Error("CLI paths and IDs must be non-empty");
  return parsed;
}

export async function writeResearchQualificationPackage(
  directoryValue: string,
  qualification: OracleQualificationV2,
): Promise<ResearchQualificationPackage> {
  const directory = resolve(directoryValue);
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) {
    throw new Error(`Refusing to overwrite non-empty qualification directory: ${directory}`);
  }
  const qualificationText = `${canonicalResearchJson(qualification)}\n`;
  const readmeText = `# Seed Research Benchmark v2 qualification\n\n` +
    `Provider calls: **0**. Deterministic branch executions: **${qualification.executionCount}**.\n\n` +
    `Qualification gate: **${qualification.qualified ? "PASSED" : "FAILED"}**.\n`;
  const files = new Map<string, string>([
    ["README.md", readmeText],
    ["oracle-qualification.json", qualificationText],
  ]);
  for (const [name, contents] of files) {
    await writeFile(join(directory, name), contents, { encoding: "utf8", flag: "wx" });
  }
  const checksumText = `${[...files].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contents]) => `${digest(contents)}  ${name}`).join("\n")}\n`;
  const checksumsPath = join(directory, "SHA256SUMS");
  await writeFile(checksumsPath, checksumText, { encoding: "utf8", flag: "wx" });
  for (const [name, contents] of files) {
    if (digest(await readFile(join(directory, name))) !== digest(contents)) {
      throw new Error(`Qualification checksum mismatch: ${name}`);
    }
  }
  return {
    directory,
    qualificationPath: join(directory, "oracle-qualification.json"),
    checksumsPath,
    qualification,
  };
}

export async function runResearchQualificationCli(
  argv: readonly string[],
  generatedAt = new Date().toISOString(),
): Promise<ResearchQualificationPackage | undefined> {
  const args = parseResearchQualificationArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return undefined;
  }
  const runId = args.runId ?? generatedRunId("qualification", generatedAt);
  const loaded = await loadResearchBenchmarkV2FromDir(resolve(args.worldDir));
  const qualification = qualifyResearchBenchmarkV2(loaded, generatedAt);
  const output = await writeResearchQualificationPackage(
    resolve(args.outputDir ?? defaultArtifactDirectory(runId)),
    qualification,
  );
  console.log(`Qualification: ${qualification.qualified ? "PASSED" : "FAILED"}`);
  console.log(`Executions: ${qualification.executionCount}; provider calls: 0`);
  console.log(`Artifact: ${output.qualificationPath}`);
  if (!qualification.qualified) {
    throw new Error(`Oracle qualification failed with ${qualification.failures.length} invariant violations`);
  }
  return output;
}

if (import.meta.main) await runResearchQualificationCli(process.argv.slice(2));
