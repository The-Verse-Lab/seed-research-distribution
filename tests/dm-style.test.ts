/**
 * Authored per-world narration STYLE reaching the GM system prompt (P1), plus the anti-recap /
 * anti-repetition / length-by-weight directives (P2/P3). The style block is omit-when-empty, so a
 * world with no authored style renders a byte-identical prompt and re-serializes unchanged.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { WorldSchema } from "../src/content/schema.ts";
import { DungeonMaster } from "../src/agents/dm.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

const promptFor = (style?: string[]): string => {
  const world = WorldSchema.parse({ id: "w", name: "W", summary: "A test world.", ...(style ? { style } : {}) });
  return new DungeonMaster(new OfflineGateway(), world).buildSystemPrompt();
};

describe("DM system prompt — authored narration style (P1)", () => {
  test("a style-less world has no style block (byte-identical prompt)", () => {
    expect(promptFor()).not.toContain("Narrative style");
  });

  test("an authored style lists each directive as a bullet under a header", () => {
    const prompt = promptFor(["Grim and understated.", "Favor short, concrete sentences."]);
    expect(prompt).toContain("Narrative style (authored for this world — follow it):");
    expect(prompt).toContain("- Grim and understated.");
    expect(prompt).toContain("- Favor short, concrete sentences.");
  });

  test("blank/whitespace directives are dropped; an all-blank list adds no block", () => {
    expect(promptFor(["  ", ""])).not.toContain("Narrative style");
    const prompt = promptFor(["  ", "Keep it terse."]);
    expect(prompt).toContain("- Keep it terse.");
  });
});

describe("DM system prompt — anti-recap + length-by-weight (P2/P3)", () => {
  test("carries the no-recap, no-repetition, and match-length directives", () => {
    const prompt = promptFor();
    expect(prompt).toContain("narrate only what is NEW this turn");
    expect(prompt).toContain("vary rhythm and vocabulary");
    expect(prompt).toContain("Match length to the beat");
  });
});

describe("WorldSchema.style round-trip", () => {
  test("absent style stays absent after parse (byte-identical serialization)", () => {
    const parsed = WorldSchema.parse({ id: "w", name: "W" });
    expect("style" in parsed).toBe(false);
  });

  test("an authored style survives parse verbatim", () => {
    const parsed = WorldSchema.parse({ id: "w", name: "W", style: ["Grim.", "Terse."] });
    expect(parsed.style).toEqual(["Grim.", "Terse."]);
  });
});

describe("DM system prompt — the player's voice is theirs (playtest 07-24 P2/P4)", () => {
  test("forbids inventing player speech and asserting the player's interior", () => {
    const prompt = promptFor();
    // AGREE beats were scripting whole paragraphs of quoted player dialogue the player never typed.
    expect(prompt).toContain("may contain ONLY words the player actually typed this turn");
    expect(prompt).toContain("never re-attribute them to the player");
    // ...and the GM was answering its own questions about what the player wanted.
    expect(prompt).toContain("Do not narrate the player character's interior as established fact");
    expect(prompt).toContain("already figured out");
  });

  test("without forbidding second-person sensation — the pillar the rule must not break", () => {
    // Hostile fiction requires narrating fear, pain and resistance honestly, and the
    // second-person mandate is what makes the prose land. The authorship rules bind WORDS and
    // ASSERTED MOTIVE only; a blanket "never narrate what they feel" would collide with both.
    const prompt = promptFor();
    expect(prompt).toContain(`SECOND PERSON ("you see…", "you feel…")`);
  });
});
