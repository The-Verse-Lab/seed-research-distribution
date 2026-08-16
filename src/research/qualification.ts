/** Deterministic oracle qualification for all Benchmark v2 cells, branches, and mechanics seeds. */
import {
  OracleQualificationV2Schema,
  type OracleQualificationV2,
  type ResearchBranchResultV2,
} from "./contracts.ts";
import {
  candidateCommand,
  expandResearchBenchmarkCells,
  scenarioSetup,
  type LoadedResearchBenchmarkV2,
  type ResearchBenchmarkCellV2,
  type ResearchScenarioV2,
} from "./benchmark.ts";
import { ResearchWorldExecutor } from "./world/executor.ts";

export type ResearchQualificationBranch = "candidate" | "silence";

function expectedClass(cell: ResearchBenchmarkCellV2): "signal" | "noise" {
  if (cell.scenario.rowKind.endsWith("control")) return "noise";
  if (cell.scenario.modality === "instrumental") return "signal";
  return cell.condition.asymmetry === 0 ? "noise" : "signal";
}

function taskSucceeded(executor: ResearchWorldExecutor, scenario: ResearchScenarioV2): boolean {
  const state = executor.snapshot();
  return state.quests[scenario.task.questId] === "complete" &&
    state.objectives[scenario.task.questId]?.[scenario.task.objectiveId] === true;
}

export function executeResearchBranch(
  loaded: LoadedResearchBenchmarkV2,
  cell: ResearchBenchmarkCellV2,
  mechanicsSeed: number,
  branch: ResearchQualificationBranch,
): ResearchBranchResultV2 {
  const executor = new ResearchWorldExecutor(loaded.definition, {
    setup: scenarioSetup(cell.scenario, cell.condition.asymmetry, mechanicsSeed),
  });
  const startClock = executor.snapshot().clock;
  let groundingAccepted = true;
  let status: ResearchBranchResultV2["status"] = "completed";
  let failureReason: string | undefined;

  if (branch === "candidate") {
    const grounded = executor.execute(candidateCommand(cell.scenario));
    groundingAccepted = grounded.accepted;
    if (!grounded.accepted) {
      status = "structural-censor";
      failureReason = `candidate:${grounded.reasonCode ?? "rejected"}`;
    }
  }

  if (status !== "structural-censor") {
    for (const [index, step] of cell.scenario.suffixSteps.entries()) {
      try {
        const result = step.kind === "move"
          ? executor.moveParty(step.to)
          : executor.resolveCase({
              caseId: step.caseId,
              suspectId: step.suspectId,
              citedEvidenceFactIds: step.citedEvidenceFactIds,
            });
        if (result.accepted) continue;
        status = step.expectedTaskStop ? "expected-task-stop" : "structural-censor";
        failureReason = `suffix[${index}]:${result.reasonCode ?? "rejected"}`;
        break;
      } catch (error) {
        status = "structural-censor";
        failureReason = `suffix[${index}]:executor:${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
  }

  executor.assertReplayInvariant();
  const end = executor.snapshot();
  return {
    mechanicsSeed,
    branch,
    status,
    taskSuccess: taskSucceeded(executor, cell.scenario),
    groundingAccepted,
    endStateHash: executor.stateHash(),
    cost: {
      clockMinutes: end.clock - startClock,
      interventionBurden: branch === "candidate" ? 1 : 0,
    },
    ...(failureReason ? { failureReason } : {}),
  };
}

function mechanicsProjection(result: ResearchBranchResultV2): unknown {
  return {
    mechanicsSeed: result.mechanicsSeed,
    branch: result.branch,
    status: result.status,
    taskSuccess: result.taskSuccess,
    groundingAccepted: result.groundingAccepted,
    endStateHash: result.endStateHash,
    cost: result.cost,
    failureReason: result.failureReason,
  };
}

/** Executes exactly 24 × 6 × 2 × 5 = 1,440 local, model-free branches. */
export function qualifyResearchBenchmarkV2(
  loaded: LoadedResearchBenchmarkV2,
  generatedAtValue: string,
): OracleQualificationV2 {
  const generatedAt = new Date(generatedAtValue);
  if (!Number.isFinite(generatedAt.valueOf())) throw new Error("Qualification generatedAt must be an ISO timestamp");
  const failures: string[] = [];
  const cells = expandResearchBenchmarkCells(loaded).map((cell) => {
    const seeds = loaded.manifest.seedPanels[cell.scenario.family]!;
    const branches = seeds.flatMap((seed) => [
      executeResearchBranch(loaded, cell, seed, "candidate"),
      executeResearchBranch(loaded, cell, seed, "silence"),
    ]);
    const candidate = branches.filter((branch) => branch.branch === "candidate");
    const silence = branches.filter((branch) => branch.branch === "silence");
    const structural = branches.filter((branch) => branch.status === "structural-censor");
    if (structural.length > 0) failures.push(`${cell.cellId}: ${structural.length} structural censors`);
    if (candidate.some((branch) => !branch.groundingAccepted)) {
      failures.push(`${cell.cellId}: candidate grounding rejected`);
    }

    const signal = candidate.every((branch) => branch.taskSuccess) && silence.every((branch) => !branch.taskSuccess);
    const noChange = candidate.every((branch, index) => branch.taskSuccess === silence[index]!.taskSuccess);
    const stableLabel = signal ? "signal" as const : noChange ? "noise" as const : null;
    if (!stableLabel) failures.push(`${cell.cellId}: mixed-sign or unstable task-success label`);
    const preregistered = expectedClass(cell);
    if (stableLabel && stableLabel !== preregistered) {
      failures.push(`${cell.cellId}: qualified ${stableLabel}, expected ${preregistered}`);
    }
    if (cell.scenario.rowKind.endsWith("control") && branches.some((branch) => !branch.taskSuccess)) {
      failures.push(`${cell.cellId}: control branch did not succeed`);
    }
    return {
      cellId: cell.cellId,
      scenarioId: cell.scenario.id,
      family: cell.scenario.family,
      modality: cell.scenario.modality,
      expectedClass: preregistered,
      condition: structuredClone(cell.condition),
      stableLabel: stableLabel ?? preregistered,
      branches,
    };
  });

  const byCondition = new Map(cells.map((cell) => [cell.cellId, cell] as const));
  for (const cell of cells.filter((row) => row.condition.incentive === "cooperative")) {
    const mixedId = cell.cellId.replace("incentive=cooperative", "incentive=mixed");
    const mixed = byCondition.get(mixedId);
    if (!mixed) {
      failures.push(`${cell.cellId}: missing mixed-incentive mechanics pair`);
      continue;
    }
    const left = JSON.stringify(cell.branches.map(mechanicsProjection));
    const right = JSON.stringify(mixed.branches.map(mechanicsProjection));
    if (left !== right) failures.push(`${cell.scenarioId}: mechanics differ by incentive`);
  }

  return OracleQualificationV2Schema.parse({
    schemaVersion: 2,
    artifactKind: "seed.research.oracle-qualification",
    suiteHash: loaded.suiteHash,
    generatedAt: generatedAt.toISOString(),
    executionCount: 1440,
    qualified: failures.length === 0,
    failures,
    cells,
  });
}
