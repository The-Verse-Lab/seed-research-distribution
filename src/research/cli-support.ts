/** Shared filesystem/provenance/configuration helpers for the research-only CLIs. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { OracleQualificationV2 } from "./contracts.ts";
import { OracleQualificationV2Schema } from "./contracts.ts";
import {
  assertResearchApiKeyEnvironment,
  parseResearchModelManifestV1,
  type ResearchModelManifestV1,
} from "./live/manifest.ts";
import type { ResearchLiveProviderMap } from "./live/run.ts";
import {
  AnthropicResearchProvider,
  GoogleResearchProvider,
  OpenAIResearchProvider,
} from "./providers/index.ts";

export const DEFAULT_RESEARCH_WORLD_DIR = "worlds/wakeward-isles";
export const DEFAULT_RESEARCH_MODEL_MANIFEST = "research-models.local.json";
export const DEFAULT_SCHEDULER_SEED = 0x51ee_d123;
export const DEFAULT_BOOTSTRAP_SEED = 0x0b00_57a9;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export function parseUint32(value: string, flag: string): number {
  if (!/^(?:0x[a-f0-9]+|\d+)$/i.test(value)) throw new Error(`${flag} must be an unsigned 32-bit integer`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`${flag} must be an unsigned 32-bit integer`);
  }
  return parsed;
}

export function generatedRunId(prefix: string, generatedAt: string): string {
  return `${prefix}-${generatedAt.replace(/[:.]/g, "-")}`;
}

export function defaultArtifactDirectory(runId: string): string {
  return resolve("research-artifacts", runId);
}

export function portablePath(path: string): string {
  const repositoryRelative = relative(process.cwd(), path).replaceAll("\\", "/");
  return repositoryRelative.startsWith("../") || isAbsolute(repositoryRelative)
    ? basename(path)
    : repositoryRelative;
}

export function gitText(args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function repositoryProvenance(): { commit: string | null; dirty: boolean | null } {
  const commit = gitText(["rev-parse", "HEAD"]);
  const status = gitText(["status", "--porcelain", "--untracked-files=normal"]);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

export interface CleanRepositoryProvenance {
  commit: string;
  dirty: false;
}

/** Hosted phases require executable bytes identified by one clean Git commit. */
export function requireCleanRepositoryProvenance(
  provenance: ReturnType<typeof repositoryProvenance> = repositoryProvenance(),
): CleanRepositoryProvenance {
  if (!provenance.commit || !/^[a-f0-9]{40}$/.test(provenance.commit) || provenance.dirty !== false) {
    throw new Error("Hosted research requires a clean Git checkout with an identifiable 40-character commit");
  }
  return { commit: provenance.commit, dirty: false };
}

export async function readJson(pathValue: string): Promise<unknown> {
  const path = resolve(pathValue);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON file: ${portablePath(path)}`, { cause: error });
    throw error;
  }
}

export async function loadOracleQualification(path: string): Promise<OracleQualificationV2> {
  return OracleQualificationV2Schema.parse(await readJson(path));
}

export async function loadLocalModelManifest(path: string): Promise<ResearchModelManifestV1> {
  return parseResearchModelManifestV1(await readJson(path));
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required research API environment variable: ${name}`);
  return value;
}

/** Instantiate fixed direct-HTTP adapters without ever returning, logging, or serializing keys. */
export function createLiveProviders(
  localManifest: ResearchModelManifestV1,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): ResearchLiveProviderMap {
  assertResearchApiKeyEnvironment(localManifest);
  return {
    google: new GoogleResearchProvider({
      apiKey: requiredEnvironmentValue(localManifest.providers[0].apiKeyEnv),
      fetch: fetchImpl,
    }),
    anthropic: new AnthropicResearchProvider({
      apiKey: requiredEnvironmentValue(localManifest.providers[1].apiKeyEnv),
      fetch: fetchImpl,
    }),
    openai: new OpenAIResearchProvider({
      apiKey: requiredEnvironmentValue(localManifest.providers[2].apiKeyEnv),
      fetch: fetchImpl,
    }),
  };
}
