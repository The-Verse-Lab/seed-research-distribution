/**
 * PROSE-TO-CODE §2.6 — judge corrections must speak fiction, never engine.
 *
 * "authorized exits" entered the r6 fiction because a continuity `correction` string written in
 * engine dialect was appended to the DM message verbatim and the model paraphrased it into prose.
 * The wordings have since been rewritten in-world; this ratchet keeps them that way: every
 * correction string in the continuity rules and the judge's default table is scanned for engine
 * vocabulary a narrator could echo. Source-scan on purpose — the strings are static literals, and
 * a new check added with a "no Command authorized…" correction should fail here before it ships.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const FILES = ["src/rules/continuity.ts", "src/agents/judge.ts"];

/** Engine vocabulary that must never ride a correction into the narrator's mouth. */
const DIALECT = [
  /authori[sz]ed/i,
  /\bCommand\b/,
  /\breducer\b/i,
  /\bclassifier\b/i,
  /\bengine\b/i,
  /\bTurnPlan\b/,
  /\bmoveParty\b/,
  /RESOLVED MECHANICS/,
];

/** Pull every correction string literal: `correction:`-keyed values, plus the judge's
 *  DEFAULT_CORRECTION table (whose keys are the violation kinds themselves). */
function correctionLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /correction:\s*\r?\n?\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g;
  for (const m of source.matchAll(re)) out.push(m[1]!.slice(1, -1));
  const table = source.match(/DEFAULT_CORRECTION[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (table) {
    for (const m of table[1]!.matchAll(/"(?:[^"\\]|\\.)*"/g)) out.push(m[0]!.slice(1, -1));
  }
  return out;
}

describe("continuity corrections carry no engine dialect (§2.6 ratchet)", () => {
  for (const file of FILES) {
    test(`${file} correction strings are in-world`, () => {
      const literals = correctionLiterals(readFileSync(file, "utf8"));
      expect(literals.length).toBeGreaterThan(0); // the scan itself must keep finding them
      for (const lit of literals) {
        for (const term of DIALECT) {
          expect(term.test(lit) ? `${file}: "${lit.slice(0, 80)}" matches ${term}` : "").toBe("");
        }
      }
    });
  }
});
