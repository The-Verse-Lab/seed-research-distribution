/** Offline analysis, gate evaluation, and immutable finalization for one live phase package. */
import { join } from "node:path";
import { analyzeResearchTrials } from "../analysis.ts";
import type { LoadedResearchBenchmarkV2 } from "../benchmark.ts";
import {
  OracleQualificationV2Schema,
  type OracleQualificationV2,
  type ResearchAnalysisV1,
} from "../contracts.ts";
import { renderResearchReport } from "../report.ts";
import { assertCurrentOracleQualification } from "../qualification.ts";
import { hashResearchValue } from "../world/state.ts";
import {
  ResearchArtifactStoreV1,
  type FinalizedResearchPackage,
} from "./artifact-store.ts";
import { ResearchBudget, sumUsd, type ResearchBudgetSnapshot } from "./budget.ts";
import {
  assertResearchPhaseTrialIntegrity,
  evaluatePilotGate,
  evaluateSmokeGate,
  type ResearchGateResult,
} from "./gates.ts";
import { ResearchRunManifestV1Schema, type ResearchRunManifestV1 } from "./manifest.ts";
import {
  assertStoredResearchContentIntegrity,
  assertStoredResearchCostAccounting,
} from "./integrity.ts";
import { readStoredLiveTrials, type StoredLiveTrialV1 } from "./records.ts";
import type { ResearchTrialPhase } from "./scheduler.ts";

export interface FinalizeResearchLivePackageOptions {
  store: ResearchArtifactStoreV1;
  loaded: LoadedResearchBenchmarkV2;
  manifest: ResearchRunManifestV1;
  qualification: OracleQualificationV2;
  phase: ResearchTrialPhase;
}

export interface FinalizedResearchLivePackage {
  package: FinalizedResearchPackage;
  trials: StoredLiveTrialV1[];
  analysis: ResearchAnalysisV1;
  gate: ResearchGateResult;
  budget: ResearchBudgetSnapshot;
}

function replayBudget(manifest: ResearchRunManifestV1, trials: readonly StoredLiveTrialV1[]): ResearchBudgetSnapshot {
  return new ResearchBudget({
    capUsd: manifest.budget.hardCapUsd,
    committedUsd: sumUsd([
      manifest.budget.priorCommittedUsd,
      ...trials.map((trial) => trial.costUsd),
    ]),
  }).snapshot();
}

/**
 * Analyze only stored public-safe observations, render the engineering report, and freeze the
 * package. Failed and even zero-call pilots are finalized rather than retried or rewritten.
 */
export async function finalizeResearchLivePackage(
  options: FinalizeResearchLivePackageOptions,
): Promise<FinalizedResearchLivePackage> {
  const manifest = ResearchRunManifestV1Schema.parse(options.manifest);
  const qualification = assertCurrentOracleQualification(
    options.loaded,
    OracleQualificationV2Schema.parse(options.qualification),
  );
  if (manifest.source.suiteHash !== qualification.suiteHash ||
    manifest.source.qualificationHash !== hashResearchValue(qualification)) {
    throw new Error("Finalization manifest does not match the oracle qualification");
  }

  // Validate all append-only rows and content references before publishing any derived output.
  await options.store.validateCompletedArtifacts();
  const trials = await readStoredLiveTrials(join(options.store.directory, "live-trials.jsonl"));
  if (trials.some((trial) => trial.phase !== options.phase)) {
    throw new Error("A result package may contain only one live research phase");
  }
  assertResearchPhaseTrialIntegrity({
    trials,
    qualification,
    manifest,
    phase: options.phase,
  });
  await assertStoredResearchCostAccounting(options.store, trials);
  await assertStoredResearchContentIntegrity(options.store, options.loaded, trials);
  const budget = replayBudget(manifest, trials);
  const analysis = analyzeResearchTrials(trials, {
    generatedAt: manifest.generatedAt,
    bootstrapSeed: manifest.design.bootstrapSeed,
    bootstrapResamples: manifest.design.bootstrapResamples,
  });
  const gate = options.phase === "smoke"
    ? evaluateSmokeGate({ trials, qualification, budget })
    : evaluatePilotGate({ trials, analysis, qualification, budget });
  const report = renderResearchReport({
    phase: options.phase,
    analysis,
    gate,
    suiteHash: manifest.source.suiteHash,
    qualificationExecutionCount: qualification.executionCount,
    committedUsd: budget.committedUsd,
  });
  await options.store.writeAnalysis(analysis);
  await options.store.writeReport(report);
  const finalized = await options.store.finalize();
  return { package: finalized, trials, analysis, gate, budget };
}
