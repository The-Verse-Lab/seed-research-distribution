#!/usr/bin/env bun
/** Verify a separate immutable smoke package before running and freezing the full pilot. */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  expandResearchBenchmarkCells,
  loadResearchBenchmarkV2FromDir,
  type LoadedResearchBenchmarkV2,
} from "./benchmark.ts";
import {
  DEFAULT_RESEARCH_MODEL_MANIFEST,
  DEFAULT_RESEARCH_WORLD_DIR,
  createLiveProviders,
  defaultArtifactDirectory,
  generatedRunId,
  loadLocalModelManifest,
  parsePositiveInteger,
  parseUint32,
  portablePath,
  readJson,
  repositoryProvenance,
  valueAfter,
} from "./cli-support.ts";
import {
  OracleQualificationV2Schema,
  type OracleQualificationV2,
} from "./contracts.ts";
import { ResearchArtifactStoreV1 } from "./live/artifact-store.ts";
import {
  finalizeResearchLivePackage,
  type FinalizedResearchLivePackage,
} from "./live/finalize.ts";
import { evaluateProviderSmoke } from "./live/gates.ts";
import {
  buildResearchRunManifestV1,
  ResearchRunManifestV1Schema,
  type ResearchModelManifestV1,
  type ResearchRunManifestV1,
} from "./live/manifest.ts";
import { readStoredLiveTrials, type StoredLiveTrialV1 } from "./live/records.ts";
import {
  researchQualificationHash,
  runResearchLivePhase,
  type ResearchLivePhaseResultV1,
  type VerifiedResearchSmokeAuthorizationV1,
} from "./live/run.ts";
import {
  LIVE_RESEARCH_PROVIDER_IDS,
  createResearchSmokeTrials,
  type LiveResearchProviderId,
} from "./live/scheduler.ts";
import {
  assertMutablePackageDirectory,
  configuredResearchModels,
} from "./smoke.ts";

export interface ResearchLiveCliArgs {
  smokePackageDir?: string;
  worldDir: string;
  modelManifestPath: string;
  outputDir?: string;
  runId?: string;
  schedulerSeed?: number;
  bootstrapSeed?: number;
  timeoutMs?: number;
  help: boolean;
}

export interface VerifiedResearchSmokePackageV1 {
  directory: string;
  manifest: ResearchRunManifestV1;
  qualification: OracleQualificationV2;
  trials: StoredLiveTrialV1[];
  authorization: VerifiedResearchSmokeAuthorizationV1;
}

export interface ResearchLiveCliResult {
  directory: string;
  verifiedSmoke: VerifiedResearchSmokePackageV1;
  run: ResearchLivePhaseResultV1;
  finalized: FinalizedResearchLivePackage;
}

export const RESEARCH_LIVE_USAGE = `Usage: bun run research:live -- --smoke <finalized-package> [options]

Verify SHA256SUMS and the nine-call provider smoke gate, then run the full
144-cell x 5-replicate x 3-provider pilot in a separate immutable package.

Required:
  --smoke <directory>       finalized, checksummed smoke package

Options:
  --world <directory>       default worlds/wakeward-isles
  --models <file>           default research-models.local.json (ignored; env names only)
  --out <directory>         default research-artifacts/pilot-<timestamp>
  --run-id <id>             portable result identifier
  --scheduler-seed <uint32> default copied from verified smoke manifest
  --bootstrap-seed <uint32> default copied from verified smoke manifest
  --timeout-ms <integer>    default copied from verified smoke manifest
  --help
`;

function validateParsedArgs(args: ResearchLiveCliArgs): void {
  if (!args.worldDir || !args.modelManifestPath || args.smokePackageDir === "" ||
    args.outputDir === "" || args.runId === "") {
    throw new Error("CLI paths and IDs must be non-empty");
  }
  if (args.runId && !/^[a-z0-9][a-z0-9._-]*$/i.test(args.runId)) {
    throw new Error("--run-id must be a portable identifier containing only letters, digits, dot, underscore, or dash");
  }
}

export function parseResearchLiveArgs(argv: readonly string[]): ResearchLiveCliArgs {
  const parsed: ResearchLiveCliArgs = {
    worldDir: DEFAULT_RESEARCH_WORLD_DIR,
    modelManifestPath: DEFAULT_RESEARCH_MODEL_MANIFEST,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--smoke") {
      parsed.smokePackageDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--smoke=")) parsed.smokePackageDir = arg.slice(8);
    else if (arg === "--world") {
      parsed.worldDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--world=")) parsed.worldDir = arg.slice(8);
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
    } else throw new Error(`Unknown research:live argument: ${arg}`);
  }
  validateParsedArgs(parsed);
  if (!parsed.help && !parsed.smokePackageDir) throw new Error("--smoke is required");
  return parsed;
}

function runtimeProvenance(): { bun: string | null; node: string } {
  return { bun: process.versions.bun ?? null, node: process.version };
}

function assertExactSmokeSchedule(
  loaded: LoadedResearchBenchmarkV2,
  manifest: ResearchRunManifestV1,
  trials: readonly StoredLiveTrialV1[],
): void {
  const expected = createResearchSmokeTrials(expandResearchBenchmarkCells(loaded));
  const observed = [...trials].sort((left, right) => left.scheduleIndex - right.scheduleIndex);
  if (observed.length !== expected.length) {
    throw new Error(`Provider smoke requires ${expected.length} scheduled trials; observed ${observed.length}`);
  }
  for (let index = 0; index < expected.length; index++) {
    const planned = expected[index]!;
    const stored = observed[index]!;
    const configuredModel = manifest.providers
      .find((provider) => provider.provider === planned.providerId)?.configuredModel;
    if (stored.trialId !== planned.trialId || stored.phase !== "smoke" ||
      stored.scheduleIndex !== planned.scheduleIndex || stored.cellId !== planned.cellId ||
      stored.scenarioId !== planned.scenarioId || stored.replicate !== planned.replicate ||
      stored.modelAttempt.provider !== planned.providerId ||
      stored.modelAttempt.configuredModel !== configuredModel) {
      throw new Error(`Stored provider smoke trial does not match the frozen schedule at index ${index}`);
    }
  }
}

function returnedModelFor(
  providerId: LiveResearchProviderId,
  manifest: ResearchRunManifestV1,
  trials: readonly StoredLiveTrialV1[],
): string {
  const providerTrials = trials.filter((trial) => trial.modelAttempt.provider === providerId);
  if (providerTrials.length !== 3) throw new Error(`Provider smoke requires three calls for ${providerId}`);
  const returned = new Set(providerTrials.map((trial) => trial.modelAttempt.returnedModel));
  if (returned.size !== 1 || returned.has(undefined)) {
    throw new Error(`Provider smoke returned inconsistent model identity for ${providerId}`);
  }
  const model = [...returned][0]!;
  const configured = manifest.providers.find((provider) => provider.provider === providerId);
  if (!configured || configured.configuredModel !== model) {
    throw new Error(`Provider smoke manifest identity does not match returned model for ${providerId}`);
  }
  if (configured.smokeReturnedModel !== undefined) {
    throw new Error(`Provider smoke manifest must not preclaim a returned model for ${providerId}`);
  }
  return model;
}

/** Verify immutable bytes and derive the only authorization accepted by the full runner. */
export async function verifyResearchSmokePackage(
  directoryValue: string,
  loaded: LoadedResearchBenchmarkV2,
): Promise<VerifiedResearchSmokePackageV1> {
  const directory = resolve(directoryValue);
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`Provider smoke package is not a directory: ${portablePath(directory)}`);
  const store = await ResearchArtifactStoreV1.open(directory);
  await store.verifyFinalized();
  const [manifest, qualification, trials] = await Promise.all([
    readJson(join(directory, "manifest.json")).then((value) => ResearchRunManifestV1Schema.parse(value)),
    readJson(join(directory, "oracle-qualification.json")).then((value) => OracleQualificationV2Schema.parse(value)),
    readStoredLiveTrials(join(directory, "live-trials.jsonl")),
  ]);
  if (!qualification.qualified || qualification.failures.length > 0) {
    throw new Error("Provider smoke package does not contain a green oracle qualification");
  }
  const qualificationHash = researchQualificationHash(qualification);
  if (manifest.source.suiteHash !== loaded.suiteHash || qualification.suiteHash !== loaded.suiteHash ||
    manifest.source.qualificationHash !== qualificationHash) {
    throw new Error("Provider smoke package provenance does not match the loaded research benchmark");
  }
  assertExactSmokeSchedule(loaded, manifest, trials);
  const gate = evaluateProviderSmoke(trials);
  if (!gate.passed) throw new Error(`Provider smoke gate failed: ${gate.failures.join("; ")}`);
  const returnedModels = {
    google: returnedModelFor("google", manifest, trials),
    anthropic: returnedModelFor("anthropic", manifest, trials),
    openai: returnedModelFor("openai", manifest, trials),
  };
  const authorization: VerifiedResearchSmokeAuthorizationV1 = {
    schemaVersion: 1,
    artifactKind: "seed.research.verified-smoke-authorization",
    gatePassed: true,
    suiteHash: loaded.suiteHash,
    qualificationHash,
    returnedModels,
  };
  return { directory, manifest, qualification, trials, authorization };
}

function pathsOverlap(left: string, right: string): boolean {
  const relativePath = relative(left, right);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function assertSeparatePackages(smokeDirectory: string, pilotDirectory: string): void {
  if (pathsOverlap(smokeDirectory, pilotDirectory) || pathsOverlap(pilotDirectory, smokeDirectory)) {
    throw new Error("Smoke and pilot result packages must use separate, non-nested directories");
  }
}

async function readExistingManifest(directory: string): Promise<ResearchRunManifestV1 | undefined> {
  try {
    return ResearchRunManifestV1Schema.parse(await readJson(join(directory, "manifest.json")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPilotManifestResumeOptions(options: {
  manifest: ResearchRunManifestV1;
  args: ResearchLiveCliArgs;
  verifiedSmoke: VerifiedResearchSmokePackageV1;
  localManifest: ResearchModelManifestV1;
}): void {
  const { manifest, args, verifiedSmoke, localManifest } = options;
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
  if (manifest.source.suiteHash !== verifiedSmoke.authorization.suiteHash ||
    manifest.source.qualificationHash !== verifiedSmoke.authorization.qualificationHash) {
    throw new Error("Existing pilot package provenance does not match the verified smoke package");
  }
  const models = configuredResearchModels(localManifest);
  for (const provider of manifest.providers) {
    if (provider.configuredModel !== models[provider.provider] ||
      provider.smokeReturnedModel !== verifiedSmoke.authorization.returnedModels[provider.provider]) {
      throw new Error(`Existing pilot model identity does not match verified smoke: ${provider.provider}`);
    }
  }
}

async function loadOrBuildPilotManifest(options: {
  directory: string;
  args: ResearchLiveCliArgs;
  generatedAt: string;
  generatedRunId: string;
  verifiedSmoke: VerifiedResearchSmokePackageV1;
  localManifest: ResearchModelManifestV1;
}): Promise<ResearchRunManifestV1> {
  const existing = await readExistingManifest(options.directory);
  if (existing) {
    assertPilotManifestResumeOptions({
      manifest: existing,
      args: options.args,
      verifiedSmoke: options.verifiedSmoke,
      localManifest: options.localManifest,
    });
    return existing;
  }
  return buildResearchRunManifestV1({
    localManifest: options.localManifest,
    runId: options.args.runId ?? options.generatedRunId,
    generatedAt: options.generatedAt,
    schedulerSeed: options.args.schedulerSeed ?? options.verifiedSmoke.manifest.design.schedulerSeed,
    bootstrapSeed: options.args.bootstrapSeed ?? options.verifiedSmoke.manifest.design.bootstrapSeed,
    timeoutMs: options.args.timeoutMs ?? options.verifiedSmoke.manifest.design.timeoutMs,
    suiteHash: options.verifiedSmoke.authorization.suiteHash,
    qualificationHash: options.verifiedSmoke.authorization.qualificationHash,
    git: repositoryProvenance(),
    runtime: runtimeProvenance(),
    smokeReturnedModels: options.verifiedSmoke.authorization.returnedModels,
  });
}

export async function runResearchLiveCli(
  argv: readonly string[],
  generatedAt = new Date().toISOString(),
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ResearchLiveCliResult | undefined> {
  const args = parseResearchLiveArgs(argv);
  if (args.help) {
    process.stdout.write(RESEARCH_LIVE_USAGE);
    return undefined;
  }
  const loaded = await loadResearchBenchmarkV2FromDir(resolve(args.worldDir));
  // This checks every checksum and the smoke gate before credentials are read or a pilot adapter exists.
  const verifiedSmoke = await verifyResearchSmokePackage(args.smokePackageDir!, loaded);
  const localManifest = await loadLocalModelManifest(args.modelManifestPath);
  const localModels = configuredResearchModels(localManifest);
  for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) {
    if (localModels[providerId] !== verifiedSmoke.authorization.returnedModels[providerId]) {
      throw new Error(`Local model configuration does not match verified smoke: ${providerId}`);
    }
  }

  const generatedId = generatedRunId("pilot", generatedAt);
  const directory = resolve(args.outputDir ?? defaultArtifactDirectory(args.runId ?? generatedId));
  assertSeparatePackages(verifiedSmoke.directory, directory);
  await assertMutablePackageDirectory(directory);
  const manifest = await loadOrBuildPilotManifest({
    directory,
    args,
    generatedAt,
    generatedRunId: generatedId,
    verifiedSmoke,
    localManifest,
  });
  const providers = createLiveProviders(localManifest, fetchImpl);
  const store = await ResearchArtifactStoreV1.open(directory);
  if ((await readStoredLiveTrials(join(directory, "live-trials.jsonl")))
    .some((trial) => trial.phase !== "pilot")) {
    throw new Error("A pilot package cannot contain provider smoke trials");
  }
  const run = await runResearchLivePhase({
    mode: "full",
    loaded,
    qualification: verifiedSmoke.qualification,
    manifest,
    providers,
    store,
    smokeAuthorization: verifiedSmoke.authorization,
  });
  const finalized = await finalizeResearchLivePackage({
    store,
    manifest,
    qualification: verifiedSmoke.qualification,
    phase: "pilot",
  });
  console.log(`Pilot gate: ${finalized.gate.passed ? "PASSED" : "FAILED"}`);
  console.log(`Calls: ${run.completedTrialCount}/${run.scheduledTrialCount}; spend: $${finalized.budget.committedUsd}`);
  console.log(`Checksums: ${finalized.package.checksumsPath}`);
  if (!finalized.gate.passed) process.exitCode = 1;
  return { directory, verifiedSmoke, run, finalized };
}

if (import.meta.main) await runResearchLiveCli(process.argv.slice(2));
