#!/usr/bin/env bun
/** Run, gate, and freeze the nine-call direct-provider smoke package. */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadResearchBenchmarkV2FromDir,
  type LoadedResearchBenchmarkV2,
} from "./benchmark.ts";
import {
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_RESEARCH_MODEL_MANIFEST,
  DEFAULT_RESEARCH_WORLD_DIR,
  DEFAULT_SCHEDULER_SEED,
  createLiveProviders,
  defaultArtifactDirectory,
  generatedRunId,
  loadLocalModelManifest,
  parsePositiveInteger,
  parseUint32,
  portablePath,
  readJson,
  repositoryProvenance,
  requireCleanRepositoryProvenance,
  type CleanRepositoryProvenance,
  valueAfter,
} from "./cli-support.ts";
import type { OracleQualificationV2 } from "./contracts.ts";
import { OracleQualificationV2Schema } from "./contracts.ts";
import { ResearchArtifactStoreV1 } from "./live/artifact-store.ts";
import {
  finalizeResearchLivePackage,
  type FinalizedResearchLivePackage,
} from "./live/finalize.ts";
import {
  buildResearchRunManifestV1,
  ResearchRunManifestV1Schema,
  type ResearchModelManifestV1,
  type ResearchRunManifestV1,
} from "./live/manifest.ts";
import {
  researchQualificationHash,
  runResearchLivePhase,
  type ResearchLivePhaseResultV1,
} from "./live/run.ts";
import { readStoredLiveTrials } from "./live/records.ts";
import { assertCurrentOracleQualification } from "./qualification.ts";

export interface ResearchSmokeCliArgs {
  worldDir: string;
  qualificationPath?: string;
  modelManifestPath: string;
  outputDir?: string;
  runId?: string;
  schedulerSeed?: number;
  bootstrapSeed?: number;
  timeoutMs?: number;
  help: boolean;
}

export interface ResearchSmokeCliResult {
  directory: string;
  run: ResearchLivePhaseResultV1;
  finalized: FinalizedResearchLivePackage;
}

export const RESEARCH_SMOKE_USAGE = `Usage: bun run research:smoke -- --qualification <package> [options]

Run the fixed 3-cell x 3-provider smoke directly against the configured hosted models.
The result is finalized even when the provider smoke gate fails.

Required:
  --qualification <path>    checksummed green qualification package

Options:
  --world <directory>       default worlds/wakeward-isles
  --models <file>           default research-models.local.json (ignored; env names only)
  --out <directory>         default research-artifacts/smoke-<timestamp>
  --run-id <id>             portable result identifier
  --scheduler-seed <uint32> default 0x51eed123
  --bootstrap-seed <uint32> default 0x0b0057a9
  --timeout-ms <integer>    per-provider deadline; default 30000
  --help
`;

function nonEmptyCliValues(args: ResearchSmokeCliArgs): void {
  if (!args.worldDir || !args.modelManifestPath || args.qualificationPath === "" ||
    args.outputDir === "" || args.runId === "") {
    throw new Error("CLI paths and IDs must be non-empty");
  }
  if (args.runId && !/^[a-z0-9][a-z0-9._-]*$/i.test(args.runId)) {
    throw new Error("--run-id must be a portable identifier containing only letters, digits, dot, underscore, or dash");
  }
}

export function parseResearchSmokeArgs(argv: readonly string[]): ResearchSmokeCliArgs {
  const parsed: ResearchSmokeCliArgs = {
    worldDir: DEFAULT_RESEARCH_WORLD_DIR,
    modelManifestPath: DEFAULT_RESEARCH_MODEL_MANIFEST,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--world") {
      parsed.worldDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--world=")) parsed.worldDir = arg.slice(8);
    else if (arg === "--qualification") {
      parsed.qualificationPath = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--qualification=")) parsed.qualificationPath = arg.slice(16);
    else if (arg === "--models") {
      parsed.modelManifestPath = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--models=")) parsed.modelManifestPath = arg.slice(9);
    else if (arg === "--out") {
      parsed.outputDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--out=")) parsed.outputDir = arg.slice(6);
    else if (arg === "--run-id") {
      parsed.runId = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--run-id=")) parsed.runId = arg.slice(9);
    else if (arg === "--scheduler-seed") {
      parsed.schedulerSeed = parseUint32(valueAfter(argv, index, arg), arg);
      index++;
    } else if (arg.startsWith("--scheduler-seed=")) {
      parsed.schedulerSeed = parseUint32(arg.slice(17), "--scheduler-seed");
    } else if (arg === "--bootstrap-seed") {
      parsed.bootstrapSeed = parseUint32(valueAfter(argv, index, arg), arg);
      index++;
    } else if (arg.startsWith("--bootstrap-seed=")) {
      parsed.bootstrapSeed = parseUint32(arg.slice(17), "--bootstrap-seed");
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveInteger(valueAfter(argv, index, arg), arg);
      index++;
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = parsePositiveInteger(arg.slice(13), "--timeout-ms");
    } else throw new Error(`Unknown research:smoke argument: ${arg}`);
  }
  nonEmptyCliValues(parsed);
  if (!parsed.help && !parsed.qualificationPath) throw new Error("--qualification is required");
  return parsed;
}

function digest(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function verifiedQualificationPackage(directory: string): Promise<OracleQualificationV2> {
  const checksumPath = join(directory, "SHA256SUMS");
  const checksumText = await readFile(checksumPath, "utf8");
  if (!checksumText.endsWith("\n")) throw new Error("Qualification SHA256SUMS must end with a newline");
  const listed = checksumText.trimEnd().split("\n").map((line, index) => {
    const match = /^([a-f0-9]{64})  ([^/\\][^\\]*)$/.exec(line);
    if (!match?.[1] || !match[2] || match[2].split("/").includes("..")) {
      throw new Error(`Invalid qualification SHA256SUMS line ${index + 1}`);
    }
    return { sha256: match[1], path: match[2] };
  });
  if (new Set(listed.map((row) => row.path)).size !== listed.length) {
    throw new Error("Qualification SHA256SUMS contains duplicate paths");
  }
  const actual = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name !== "SHA256SUMS")
    .map((entry) => {
      if (!entry.isFile()) throw new Error(`Unexpected qualification package entry: ${entry.name}`);
      return entry.name;
    })
    .sort(compareCodePoints);
  const expected = listed.map((row) => row.path).sort(compareCodePoints);
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error("Qualification SHA256SUMS does not exactly cover the package");
  }
  for (const row of listed) {
    if (digest(await readFile(join(directory, row.path))) !== row.sha256) {
      throw new Error(`Qualification checksum mismatch: ${row.path}`);
    }
  }
  if (!expected.includes("oracle-qualification.json")) {
    throw new Error("Qualification package is missing oracle-qualification.json");
  }
  return OracleQualificationV2Schema.parse(await readJson(join(directory, "oracle-qualification.json")));
}

/** Verify exact checksum coverage before loading a qualification package. */
export async function loadVerifiedOracleQualification(pathValue: string): Promise<OracleQualificationV2> {
  const path = resolve(pathValue);
  const info = await stat(path);
  if (info.isDirectory()) return await verifiedQualificationPackage(path);
  throw new Error(`Oracle qualification must be a checksummed package directory: ${portablePath(path)}`);
}

function assertGreenQualification(
  qualification: OracleQualificationV2,
  loaded: LoadedResearchBenchmarkV2,
): void {
  assertCurrentOracleQualification(loaded, qualification);
  if (!qualification.qualified || qualification.failures.length > 0) {
    throw new Error("Provider smoke requires a green oracle qualification");
  }
  if (qualification.suiteHash !== loaded.suiteHash) {
    throw new Error("Oracle qualification does not match the loaded research benchmark");
  }
}

export function configuredResearchModels(
  localManifest: ResearchModelManifestV1,
): Readonly<Record<"google" | "anthropic" | "openai", string>> {
  return {
    google: localManifest.providers[0].model,
    anthropic: localManifest.providers[1].model,
    openai: localManifest.providers[2].model,
  };
}

function runtimeProvenance(): { bun: string | null; node: string } {
  return { bun: process.versions.bun ?? null, node: process.version };
}

async function readExistingManifest(directory: string): Promise<ResearchRunManifestV1 | undefined> {
  try {
    return ResearchRunManifestV1Schema.parse(await readJson(join(directory, "manifest.json")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertManifestResumeOptions(options: {
  manifest: ResearchRunManifestV1;
  args: ResearchSmokeCliArgs;
  loaded: LoadedResearchBenchmarkV2;
  qualification: OracleQualificationV2;
  localManifest: ResearchModelManifestV1;
  git: CleanRepositoryProvenance;
}): void {
  const { manifest, args, loaded, qualification, localManifest, git } = options;
  if (args.runId && manifest.runId !== args.runId) throw new Error("--run-id does not match the existing package");
  if (args.schedulerSeed !== undefined && manifest.design.schedulerSeed !== args.schedulerSeed) {
    throw new Error("--scheduler-seed does not match the existing package");
  }
  if (args.bootstrapSeed !== undefined && manifest.design.bootstrapSeed !== args.bootstrapSeed) {
    throw new Error("--bootstrap-seed does not match the existing package");
  }
  if (args.timeoutMs !== undefined && manifest.design.timeoutMs !== args.timeoutMs) {
    throw new Error("--timeout-ms does not match the existing package");
  }
  if (manifest.source.suiteHash !== loaded.suiteHash ||
    manifest.source.qualificationHash !== researchQualificationHash(qualification)) {
    throw new Error("Existing package manifest does not match the requested benchmark qualification");
  }
  if (manifest.source.git.commit !== git.commit || manifest.budget.priorCommittedUsd !== "0") {
    throw new Error("Existing smoke package does not match the clean executable commit or zero-spend baseline");
  }
  const models = configuredResearchModels(localManifest);
  for (const provider of manifest.providers) {
    if (provider.configuredModel !== models[provider.provider] ||
      provider.smokeReturnedModel !== undefined) {
      throw new Error(`Existing package model identity does not match local configuration: ${provider.provider}`);
    }
  }
}

async function loadOrBuildSmokeManifest(options: {
  directory: string;
  args: ResearchSmokeCliArgs;
  generatedAt: string;
  generatedRunId: string;
  loaded: LoadedResearchBenchmarkV2;
  qualification: OracleQualificationV2;
  localManifest: ResearchModelManifestV1;
  git: CleanRepositoryProvenance;
}): Promise<ResearchRunManifestV1> {
  const existing = await readExistingManifest(options.directory);
  if (existing) {
    assertManifestResumeOptions({
      manifest: existing,
      args: options.args,
      loaded: options.loaded,
      qualification: options.qualification,
      localManifest: options.localManifest,
      git: options.git,
    });
    return existing;
  }
  return buildResearchRunManifestV1({
    localManifest: options.localManifest,
    runId: options.args.runId ?? options.generatedRunId,
    generatedAt: options.generatedAt,
    schedulerSeed: options.args.schedulerSeed ?? DEFAULT_SCHEDULER_SEED,
    bootstrapSeed: options.args.bootstrapSeed ?? DEFAULT_BOOTSTRAP_SEED,
    timeoutMs: options.args.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    suiteHash: options.loaded.suiteHash,
    qualificationHash: researchQualificationHash(options.qualification),
    git: options.git,
    runtime: runtimeProvenance(),
  });
}

export async function assertMutablePackageDirectory(directory: string): Promise<void> {
  const info = await stat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory()) throw new Error(`Research package output is not a directory: ${portablePath(directory)}`);
  if ((await readdir(directory)).includes("SHA256SUMS")) {
    const store = await ResearchArtifactStoreV1.open(directory);
    await store.verifyFinalized();
    throw new Error(`Research result package is already finalized: ${portablePath(directory)}`);
  }
}

export async function runResearchSmokeCli(
  argv: readonly string[],
  generatedAt = new Date().toISOString(),
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  provenance: ReturnType<typeof repositoryProvenance> = repositoryProvenance(),
): Promise<ResearchSmokeCliResult | undefined> {
  const args = parseResearchSmokeArgs(argv);
  if (args.help) {
    process.stdout.write(RESEARCH_SMOKE_USAGE);
    return undefined;
  }
  const git = requireCleanRepositoryProvenance(provenance);
  const generatedId = generatedRunId("smoke", generatedAt);
  const directory = resolve(args.outputDir ?? defaultArtifactDirectory(args.runId ?? generatedId));
  await assertMutablePackageDirectory(directory);
  const [loaded, qualification, localManifest] = await Promise.all([
    loadResearchBenchmarkV2FromDir(resolve(args.worldDir)),
    loadVerifiedOracleQualification(args.qualificationPath!),
    loadLocalModelManifest(args.modelManifestPath),
  ]);
  assertGreenQualification(qualification, loaded);
  const manifest = await loadOrBuildSmokeManifest({
    directory,
    args,
    generatedAt,
    generatedRunId: generatedId,
    loaded,
    qualification,
    localManifest,
    git,
  });
  // Provider construction validates env presence. Secret values stay only inside the adapters.
  const providers = createLiveProviders(localManifest, fetchImpl);
  const store = await ResearchArtifactStoreV1.open(directory);
  if ((await readStoredLiveTrials(join(directory, "live-trials.jsonl")))
    .some((trial) => trial.phase !== "smoke")) {
    throw new Error("A provider smoke package cannot contain pilot trials");
  }
  const run = await runResearchLivePhase({
    mode: "smoke",
    loaded,
    qualification,
    manifest,
    providers,
    store,
  });
  const finalized = await finalizeResearchLivePackage({
    store,
    loaded,
    manifest,
    qualification,
    phase: "smoke",
  });
  console.log(`Provider smoke gate: ${finalized.gate.passed ? "PASSED" : "FAILED"}`);
  console.log(`Calls: ${run.completedTrialCount}/${run.scheduledTrialCount}; spend: $${finalized.budget.committedUsd}`);
  console.log(`Checksums: ${finalized.package.checksumsPath}`);
  if (!finalized.gate.passed) process.exitCode = 1;
  return { directory, run, finalized };
}

if (import.meta.main) await runResearchSmokeCli(process.argv.slice(2));
