/** Deterministic live-trial scheduling and per-provider first-attempt coordination. */
import { createHash } from "node:crypto";
import type { ResearchBenchmarkCellV2 } from "../benchmark.ts";

export const LIVE_RESEARCH_PROVIDER_IDS = ["google", "anthropic", "openai"] as const;
export const LIVE_RESEARCH_CELL_COUNT = 144;
export const LIVE_RESEARCH_REPLICATES = 5;

export type LiveResearchProviderId = typeof LIVE_RESEARCH_PROVIDER_IDS[number];
export type ResearchTrialPhase = "smoke" | "pilot";

/**
 * A deliberately context-free dispatch identity. The prompt and packet are rebuilt
 * from `cellId` for every call; conversation/session/history fields do not exist here.
 */
export interface ScheduledResearchTrialV1 {
  readonly schemaVersion: 1;
  readonly phase: ResearchTrialPhase;
  readonly scheduleIndex: number;
  readonly trialId: string;
  readonly providerId: LiveResearchProviderId;
  readonly cellId: string;
  readonly scenarioId: string;
  readonly replicate: number;
}

export interface LiveResearchScheduleV1 {
  readonly schemaVersion: 1;
  readonly artifactKind: "seed.research.live-schedule";
  /** The exact unsigned 32-bit seed used by Fisher-Yates. */
  readonly schedulerSeed: number;
  readonly providerIds: readonly LiveResearchProviderId[];
  readonly replicatesPerCell: typeof LIVE_RESEARCH_REPLICATES;
  readonly trials: readonly ScheduledResearchTrialV1[];
}

export interface ResearchSmokeCellSelection {
  readonly informingSignal: ResearchBenchmarkCellV2;
  readonly instrumentalSignal: ResearchBenchmarkCellV2;
  readonly negativeControl: ResearchBenchmarkCellV2;
}

export interface ResearchFirstAttempt<TResult> {
  readonly attemptNumber: 1;
  readonly trial: ScheduledResearchTrialV1;
  readonly result: TResult;
}

export interface ResearchFirstAttemptFailure {
  readonly attemptNumber: 1;
  readonly trial: ScheduledResearchTrialV1;
  readonly error: unknown;
}

export interface ResearchTrialCoordinatorResult<TResult> {
  /** Successful first attempts in original schedule order, not completion order. */
  readonly completed: readonly ResearchFirstAttempt<TResult>[];
  /** At most one failure per provider, also in original schedule order. */
  readonly failures: readonly ResearchFirstAttemptFailure[];
  /** Never dispatched because an earlier trial for the same provider failed. */
  readonly skipped: readonly ScheduledResearchTrialV1[];
}

type TrialDraft = Omit<ScheduledResearchTrialV1, "scheduleIndex">;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUint32(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Research scheduler seed must be an unsigned 32-bit integer");
  }
}

function nextUint32(seed: number): () => number {
  let state = seed >>> 0;
  // Mulberry32 is small, completely specified here, and has a useful non-degenerate seed zero.
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

function uniformIndex(next: () => number, upperExclusive: number): number {
  const uint32Range = 0x1_0000_0000;
  const limit = uint32Range - (uint32Range % upperExclusive);
  let value: number;
  do value = next(); while (value >= limit);
  return value % upperExclusive;
}

/** Seeded Fisher-Yates over a copy; input order and values are never mutated. */
export function deterministicResearchShuffle<T>(values: readonly T[], schedulerSeed: number): T[] {
  assertUint32(schedulerSeed);
  const shuffled = [...values];
  const next = nextUint32(schedulerSeed);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = uniformIndex(next, index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function validateCells(cells: readonly ResearchBenchmarkCellV2[], expectedCount: number): ResearchBenchmarkCellV2[] {
  if (cells.length !== expectedCount) {
    throw new Error(`Research schedule requires exactly ${expectedCount} unique cells; received ${cells.length}`);
  }
  const byCellId = new Map<string, ResearchBenchmarkCellV2>();
  for (const cell of cells) {
    if (!cell.cellId || !cell.scenario.id) throw new Error("Research schedule cells require stable IDs");
    if (byCellId.has(cell.cellId)) throw new Error(`Duplicate research schedule cellId: ${cell.cellId}`);
    byCellId.set(cell.cellId, cell);
  }
  return [...byCellId.values()].sort((left, right) => compareStrings(left.cellId, right.cellId));
}

export function researchTrialId(
  phase: ResearchTrialPhase,
  providerId: LiveResearchProviderId,
  cellId: string,
  replicate: number,
): string {
  const digest = createHash("sha256")
    .update("seed.research.trial.v1\0")
    .update(phase)
    .update("\0")
    .update(providerId)
    .update("\0")
    .update(cellId)
    .update("\0")
    .update(String(replicate))
    .digest("hex");
  return `trial-${digest}`;
}

function trialDraft(
  phase: ResearchTrialPhase,
  providerId: LiveResearchProviderId,
  cell: ResearchBenchmarkCellV2,
  replicate: number,
): TrialDraft {
  return {
    schemaVersion: 1,
    phase,
    trialId: researchTrialId(phase, providerId, cell.cellId, replicate),
    providerId,
    cellId: cell.cellId,
    scenarioId: cell.scenario.id,
    replicate,
  };
}

/** Build and randomize exactly 144 × 5 × 3 = 2,160 context-free pilot calls. */
export function createLiveResearchSchedule(
  cells: readonly ResearchBenchmarkCellV2[],
  schedulerSeed: number,
): LiveResearchScheduleV1 {
  assertUint32(schedulerSeed);
  const canonicalCells = validateCells(cells, LIVE_RESEARCH_CELL_COUNT);
  const drafts: TrialDraft[] = [];
  for (const providerId of LIVE_RESEARCH_PROVIDER_IDS) {
    for (const cell of canonicalCells) {
      for (let replicate = 1; replicate <= LIVE_RESEARCH_REPLICATES; replicate++) {
        drafts.push(trialDraft("pilot", providerId, cell, replicate));
      }
    }
  }
  const shuffled = deterministicResearchShuffle(drafts, schedulerSeed);
  const trials = shuffled.map((trial, scheduleIndex) => ({ ...trial, scheduleIndex }));
  if (new Set(trials.map((trial) => trial.trialId)).size !== trials.length) {
    throw new Error("Research trial identity collision");
  }
  return {
    schemaVersion: 1,
    artifactKind: "seed.research.live-schedule",
    schedulerSeed,
    providerIds: [...LIVE_RESEARCH_PROVIDER_IDS],
    replicatesPerCell: LIVE_RESEARCH_REPLICATES,
    trials,
  };
}

/** Resume without reshuffling: completed IDs are removed and original schedule indices survive. */
export function pendingLiveResearchTrials(
  trials: readonly ScheduledResearchTrialV1[],
  completedTrialIds: ReadonlySet<string>,
): ScheduledResearchTrialV1[] {
  return trials.filter((trial) => !completedTrialIds.has(trial.trialId));
}

/** Deterministically pick one cell for each preregistered smoke category. */
export function selectResearchSmokeCells(
  cells: readonly ResearchBenchmarkCellV2[],
): ResearchSmokeCellSelection {
  const canonical = validateCells(cells, LIVE_RESEARCH_CELL_COUNT);
  const find = (predicate: (cell: ResearchBenchmarkCellV2) => boolean, label: string): ResearchBenchmarkCellV2 => {
    const cell = canonical.find(predicate);
    if (!cell) throw new Error(`Research benchmark has no ${label} smoke cell`);
    return cell;
  };
  return {
    informingSignal: find(
      (cell) => cell.scenario.rowKind === "informing-opportunity" && cell.condition.asymmetry !== 0,
      "informing signal",
    ),
    instrumentalSignal: find(
      (cell) => cell.scenario.rowKind === "instrumental-opportunity",
      "instrumental signal",
    ),
    negativeControl: find(
      (cell) => cell.scenario.rowKind.endsWith("control"),
      "negative control",
    ),
  };
}

/** Build the fixed 3-category × 3-provider = 9-call smoke panel. */
export function createResearchSmokeTrials(
  cells: readonly ResearchBenchmarkCellV2[],
): ScheduledResearchTrialV1[] {
  const selected = selectResearchSmokeCells(cells);
  const smokeCells = [selected.informingSignal, selected.instrumentalSignal, selected.negativeControl];
  const drafts = smokeCells.flatMap((cell) =>
    LIVE_RESEARCH_PROVIDER_IDS.map((providerId) => trialDraft("smoke", providerId, cell, 1))
  );
  const trials = drafts.map((trial, scheduleIndex) => ({ ...trial, scheduleIndex }));
  if (new Set(trials.map((trial) => trial.trialId)).size !== 9) {
    throw new Error("Research smoke trial identity collision");
  }
  return trials;
}

function immutableTrial(trial: ScheduledResearchTrialV1): ScheduledResearchTrialV1 {
  return Object.freeze({ ...trial });
}

function validateCoordinatorTrials(trials: readonly ScheduledResearchTrialV1[]): ScheduledResearchTrialV1[] {
  const ids = new Set<string>();
  const indices = new Set<number>();
  const providerIds = new Set<string>(LIVE_RESEARCH_PROVIDER_IDS);
  const output = trials.map(immutableTrial);
  for (const trial of output) {
    if (ids.has(trial.trialId)) throw new Error(`Duplicate scheduled trialId: ${trial.trialId}`);
    if (!Number.isInteger(trial.scheduleIndex) || trial.scheduleIndex < 0 || indices.has(trial.scheduleIndex)) {
      throw new Error(`Invalid or duplicate research scheduleIndex: ${trial.scheduleIndex}`);
    }
    if (!providerIds.has(trial.providerId)) throw new Error(`Unknown live research provider: ${trial.providerId}`);
    ids.add(trial.trialId);
    indices.add(trial.scheduleIndex);
  }
  return output.sort((left, right) => left.scheduleIndex - right.scheduleIndex);
}

function assertReturnedTrialIdentity(result: unknown, trial: ScheduledResearchTrialV1): void {
  if (result === null || typeof result !== "object" || !("trialId" in result)) return;
  if ((result as { trialId?: unknown }).trialId !== trial.trialId) {
    throw new Error(`First-attempt result trialId does not match scheduled trial: ${trial.trialId}`);
  }
}

/**
 * Run one serial worker per provider. Workers progress independently; a thrown
 * callback stops only that provider and is recorded without a retry.
 */
export async function coordinateResearchTrials<TResult>(
  scheduledTrials: readonly ScheduledResearchTrialV1[],
  execute: (trial: ScheduledResearchTrialV1) => TResult | Promise<TResult>,
): Promise<ResearchTrialCoordinatorResult<TResult>> {
  const ordered = validateCoordinatorTrials(scheduledTrials);
  const completed: ResearchFirstAttempt<TResult>[] = [];
  const failures: ResearchFirstAttemptFailure[] = [];
  const skipped: ScheduledResearchTrialV1[] = [];

  await Promise.all(LIVE_RESEARCH_PROVIDER_IDS.map(async (providerId) => {
    const queue = ordered.filter((trial) => trial.providerId === providerId);
    for (let index = 0; index < queue.length; index++) {
      const trial = queue[index]!;
      try {
        const result = await execute(trial);
        assertReturnedTrialIdentity(result, trial);
        completed.push({ attemptNumber: 1, trial, result });
      } catch (error) {
        failures.push({ attemptNumber: 1, trial, error });
        skipped.push(...queue.slice(index + 1));
        break;
      }
    }
  }));

  const bySchedule = <T extends { trial: ScheduledResearchTrialV1 }>(left: T, right: T): number =>
    left.trial.scheduleIndex - right.trial.scheduleIndex;
  completed.sort(bySchedule);
  failures.sort(bySchedule);
  skipped.sort((left, right) => left.scheduleIndex - right.scheduleIndex);
  return { completed, failures, skipped };
}
