/**
 * Safety-normalization tests — the obfuscation-folding layer that sits in front of the detector.
 *
 * Two directions, both load-bearing:
 *  - bypasses MUST be folded back to plain ASCII so the term lists catch them (a missed fold is a
 *    fail-open minor-safety hole);
 *  - benign text MUST be left intact so normalization can never MANUFACTURE a banned term where
 *    none was written.
 *
 * No real graphic content here — these assert the string transform on neutral tokens.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { foldLeetspeak, normalizeForSafety, normalizeForSafetyBase } from "../src/llm/normalize.ts";

describe("normalizeForSafety — folds obfuscation back to ASCII", () => {
  test("leetspeak digits/symbols → letters", () => {
    expect(normalizeForSafety("ch1ld").toLowerCase()).toBe("child");
    expect(normalizeForSafety("t33n").toLowerCase()).toBe("teen");
    expect(normalizeForSafety("sch00lgirl").toLowerCase()).toBe("schoolgirl");
    expect(normalizeForSafety("s3x").toLowerCase()).toBe("sex");
    expect(normalizeForSafety("p3n!s").toLowerCase()).toBe("penis");
  });

  test("letters spaced apart by separators collapse (3+ run)", () => {
    expect(normalizeForSafety("c h i l d").toLowerCase()).toBe("child");
    expect(normalizeForSafety("c.h.i.l.d").toLowerCase()).toBe("child");
    expect(normalizeForSafety("c-h-i-l-d").toLowerCase()).toBe("child");
  });

  test("single in-word underscore is removed", () => {
    expect(normalizeForSafety("ch_ild").toLowerCase()).toBe("child");
    expect(normalizeForSafety("chi_ld").toLowerCase()).toBe("child");
  });

  test("zero-width / invisible splits are stripped", () => {
    expect(normalizeForSafety("ch​ild").toLowerCase()).toBe("child"); // zero-width space
    expect(normalizeForSafety("ch‍i‌ld").toLowerCase()).toBe("child"); // (non-)joiners
    expect(normalizeForSafety("ch­ild").toLowerCase()).toBe("child"); // soft hyphen
    expect(normalizeForSafety("ch﻿ild").toLowerCase()).toBe("child"); // BOM / ZWNBSP
  });

  test("accents and cross-script homoglyphs fold to base Latin", () => {
    expect(normalizeForSafety("chïld").toLowerCase()).toBe("child"); // ï
    expect(normalizeForSafety("sеx").toLowerCase()).toBe("sex"); // Cyrillic e (U+0435)
    expect(normalizeForSafety("сhild").toLowerCase()).toBe("child"); // Cyrillic c (U+0441)
  });
});

describe("normalizeForSafety — must NOT manufacture matches in benign text", () => {
  test("ordinary prose with single-letter words is untouched", () => {
    expect(normalizeForSafety("I am a kid")).toBe("I am a kid");
    expect(normalizeForSafety("a cat sat on a mat")).toBe("a cat sat on a mat");
  });

  test("two-letter abbreviations are NOT collapsed (require a 3+ run)", () => {
    expect(normalizeForSafety("a.m.")).toBe("a.m.");
    expect(normalizeForSafety("e.g. the cat")).toBe("e.g. the cat");
  });

  test("multi-letter words with internal hyphens are preserved", () => {
    // The hyphen in a real word survives (its letters aren't single), so age phrases still parse.
    expect(normalizeForSafetyBase("twelve-year-old").toLowerCase()).toBe("twelve-year-old");
    expect(normalizeForSafetyBase("well-known")).toBe("well-known");
  });
});

describe("base view vs leet fold — digits", () => {
  test("the base view PRESERVES digits (so age regexes still see them)", () => {
    expect(normalizeForSafetyBase("12 years old")).toBe("12 years old");
    expect(normalizeForSafetyBase("8th grader")).toBe("8th grader");
    expect(normalizeForSafetyBase("aged 14 to 25")).toBe("aged 14 to 25");
  });

  test("foldLeetspeak is position-preserving (length unchanged)", () => {
    const base = normalizeForSafetyBase("he is 13 and ch1ld-like");
    expect(foldLeetspeak(base).length).toBe(base.length);
  });
});
