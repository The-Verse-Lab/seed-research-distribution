/** Safe, content-addressed records written to the immutable live result package. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  LiveTrialResultV1Schema,
  ResearchBranchResultV2Schema,
  type LiveTrialResultV1,
} from "../contracts.ts";
import type { ContentAddressedArtifact } from "./artifact-store.ts";
import type { ResearchTrialPhase } from "./scheduler.ts";

export const ContentAddressedArtifactSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().regex(/^(?:prompts\/[a-f0-9]{64}\.txt|responses\/[a-f0-9]{64}\.json)$/),
  bytes: z.number().int().nonnegative(),
}).strict();

export const StoredLiveTrialV1Schema = LiveTrialResultV1Schema.extend({
  phase: z.enum(["smoke", "pilot"]),
  scheduleIndex: z.number().int().nonnegative(),
  promptArtifact: ContentAddressedArtifactSchema,
  visibleResponseArtifact: ContentAddressedArtifactSchema.optional(),
  costUsd: z.string().regex(/^\d+(?:\.\d{1,9})?$/),
  costBasis: z.enum(["reported-usage", "projected-upper-bound"]),
}).strict();

export const StoredBranchResultV1Schema = ResearchBranchResultV2Schema.extend({
  schemaVersion: z.literal(1),
  artifactKind: z.literal("seed.research.stored-branch-result"),
  branchResultId: z.string().regex(/^branch-[a-f0-9]{64}$/),
  trialId: z.string().min(1),
  role: z.enum(["chosen", "forced-silence"]),
  seedIndex: z.number().int().min(0).max(4),
}).strict();

export type StoredLiveTrialV1 = z.infer<typeof StoredLiveTrialV1Schema>;
export type StoredBranchResultV1 = z.infer<typeof StoredBranchResultV1Schema>;

export function toStoredLiveTrial(options: {
  trial: LiveTrialResultV1;
  phase: ResearchTrialPhase;
  scheduleIndex: number;
  promptArtifact: ContentAddressedArtifact;
  visibleResponseArtifact?: ContentAddressedArtifact;
  costUsd: string;
  costBasis: "reported-usage" | "projected-upper-bound";
}): StoredLiveTrialV1 {
  const trial = structuredClone(options.trial);
  // The exact bytes live in responses/<sha>.json; do not duplicate them in the JSONL record.
  delete trial.modelAttempt.visibleOutput;
  return StoredLiveTrialV1Schema.parse({
    ...trial,
    phase: options.phase,
    scheduleIndex: options.scheduleIndex,
    promptArtifact: options.promptArtifact,
    ...(options.visibleResponseArtifact ? { visibleResponseArtifact: options.visibleResponseArtifact } : {}),
    costUsd: options.costUsd,
    costBasis: options.costBasis,
  });
}

function branchResultId(trialId: string, role: string, seedIndex: number): string {
  return `branch-${createHash("sha256")
    .update("seed.research.stored-branch.v1\0")
    .update(trialId)
    .update("\0")
    .update(role)
    .update("\0")
    .update(String(seedIndex))
    .digest("hex")}`;
}

export function storedBranchResults(trial: LiveTrialResultV1): StoredBranchResultV1[] {
  const output: StoredBranchResultV1[] = [];
  for (const [role, branches] of [
    ["chosen", trial.chosenBranches],
    ["forced-silence", trial.silenceBranches],
  ] as const) {
    branches.forEach((branch, seedIndex) => output.push(StoredBranchResultV1Schema.parse({
      ...branch,
      schemaVersion: 1,
      artifactKind: "seed.research.stored-branch-result",
      branchResultId: branchResultId(trial.trialId, role, seedIndex),
      trialId: trial.trialId,
      role,
      seedIndex,
    })));
  }
  return output;
}

export function parseStoredLiveTrialsJsonl(contents: string): StoredLiveTrialV1[] {
  if (contents && !contents.endsWith("\n")) throw new Error("Truncated live-trials JSONL");
  const trials = contents.split("\n").filter(Boolean).map((line, index) => {
    try {
      return StoredLiveTrialV1Schema.parse(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`Invalid stored live trial at line ${index + 1}`, { cause: error });
    }
  });
  if (new Set(trials.map((trial) => trial.trialId)).size !== trials.length) {
    throw new Error("Duplicate completed trialId in live-trials JSONL");
  }
  return trials;
}

export async function readStoredLiveTrials(path: string): Promise<StoredLiveTrialV1[]> {
  return parseStoredLiveTrialsJsonl(await readFile(path, "utf8"));
}
