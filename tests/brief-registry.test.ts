/**
 * The brief-block registry — byte-identity across the refactor, and the ordering invariant it exists
 * to enforce.
 *
 * `buildNarrationContext` used to assemble the brief as one ~50-element array literal whose ordering
 * rules ("this block must sit BEFORE `# NOW` or the guard's cut point moves") were enforced by
 * comment. The registry makes region and order into data, so a misplaced block is a failing test
 * rather than a silent change to what the minor-safety guard screens.
 *
 * The golden spec is the guard on that: the brief is a byte-stable tested contract, so any change to
 * how it is assembled has to be a change someone MEANT to make. When the registry landed, the golden
 * was generated from the pre-registry builder at HEAD (in a throwaway worktree) and matched exactly,
 * proving the reorganization was byte-neutral. It has since moved once on purpose, for the two-tier
 * canon-name registry — see `tests/canon-names.test.ts`. Regenerate it only alongside a deliberate
 * change to the brief, never to make a red test green.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { ACTION_BLOCKS, GROUNDING_BLOCKS, LOCATION_LINES, buildNarrationContext } from "../src/agents/context.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import { BRIEF_FIXTURES } from "./support/brief-fixtures.ts";

describe("brief-block registry", () => {
  test("the assembled brief matches the golden byte for byte", async () => {
    const golden = (await Bun.file("tests/fixtures/brief-golden.json").json()) as Record<string, string>;
    for (const [name, input] of Object.entries(BRIEF_FIXTURES)) {
      expect(buildNarrationContext(input).contextText, `fixture "${name}"`).toBe(golden[name]!);
    }
    // The fixture file must not quietly fall behind the fixtures it pins.
    expect(Object.keys(golden).sort()).toEqual(Object.keys(BRIEF_FIXTURES).sort());
  });

  test("every grounding block renders before the guard's cut point, every action block after", () => {
    // This is the invariant the old array literal enforced only by comment. `# NOW` is where the
    // minor-safety guard's input screen cuts: anything that drifts across it changes what is
    // screened, which is a safety-relevant change, not a cosmetic one.
    for (const input of Object.values(BRIEF_FIXTURES)) {
      const text = buildNarrationContext(input).contextText;
      const cut = text.indexOf(BRIEF_MARKERS.now);
      expect(cut).toBeGreaterThan(-1);
      for (const block of GROUNDING_BLOCKS) {
        const at = text.indexOf(block.key);
        if (at >= 0) expect(at, `${block.key} must precede ${BRIEF_MARKERS.now}`).toBeLessThan(cut);
      }
      for (const block of ACTION_BLOCKS) {
        const at = text.indexOf(block.key);
        if (at >= 0) expect(at, `${block.key} must follow ${BRIEF_MARKERS.now}`).toBeGreaterThan(cut);
      }
    }
  });

  test("registry keys are unique and its declared order is the rendered order", () => {
    for (const registry of [LOCATION_LINES, GROUNDING_BLOCKS, ACTION_BLOCKS]) {
      const keys = registry.map((b) => b.key);
      expect(new Set(keys).size, `duplicate key in ${keys.join(",")}`).toBe(keys.length);
    }
    // The location line-stack is where drift is easiest to introduce and hardest to see.
    const text = buildNarrationContext(BRIEF_FIXTURES.locationStack!).contextText;
    const positions = LOCATION_LINES.map((l) => text.indexOf(l.key)).filter((i) => i >= 0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("a block that renders nothing costs zero bytes", () => {
    // The omit-when-empty discipline is what keeps the header contract byte-stable as blocks are
    // added. A minimal brief must carry no trace of the optional blocks at all.
    const text = buildNarrationContext(BRIEF_FIXTURES.minimal!).contextText;
    for (const key of ["# STORY SO FAR", "# PRIOR NPC CLAIMS", "# RELEVANT LORE", "# FACTION STANDING"]) {
      expect(text).not.toContain(key);
    }
    expect(text).not.toContain("\n\n\n"); // no blank-line residue where a block was skipped
  });
});
