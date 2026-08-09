/**
 * Preset catalogs + resolver - alignment/personality lookup with lenient unknown-id handling.
 *
 * @author Runkai Zhang
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { AlignmentIds } from "../src/content/schema.ts";
import { MORALITIES } from "../src/content/presets/moralities.ts";
import { PERSONALITIES } from "../src/content/presets/personalities.ts";
import { listPresets, resolvePreset } from "../src/content/presets/preset.ts";

describe("preset catalogs", () => {
  test("moralities cover the full nine-alignment grid", () => {
    expect(MORALITIES.map((m) => m.id)).toEqual([...AlignmentIds]);
    for (const m of MORALITIES) expect(m.guidance.length).toBeGreaterThan(40);
  });

  test("personalities include the core archetypes and have guidance", () => {
    const ids = new Set(PERSONALITIES.map((p) => p.id));
    for (const need of [
      "stoic-guardian",
      "trickster",
      "zealot",
      "schemer",
      "hedonist",
      "caretaker",
      "brute",
      "sage",
    ]) {
      expect(ids.has(need)).toBe(true);
    }
    for (const p of PERSONALITIES) expect(p.guidance.length).toBeGreaterThan(20);
  });
});

describe("resolvePreset", () => {
  afterEach(() => mock.restore());

  test("returns the entry for a known id", () => {
    expect(resolvePreset(MORALITIES, "ne")?.label).toBe("Neutral Evil");
    expect(resolvePreset(PERSONALITIES, "trickster")?.id).toBe("trickster");
  });

  test("an empty or unset id resolves to undefined without warning", () => {
    const warn = mock(() => {});
    const orig = console.warn;
    console.warn = warn;
    try {
      expect(resolvePreset(MORALITIES, "")).toBeUndefined();
      expect(resolvePreset(MORALITIES, undefined)).toBeUndefined();
      expect(resolvePreset(MORALITIES, "   ")).toBeUndefined();
    } finally {
      console.warn = orig;
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("a non-empty unknown id warns once and returns undefined without throwing", () => {
    const warn = mock(() => {});
    const orig = console.warn;
    console.warn = warn;
    try {
      expect(resolvePreset(MORALITIES, "totally-bogus-phase1")).toBeUndefined();
      expect(resolvePreset(MORALITIES, "totally-bogus-phase1")).toBeUndefined();
    } finally {
      console.warn = orig;
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("listPresets renders one line per entry", () => {
    expect(listPresets(MORALITIES).split("\n").length).toBe(MORALITIES.length);
    expect(listPresets(PERSONALITIES).split("\n").length).toBe(PERSONALITIES.length);
  });
});
