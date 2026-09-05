/** Decimal-safe projected and cumulative USD hard-cap enforcement. */

export type UsdInput = string | number;

export interface ResearchBudgetOptions {
  /** Defaults to USD 100. */
  capUsd?: UsdInput;
  /** Previously committed spend when resuming a run. */
  committedUsd?: UsdInput;
}

export interface ResearchBudgetReservation {
  reservationId: string;
  projectedUsd: string;
}

export interface ResearchBudgetSnapshot {
  capUsd: string;
  committedUsd: string;
  reservedUsd: string;
  availableUsd: string;
  reservationCount: number;
}

export const DEFAULT_RESEARCH_BUDGET_USD = "100";
const USD_SCALE = 1_000_000_000n;

export class ResearchBudgetExceededError extends Error {
  override readonly name = "ResearchBudgetExceededError";
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Convert decimal USD to integer nano-USD without binary floating-point arithmetic. */
function parseUsd(value: UsdInput, label: string): bigint {
  if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  const text = String(value).trim();
  const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match?.[1]) throw new RangeError(`${label} must be a non-negative decimal USD amount`);
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new RangeError(`${label} exponent is out of range`);
  }

  const digits = `${match[1]}${fraction}`.replace(/^0+(?=\d)/, "");
  const decimalPlaces = fraction.length - exponent;
  const scalePlaces = 9;
  if (decimalPlaces <= scalePlaces) {
    return BigInt(digits) * powerOfTen(scalePlaces - decimalPlaces);
  }

  const excess = decimalPlaces - scalePlaces;
  const split = digits.length - excess;
  const kept = split > 0 ? digits.slice(0, split) : "0";
  const discarded = split > 0 ? digits.slice(split) : `${"0".repeat(-split)}${digits}`;
  if (/[^0]/.test(discarded)) {
    throw new RangeError(`${label} has precision smaller than one nano-USD`);
  }
  return BigInt(kept);
}

function formatUsd(units: bigint): string {
  const whole = units / USD_SCALE;
  const fraction = (units % USD_SCALE).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Normalize a supported USD input to its canonical exact decimal representation. */
export function normalizeUsd(value: UsdInput): string {
  return formatUsd(parseUsd(value, "USD amount"));
}

/** Sum safe decimal USD values without binary floating-point arithmetic. */
export function sumUsd(values: readonly UsdInput[]): string {
  return formatUsd(values.reduce((sum, value) => sum + parseUsd(value, "USD amount"), 0n));
}

/** Exact ordering for supported USD inputs without converting through binary floating point. */
export function compareUsd(left: UsdInput, right: UsdInput): -1 | 0 | 1 {
  const leftUnits = parseUsd(left, "Left USD amount");
  const rightUnits = parseUsd(right, "Right USD amount");
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

/**
 * In-memory hard-cap ledger. Call `reserve` before dispatching any provider request;
 * a rejected reservation is the fail-closed boundary and authorizes no request.
 */
export class ResearchBudget {
  private readonly cap: bigint;
  private committed: bigint;
  private readonly reservations = new Map<string, bigint>();
  private readonly recoveredDispatches = new Set<string>();

  constructor(options: ResearchBudgetOptions = {}) {
    this.cap = parseUsd(options.capUsd ?? DEFAULT_RESEARCH_BUDGET_USD, "Budget cap");
    this.committed = parseUsd(options.committedUsd ?? "0", "Committed spend");
  }

  private reservedTotal(exceptId?: string): bigint {
    let total = 0n;
    for (const [id, amount] of this.reservations) if (id !== exceptId) total += amount;
    return total;
  }

  snapshot(): ResearchBudgetSnapshot {
    const reserved = this.reservedTotal();
    return {
      capUsd: formatUsd(this.cap),
      committedUsd: formatUsd(this.committed),
      reservedUsd: formatUsd(reserved),
      availableUsd: formatUsd(this.cap > this.committed + reserved ? this.cap - this.committed - reserved : 0n),
      reservationCount: this.reservations.size,
    };
  }

  reserve(reservationId: string, projectedUsd: UsdInput): ResearchBudgetReservation {
    if (typeof reservationId !== "string" || reservationId.length === 0) {
      throw new Error("Budget reservationId must be non-empty");
    }
    if (this.reservations.has(reservationId)) throw new Error(`Budget reservation already exists: ${reservationId}`);
    const projected = parseUsd(projectedUsd, "Projected spend");
    const total = this.committed + this.reservedTotal() + projected;
    if (total > this.cap) {
      throw new ResearchBudgetExceededError(
        `Projected spend would exceed the USD ${formatUsd(this.cap)} research hard cap`,
      );
    }
    this.reservations.set(reservationId, projected);
    return { reservationId, projectedUsd: formatUsd(projected) };
  }

  /** Commit actual billed cost and release any unused part of its projection. */
  commit(reservationId: string, actualUsd: UsdInput): ResearchBudgetSnapshot {
    const projected = this.reservations.get(reservationId);
    if (projected === undefined) throw new Error(`Unknown budget reservation: ${reservationId}`);
    const actual = parseUsd(actualUsd, "Actual spend");
    if (actual > projected) {
      throw new ResearchBudgetExceededError(
        `Actual spend USD ${formatUsd(actual)} exceeds reserved USD ${formatUsd(projected)}`,
      );
    }
    if (this.committed + this.reservedTotal(reservationId) + actual > this.cap) {
      throw new ResearchBudgetExceededError("Cumulative spend would exceed the research hard cap");
    }
    this.reservations.delete(reservationId);
    this.committed += actual;
    return this.snapshot();
  }

  /**
   * Record safe usage reported after an already-dispatched request, even if the provider exceeds
   * its conservative reservation. This never authorizes another request: subsequent reservations
   * still fail at or above the cap, and the phase gate reports the observed overage.
   */
  commitObserved(reservationId: string, actualUsd: UsdInput): ResearchBudgetSnapshot {
    if (!this.reservations.has(reservationId)) throw new Error(`Unknown budget reservation: ${reservationId}`);
    const actual = parseUsd(actualUsd, "Actual observed spend");
    this.reservations.delete(reservationId);
    this.committed += actual;
    return this.snapshot();
  }

  /**
   * Record the conservative cost of a request that a prior process durably marked as dispatched.
   * This is accounting for already-incurred exposure, not authorization for a new request, so it
   * remains valid when another observed overage has already exhausted the cap.
   */
  recordPreviouslyDispatched(dispatchId: string, actualUsd: UsdInput): ResearchBudgetSnapshot {
    if (typeof dispatchId !== "string" || dispatchId.length === 0) {
      throw new Error("Previously dispatched request id must be non-empty");
    }
    if (this.reservations.has(dispatchId)) {
      throw new Error(`Previously dispatched request still has a budget reservation: ${dispatchId}`);
    }
    if (this.recoveredDispatches.has(dispatchId)) {
      throw new Error(`Previously dispatched request was already recorded: ${dispatchId}`);
    }
    const actual = parseUsd(actualUsd, "Previously dispatched spend");
    this.recoveredDispatches.add(dispatchId);
    this.committed += actual;
    return this.snapshot();
  }

  /** Release a reservation after a request is cancelled before billable completion. */
  release(reservationId: string): ResearchBudgetSnapshot {
    if (!this.reservations.delete(reservationId)) throw new Error(`Unknown budget reservation: ${reservationId}`);
    return this.snapshot();
  }

  hasReservation(reservationId: string): boolean {
    return this.reservations.has(reservationId);
  }
}
