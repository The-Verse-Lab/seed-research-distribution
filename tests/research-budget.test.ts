import { describe, expect, test } from "bun:test";
import {
  ResearchBudget,
  ResearchBudgetExceededError,
  normalizeUsd,
  sumUsd,
} from "../src/research/live/budget.ts";

describe("ResearchBudget", () => {
  test("uses exact decimal accounting across reservation, commit, and release", () => {
    const budget = new ResearchBudget({ capUsd: 0.3 });
    expect(budget.reserve("request-a", 0.1)).toEqual({ reservationId: "request-a", projectedUsd: "0.1" });
    expect(budget.reserve("request-b", 0.2)).toEqual({ reservationId: "request-b", projectedUsd: "0.2" });
    expect(budget.snapshot()).toMatchObject({
      capUsd: "0.3",
      committedUsd: "0",
      reservedUsd: "0.3",
      availableUsd: "0",
      reservationCount: 2,
    });
    expect(() => budget.reserve("one-nano-too-many", "0.000000001")).toThrow(ResearchBudgetExceededError);

    expect(budget.commit("request-a", "0.08")).toMatchObject({
      committedUsd: "0.08",
      reservedUsd: "0.2",
      availableUsd: "0.02",
    });
    expect(budget.release("request-b")).toMatchObject({
      committedUsd: "0.08",
      reservedUsd: "0",
      availableUsd: "0.22",
    });
  });

  test("defaults to USD 100 and enforces cumulative resumed spend", () => {
    const budget = new ResearchBudget({ committedUsd: "99.999999999" });
    expect(budget.snapshot().capUsd).toBe("100");
    budget.reserve("last-nano", "0.000000001");
    expect(budget.commit("last-nano", "0.000000001")).toMatchObject({
      committedUsd: "100",
      availableUsd: "0",
    });
    expect(() => budget.reserve("over-cap", "0.000000001")).toThrow(ResearchBudgetExceededError);
    const observedOverage = new ResearchBudget({ capUsd: "1", committedUsd: "1.000000001" });
    expect(observedOverage.snapshot()).toMatchObject({ committedUsd: "1.000000001", availableUsd: "0" });
    expect(() => observedOverage.reserve("blocked", "0")).toThrow(ResearchBudgetExceededError);
  });

  test("fails closed before dispatch and keeps an under-reserved request uncommitted", () => {
    const budget = new ResearchBudget({ capUsd: "1" });
    budget.reserve("first", "0.75");
    let dispatched = false;
    try {
      budget.reserve("blocked", "0.250000001");
      dispatched = true;
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchBudgetExceededError);
    }
    expect(dispatched).toBe(false);

    expect(() => budget.commit("first", "0.750000001")).toThrow(ResearchBudgetExceededError);
    expect(budget.hasReservation("first")).toBe(true);
    expect(budget.snapshot().committedUsd).toBe("0");
    expect(budget.commit("first", "0.7")).toMatchObject({ committedUsd: "0.7", availableUsd: "0.3" });
    expect(() => budget.commit("missing", "0")).toThrow(/Unknown budget reservation/);
  });

  test("rejects negative, non-finite, and sub-nano USD inputs", () => {
    expect(normalizeUsd("1.230000000")).toBe("1.23");
    expect(normalizeUsd("1e-3")).toBe("0.001");
    expect(() => normalizeUsd("-0.01")).toThrow(/non-negative decimal/);
    expect(() => normalizeUsd(Number.NaN)).toThrow(/finite/);
    expect(() => normalizeUsd("0.0000000001")).toThrow(/nano-USD/);
    expect(sumUsd(["0.1", "0.02", "0.003"])).toBe("0.123");
  });

  test("records a post-dispatch provider overage without authorizing another request", () => {
    const budget = new ResearchBudget({ capUsd: "1" });
    budget.reserve("first", "0.75");
    expect(budget.commitObserved("first", "0.8")).toMatchObject({ committedUsd: "0.8", availableUsd: "0.2" });
    budget.reserve("second", "0.2");
    expect(budget.commitObserved("second", "0.25")).toMatchObject({
      committedUsd: "1.05",
      reservedUsd: "0",
      availableUsd: "0",
    });
    expect(() => budget.reserve("blocked", "0")).toThrow(ResearchBudgetExceededError);
  });

  test("accounts for a previously dispatched request after the cap is exhausted", () => {
    const budget = new ResearchBudget({ capUsd: "1", committedUsd: "1.05" });
    expect(budget.recordPreviouslyDispatched("crash-marker", "0.02")).toMatchObject({
      committedUsd: "1.07",
      reservedUsd: "0",
      availableUsd: "0",
    });
    expect(() => budget.recordPreviouslyDispatched("crash-marker", "0.02")).toThrow(/already recorded/);
    expect(() => budget.reserve("new-request", "0")).toThrow(ResearchBudgetExceededError);
  });
});
