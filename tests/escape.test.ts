/**
 * Disengage mechanics — the pure core of r11 F-5 (the price of walking out of a live fight, and
 * what becomes of the ally left in it). No engine, no model: the numbers are code's.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  allyFateSummary,
  escapeAbility,
  escapeDc,
  resolveAllyFate,
  ESCAPE_DC_MAX,
  ESCAPE_DC_MIN,
  type EscapeFoe,
} from "../src/rules/escape.ts";

const foe = (level: number, name = `foe${level}`): EscapeFoe => ({ id: name, name, level });

describe("escapeDc", () => {
  test("a lone level-1 foe is a DC a level-1 PC usually beats — the point is the ROLL, not a refusal", () => {
    expect(escapeDc([foe(1)])).toBe(9);
  });

  test("a circle is harder to leave than a duel", () => {
    expect(escapeDc([foe(1), foe(1)])).toBe(10);
    expect(escapeDc([foe(1), foe(1), foe(1)])).toBe(11);
  });

  test("the toughest foe sets the floor, and the band is clamped both ways", () => {
    expect(escapeDc([foe(1), foe(4)])).toBe(13);
    expect(escapeDc([])).toBe(ESCAPE_DC_MIN);
    expect(escapeDc([foe(20), foe(20), foe(20), foe(20)])).toBe(ESCAPE_DC_MAX);
  });
});

describe("escapeAbility", () => {
  test("the better stat carries the break — and NAMES itself (r7 convention)", () => {
    expect(escapeAbility(16, 10)).toEqual({ ability: "str", score: 16, skill: "Athletics" });
    expect(escapeAbility(10, 16)).toEqual({ ability: "dex", score: 16, skill: "Acrobatics" });
  });

  test("a tie goes to footwork", () => {
    expect(escapeAbility(12, 12).ability).toBe("dex");
  });
});

describe("resolveAllyFate", () => {
  const high = (): number => 0.99; // nat 20
  const low = (): number => 0.0; // nat 1

  test("clearing the DC by 5+ gets the ally out unhurt", () => {
    const out = resolveAllyFate(1, 20, 20, 10, high);
    expect(out.fate).toBe("escaped");
    expect(out.hpAfter).toBeUndefined();
  });

  test("missing the DC leaves them down where they stood", () => {
    expect(resolveAllyFate(1, 20, 20, 14, low).fate).toBe("downed");
  });

  test("scraping past the DC gets them out hurt, never below 1 HP", () => {
    // Level 8 + a nat 1 = 9 against DC 9: cleared, but not by 5.
    const out = resolveAllyFate(8, 20, 20, 9, low);
    expect(out.fate).toBe("wounded");
    expect(out.hpAfter).toBe(6);
    const tiny = resolveAllyFate(8, 2, 2, 9, low);
    expect(tiny.hpAfter).toBe(1);
  });

  test("a wound never HEALS an already-hurt ally", () => {
    const out = resolveAllyFate(8, 30, 3, 9, low);
    expect(out.fate).toBe("wounded");
    expect(out.hpAfter).toBe(3);
  });

  test("every fate has a plain-language line, and none of it is engine dialect", () => {
    for (const rng of [high, low]) {
      const line = allyFateSummary("Sela", resolveAllyFate(1, 12, 12, 12, rng));
      expect(line.startsWith("Sela ")).toBe(true);
      expect(line).not.toContain("HP");
      expect(line).not.toContain("DC");
    }
  });
});
