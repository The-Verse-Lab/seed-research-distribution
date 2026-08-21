/**
 * Immutable, resumable artifact storage for a live research result package.
 *
 * Fixed artifacts and content-addressed blobs are published atomically from a
 * same-directory temporary inode. JSONL observations are append-only and are
 * serialized behind an exclusive package lock. Finalization freezes the package
 * with a deterministic SHA256SUMS and immediately verifies every listed byte.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  StoredBranchResultV1Schema,
  StoredLiveTrialV1Schema,
  storedBranchResults,
  type StoredLiveTrialV1,
} from "./records.ts";

const MANIFEST_FILE = "manifest.json";
const QUALIFICATION_FILE = "oracle-qualification.json";
const LIVE_TRIALS_FILE = "live-trials.jsonl";
const BRANCH_RESULTS_FILE = "branch-results.jsonl";
const ANALYSIS_FILE = "analysis.json";
const REPORT_FILE = "REPORT.md";
const CHECKSUM_FILE = "SHA256SUMS";
const PROMPTS_DIR = "prompts";
const RESPONSES_DIR = "responses";
const LOCK_FILE = ".artifact-store.lock";
const COMPLETED_TRIAL_INTENT_FILE = ".completed-trial-intent.json";
const PROVIDER_DISPATCH_INTENTS_DIR = ".provider-dispatch-intents";
const MAX_PROVIDER_DISPATCH_INTENTS = 3;

const REQUIRED_ROOT_FILES = [
  ANALYSIS_FILE,
  BRANCH_RESULTS_FILE,
  LIVE_TRIALS_FILE,
  MANIFEST_FILE,
  QUALIFICATION_FILE,
  REPORT_FILE,
] as const;

const ROOT_ATOMIC_TARGETS = new Set<string>([
  ...REQUIRED_ROOT_FILES,
  CHECKSUM_FILE,
  LOCK_FILE,
  COMPLETED_TRIAL_INTENT_FILE,
]);

const ATOMIC_TEMP_NAME_PATTERN = /^\.(.+)\.tmp-([1-9][0-9]{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

const DANGEROUS_KEYS = new Set([
  "apikey",
  "authorization",
  "bearer",
  "bearertoken",
  "token",
  "authtoken",
  "authentication",
  "accesstoken",
  "clientsecret",
  "secret",
  "password",
  "credential",
  "credentials",
  "reasoning",
  "reasoningtext",
  "reasoningcontent",
  "hiddenreasoning",
  "chainofthought",
  "thinking",
  "thinkingtext",
  "request",
  "response",
  "rawrequest",
  "rawresponse",
  "requestbody",
  "responsebody",
  "requestheaders",
  "responseheaders",
  "httprequest",
  "httpresponse",
  "providerrequest",
  "providerresponse",
  "providerenvelope",
  "headers",
  "body",
  "envelope",
]);

const DANGEROUS_TEXT: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  { pattern: /\bbearer\s+[a-z0-9._~+/=-]+/i, description: "bearer credential" },
  {
    pattern: /\b(?:api[-_ ]?key|authorization)\s*[:=]\s*["']?[^\s"',}]+/i,
    description: "API key or authorization value",
  },
  { pattern: /\bsk-(?:ant-|proj-)?[a-z0-9_-]{12,}/i, description: "provider API key" },
  { pattern: /\bAIza[a-z0-9_-]{20,}/i, description: "Google API key" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, description: "private key" },
  {
    pattern: /<\/?(?:think|thinking)>|reasoning_content|chain[- ]of[- ]thought/i,
    description: "hidden reasoning",
  },
  {
    pattern: /["'](?:api[-_]?key|authorization|reasoning(?:_content)?|hidden[-_]?reasoning|chain[-_]?of[-_]?thought|raw[-_]?(?:request|response)|provider[-_]?envelope|request|response|headers|body)["']\s*:/i,
    description: "dangerous embedded field",
  },
];

export interface ContentAddressedArtifact {
  sha256: string;
  /** Portable path relative to the package root. */
  path: string;
  bytes: number;
}

export interface ResearchPackageChecksum {
  path: string;
  sha256: string;
}

export interface FinalizedResearchPackage {
  directory: string;
  checksumsPath: string;
  entries: ResearchPackageChecksum[];
}

export interface CompletedTrialProgress {
  stage: "intent-synced" | "branch-synced" | "trial-synced" | "commit-synced";
  trialId: string;
  branchRowsPresent: number;
  totalBranchRows: number;
}

export type ProviderDispatchIntentV1 = Readonly<Record<string, unknown> & {
  trialId: string;
  providerId: string;
}>;

export interface ResearchArtifactStoreV1Options {
  /** Optional durability-boundary observer; throwing simulates an interrupted process in tests. */
  onCompletedTrialProgress?: (progress: CompletedTrialProgress) => void | Promise<void>;
}

interface CompletedTrialIntentV1 {
  schemaVersion: 1;
  artifactKind: "seed.research.completed-trial-intent";
  trialId: string;
  trial: unknown;
  branchResults: unknown[];
}

interface PreparedCompletedTrial {
  intent: CompletedTrialIntentV1;
  trialId: string;
  trialLine: string;
  branches: Array<{ branchResultId: string; line: string }>;
}

interface IndexedJsonLine {
  line: string;
  value: Record<string, unknown>;
}

interface JsonLineTail {
  completeByteLength: number;
  records: IndexedJsonLine[];
  suffix: Buffer;
}

interface ValidatedCompletedLogs {
  promptPaths: Set<string>;
  responsePaths: Set<string>;
}

interface PreparedProviderDispatchIntent {
  filename: string;
  contents: string;
  intent: ProviderDispatchIntentV1;
}

class AtomicTargetExistsError extends Error {}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isDangerousKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (DANGEROUS_KEYS.has(normalized)) return true;
  // A redacted manifest stores names such as `apiKeyEnv`, never an API key.
  if (normalized.endsWith("apikeyenv")) return false;
  return normalized.includes("apikey")
    || normalized.includes("authorization")
    || normalized.includes("bearertoken")
    || normalized.includes("accesstoken")
    || normalized.includes("clientsecret")
    || normalized.includes("hiddenreasoning")
    || normalized.includes("reasoningcontent")
    || normalized.includes("chainofthought")
    || /^raw(?:provider)?(?:request|response|envelope|headers|body)$/.test(normalized)
    || /^provider(?:request|response|envelope|headers|body)$/.test(normalized);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeText(value: string, path: string, parseWholeJson = true): void {
  for (const rule of DANGEROUS_TEXT) {
    if (rule.pattern.test(value)) throw new Error(`Unsafe stored value at ${path}: ${rule.description}`);
  }
  if (!parseWholeJson) return;
  try {
    assertSafeStoredValue(JSON.parse(value) as unknown, `${path}<json>`);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

/** Reject secrets, private reasoning, provider envelopes, and non-JSON values recursively. */
export function assertSafeStoredValue(
  value: unknown,
  path = "artifact",
  seen: Set<object> = new Set(),
): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeText(value, path, false);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Unsafe non-finite number at ${path}`);
    return;
  }
  if (typeof value !== "object") throw new Error(`Non-JSON value at ${path}`);
  if (seen.has(value)) throw new Error(`Circular stored value at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertSafeStoredValue(entry, `${path}[${index}]`, seen));
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Non-plain stored object at ${path}`);
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isDangerousKey(key)) {
        throw new Error(`Unsafe stored key at ${path}.${key}`);
      }
      assertSafeStoredValue(entry, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCodePoints(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function serializedJson(value: unknown, label: string): string {
  assertSafeStoredValue(value, label);
  return `${canonicalJson(value)}\n`;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function prepareProviderDispatchIntent(intent: unknown): PreparedProviderDispatchIntent {
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) {
    throw new Error("Provider dispatch intent must be an object");
  }
  const candidate = intent as { trialId?: unknown; providerId?: unknown };
  if (typeof candidate.trialId !== "string" || candidate.trialId.length === 0) {
    throw new Error("Provider dispatch intent must have a non-empty trialId");
  }
  if (typeof candidate.providerId !== "string" || candidate.providerId.length === 0) {
    throw new Error("Provider dispatch intent must have a non-empty providerId");
  }
  const contents = serializedJson(intent, PROVIDER_DISPATCH_INTENTS_DIR);
  return {
    filename: `${sha256(`seed.research.provider-dispatch.v1\0${candidate.providerId}`)}.json`,
    contents,
    intent: JSON.parse(contents) as ProviderDispatchIntentV1,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function isDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return true;
    if (isErrno(error, "EPERM")) return false;
    throw error;
  }
}

function parsedAtomicTempName(
  name: string,
  targetAllowed: (targetName: string) => boolean,
): { targetName: string; pid: number } | null {
  const match = ATOMIC_TEMP_NAME_PATTERN.exec(name);
  if (!match?.[1] || !match[2] || !targetAllowed(match[1])) return null;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
  return { targetName: match[1], pid };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Publish complete bytes without ever replacing an existing target. */
async function atomicWriteExclusive(target: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(temp, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    closed = true;
    try {
      await link(temp, target);
      await syncDirectory(dirname(target));
    } catch (error) {
      if (isErrno(error, "EEXIST")) throw new AtomicTargetExistsError(`Artifact already exists: ${target}`);
      throw error;
    }
  } finally {
    if (!closed) await handle.close().catch(() => {});
    await unlink(temp).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

async function unlinkAndSync(target: string): Promise<void> {
  await unlink(target);
  await syncDirectory(dirname(target));
}

async function removeStalePackageLock(lockPath: string): Promise<boolean> {
  let owner: string;
  try {
    owner = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
  const match = /^(\d+)\n/.exec(owner);
  if (!match?.[1]) return false;
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (!isErrno(error, "ESRCH")) return false;
  }
  try {
    await unlinkAndSync(lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
}

async function appendAndSync(target: string, line: string): Promise<void> {
  const handle = await open(target, "a", 0o600);
  try {
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateAndSync(target: string, byteLength: number): Promise<void> {
  const handle = await open(target, "r+", 0o600);
  try {
    await handle.truncate(byteLength);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function filesBelow(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(child));
    else if (entry.isFile()) output.push(child);
    else throw new Error(`Unsupported artifact filesystem entry: ${child}`);
  }
  return output;
}

function parseJsonLines(contents: string, path: string): IndexedJsonLine[] {
  if (contents.length > 0 && !contents.endsWith("\n")) throw new Error(`Truncated JSONL artifact: ${path}`);
  const records: IndexedJsonLine[] = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid JSONL record at ${path}:${index + 1}`);
    }
    assertSafeStoredValue(value, `${path}:${index + 1}`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`JSONL record must be an object at ${path}:${index + 1}`);
    }
    records.push({ line: `${line}\n`, value: value as Record<string, unknown> });
  }
  return records;
}

async function readJsonLineTail(target: string, path: string): Promise<JsonLineTail> {
  const contents = await readFile(target);
  if (contents.length === 0 || contents[contents.length - 1] === 0x0a) {
    return {
      completeByteLength: contents.length,
      records: parseJsonLines(contents.toString("utf8"), path),
      suffix: Buffer.alloc(0),
    };
  }
  const lastNewline = contents.lastIndexOf(0x0a);
  const completeByteLength = lastNewline + 1;
  return {
    completeByteLength,
    records: parseJsonLines(contents.subarray(0, completeByteLength).toString("utf8"), path),
    suffix: contents.subarray(completeByteLength),
  };
}

function isStrictBytePrefix(candidate: Buffer, intendedLine: string): boolean {
  const intended = Buffer.from(intendedLine, "utf8");
  return candidate.length > 0 && candidate.length < intended.length &&
    candidate.equals(intended.subarray(0, candidate.length));
}

function assertJsonLines(contents: string, path: string): void {
  parseJsonLines(contents, path);
}

function requireRecordId(record: IndexedJsonLine, field: string, path: string): string {
  const value = record.value[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field} in ${path}`);
  return value;
}

function prepareCompletedTrial(trial: unknown, branchResults: readonly unknown[]): PreparedCompletedTrial {
  if (trial === null || typeof trial !== "object" || Array.isArray(trial)) {
    throw new Error("Completed live trial must be an object");
  }
  const trialId = (trial as { trialId?: unknown }).trialId;
  if (typeof trialId !== "string" || trialId.length === 0) {
    throw new Error("Completed live trial must have a non-empty trialId");
  }
  const trialLine = serializedJson(trial, LIVE_TRIALS_FILE);
  const seen = new Set<string>();
  const branches = branchResults.map((branch, index) => {
    if (branch === null || typeof branch !== "object" || Array.isArray(branch)) {
      throw new Error(`Completed branch result ${index} must be an object`);
    }
    const candidate = branch as { trialId?: unknown; branchResultId?: unknown };
    if (candidate.trialId !== trialId) {
      throw new Error(`Completed branch result ${index} has a mismatched trialId`);
    }
    if (typeof candidate.branchResultId !== "string" || candidate.branchResultId.length === 0) {
      throw new Error(`Completed branch result ${index} must have a stable branchResultId`);
    }
    if (seen.has(candidate.branchResultId)) {
      throw new Error(`Duplicate branchResultId in completed trial: ${candidate.branchResultId}`);
    }
    seen.add(candidate.branchResultId);
    return {
      branchResultId: candidate.branchResultId,
      line: serializedJson(branch, BRANCH_RESULTS_FILE),
    };
  });
  return {
    trialId,
    trialLine,
    branches,
    intent: {
      schemaVersion: 1,
      artifactKind: "seed.research.completed-trial-intent",
      trialId,
      trial,
      branchResults: [...branchResults],
    },
  };
}

/** Stateful facade for one result-package directory. */
export class ResearchArtifactStoreV1 {
  readonly directory: string;
  private operation: Promise<void> = Promise.resolve();
  private readonly options: ResearchArtifactStoreV1Options;

  private constructor(directory: string, options: ResearchArtifactStoreV1Options) {
    this.directory = resolve(directory);
    this.options = options;
  }

  static async open(
    directory: string,
    options: ResearchArtifactStoreV1Options = {},
  ): Promise<ResearchArtifactStoreV1> {
    const store = new ResearchArtifactStoreV1(directory, options);
    await mkdir(store.directory, { recursive: true });
    await store.serialized(() => store.withPackageLock(async () => {
      if (await exists(store.file(CHECKSUM_FILE))) {
        if (await exists(store.file(COMPLETED_TRIAL_INTENT_FILE))) {
          throw new Error("Finalized result package contains an unresolved completed-trial intent");
        }
        if (await exists(store.file(PROVIDER_DISPATCH_INTENTS_DIR))) {
          throw new Error("Finalized result package contains provider-dispatch intent state");
        }
        return;
      }
      await mkdir(store.file(PROMPTS_DIR), { recursive: true });
      await mkdir(store.file(RESPONSES_DIR), { recursive: true });
      for (const name of [LIVE_TRIALS_FILE, BRANCH_RESULTS_FILE]) {
        try {
          await atomicWriteExclusive(store.file(name), "");
        } catch (error) {
          if (!(error instanceof AtomicTargetExistsError)) throw error;
        }
      }
      await store.recoverCompletedTrialIntentUnlocked();
      await store.reconcileProviderDispatchIntentsUnlocked();
    }));
    return store;
  }

  private file(name: string): string {
    return join(this.directory, name);
  }

  private async ensureProviderDispatchDirectoryUnlocked(): Promise<void> {
    const directory = this.file(PROVIDER_DISPATCH_INTENTS_DIR);
    try {
      await mkdir(directory);
      await syncDirectory(this.directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const info = await stat(directory);
      if (!info.isDirectory()) throw new Error(`${PROVIDER_DISPATCH_INTENTS_DIR} is not a directory`);
    }
  }

  private async providerDispatchIntentsUnlocked(): Promise<PreparedProviderDispatchIntent[]> {
    const directory = this.file(PROVIDER_DISPATCH_INTENTS_DIR);
    if (!(await exists(directory))) return [];
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error(`${PROVIDER_DISPATCH_INTENTS_DIR} is not a directory`);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_PROVIDER_DISPATCH_INTENTS) {
      throw new Error(`Too many unresolved provider dispatches: ${entries.length}`);
    }
    const intents: PreparedProviderDispatchIntent[] = [];
    const providers = new Set<string>();
    const trials = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new Error(`Unexpected provider-dispatch intent entry: ${entry.name}`);
      }
      const contents = await readFile(join(directory, entry.name), "utf8");
      let value: unknown;
      try {
        value = JSON.parse(contents) as unknown;
      } catch {
        throw new Error(`Invalid provider-dispatch intent: ${entry.name}`);
      }
      const prepared = prepareProviderDispatchIntent(value);
      if (prepared.filename !== entry.name || prepared.contents !== contents) {
        throw new Error(`Conflicting or non-canonical provider-dispatch intent: ${entry.name}`);
      }
      if (providers.has(prepared.intent.providerId)) {
        throw new Error(`Duplicate provider-dispatch marker for providerId: ${prepared.intent.providerId}`);
      }
      if (trials.has(prepared.intent.trialId)) {
        throw new Error(`Duplicate provider-dispatch marker for trialId: ${prepared.intent.trialId}`);
      }
      providers.add(prepared.intent.providerId);
      trials.add(prepared.intent.trialId);
      intents.push(prepared);
    }
    return intents.sort((left, right) =>
      compareCodePoints(left.intent.providerId, right.intent.providerId) ||
      compareCodePoints(left.intent.trialId, right.intent.trialId)
    );
  }

  private async cleanupEmptyProviderDispatchDirectoryUnlocked(): Promise<void> {
    const directory = this.file(PROVIDER_DISPATCH_INTENTS_DIR);
    if (!(await exists(directory))) return;
    if ((await readdir(directory)).length > 0) return;
    try {
      await rmdir(directory);
      await syncDirectory(this.directory);
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) throw error;
    }
  }

  private async removeProviderDispatchIntentUnlocked(intent: PreparedProviderDispatchIntent): Promise<void> {
    await unlinkAndSync(join(this.file(PROVIDER_DISPATCH_INTENTS_DIR), intent.filename));
    await this.cleanupEmptyProviderDispatchDirectoryUnlocked();
  }

  private completedRowProviderId(row: IndexedJsonLine): string | undefined {
    if (typeof row.value.providerId === "string") return row.value.providerId;
    const attempt = row.value.modelAttempt;
    if (attempt && typeof attempt === "object" && !Array.isArray(attempt) &&
      typeof (attempt as { provider?: unknown }).provider === "string") {
      return (attempt as { provider: string }).provider;
    }
    return undefined;
  }

  private async reconcileProviderDispatchIntentsUnlocked(): Promise<void> {
    const intents = await this.providerDispatchIntentsUnlocked();
    const completed = await this.liveTrialRowsUnlocked();
    for (const intent of intents) {
      const row = completed.get(intent.intent.trialId);
      if (!row) continue;
      const completedProviderId = this.completedRowProviderId(row);
      if (completedProviderId && completedProviderId !== intent.intent.providerId) {
        throw new Error(`Completed trial provider conflicts with dispatch marker: ${intent.intent.trialId}`);
      }
      await this.removeProviderDispatchIntentUnlocked(intent);
    }
    await this.cleanupEmptyProviderDispatchDirectoryUnlocked();
  }

  private async assertNoProviderDispatchIntentsUnlocked(): Promise<void> {
    const intents = await this.providerDispatchIntentsUnlocked();
    if (intents.length > 0) {
      throw new Error(`Cannot finalize with ${intents.length} unresolved provider dispatch intent(s)`);
    }
    if (await exists(this.file(PROVIDER_DISPATCH_INTENTS_DIR))) {
      throw new Error(`Cannot finalize while ${PROVIDER_DISPATCH_INTENTS_DIR} exists`);
    }
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async reconcileAtomicTempDirectoryUnlocked(
    directory: string,
    targetAllowed: (targetName: string) => boolean,
  ): Promise<void> {
    const directoryInfo = await lstatIfExists(directory);
    if (!directoryInfo) return;
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(`Atomic artifact directory is not a safe regular directory: ${directory}`);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const parsed = parsedAtomicTempName(entry.name, targetAllowed);
      if (!parsed) continue;
      const tempPath = join(directory, entry.name);
      const tempInfo = await lstatIfExists(tempPath);
      if (!tempInfo) continue;
      if (entry.isSymbolicLink() || !entry.isFile() || tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
        throw new Error(`Atomic temporary artifact is not a safe regular file: ${tempPath}`);
      }
      if (!isDeadProcess(parsed.pid)) {
        throw new Error(`Atomic temporary artifact belongs to a live or unverifiable process: ${tempPath}`);
      }

      const targetPath = join(directory, parsed.targetName);
      const targetInfo = await lstatIfExists(targetPath);
      if (parsed.targetName !== LOCK_FILE && targetInfo) {
        if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
          throw new Error(`Atomic temporary artifact target is not a safe regular file: ${targetPath}`);
        }
        const sameInode = tempInfo.dev === targetInfo.dev && tempInfo.ino === targetInfo.ino;
        if (!sameInode && !(await readFile(tempPath)).equals(await readFile(targetPath))) {
          throw new Error(`Atomic temporary artifact conflicts with its published target: ${tempPath}`);
        }
      }

      // The package lock excludes cooperative writers. Re-check immediately
      // before unlinking so a non-regular replacement is retained fail-closed.
      const currentInfo = await lstatIfExists(tempPath);
      if (!currentInfo || currentInfo.isSymbolicLink() || !currentInfo.isFile() ||
        currentInfo.dev !== tempInfo.dev || currentInfo.ino !== tempInfo.ino) {
        throw new Error(`Atomic temporary artifact changed during reconciliation: ${tempPath}`);
      }
      await unlinkAndSync(tempPath);
    }
  }

  private async reconcileStaleAtomicTempsUnlocked(): Promise<void> {
    await this.reconcileAtomicTempDirectoryUnlocked(
      this.directory,
      (targetName) => ROOT_ATOMIC_TARGETS.has(targetName),
    );
    await this.reconcileAtomicTempDirectoryUnlocked(
      this.file(PROMPTS_DIR),
      (targetName) => /^[a-f0-9]{64}\.txt$/.test(targetName),
    );
    await this.reconcileAtomicTempDirectoryUnlocked(
      this.file(RESPONSES_DIR),
      (targetName) => /^[a-f0-9]{64}\.json$/.test(targetName),
    );
    await this.reconcileAtomicTempDirectoryUnlocked(
      this.file(PROVIDER_DISPATCH_INTENTS_DIR),
      (targetName) => /^[a-f0-9]{64}\.json$/.test(targetName),
    );
  }

  private async withPackageLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = this.file(LOCK_FILE);
    const owner = `${process.pid}\n${randomUUID()}\n`;
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
      try {
        await atomicWriteExclusive(lockPath, owner);
        acquired = true;
      } catch (error) {
        if (!(error instanceof AtomicTargetExistsError)) throw error;
        if (attempt === 0 && await removeStalePackageLock(lockPath)) continue;
        throw new Error(`Research artifact package is locked: ${this.directory}`);
      }
    }
    if (!acquired) throw new Error(`Research artifact package is locked: ${this.directory}`);
    try {
      await this.reconcileStaleAtomicTempsUnlocked();
      return await action();
    } finally {
      const current = await readFile(lockPath, "utf8").catch(() => null);
      if (current === owner) {
        await unlinkAndSync(lockPath).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    }
  }

  private async assertMutableUnlocked(): Promise<void> {
    if (await exists(this.file(CHECKSUM_FILE))) {
      throw new Error(`Research artifact package is finalized and immutable: ${this.directory}`);
    }
    await this.assertNoCompletedTrialIntentUnlocked();
  }

  private async assertNoCompletedTrialIntentUnlocked(): Promise<void> {
    if (await exists(this.file(COMPLETED_TRIAL_INTENT_FILE))) {
      throw new Error("Research artifact package has an unresolved completed-trial intent; reopen it to recover");
    }
  }

  private async writeFixedJson(name: string, value: unknown): Promise<void> {
    const contents = serializedJson(value, name);
    return await this.serialized(() => this.withPackageLock(async () => {
      await this.assertMutableUnlocked();
      try {
        await atomicWriteExclusive(this.file(name), contents);
      } catch (error) {
        if (error instanceof AtomicTargetExistsError) {
          throw new Error(`Refusing to overwrite immutable artifact: ${name}`);
        }
        throw error;
      }
    }));
  }

  /**
   * Publish deterministic finalization output, or accept the exact bytes left by an
   * interrupted earlier finalization attempt. Existing different bytes remain immutable.
   */
  private async writeFinalizationJson(name: string, value: unknown): Promise<void> {
    const contents = serializedJson(value, name);
    return await this.serialized(() => this.withPackageLock(async () => {
      const target = this.file(name);
      if (await exists(target)) {
        if (await readFile(target, "utf8") !== contents) {
          throw new Error(`Refusing to overwrite immutable artifact: ${name}`);
        }
        return;
      }
      await this.assertMutableUnlocked();
      try {
        await atomicWriteExclusive(target, contents);
      } catch (error) {
        if (error instanceof AtomicTargetExistsError) {
          if (await readFile(target, "utf8") === contents) return;
          throw new Error(`Refusing to overwrite immutable artifact: ${name}`);
        }
        throw error;
      }
    }));
  }

  writeManifest(value: unknown): Promise<void> {
    return this.writeFixedJson(MANIFEST_FILE, value);
  }

  writeOracleQualification(value: unknown): Promise<void> {
    return this.writeFixedJson(QUALIFICATION_FILE, value);
  }

  writeAnalysis(value: unknown): Promise<void> {
    return this.writeFinalizationJson(ANALYSIS_FILE, value);
  }

  async writeReport(markdown: string): Promise<void> {
    if (typeof markdown !== "string") throw new Error("REPORT.md must be text");
    assertSafeText(markdown, REPORT_FILE);
    return await this.serialized(() => this.withPackageLock(async () => {
      const target = this.file(REPORT_FILE);
      if (await exists(target)) {
        if (await readFile(target, "utf8") !== markdown) {
          throw new Error(`Refusing to overwrite immutable artifact: ${REPORT_FILE}`);
        }
        return;
      }
      await this.assertMutableUnlocked();
      try {
        await atomicWriteExclusive(target, markdown);
      } catch (error) {
        if (error instanceof AtomicTargetExistsError) {
          if (await readFile(target, "utf8") === markdown) return;
          throw new Error(`Refusing to overwrite immutable artifact: ${REPORT_FILE}`);
        }
        throw error;
      }
    }));
  }

  private async storeContent(directory: string, extension: string, contents: string): Promise<ContentAddressedArtifact> {
    assertSafeText(contents, directory);
    const digest = sha256(contents);
    const relativePath = `${directory}/${digest}.${extension}`;
    const target = this.file(relativePath);
    return this.serialized(() => this.withPackageLock(async () => {
      await this.assertMutableUnlocked();
      if (await exists(target)) {
        const stored = await readFile(target, "utf8");
        if (stored !== contents) throw new Error(`Content hash collision at ${relativePath}`);
      } else {
        try {
          await atomicWriteExclusive(target, contents);
        } catch (error) {
          if (!(error instanceof AtomicTargetExistsError)) throw error;
          const stored = await readFile(target, "utf8");
          if (stored !== contents) throw new Error(`Content hash collision at ${relativePath}`);
        }
      }
      return { sha256: digest, path: relativePath, bytes: Buffer.byteLength(contents) };
    }));
  }

  /** Preserve the exact public prompt bytes. Repeated identical bytes are idempotent. */
  storePrompt(prompt: string): Promise<ContentAddressedArtifact> {
    return this.storeContent(PROMPTS_DIR, "txt", prompt);
  }

  /** Preserve the exact visible output bytes, including an invalid first response. */
  storeVisibleResponse(output: string): Promise<ContentAddressedArtifact> {
    return this.storeContent(RESPONSES_DIR, "json", output);
  }

  /** Durably claim one first provider attempt before any network dispatch occurs. */
  async beginProviderDispatch<T extends { readonly trialId: string; readonly providerId: string }>(
    intent: T,
  ): Promise<void> {
    const prepared = prepareProviderDispatchIntent(intent);
    return await this.serialized(() => this.withPackageLock(async () => {
      await this.assertMutableUnlocked();
      await this.reconcileProviderDispatchIntentsUnlocked();
      if ((await this.liveTrialRowsUnlocked()).has(prepared.intent.trialId)) {
        throw new Error(`Provider dispatch trialId is already completed: ${prepared.intent.trialId}`);
      }
      const pending = await this.providerDispatchIntentsUnlocked();
      if (pending.some((row) => row.intent.providerId === prepared.intent.providerId)) {
        throw new Error(`Provider already has an unresolved dispatch: ${prepared.intent.providerId}`);
      }
      if (pending.some((row) => row.intent.trialId === prepared.intent.trialId)) {
        throw new Error(`Trial already has an unresolved provider dispatch: ${prepared.intent.trialId}`);
      }
      if (pending.length >= MAX_PROVIDER_DISPATCH_INTENTS) {
        throw new Error(`At most ${MAX_PROVIDER_DISPATCH_INTENTS} provider dispatches may be unresolved`);
      }
      await this.ensureProviderDispatchDirectoryUnlocked();
      try {
        await atomicWriteExclusive(
          join(this.file(PROVIDER_DISPATCH_INTENTS_DIR), prepared.filename),
          prepared.contents,
        );
      } catch (error) {
        if (error instanceof AtomicTargetExistsError) {
          throw new Error(`Conflicting provider-dispatch marker for providerId: ${prepared.intent.providerId}`);
        }
        throw error;
      }
    }));
  }

  /** Enumerate already-dispatched, unresolved first attempts; callers must never dispatch them again. */
  pendingProviderDispatches(): Promise<ProviderDispatchIntentV1[]> {
    return this.serialized(() => this.withPackageLock(async () => {
      await this.reconcileProviderDispatchIntentsUnlocked();
      return (await this.providerDispatchIntentsUnlocked()).map((row) => structuredClone(row.intent));
    }));
  }

  private async liveTrialRowsUnlocked(): Promise<Map<string, IndexedJsonLine>> {
    const contents = await readFile(this.file(LIVE_TRIALS_FILE), "utf8");
    const indexed = new Map<string, IndexedJsonLine>();
    for (const [index, record] of parseJsonLines(contents, LIVE_TRIALS_FILE).entries()) {
      const trialId = requireRecordId(record, "trialId", `${LIVE_TRIALS_FILE}:${index + 1}`);
      if (indexed.has(trialId)) throw new Error(`Duplicate completed trialId in artifact: ${trialId}`);
      indexed.set(trialId, record);
    }
    return indexed;
  }

  private async branchResultRowsUnlocked(): Promise<{
    byId: Map<string, IndexedJsonLine>;
    byTrialId: Map<string, IndexedJsonLine[]>;
  }> {
    const contents = await readFile(this.file(BRANCH_RESULTS_FILE), "utf8");
    const byId = new Map<string, IndexedJsonLine>();
    const byTrialId = new Map<string, IndexedJsonLine[]>();
    for (const [index, record] of parseJsonLines(contents, BRANCH_RESULTS_FILE).entries()) {
      const path = `${BRANCH_RESULTS_FILE}:${index + 1}`;
      const trialId = requireRecordId(record, "trialId", path);
      const branchResultId = requireRecordId(record, "branchResultId", path);
      if (byId.has(branchResultId)) throw new Error(`Duplicate branchResultId in artifact: ${branchResultId}`);
      byId.set(branchResultId, record);
      const rows = byTrialId.get(trialId) ?? [];
      rows.push(record);
      byTrialId.set(trialId, rows);
    }
    return { byId, byTrialId };
  }

  private async completedTrialIdsUnlocked(): Promise<Set<string>> {
    return new Set((await this.liveTrialRowsUnlocked()).keys());
  }

  private async readCompletedTrialIntentUnlocked(): Promise<PreparedCompletedTrial | null> {
    const target = this.file(COMPLETED_TRIAL_INTENT_FILE);
    if (!(await exists(target))) return null;
    const contents = await readFile(target, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch {
      throw new Error("Invalid completed-trial intent journal");
    }
    assertSafeStoredValue(value, COMPLETED_TRIAL_INTENT_FILE);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid completed-trial intent journal");
    }
    const candidate = value as Partial<CompletedTrialIntentV1>;
    if (candidate.schemaVersion !== 1 || candidate.artifactKind !== "seed.research.completed-trial-intent" ||
      typeof candidate.trialId !== "string" || !Array.isArray(candidate.branchResults)) {
      throw new Error("Invalid completed-trial intent journal");
    }
    const prepared = prepareCompletedTrial(candidate.trial, candidate.branchResults);
    if (prepared.trialId !== candidate.trialId || serializedJson(prepared.intent, COMPLETED_TRIAL_INTENT_FILE) !== contents) {
      throw new Error("Conflicting or non-canonical completed-trial intent journal");
    }
    return prepared;
  }

  private async reportCompletedTrialProgress(
    stage: CompletedTrialProgress["stage"],
    prepared: PreparedCompletedTrial,
    branchRowsPresent: number,
  ): Promise<void> {
    await this.options.onCompletedTrialProgress?.({
      stage,
      trialId: prepared.trialId,
      branchRowsPresent,
      totalBranchRows: prepared.branches.length,
    });
  }

  private expectedBranchRecoveryLine(
    prepared: PreparedCompletedTrial,
    records: readonly IndexedJsonLine[],
  ): string | null {
    const byId = new Map<string, IndexedJsonLine>();
    const existingForTrial: IndexedJsonLine[] = [];
    for (const [index, record] of records.entries()) {
      const path = `${BRANCH_RESULTS_FILE}:${index + 1}`;
      const trialId = requireRecordId(record, "trialId", path);
      const branchResultId = requireRecordId(record, "branchResultId", path);
      if (byId.has(branchResultId)) throw new Error(`Duplicate branchResultId in artifact: ${branchResultId}`);
      byId.set(branchResultId, record);
      if (trialId === prepared.trialId) existingForTrial.push(record);
    }
    if (existingForTrial.length >= prepared.branches.length) {
      throw new Error(`Truncated ${BRANCH_RESULTS_FILE} has no pending journaled branch append`);
    }
    for (const [index, existing] of existingForTrial.entries()) {
      const intended = prepared.branches[index];
      if (!intended || existing.value.branchResultId !== intended.branchResultId || existing.line !== intended.line) {
        throw new Error(`Non-prefix or conflicting branch recovery for completed trial ${prepared.trialId}`);
      }
    }
    for (let index = existingForTrial.length; index < prepared.branches.length; index++) {
      const intended = prepared.branches[index]!;
      if (byId.has(intended.branchResultId)) {
        throw new Error(`Conflicting bytes or trialId for branchResultId: ${intended.branchResultId}`);
      }
    }
    return prepared.branches[existingForTrial.length]!.line;
  }

  private expectedLiveTrialRecoveryLine(
    prepared: PreparedCompletedTrial,
    records: readonly IndexedJsonLine[],
  ): string | null {
    const byId = new Map<string, IndexedJsonLine>();
    for (const [index, record] of records.entries()) {
      const trialId = requireRecordId(record, "trialId", `${LIVE_TRIALS_FILE}:${index + 1}`);
      if (byId.has(trialId)) throw new Error(`Duplicate completed trialId in artifact: ${trialId}`);
      byId.set(trialId, record);
    }
    const existing = byId.get(prepared.trialId);
    if (!existing) return prepared.trialLine;
    if (existing.line !== prepared.trialLine) {
      throw new Error(`Conflicting bytes for completed trialId: ${prepared.trialId}`);
    }
    return null;
  }

  /**
   * A durable intent identifies the exact next append bytes. Only a non-newline
   * suffix that is a strict byte prefix of those bytes is safe to truncate. A
   * complete conflicting row, a later intended row, or arbitrary corruption is
   * retained and fails closed.
   */
  private async repairTornCompletedTrialAppendsUnlocked(prepared: PreparedCompletedTrial): Promise<void> {
    const branchTail = await readJsonLineTail(this.file(BRANCH_RESULTS_FILE), BRANCH_RESULTS_FILE);
    if (branchTail.suffix.length > 0) {
      const expected = this.expectedBranchRecoveryLine(prepared, branchTail.records);
      if (!expected || !isStrictBytePrefix(branchTail.suffix, expected)) {
        throw new Error(`Truncated JSONL artifact does not match the journaled append: ${BRANCH_RESULTS_FILE}`);
      }
      await truncateAndSync(this.file(BRANCH_RESULTS_FILE), branchTail.completeByteLength);
    }

    const trialTail = await readJsonLineTail(this.file(LIVE_TRIALS_FILE), LIVE_TRIALS_FILE);
    if (trialTail.suffix.length > 0) {
      const expected = this.expectedLiveTrialRecoveryLine(prepared, trialTail.records);
      if (!expected || !isStrictBytePrefix(trialTail.suffix, expected)) {
        throw new Error(`Truncated JSONL artifact does not match the journaled append: ${LIVE_TRIALS_FILE}`);
      }
      await truncateAndSync(this.file(LIVE_TRIALS_FILE), trialTail.completeByteLength);
    }
  }

  private async finishCompletedTrialIntentUnlocked(
    prepared: PreparedCompletedTrial,
    reportProgress: boolean,
  ): Promise<void> {
    await this.repairTornCompletedTrialAppendsUnlocked(prepared);
    const liveRows = await this.liveTrialRowsUnlocked();
    const branchRows = await this.branchResultRowsUnlocked();
    const existingForTrial = branchRows.byTrialId.get(prepared.trialId) ?? [];
    if (existingForTrial.length > prepared.branches.length) {
      throw new Error(`Conflicting branch rows for completed trialId: ${prepared.trialId}`);
    }
    for (const [index, existing] of existingForTrial.entries()) {
      const intended = prepared.branches[index];
      if (!intended || existing.value.branchResultId !== intended.branchResultId || existing.line !== intended.line) {
        throw new Error(`Non-prefix or conflicting branch recovery for completed trial ${prepared.trialId}`);
      }
    }
    const rowsPresent = existingForTrial.length;
    for (let index = rowsPresent; index < prepared.branches.length; index++) {
      const intended = prepared.branches[index]!;
      const existing = branchRows.byId.get(intended.branchResultId);
      if (existing) {
        throw new Error(`Conflicting bytes or trialId for branchResultId: ${intended.branchResultId}`);
      }
    }

    const existingTrial = liveRows.get(prepared.trialId);
    if (existingTrial && existingTrial.line !== prepared.trialLine) {
      throw new Error(`Conflicting bytes for completed trialId: ${prepared.trialId}`);
    }
    let appendedRows = rowsPresent;
    for (let index = rowsPresent; index < prepared.branches.length; index++) {
      await appendAndSync(this.file(BRANCH_RESULTS_FILE), prepared.branches[index]!.line);
      appendedRows++;
      if (reportProgress) await this.reportCompletedTrialProgress("branch-synced", prepared, appendedRows);
    }
    if (!existingTrial) {
      await appendAndSync(this.file(LIVE_TRIALS_FILE), prepared.trialLine);
      if (reportProgress) await this.reportCompletedTrialProgress("trial-synced", prepared, appendedRows);
    }
    await unlinkAndSync(this.file(COMPLETED_TRIAL_INTENT_FILE));
  }

  private async recoverCompletedTrialIntentUnlocked(): Promise<void> {
    const prepared = await this.readCompletedTrialIntentUnlocked();
    if (prepared) await this.finishCompletedTrialIntentUnlocked(prepared, false);
  }

  completedTrialIds(): Promise<Set<string>> {
    return this.serialized(() => this.withPackageLock(async () => {
      await this.assertNoCompletedTrialIntentUnlocked();
      return this.completedTrialIdsUnlocked();
    }));
  }

  async hasCompletedTrial(trialId: string): Promise<boolean> {
    if (!trialId) throw new Error("trialId must be non-empty");
    return (await this.completedTrialIds()).has(trialId);
  }

  /** Non-transactional low-level append; normal runtime code must use appendCompletedTrial(). */
  async appendLiveTrial<T extends { readonly trialId: string }>(trial: T): Promise<void> {
    if (typeof trial.trialId !== "string" || trial.trialId.length === 0) {
      throw new Error("Live trial must have a non-empty trialId");
    }
    const line = serializedJson(trial, LIVE_TRIALS_FILE);
    return await this.serialized(() => this.withPackageLock(async () => {
      await this.assertMutableUnlocked();
      const completed = await this.completedTrialIdsUnlocked();
      if (completed.has(trial.trialId)) {
        throw new Error(`Refusing to overwrite completed trialId: ${trial.trialId}`);
      }
      await appendAndSync(this.file(LIVE_TRIALS_FILE), line);
    }));
  }

  /** Non-transactional low-level append; normal runtime code must use appendCompletedTrial(). */
  async appendBranchResult<T extends { readonly trialId: string; readonly branchResultId: string }>(result: T): Promise<void> {
    if (typeof result.trialId !== "string" || result.trialId.length === 0) {
      throw new Error("Branch result must have a non-empty trialId");
    }
    if (typeof result.branchResultId !== "string" || result.branchResultId.length === 0) {
      throw new Error("Branch result must have a stable branchResultId");
    }
    const line = serializedJson(result, BRANCH_RESULTS_FILE);
    return await this.serialized(() => this.withPackageLock(async () => {
      await this.assertMutableUnlocked();
      if ((await this.completedTrialIdsUnlocked()).has(result.trialId)) {
        throw new Error(`Refusing to append a branch to completed trialId: ${result.trialId}`);
      }
      if ((await this.branchResultRowsUnlocked()).byId.has(result.branchResultId)) {
        throw new Error(`Duplicate branchResultId in artifact: ${result.branchResultId}`);
      }
      await appendAndSync(this.file(BRANCH_RESULTS_FILE), line);
    }));
  }

  /**
   * Write one provider result and all deterministic branch replays as one recoverable
   * logical commit. A repeated completed trialId is rejected; recovery is performed by open().
   */
  async appendCompletedTrial<
    TTrial extends { readonly trialId: string },
    TBranch extends { readonly trialId: string; readonly branchResultId: string },
  >(trial: TTrial, branchResults: readonly TBranch[]): Promise<void> {
    const prepared = prepareCompletedTrial(trial, branchResults);
    return await this.serialized(() => this.withPackageLock(async () => {
      await this.assertMutableUnlocked();
      const liveRows = await this.liveTrialRowsUnlocked();
      if (liveRows.has(prepared.trialId)) {
        throw new Error(`Refusing to overwrite completed trialId: ${prepared.trialId}`);
      }
      const existingBranches = await this.branchResultRowsUnlocked();
      if ((existingBranches.byTrialId.get(prepared.trialId)?.length ?? 0) > 0) {
        throw new Error(`Unjournaled branch rows already exist for trialId: ${prepared.trialId}`);
      }
      for (const branch of prepared.branches) {
        if (existingBranches.byId.has(branch.branchResultId)) {
          throw new Error(`Conflicting branchResultId already exists: ${branch.branchResultId}`);
        }
      }
      await atomicWriteExclusive(
        this.file(COMPLETED_TRIAL_INTENT_FILE),
        serializedJson(prepared.intent, COMPLETED_TRIAL_INTENT_FILE),
      );
      await this.reportCompletedTrialProgress("intent-synced", prepared, 0);
      await this.finishCompletedTrialIntentUnlocked(prepared, true);
      await this.reportCompletedTrialProgress("commit-synced", prepared, prepared.branches.length);
      await this.reconcileProviderDispatchIntentsUnlocked();
    }));
  }

  private async validateContentReferenceUnlocked(
    artifact: { sha256: string; path: string; bytes: number },
    directory: typeof PROMPTS_DIR | typeof RESPONSES_DIR,
    extension: "txt" | "json",
    trialId: string,
  ): Promise<void> {
    const expectedPath = `${directory}/${artifact.sha256}.${extension}`;
    if (artifact.path !== expectedPath) {
      throw new Error(`Content-addressed ${directory} path mismatch for trialId: ${trialId}`);
    }
    let contents: Buffer;
    try {
      contents = await readFile(this.file(artifact.path));
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new Error(`Missing referenced ${directory} artifact for trialId: ${trialId}`);
      }
      throw error;
    }
    if (contents.byteLength !== artifact.bytes) {
      throw new Error(`Referenced ${directory} byte count mismatch for trialId: ${trialId}`);
    }
    if (sha256(contents) !== artifact.sha256) {
      throw new Error(`Referenced ${directory} hash mismatch for trialId: ${trialId}`);
    }
  }

  private async validateCompletedLogsUnlocked(): Promise<ValidatedCompletedLogs> {
    await this.assertNoCompletedTrialIntentUnlocked();
    await this.assertNoProviderDispatchIntentsUnlocked();
    const completed = await this.liveTrialRowsUnlocked();
    const branches = await this.branchResultRowsUnlocked();
    for (const [trialId] of branches.byTrialId) {
      if (!completed.has(trialId)) throw new Error(`Orphan branch rows for incomplete trialId: ${trialId}`);
    }
    const promptPaths = new Set<string>();
    const responsePaths = new Set<string>();
    for (const [trialId, row] of completed) {
      let trial: StoredLiveTrialV1;
      try {
        trial = StoredLiveTrialV1Schema.parse(row.value);
      } catch (error) {
        throw new Error(`Invalid completed stored trial: ${trialId}`, { cause: error });
      }
      const observedRows = branches.byTrialId.get(trialId) ?? [];
      if (observedRows.length !== 10) {
        throw new Error(`Completed trial ${trialId} requires exactly 10 branch rows; observed ${observedRows.length}`);
      }
      const expectedRows = storedBranchResults(trial);
      const expectedById = new Map(expectedRows.map((branch) => [branch.branchResultId, branch] as const));
      for (const observedRow of observedRows) {
        let observed;
        try {
          observed = StoredBranchResultV1Schema.parse(observedRow.value);
        } catch (error) {
          throw new Error(`Invalid stored branch row for trialId: ${trialId}`, { cause: error });
        }
        const expected = expectedById.get(observed.branchResultId);
        if (!expected || !sameCanonicalValue(observed, expected)) {
          throw new Error(`Stored branch row does not match its live trial: ${observed.branchResultId}`);
        }
        expectedById.delete(observed.branchResultId);
      }
      if (expectedById.size !== 0) {
        throw new Error(`Completed trial ${trialId} is missing ${expectedById.size} matching branch row(s)`);
      }

      await this.validateContentReferenceUnlocked(trial.promptArtifact, PROMPTS_DIR, "txt", trialId);
      promptPaths.add(trial.promptArtifact.path);
      if (trial.visibleResponseArtifact) {
        await this.validateContentReferenceUnlocked(
          trial.visibleResponseArtifact,
          RESPONSES_DIR,
          "json",
          trialId,
        );
        responsePaths.add(trial.visibleResponseArtifact.path);
      }
    }
    return { promptPaths, responsePaths };
  }

  private async collectPackageFilesUnlocked(): Promise<Array<{ path: string; absolute: string; sha256: string }>> {
    const referenced = await this.validateCompletedLogsUnlocked();
    for (const name of REQUIRED_ROOT_FILES) {
      if (!(await exists(this.file(name)))) throw new Error(`Cannot finalize: missing ${name}`);
    }
    for (const name of [PROMPTS_DIR, RESPONSES_DIR]) {
      const info = await stat(this.file(name)).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`Cannot finalize: missing ${name}/`);
    }

    const rows: Array<{ path: string; absolute: string; sha256: string }> = [];
    for (const absolute of await filesBelow(this.directory)) {
      const path = portablePath(relative(this.directory, absolute));
      if (path === CHECKSUM_FILE || path === LOCK_FILE) continue;
      const rootAllowed = (REQUIRED_ROOT_FILES as readonly string[]).includes(path);
      const prompt = /^prompts\/([a-f0-9]{64})\.txt$/.exec(path);
      const response = /^responses\/([a-f0-9]{64})\.json$/.exec(path);
      if (!rootAllowed && !prompt && !response) throw new Error(`Unexpected result-package file: ${path}`);
      if (prompt && !referenced.promptPaths.has(path)) {
        throw new Error(`Unreferenced prompt artifact: ${path}`);
      }
      if (response && !referenced.responsePaths.has(path)) {
        throw new Error(`Unreferenced visible-response artifact: ${path}`);
      }

      const contents = await readFile(absolute);
      const digest = sha256(contents);
      const addressedHash = prompt?.[1] ?? response?.[1];
      if (addressedHash && addressedHash !== digest) throw new Error(`Content hash collision at ${path}`);

      const text = contents.toString("utf8");
      if (path.endsWith(".jsonl")) assertJsonLines(text, path);
      else if (path === REPORT_FILE || prompt || response) assertSafeText(text, path);
      else {
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          throw new Error(`Invalid JSON artifact: ${path}`);
        }
        assertSafeStoredValue(value, path);
      }
      rows.push({ path, absolute, sha256: digest });
    }
    rows.sort((left, right) => compareCodePoints(left.path, right.path));
    return rows;
  }

  private async verifyFinalizedUnlocked(): Promise<ResearchPackageChecksum[]> {
    const checksumPath = this.file(CHECKSUM_FILE);
    if (!(await exists(checksumPath))) throw new Error(`Result package is not finalized: ${this.directory}`);
    const text = await readFile(checksumPath, "utf8");
    if (!text.endsWith("\n")) throw new Error(`${CHECKSUM_FILE} must end with a newline`);
    const listed: ResearchPackageChecksum[] = [];
    const seen = new Set<string>();
    for (const [index, line] of text.trimEnd().split("\n").entries()) {
      const match = /^([a-f0-9]{64})  ([^\\]+)$/.exec(line);
      if (!match?.[1] || !match[2]) throw new Error(`Invalid ${CHECKSUM_FILE} line ${index + 1}`);
      const path = match[2];
      if (path.startsWith("/") || path.split("/").includes("..") || seen.has(path)) {
        throw new Error(`Unsafe or duplicate checksum path: ${path}`);
      }
      seen.add(path);
      listed.push({ sha256: match[1], path });
    }

    const actual = await this.collectPackageFilesUnlocked();
    if (listed.length !== actual.length || listed.some((row, index) => row.path !== actual[index]?.path)) {
      throw new Error(`${CHECKSUM_FILE} does not exactly cover the result package`);
    }
    for (let index = 0; index < listed.length; index++) {
      const expected = listed[index]!;
      const observed = actual[index]!;
      if (expected.sha256 !== observed.sha256) throw new Error(`Checksum mismatch: ${expected.path}`);
    }
    return listed;
  }

  finalize(): Promise<FinalizedResearchPackage> {
    return this.serialized(() => this.withPackageLock(async () => {
      if (await exists(this.file(CHECKSUM_FILE))) {
        const entries = await this.verifyFinalizedUnlocked();
        return {
          directory: this.directory,
          checksumsPath: this.file(CHECKSUM_FILE),
          entries,
        };
      }
      await this.assertMutableUnlocked();
      const files = await this.collectPackageFilesUnlocked();
      const contents = `${files.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`;
      try {
        await atomicWriteExclusive(this.file(CHECKSUM_FILE), contents);
      } catch (error) {
        if (error instanceof AtomicTargetExistsError) throw new Error(`Result package is already finalized`);
        throw error;
      }
      const entries = await this.verifyFinalizedUnlocked();
      return {
        directory: this.directory,
        checksumsPath: this.file(CHECKSUM_FILE),
        entries,
      };
    }));
  }

  /** Validate completed JSONL rows and every content-addressed reference before analysis writes. */
  validateCompletedArtifacts(): Promise<void> {
    return this.serialized(() => this.withPackageLock(async () => {
      await this.validateCompletedLogsUnlocked();
    }));
  }

  verifyFinalized(): Promise<ResearchPackageChecksum[]> {
    return this.serialized(() => this.withPackageLock(() => this.verifyFinalizedUnlocked()));
  }
}
