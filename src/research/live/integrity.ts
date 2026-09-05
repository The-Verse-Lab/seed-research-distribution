/** Semantic validation shared by resume, finalization, and smoke authorization. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildResearchDecisionPacket,
  expandResearchBenchmarkCells,
  type LoadedResearchBenchmarkV2,
} from "../benchmark.ts";
import { renderResearchPrompt } from "../prompt.ts";
import { parseVisibleResearchDecision } from "../providers/shared.ts";
import { canonicalResearchJson } from "../world/state.ts";
import type { ResearchArtifactStoreV1 } from "./artifact-store.ts";
import {
  calculateActualResearchCost,
  projectResearchCallCost,
  ResearchPricingProviderSchema,
} from "./pricing.ts";
import type { StoredLiveTrialV1 } from "./records.ts";
import { normalizeUsd } from "./budget.ts";

function sameOptionalJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalResearchJson(left) === canonicalResearchJson(right);
}

export async function assertStoredResearchCostAccounting(
  store: ResearchArtifactStoreV1,
  trials: readonly StoredLiveTrialV1[],
): Promise<void> {
  for (const trial of trials) {
    const provider = ResearchPricingProviderSchema.parse(trial.modelAttempt.provider);
    const expected = trial.modelAttempt.usage
      ? calculateActualResearchCost(provider, trial.modelAttempt.usage).totalCostUsd
      : projectResearchCallCost(
          provider,
          await readFile(join(store.directory, trial.promptArtifact.path), "utf8"),
        ).totalCostUsd;
    if (normalizeUsd(trial.costUsd) !== normalizeUsd(expected)) {
      throw new Error(`Stored trial cost does not match its safe accounting basis: ${trial.trialId}`);
    }
  }
}

/**
 * Bind every stored prompt to the current public packet and every parse-derived attempt to the
 * exact retained visible JSON. Content-address verification is performed separately by the store.
 */
export async function assertStoredResearchContentIntegrity(
  store: ResearchArtifactStoreV1,
  loaded: LoadedResearchBenchmarkV2,
  trials: readonly StoredLiveTrialV1[],
): Promise<void> {
  const cells = new Map(expandResearchBenchmarkCells(loaded).map((cell) => [cell.cellId, cell] as const));
  for (const trial of trials) {
    const cell = cells.get(trial.cellId);
    if (!cell) throw new Error(`Stored trial references an unknown benchmark cell: ${trial.trialId}`);
    const packet = buildResearchDecisionPacket(loaded, cell);
    const expectedPrompt = renderResearchPrompt(packet);
    const storedPrompt = await readFile(join(store.directory, trial.promptArtifact.path), "utf8");
    if (storedPrompt !== expectedPrompt) {
      throw new Error(`Stored prompt differs from the frozen public packet: ${trial.trialId}`);
    }

    const parseDerived = trial.modelAttempt.status === "valid" ||
      trial.modelAttempt.status === "invalid-json" ||
      trial.modelAttempt.status === "invalid-schema";
    if (!trial.visibleResponseArtifact) {
      if (parseDerived) throw new Error(`Parse-derived attempt is missing visible response bytes: ${trial.trialId}`);
      continue;
    }
    if (!parseDerived) continue;

    const visible = await readFile(join(store.directory, trial.visibleResponseArtifact.path), "utf8");
    const parsed = parseVisibleResearchDecision(
      visible,
      new Set(packet.candidates.map((candidate) => candidate.candidateId)),
    );
    if (parsed.status !== trial.modelAttempt.status ||
      !sameOptionalJson(parsed.parsedDecision, trial.modelAttempt.parsedDecision) ||
      parsed.errorClass !== trial.modelAttempt.errorClass) {
      throw new Error(`Stored visible response does not reproduce its parsed attempt: ${trial.trialId}`);
    }
  }
}
