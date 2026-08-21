import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { LiveTrialResultV1 } from "../src/research/contracts.ts";
import { ResearchArtifactStoreV1 } from "../src/research/live/artifact-store.ts";
import { storedBranchResults, toStoredLiveTrial } from "../src/research/live/records.ts";

function digest(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

const DEAD_PID = 2_147_483_647;

function atomicTempName(targetName: string, discriminator: number): string {
  const tail = discriminator.toString(16).padStart(12, "0");
  return `.${targetName}.tmp-${DEAD_PID}-00000000-0000-4000-8000-${tail}`;
}

async function populate(store: ResearchArtifactStoreV1, includeDerived = true): Promise<void> {
  await store.writeManifest({
    artifactKind: "seed.research.live-manifest",
    schemaVersion: 1,
    providers: [{ provider: "openai", model: "test-model", apiKeyEnv: "OPENAI_API_KEY" }],
  });
  await store.writeOracleQualification({
    artifactKind: "seed.research.oracle-qualification",
    schemaVersion: 2,
    executionCount: 1440,
    qualified: true,
  });
  const prompt = await store.storePrompt("Choose exactly one listed candidate or abstain.\n");
  const visibleOutput = '{"decision":{"choice":"abstain"}}';
  const response = await store.storeVisibleResponse(visibleOutput);
  const branch = (mechanicsSeed: number) => ({
    mechanicsSeed,
    branch: "silence" as const,
    status: "completed" as const,
    taskSuccess: true,
    groundingAccepted: true,
    endStateHash: "a".repeat(64),
    cost: { clockMinutes: 1, interventionBurden: 0 },
  });
  const trial: LiveTrialResultV1 = {
    schemaVersion: 1,
    artifactKind: "seed.research.live-trial",
    trialId: "trial-1",
    cellId: "cell-1",
    scenarioId: "scenario-1",
    family: "family-1",
    modality: "informing",
    expectedClass: "noise",
    condition: { asymmetry: 0, incentive: "cooperative" },
    replicate: 1,
    modelAttempt: {
      schemaVersion: 1,
      attemptId: "trial-1::attempt=1",
      provider: "openai",
      configuredModel: "test-model",
      returnedModel: "test-model",
      status: "valid",
      latencyMs: 1,
      requestId: "request-1",
      visibleOutput,
      parsedDecision: { choice: "abstain" },
      usage: { inputTokens: 10, outputTokens: 2 },
    },
    parsedChoice: { choice: "abstain" },
    grounding: { accepted: true },
    chosenBranches: [1, 2, 3, 4, 5].map(branch),
    silenceBranches: [1, 2, 3, 4, 5].map(branch),
    taskSuccessRate: 1,
    regret: 0,
  };
  const stored = toStoredLiveTrial({
    trial,
    phase: "smoke",
    scheduleIndex: 0,
    promptArtifact: prompt,
    visibleResponseArtifact: response,
    costUsd: "0.001",
    costBasis: "reported-usage",
  });
  await store.appendCompletedTrial(stored, storedBranchResults(stored));
  if (includeDerived) {
    await store.writeAnalysis({
      artifactKind: "seed.research.analysis",
      schemaVersion: 1,
      confusion: { hits: 0, misses: 1, falseAlarms: 0, correctRejections: 1 },
    });
    await store.writeReport("# Research report\n\nOne completed safe trial.\n");
  }
}

describe("ResearchArtifactStoreV1", () => {
  test("reconciles genuine stale atomic temp files under the package lock", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-atomic-temp-recovery-"));
    try {
      const directory = join(scratch, "package");
      const store = await ResearchArtifactStoreV1.open(directory);
      const manifest = { schemaVersion: 1, artifactKind: "seed.research.live-manifest" };
      await store.writeManifest(manifest);

      // Simulate all relevant hard-kill windows: after publication (same
      // inode), before publication, inside a content directory, and while
      // publishing the package lock itself.
      const publishedTemp = join(directory, atomicTempName("manifest.json", 1));
      const unpublishedTemp = join(directory, atomicTempName("oracle-qualification.json", 2));
      const promptTemp = join(
        directory,
        "prompts",
        atomicTempName(`${"a".repeat(64)}.txt`, 3),
      );
      const lockTemp = join(directory, atomicTempName(".artifact-store.lock", 4));
      const dispatchDirectory = join(directory, ".provider-dispatch-intents");
      const dispatchTemp = join(
        dispatchDirectory,
        atomicTempName(`${"b".repeat(64)}.json`, 5),
      );
      await link(join(directory, "manifest.json"), publishedTemp);
      await writeFile(unpublishedTemp, "partially synced qualification bytes", "utf8");
      await writeFile(promptTemp, "partially synced prompt bytes", "utf8");
      await writeFile(lockTemp, `${DEAD_PID}\npartial-owner`, "utf8");
      await mkdir(dispatchDirectory);
      await writeFile(dispatchTemp, "partially synced dispatch intent", "utf8");

      const reopened = await ResearchArtifactStoreV1.open(directory);
      for (const temp of [publishedTemp, unpublishedTemp, promptTemp, lockTemp, dispatchTemp]) {
        await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(lstat(dispatchDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))).toEqual(manifest);
      await reopened.writeOracleQualification({
        schemaVersion: 2,
        artifactKind: "seed.research.oracle-qualification",
        executionCount: 1440,
        qualified: true,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("retains arbitrary temp-like files for package validation to reject", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-arbitrary-temp-file-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      const arbitrary = join(store.directory, `.manifest.json.tmp-${DEAD_PID}-not-a-generated-uuid`);
      await writeFile(arbitrary, "arbitrary user bytes", "utf8");
      await populate(store);

      await expect(store.finalize()).rejects.toThrow(/Unexpected result-package file/);
      expect(await readFile(arbitrary, "utf8")).toBe("arbitrary user bytes");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("retains and rejects conflicting or symlinked generated temp names", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-conflicting-temp-file-"));
    try {
      const conflictDirectory = join(scratch, "conflict");
      const conflictStore = await ResearchArtifactStoreV1.open(conflictDirectory);
      await conflictStore.writeManifest({ schemaVersion: 1, artifactKind: "published-manifest" });
      const conflictingTemp = join(conflictDirectory, atomicTempName("manifest.json", 6));
      await writeFile(conflictingTemp, '{"artifactKind":"different-manifest"}\n', "utf8");

      await expect(ResearchArtifactStoreV1.open(conflictDirectory))
        .rejects.toThrow(/conflicts with its published target/);
      expect(await readFile(conflictingTemp, "utf8")).toBe('{"artifactKind":"different-manifest"}\n');

      const symlinkDirectory = join(scratch, "symlink");
      await ResearchArtifactStoreV1.open(symlinkDirectory);
      const external = join(scratch, "external-user-file");
      const symlinkedTemp = join(symlinkDirectory, atomicTempName("oracle-qualification.json", 7));
      await writeFile(external, "external user bytes", "utf8");
      await symlink(external, symlinkedTemp);

      await expect(ResearchArtifactStoreV1.open(symlinkDirectory))
        .rejects.toThrow(/not a safe regular file/);
      expect((await lstat(symlinkedTemp)).isSymbolicLink()).toBe(true);
      expect(await readFile(external, "utf8")).toBe("external user bytes");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("finalizes a complete package with deterministic, verified checksums", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-artifacts-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      await populate(store);
      const finalized = await store.finalize();
      await store.validateCompletedArtifacts();
      const verified = await store.verifyFinalized();
      expect(verified).toEqual(finalized.entries);

      const checksumText = await readFile(finalized.checksumsPath, "utf8");
      const lines = checksumText.trim().split("\n");
      const paths = lines.map((line) => line.slice(66));
      expect(paths).toEqual([...paths].sort());
      expect(paths).toEqual(expect.arrayContaining([
        "manifest.json",
        "oracle-qualification.json",
        "live-trials.jsonl",
        "branch-results.jsonl",
        "analysis.json",
        "REPORT.md",
      ]));
      for (const line of lines) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line)!;
        expect(digest(await readFile(join(finalized.directory, match[2]!)))).toBe(match[1]!);
      }

      await expect(store.appendLiveTrial({ trialId: "trial-2", status: "valid" })).rejects.toThrow(/finalized/);
      await expect(store.appendCompletedTrial(
        { trialId: "trial-2", status: "valid" },
        [{ branchResultId: "trial-2:branch", trialId: "trial-2" }],
      )).rejects.toThrow(/finalized/);
      await expect(store.beginProviderDispatch({ trialId: "trial-2", providerId: "openai" }))
        .rejects.toThrow(/finalized/);
      await writeFile(join(finalized.directory, "REPORT.md"), "tampered\n", "utf8");
      await expect(store.verifyFinalized()).rejects.toThrow(/Checksum mismatch/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("durably records at most one unresolved first dispatch per provider and blocks finalization", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-provider-dispatch-"));
    try {
      const directory = join(scratch, "package");
      const store = await ResearchArtifactStoreV1.open(directory);
      const google = {
        trialId: "trial-google",
        providerId: "google",
        cellId: "cell-1",
        promptRef: { sha256: "a".repeat(64), path: `prompts/${"a".repeat(64)}.txt` },
        projectedUsd: "0.01",
      };
      await store.beginProviderDispatch(google);
      expect(await store.pendingProviderDispatches()).toEqual([google]);
      await expect(store.beginProviderDispatch(google)).rejects.toThrow(/Provider already has/);
      await expect(store.beginProviderDispatch({ trialId: "trial-google-2", providerId: "google" }))
        .rejects.toThrow(/Provider already has/);
      await expect(store.beginProviderDispatch({ trialId: "trial-google", providerId: "other" }))
        .rejects.toThrow(/Trial already has/);
      await expect(store.beginProviderDispatch({
        trialId: "unsafe",
        providerId: "unsafe-provider",
        providerEnvelope: { raw: true },
      })).rejects.toThrow(/Unsafe stored key/);

      await store.beginProviderDispatch({ trialId: "trial-openai", providerId: "openai" });
      await store.beginProviderDispatch({ trialId: "trial-anthropic", providerId: "anthropic" });
      await expect(store.beginProviderDispatch({ trialId: "trial-fourth", providerId: "fourth" }))
        .rejects.toThrow(/At most 3/);
      expect((await store.pendingProviderDispatches()).map((intent) => intent.providerId))
        .toEqual(["anthropic", "google", "openai"]);
      await expect(store.finalize()).rejects.toThrow(/unresolved provider dispatch/);

      const reopened = await ResearchArtifactStoreV1.open(directory);
      expect(await reopened.pendingProviderDispatches()).toEqual(await store.pendingProviderDispatches());
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("clears a matching dispatch only after durable completion and reconciles the final crash window", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-provider-commit-window-"));
    try {
      const normalDirectory = join(scratch, "normal");
      const normal = await ResearchArtifactStoreV1.open(normalDirectory);
      await normal.beginProviderDispatch({ trialId: "trial-normal", providerId: "openai", projectedUsd: "0.02" });
      await normal.appendCompletedTrial(
        { trialId: "trial-normal", providerId: "openai", status: "valid" },
        [{ branchResultId: "trial-normal:branch", trialId: "trial-normal" }],
      );
      expect(await normal.pendingProviderDispatches()).toEqual([]);
      await expect(readdir(join(normalDirectory, ".provider-dispatch-intents"))).rejects.toMatchObject({ code: "ENOENT" });

      const crashDirectory = join(scratch, "crash-after-commit");
      const interrupted = await ResearchArtifactStoreV1.open(crashDirectory, {
        onCompletedTrialProgress(progress) {
          if (progress.stage === "commit-synced") throw new Error("simulated post-commit crash");
        },
      });
      await interrupted.beginProviderDispatch({
        trialId: "trial-crash",
        providerId: "anthropic",
        projectedUsd: "0.03",
      });
      await expect(interrupted.appendCompletedTrial(
        { trialId: "trial-crash", providerId: "anthropic", status: "valid" },
        [{ branchResultId: "trial-crash:branch", trialId: "trial-crash" }],
      )).rejects.toThrow("simulated post-commit crash");
      expect(await readdir(join(crashDirectory, ".provider-dispatch-intents"))).toHaveLength(1);
      await expect(readFile(join(crashDirectory, ".completed-trial-intent.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      const recovered = await ResearchArtifactStoreV1.open(crashDirectory);
      expect(await recovered.completedTrialIds()).toEqual(new Set(["trial-crash"]));
      expect(await recovered.pendingProviderDispatches()).toEqual([]);
      await expect(readdir(join(crashDirectory, ".provider-dispatch-intents")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("recovers an interrupted completed-trial intent at every durable append boundary", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-transaction-recovery-"));
    const cases = [
      { name: "zero-branches", stop: (stage: string, count: number) => stage === "intent-synced" && count === 0 },
      { name: "some-branches", stop: (stage: string, count: number) => stage === "branch-synced" && count === 1 },
      { name: "all-branches", stop: (stage: string, count: number) => stage === "branch-synced" && count === 3 },
      { name: "after-live", stop: (stage: string) => stage === "trial-synced" },
    ];
    try {
      for (const crashCase of cases) {
        const directory = join(scratch, crashCase.name);
        const interrupted = await ResearchArtifactStoreV1.open(directory, {
          onCompletedTrialProgress(progress) {
            if (crashCase.stop(progress.stage, progress.branchRowsPresent)) throw new Error("simulated crash");
          },
        });
        const trial = { trialId: `trial-${crashCase.name}`, status: "valid", responseHash: "a".repeat(64) };
        const branches = Array.from({ length: 3 }, (_, index) => ({
          branchResultId: `${trial.trialId}:branch:${index}`,
          trialId: trial.trialId,
          mechanicsSeed: index,
          branch: index % 2 === 0 ? "candidate" : "silence",
        }));
        await interrupted.beginProviderDispatch({ trialId: trial.trialId, providerId: "test-provider" });
        await expect(interrupted.appendCompletedTrial(trial, branches)).rejects.toThrow("simulated crash");
        await expect(interrupted.finalize()).rejects.toThrow(/unresolved completed-trial intent/);

        const recovered = await ResearchArtifactStoreV1.open(directory);
        expect(await recovered.completedTrialIds()).toEqual(new Set([trial.trialId]));
        expect(await recovered.pendingProviderDispatches()).toEqual([]);
        const storedTrials = (await readFile(join(directory, "live-trials.jsonl"), "utf8")).trim().split("\n");
        const storedBranches = (await readFile(join(directory, "branch-results.jsonl"), "utf8")).trim().split("\n");
        expect(storedTrials).toHaveLength(1);
        expect(storedBranches).toHaveLength(3);
        expect(new Set(storedBranches.map((line) => JSON.parse(line).branchResultId)).size).toBe(3);
        await expect(readFile(join(directory, ".completed-trial-intent.json"), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
        await expect(recovered.appendCompletedTrial(trial, branches)).rejects.toThrow(/completed trialId/);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("repairs only an exact torn suffix identified by the durable completed-trial intent", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-torn-append-recovery-"));
    const trial = { trialId: "trial-torn", status: "valid", responseHash: "a".repeat(64) };
    const branches = Array.from({ length: 3 }, (_, index) => ({
      branchResultId: `${trial.trialId}:branch:${index}`,
      trialId: trial.trialId,
      mechanicsSeed: index,
      branch: index % 2 === 0 ? "candidate" : "silence",
    }));
    try {
      const baseline = await ResearchArtifactStoreV1.open(join(scratch, "baseline"));
      await baseline.appendCompletedTrial(trial, branches);
      const intendedTrialBytes = await readFile(join(baseline.directory, "live-trials.jsonl"), "utf8");
      const intendedBranchBytes = await readFile(join(baseline.directory, "branch-results.jsonl"), "utf8");
      const firstBranchLine = `${intendedBranchBytes.split("\n")[0]}\n`;

      const branchDirectory = join(scratch, "branch-tail");
      const branchInterrupted = await ResearchArtifactStoreV1.open(branchDirectory, {
        onCompletedTrialProgress(progress) {
          if (progress.stage === "intent-synced") throw new Error("simulated pre-branch crash");
        },
      });
      await expect(branchInterrupted.appendCompletedTrial(trial, branches))
        .rejects.toThrow("simulated pre-branch crash");
      await appendFile(
        join(branchDirectory, "branch-results.jsonl"),
        firstBranchLine.slice(0, Math.floor(firstBranchLine.length / 2)),
        "utf8",
      );
      const branchRecovered = await ResearchArtifactStoreV1.open(branchDirectory);
      expect(await branchRecovered.completedTrialIds()).toEqual(new Set([trial.trialId]));
      expect(await readFile(join(branchDirectory, "branch-results.jsonl"), "utf8")).toBe(intendedBranchBytes);
      expect(await readFile(join(branchDirectory, "live-trials.jsonl"), "utf8")).toBe(intendedTrialBytes);

      const trialDirectory = join(scratch, "trial-tail");
      const trialInterrupted = await ResearchArtifactStoreV1.open(trialDirectory, {
        onCompletedTrialProgress(progress) {
          if (progress.stage === "branch-synced" && progress.branchRowsPresent === branches.length) {
            throw new Error("simulated pre-trial crash");
          }
        },
      });
      await expect(trialInterrupted.appendCompletedTrial(trial, branches))
        .rejects.toThrow("simulated pre-trial crash");
      // This is complete JSON but lacks the final JSONL newline, the last possible
      // tear boundary of the exact journaled append.
      await appendFile(join(trialDirectory, "live-trials.jsonl"), intendedTrialBytes.slice(0, -1), "utf8");
      const trialRecovered = await ResearchArtifactStoreV1.open(trialDirectory);
      expect(await trialRecovered.completedTrialIds()).toEqual(new Set([trial.trialId]));
      expect(await readFile(join(trialDirectory, "branch-results.jsonl"), "utf8")).toBe(intendedBranchBytes);
      expect(await readFile(join(trialDirectory, "live-trials.jsonl"), "utf8")).toBe(intendedTrialBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("retains and rejects an arbitrary or complete conflicting non-newline suffix", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-torn-append-conflict-"));
    try {
      const directory = join(scratch, "package");
      const interrupted = await ResearchArtifactStoreV1.open(directory, {
        onCompletedTrialProgress(progress) {
          if (progress.stage === "intent-synced") throw new Error("simulated crash");
        },
      });
      const trial = { trialId: "trial-intended", status: "valid" };
      const branches = [{
        branchResultId: "branch-intended",
        trialId: trial.trialId,
        taskSuccess: true,
      }];
      await expect(interrupted.appendCompletedTrial(trial, branches)).rejects.toThrow("simulated crash");
      const branchPath = join(directory, "branch-results.jsonl");
      const conflictingCompleteRow = JSON.stringify({
        branchResultId: "branch-conflicting",
        trialId: "trial-conflicting",
        taskSuccess: false,
      });
      await appendFile(branchPath, conflictingCompleteRow, "utf8");
      const bytesBeforeRecovery = await readFile(branchPath);

      await expect(ResearchArtifactStoreV1.open(directory))
        .rejects.toThrow(/Truncated JSONL artifact does not match the journaled append/);
      expect(await readFile(branchPath)).toEqual(bytesBeforeRecovery);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects mismatched, duplicate, reused, and conflicting completed-trial identities", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-transaction-conflicts-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      await expect(store.appendCompletedTrial(
        { trialId: "trial-a", status: "valid" },
        [{ branchResultId: "branch-a", trialId: "trial-b" }],
      )).rejects.toThrow(/mismatched trialId/);
      await expect(store.appendCompletedTrial(
        { trialId: "trial-a", status: "valid" },
        [
          { branchResultId: "branch-a", trialId: "trial-a" },
          { branchResultId: "branch-a", trialId: "trial-a" },
        ],
      )).rejects.toThrow(/Duplicate branchResultId/);

      await store.appendCompletedTrial(
        { trialId: "trial-a", status: "valid" },
        [{ branchResultId: "branch-a", trialId: "trial-a", taskSuccess: true }],
      );
      await expect(store.appendCompletedTrial(
        { trialId: "trial-a", status: "replacement" },
        [{ branchResultId: "branch-a-new", trialId: "trial-a" }],
      )).rejects.toThrow(/completed trialId/);
      await expect(store.appendCompletedTrial(
        { trialId: "trial-b", status: "valid" },
        [{ branchResultId: "branch-a", trialId: "trial-b", taskSuccess: false }],
      )).rejects.toThrow(/branchResultId already exists/);
      expect((await readFile(join(store.directory, "live-trials.jsonl"), "utf8")).trim().split("\n"))
        .toHaveLength(1);
      expect((await readFile(join(store.directory, "branch-results.jsonl"), "utf8")).trim().split("\n"))
        .toHaveLength(1);

      const recoveryDirectory = join(scratch, "recovery-conflict");
      const interrupted = await ResearchArtifactStoreV1.open(recoveryDirectory, {
        onCompletedTrialProgress(progress) {
          if (progress.stage === "intent-synced") throw new Error("simulated crash");
        },
      });
      const recoveryTrial = { trialId: "trial-recovery", status: "valid" };
      const recoveryBranches = [{
        branchResultId: "branch-recovery",
        trialId: recoveryTrial.trialId,
        taskSuccess: true,
      }];
      await expect(interrupted.appendCompletedTrial(recoveryTrial, recoveryBranches)).rejects.toThrow("simulated crash");
      await appendFile(join(recoveryDirectory, "branch-results.jsonl"), `${JSON.stringify({
        branchResultId: "branch-recovery",
        trialId: recoveryTrial.trialId,
        taskSuccess: false,
      })}\n`, "utf8");
      await expect(ResearchArtifactStoreV1.open(recoveryDirectory)).rejects.toThrow(/conflicting branch recovery/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("refuses overwrites, resumes completed IDs, and detects content hash collisions", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-resume-"));
    try {
      const directory = join(scratch, "package");
      const store = await ResearchArtifactStoreV1.open(directory);
      await store.writeManifest({ schemaVersion: 1, artifactKind: "manifest" });
      await expect(store.writeManifest({ schemaVersion: 1, artifactKind: "replacement" }))
        .rejects.toThrow(/Refusing to overwrite/);

      const promptText = "Exact safe prompt bytes.\n";
      const first = await store.storePrompt(promptText);
      expect(await store.storePrompt(promptText)).toEqual(first);
      expect(await readFile(join(directory, first.path), "utf8")).toBe(promptText);

      await store.appendLiveTrial({ trialId: "completed-1", status: "valid" });
      const resumed = await ResearchArtifactStoreV1.open(directory);
      expect(await resumed.completedTrialIds()).toEqual(new Set(["completed-1"]));
      expect(await resumed.hasCompletedTrial("completed-1")).toBe(true);
      await expect(resumed.appendLiveTrial({ trialId: "completed-1", status: "valid" }))
        .rejects.toThrow(/completed trialId/);

      const collisionDirectory = join(scratch, "collision");
      const collisionStore = await ResearchArtifactStoreV1.open(collisionDirectory);
      const intended = "content whose digest names the path";
      const hash = digest(intended);
      await mkdir(join(collisionDirectory, "prompts"), { recursive: true });
      await writeFile(join(collisionDirectory, "prompts", `${hash}.txt`), "different bytes", "utf8");
      await expect(collisionStore.storePrompt(intended)).rejects.toThrow(/Content hash collision/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects credentials, private reasoning, and generic envelopes but preserves safe exact bytes", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-safety-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      await expect(store.writeManifest({ apiKey: "sk-ant-this-must-never-be-stored" }))
        .rejects.toThrow(/Unsafe stored key/);
      await expect(store.writeManifest({ openaiApiKey: "short" }))
        .rejects.toThrow(/Unsafe stored key/);
      await expect(store.writeManifest({ authorizationHeader: "opaque" }))
        .rejects.toThrow(/Unsafe stored key/);
      await expect(store.writeManifest({ providerEnvelope: { id: "raw-provider-object" } }))
        .rejects.toThrow(/Unsafe stored key/);
      await expect(store.appendLiveTrial({ trialId: "bad", reasoning: "private deliberation" }))
        .rejects.toThrow(/Unsafe stored key/);
      await expect(store.storePrompt("Authorization: Bearer abcdefghijklmnop"))
        .rejects.toThrow(/bearer credential|authorization value/);
      await expect(store.storePrompt("Bearer x"))
        .rejects.toThrow(/bearer credential/);
      await expect(store.storeVisibleResponse('{"choice":"abstain","authorization":"Bearer abcdefghijklmnop"}'))
        .rejects.toThrow(/dangerous embedded field|Unsafe stored key|bearer credential/);

      const prompt = "Use only this public packet.\n{\"candidateId\":\"candidate-1\"}\n";
      const visible = '{"choice":"intervene","candidateId":"candidate-1"}\n';
      const promptRef = await store.storePrompt(prompt);
      const visibleRef = await store.storeVisibleResponse(visible);
      expect(await readFile(join(store.directory, promptRef.path), "utf8")).toBe(prompt);
      expect(await readFile(join(store.directory, visibleRef.path), "utf8")).toBe(visible);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects missing blobs, altered branch rows, and unreferenced content before checksumming", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-reference-integrity-"));
    try {
      const missing = await ResearchArtifactStoreV1.open(join(scratch, "missing"));
      await populate(missing);
      const missingTrials = JSON.parse((await readFile(join(missing.directory, "live-trials.jsonl"), "utf8")).trim());
      await unlink(join(missing.directory, missingTrials.promptArtifact.path));
      await expect(missing.finalize()).rejects.toThrow(/Missing referenced prompts artifact/);

      const altered = await ResearchArtifactStoreV1.open(join(scratch, "altered"));
      await populate(altered);
      const branchPath = join(altered.directory, "branch-results.jsonl");
      const rows = (await readFile(branchPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      rows[0].taskSuccess = false;
      await writeFile(branchPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      await expect(altered.finalize()).rejects.toThrow(/does not match its live trial/);

      const orphan = await ResearchArtifactStoreV1.open(join(scratch, "orphan"));
      await populate(orphan);
      await orphan.storePrompt("Unreferenced but otherwise safe prompt bytes.\n");
      await expect(orphan.finalize()).rejects.toThrow(/Unreferenced prompt artifact/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("resumes deterministic finalization writes but never replaces different bytes", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-finalization-resume-"));
    try {
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      await populate(store, false);
      const analysis = { schemaVersion: 1, artifactKind: "seed.research.analysis", status: "partial" };
      await store.writeAnalysis(analysis);
      await store.writeAnalysis(structuredClone(analysis));
      await expect(store.writeAnalysis({ ...analysis, status: "different" })).rejects.toThrow(/overwrite/);
      const report = "# Deterministic report\n";
      await store.writeReport(report);
      await store.writeReport(report);
      await expect(store.writeReport(`${report}\nchanged\n`)).rejects.toThrow(/overwrite/);
      expect(await store.finalize()).toMatchObject({ directory: store.directory });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
