import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  expandResearchBenchmarkCells,
  loadResearchBenchmarkV2FromDir,
  type ResearchBenchmarkCellV2,
} from "../src/research/benchmark.ts";
import {
  LIVE_RESEARCH_PROVIDER_IDS,
  coordinateResearchTrials,
  createLiveResearchSchedule,
  createResearchSmokeTrials,
  pendingLiveResearchTrials,
  selectResearchSmokeCells,
  type LiveResearchProviderId,
  type ScheduledResearchTrialV1,
} from "../src/research/live/scheduler.ts";

const DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));
let cells: ResearchBenchmarkCellV2[];

beforeAll(async () => {
  cells = expandResearchBenchmarkCells(await loadResearchBenchmarkV2FromDir(DIR));
});

function callsPerProvider(trials: readonly ScheduledResearchTrialV1[], count: number): ScheduledResearchTrialV1[] {
  return LIVE_RESEARCH_PROVIDER_IDS.flatMap((providerId) =>
    trials.filter((trial) => trial.providerId === providerId).slice(0, count)
  );
}

describe("live research scheduler", () => {
  test("builds a deterministic randomized 2,160-call schedule with context-free unique identities", () => {
    const first = createLiveResearchSchedule(cells, 0x1234_5678);
    const second = createLiveResearchSchedule([...cells].reverse(), 0x1234_5678);
    expect(first).toEqual(second);
    expect(first.schedulerSeed).toBe(0x1234_5678);
    expect(first.trials).toHaveLength(144 * 5 * 3);
    expect(new Set(first.trials.map((trial) => trial.trialId)).size).toBe(2160);
    expect(new Set(first.trials.slice(0, 24).map((trial) => trial.providerId)).size).toBe(3);

    for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) {
      const providerTrials = first.trials.filter((trial) => trial.providerId === providerId);
      expect(providerTrials).toHaveLength(144 * 5);
      expect(new Set(providerTrials.map((trial) => `${trial.cellId}:${trial.replicate}`)).size).toBe(144 * 5);
    }
    for (const [index, trial] of first.trials.entries()) {
      expect(trial.scheduleIndex).toBe(index);
      expect(Object.keys(trial).sort()).toEqual([
        "cellId",
        "phase",
        "providerId",
        "replicate",
        "scenarioId",
        "scheduleIndex",
        "schemaVersion",
        "trialId",
      ]);
    }
  });

  test("changes only full order when the recorded uint32 seed changes", () => {
    const first = createLiveResearchSchedule(cells, 1);
    const second = createLiveResearchSchedule(cells, 2);
    expect(first.trials.map((trial) => trial.trialId)).not.toEqual(second.trials.map((trial) => trial.trialId));
    expect([...first.trials.map((trial) => trial.trialId)].sort())
      .toEqual([...second.trials.map((trial) => trial.trialId)].sort());
    expect(() => createLiveResearchSchedule(cells, -1)).toThrow(/unsigned 32-bit/);
    expect(() => createLiveResearchSchedule(cells, 0x1_0000_0000)).toThrow(/unsigned 32-bit/);
  });

  test("filters completed trial IDs without reshuffling the resume order", () => {
    const schedule = createLiveResearchSchedule(cells, 77);
    const completed = new Set(schedule.trials.filter((_, index) => index % 4 === 0).map((trial) => trial.trialId));
    const pending = pendingLiveResearchTrials(schedule.trials, completed);
    expect(pending).toEqual(schedule.trials.filter((trial) => !completed.has(trial.trialId)));
    expect(pending.every((trial, index) => index === 0 || trial.scheduleIndex > pending[index - 1]!.scheduleIndex))
      .toBe(true);
    expect(pendingLiveResearchTrials(schedule.trials, completed)).toEqual(pending);
  });

  test("selects three representative smoke cells and expands them to nine unique provider calls", () => {
    const selected = selectResearchSmokeCells(cells);
    expect(selected.informingSignal.scenario.rowKind).toBe("informing-opportunity");
    expect(selected.informingSignal.condition.asymmetry).not.toBe(0);
    expect(selected.instrumentalSignal.scenario.rowKind).toBe("instrumental-opportunity");
    expect(selected.negativeControl.scenario.rowKind.endsWith("control")).toBe(true);
    expect(selectResearchSmokeCells([...cells].reverse())).toEqual(selected);

    const smoke = createResearchSmokeTrials(cells);
    expect(smoke).toHaveLength(9);
    expect(new Set(smoke.map((trial) => trial.trialId)).size).toBe(9);
    expect(new Set(smoke.map((trial) => trial.cellId))).toEqual(new Set([
      selected.informingSignal.cellId,
      selected.instrumentalSignal.cellId,
      selected.negativeControl.cellId,
    ]));
    for (const cellId of new Set(smoke.map((trial) => trial.cellId))) {
      expect(new Set(smoke.filter((trial) => trial.cellId === cellId).map((trial) => trial.providerId)))
        .toEqual(new Set(LIVE_RESEARCH_PROVIDER_IDS));
    }
  });

  test("allows providers to progress independently with at most one in-flight call each", async () => {
    const trials = callsPerProvider(createLiveResearchSchedule(cells, 19).trials, 3);
    const active = new Map<LiveResearchProviderId, number>();
    const maximum = new Map<LiveResearchProviderId, number>();
    const callCount = new Map<string, number>();
    const firstProviders = new Set<LiveResearchProviderId>();
    let activeTotal = 0;
    let maximumTotal = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const result = await coordinateResearchTrials(trials, async (trial) => {
      callCount.set(trial.trialId, (callCount.get(trial.trialId) ?? 0) + 1);
      const nowActive = (active.get(trial.providerId) ?? 0) + 1;
      active.set(trial.providerId, nowActive);
      maximum.set(trial.providerId, Math.max(maximum.get(trial.providerId) ?? 0, nowActive));
      activeTotal++;
      maximumTotal = Math.max(maximumTotal, activeTotal);
      firstProviders.add(trial.providerId);
      if (firstProviders.size === LIVE_RESEARCH_PROVIDER_IDS.length) openGate();
      try {
        await gate;
        await Promise.resolve();
        return { trialId: trial.trialId };
      } finally {
        active.set(trial.providerId, (active.get(trial.providerId) ?? 1) - 1);
        activeTotal--;
      }
    });

    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.completed).toHaveLength(9);
    expect([...callCount.values()]).toEqual(Array(9).fill(1));
    expect(maximumTotal).toBe(3);
    for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) expect(maximum.get(providerId)).toBe(1);
    const resultOrder = result.completed.map((attempt) => attempt.trial.scheduleIndex);
    expect(resultOrder).toEqual([...resultOrder].sort((left, right) => left - right));
    expect(result.completed.every((attempt) => attempt.attemptNumber === 1 &&
      attempt.result.trialId === attempt.trial.trialId)).toBe(true);
  });

  test("does not retry a failed callback and stops only that provider's later dispatches", async () => {
    const trials = callsPerProvider(createLiveResearchSchedule(cells, 23).trials, 3);
    const anthropic = trials.filter((trial) => trial.providerId === "anthropic");
    const failing = anthropic[1]!;
    const skipped = anthropic[2]!;
    const callCount = new Map<string, number>();
    const result = await coordinateResearchTrials(trials, async (trial) => {
      callCount.set(trial.trialId, (callCount.get(trial.trialId) ?? 0) + 1);
      if (trial.trialId === failing.trialId) throw new Error("first attempt failed");
      await Promise.resolve();
      return { trialId: trial.trialId };
    });

    expect(callCount.get(failing.trialId)).toBe(1);
    expect(callCount.has(skipped.trialId)).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.trial.trialId).toBe(failing.trialId);
    expect(result.skipped.map((trial) => trial.trialId)).toEqual([skipped.trialId]);
    expect(result.completed).toHaveLength(7);
    for (const providerId of ["google", "openai"] as const) {
      expect(trials.filter((trial) => trial.providerId === providerId)
        .every((trial) => callCount.get(trial.trialId) === 1)).toBe(true);
    }
  });
});
