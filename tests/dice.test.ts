/**
 * Dice engine tests — also the proof that the toolchain runs.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { abilityModifier, mulberry32, roll, rollD20 } from "../src/rules/dice.ts";

describe("roll()", () => {
  test("parses NdM+K and sums correctly", () => {
    const r = roll("2d6+3", mulberry32(42));
    expect(r.rolls.length).toBe(2);
    expect(r.modifier).toBe(3);
    expect(r.total).toBe((r.rolls[0] ?? 0) + (r.rolls[1] ?? 0) + 3);
    for (const d of r.rolls) expect(d).toBeGreaterThanOrEqual(1);
    for (const d of r.rolls) expect(d).toBeLessThanOrEqual(6);
  });

  test("supports a bare dY", () => {
    const r = roll("d20", mulberry32(1));
    expect(r.rolls.length).toBe(1);
    expect(r.modifier).toBe(0);
  });

  test("rejects invalid notation", () => {
    expect(() => roll("banana")).toThrow();
    expect(() => roll("2x6")).toThrow();
  });

  test("a fixed seed is deterministic", () => {
    expect(roll("3d8+2", mulberry32(99)).total).toBe(roll("3d8+2", mulberry32(99)).total);
  });
});

describe("rollD20()", () => {
  test("advantage rolls two dice and keeps the higher", () => {
    const r = rollD20({ advantage: true, modifier: 2 }, mulberry32(7));
    expect(r.rolls.length).toBe(2);
    expect(r.picked).toBe(Math.max(...r.rolls));
    expect(r.total).toBe(r.picked + 2);
  });

  test("disadvantage keeps the lower", () => {
    const r = rollD20({ disadvantage: true }, mulberry32(7));
    expect(r.picked).toBe(Math.min(...r.rolls));
  });

  test("advantage + disadvantage cancel to a single die", () => {
    const r = rollD20({ advantage: true, disadvantage: true }, mulberry32(7));
    expect(r.rolls.length).toBe(1);
  });
});

describe("abilityModifier()", () => {
  test("matches the 5e table", () => {
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(14)).toBe(2);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(20)).toBe(5);
  });
});
