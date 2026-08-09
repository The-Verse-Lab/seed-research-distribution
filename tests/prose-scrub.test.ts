/**
 * Prose-artifact scrub (r3 P4) — purely mechanical output hygiene: a LEADING leaked brief header
 * ("# NOW …") and minority CJK glitch runs are stripped; everything else — including mid-prose
 * `#` and genuinely CJK-language text — passes through byte-identical.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { scrubProseArtifacts } from "../src/llm/prose-scrub.ts";

describe("scrubProseArtifacts", () => {
  test("a leading leaked header line is dropped; the prose survives", () => {
    expect(scrubProseArtifacts("# NOW The silence outside deepens.\nThe fire pops.")).toBe(
      "The silence outside deepens.\nThe fire pops.",
    );
  });

  test("stacked leaked headers are all dropped", () => {
    expect(scrubProseArtifacts("# NOW\n## LOCATION\nThe road bends east.")).toBe("The road bends east.");
  });

  test("a mid-prose # is never touched", () => {
    const s = "The sign reads #5 on the list.\n# Not a header mid-way? Still prose after a newline...";
    // Only a LEADING header line is scrubbed — this text does not start with one.
    expect(scrubProseArtifacts(s)).toBe(s);
  });

  test("a minority CJK glitch run is removed and spacing collapsed", () => {
    expect(scrubProseArtifacts("a sound like breaking石灰岩 under the floor")).toBe(
      "a sound like breaking under the floor",
    );
  });

  test("majority-CJK prose passes through untouched (a CJK-language world is legal)", () => {
    const s = "夜色深沉，市场的喧嚣渐渐远去。石灰岩的墙面泛着微光。";
    expect(scrubProseArtifacts(s)).toBe(s);
  });

  test("clean prose is byte-identical", () => {
    const s = "You speak, and Sela weighs the words a long moment before answering.";
    expect(scrubProseArtifacts(s)).toBe(s);
  });

  test("an inline regurgitated grounding block is stripped, surrounding prose intact (r4 P3)", () => {
    // The live sample: a fenced brief dump mid-flight-scene, listing exits that contradicted state.
    const s =
      "You run until the glass-road blurs. --- You carry: Leather Armor, Club, Potion of Healing x2 " +
      "Wielding/worn: Leather Armor, Club Party: you travel alone Time: late afternoon, day 2 " +
      "Location: the Ashwild road Ambience: wind over glass Exits: the road south-west (flats), " +
      "the track north (broken ground) --- The wind dies as suddenly as it rose.";
    const out = scrubProseArtifacts(s);
    expect(out).toContain("You run until the glass-road blurs.");
    expect(out).toContain("The wind dies as suddenly as it rose.");
    expect(out).not.toContain("You carry:");
    expect(out).not.toContain("Exits:");
    expect(out).not.toContain("---");
  });

  test("a multi-line grounding block run is stripped as one unit", () => {
    const s = [
      "The door gives way at last.",
      "---",
      "You carry: a club, a waterskin",
      "Exits: the stair up, a flooded passage",
      "Time: dusk, day 1",
      "---",
      "Beyond it, the cellar breathes cold.",
    ].join("\n");
    const out = scrubProseArtifacts(s);
    expect(out).toContain("The door gives way at last.");
    expect(out).toContain("Beyond it, the cellar breathes cold.");
    expect(out).not.toContain("You carry:");
    expect(out).not.toContain("Time: dusk");
  });

  test("a lone grounding-shaped line survives — a letter may legitimately read 'Time: dusk'", () => {
    const s = "The note is brief.\nTime: dusk. Come alone.\nNothing else is written.";
    expect(scrubProseArtifacts(s)).toBe(s);
  });

  test("brief-block scrub is idempotent", () => {
    const s = "Prose before. --- You carry: rope Exits: the gate --- Prose after.";
    const once = scrubProseArtifacts(s);
    expect(scrubProseArtifacts(once)).toBe(once);
  });
});

describe("engine dialect (r6 P3)", () => {
  test("the narrator never reads the exits table aloud", () => {
    const s = "And the two authorized exits are behind you — the stair up, and the flooded passage.";
    expect(scrubProseArtifacts(s)).toBe(
      "And the two ways out are behind you — the stair up, and the flooded passage.",
    );
  });

  test("case is preserved at sentence start; ordinary prose is untouched", () => {
    expect(scrubProseArtifacts("Authorized exits are marked on the plan.")).toBe("Ways out are marked on the plan.");
    const plain = "The authorized biography of a salt-merchant.";
    expect(scrubProseArtifacts(plain)).toBe(plain);
  });
});

describe("scrubProseArtifacts — the misses the regex audit reproduced (§8g)", () => {
  // The leading-header boundary was `\s+(?=[A-Z][a-z])` — Sentence-case prose ONLY. A model that
  // echoes the scaffolding mid-thought continues in lower case, and both of these reached the
  // player with the literal marker still on the front.
  test("a header followed by LOWER-CASE prose on the same line is stripped", () => {
    expect(scrubProseArtifacts("# NOW the silence outside is absolute.")).toBe(
      "the silence outside is absolute.",
    );
    expect(scrubProseArtifacts("## THE RECORD you already have stands.")).toBe(
      "you already have stands.",
    );
  });

  test("a model-authored mixed-case markdown title is still left alone", () => {
    const s = "# The Vault of Ashes\nYou descend into the cold.";
    expect(scrubProseArtifacts(s)).toBe(s);
  });

  // The engine-dialect table was US-spelling-only; a model writing British English said
  // "the two authorised exits are behind you" and the plumbing reached the player verbatim.
  test("British 'authorised exit(s)' is rewritten exactly like the US spelling", () => {
    expect(scrubProseArtifacts("The two authorised exits are behind you.")).toBe(
      "The two ways out are behind you.",
    );
    expect(scrubProseArtifacts("The two authorized exits are behind you.")).toBe(
      "The two ways out are behind you.",
    );
    expect(scrubProseArtifacts("Authorised exit: the north stair.")).toBe("Way out: the north stair.");
  });
});
