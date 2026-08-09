/**
 * Exhaustion — long-horizon attrition layered over short-term energy.
 *
 * Energy stays the short pool. When it is pushed past empty, the engine raises this persistent
 * ladder and refills energy only to the reduced working cap. Tables live here so checks, combat,
 * rest, UI, and narration read one set of numbers.
 *
 * @author Runkai Zhang
 */
import type { EntityStats } from "../world/entity.ts";

export const EXHAUSTION_MAX = 6;
export const PROVISIONS_ITEM_ID = "item.rations";

export const EXHAUSTION_LABELS = [
  "",
  "Winded",
  "Weary",
  "Fatigued",
  "Spent",
  "Failing",
  "Collapse",
] as const;

export const EXHAUSTION_DESCRIPTORS = [
  "",
  "winded, breath quick",
  "weary, muscles heavy",
  "fatigued, hands unsteady",
  "spent, vision graying",
  "failing, near collapse",
  "collapsed, world gone dark",
] as const;

const CHECK_DC_ADJUSTMENTS = [0, 0, 2, 0, 2, 4, 0] as const;
const CHECK_DISADVANTAGE = [false, false, false, true, true, true, true] as const;
const ATTACK_TO_HIT_ADJUSTMENTS = [0, 0, 0, -2, -4, -4, 0] as const;
const ATTACK_DISADVANTAGE = [false, false, false, false, false, true, true] as const;
const WORKING_CAP_FACTORS = [1, 0.9, 0.8, 0.65, 0.5, 0.35, 0] as const;
const MOVE_FACTORS = [1, 1, 1, 1.25, 1.5, 2, 2] as const;

function levelOf(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(EXHAUSTION_MAX, Math.trunc(level)));
}

export function exhaustionOf(stats: Pick<EntityStats, "exhaustion"> | undefined): number {
  return levelOf(stats?.exhaustion ?? 0);
}

export function exhaustionLabel(level: number): string {
  return EXHAUSTION_LABELS[levelOf(level)] ?? "";
}

export function exhaustionDescriptor(level: number): string {
  return EXHAUSTION_DESCRIPTORS[levelOf(level)] ?? "";
}

export interface ExhaustionCheckMods {
  dcAdjustment: number;
  disadvantage: boolean;
}

export function exhaustionCheckMods(level: number): ExhaustionCheckMods {
  const l = levelOf(level);
  return {
    dcAdjustment: CHECK_DC_ADJUSTMENTS[l] ?? 0,
    disadvantage: CHECK_DISADVANTAGE[l] ?? false,
  };
}

export interface ExhaustionAttackMods {
  toHit: number;
  disadvantage: boolean;
}

export function exhaustionAttackMods(level: number): ExhaustionAttackMods {
  const l = levelOf(level);
  return {
    toHit: ATTACK_TO_HIT_ADJUSTMENTS[l] ?? 0,
    disadvantage: ATTACK_DISADVANTAGE[l] ?? false,
  };
}

export function exhaustionCapFactor(level: number): number {
  return WORKING_CAP_FACTORS[levelOf(level)] ?? 1;
}

export function exhaustionMoveFactor(level: number): number {
  return MOVE_FACTORS[levelOf(level)] ?? 1;
}

export function workingCap(level: number, maxEnergy: number): number {
  return Math.max(0, Math.floor(maxEnergy * exhaustionCapFactor(level)));
}
