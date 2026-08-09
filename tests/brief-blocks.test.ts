/**
 * Brief composition — the block breakdown the Observatory shows for a prompt.
 *
 * `briefBlocks` recovers a brief's structure by PARSING it, which only works because the brief's
 * literal headers are a byte-stable contract (`src/agents/context.ts`, `src/util/markers.ts`). So
 * these specs run the parser over a REAL assembled brief, not only over hand-written text: if the
 * header contract ever drifts, the block keys drift with it and this fails.
 *
 * The load-bearing property is the sum invariant — every byte lands in exactly one block. A
 * breakdown that quietly loses bytes is worse than no breakdown: it reads as complete.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { briefBlocks, briefFromMessages, PREAMBLE_KEY } from "../src/logging/brief-blocks.ts";
import { buildNarrationContext } from "../src/agents/context.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

const world = WorldSchema.parse({
  id: "w.b",
  name: "B",
  summary: "A cold shore.",
  locations: [
    {
      id: "loc.a",
      name: "The Quay",
      description: "Wet stone and rope.",
      exits: [{ to: "loc.b", name: "the east road", minutes: 60, direction: "east" }],
    },
    { id: "loc.b", name: "Elsewhere", description: "d" },
  ],
  npcs: [],
});

const campaign = CampaignSchema.parse({
  id: "c.b",
  name: "B",
  worldId: "w.b",
  characters: [
    {
      id: "pc.you",
      name: "You",
      stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 },
    },
  ],
  startingState: { locationId: "loc.a", party: ["pc.you"], companions: [] },
});

const state: GameState = {
  campaignId: "c.b",
  worldId: "w.b",
  partyLocationId: "loc.a",
  clock: 0,
  party: ["pc.you"],
  companions: [],
  actors: {},
  quests: {},
  relationships: {},
  autonomy: {},
  modules: {},
  flags: {},
};

const realBrief = (): string =>
  buildNarrationContext({ world, campaign, state, trigger: "I look around.", recentEvents: [] }).contextText;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const sumBytes = (text: string): number => briefBlocks(text).reduce((n, b) => n + b.bytes, 0);

describe("brief composition", () => {
  test("a real assembled brief splits on its contract headers", () => {
    const keys = briefBlocks(realBrief()).map((b) => b.key);
    // The headers `src/agents/context.ts` guarantees on every brief.
    expect(keys).toContain("# WORLD");
    expect(keys).toContain("# LOCATION");
    expect(keys).toContain("# RECENT");
    expect(keys).toContain("# NOW");
    // `# WORLD` opens the brief, so nothing is stranded ahead of the first header.
    expect(keys).not.toContain(PREAMBLE_KEY);
    expect(keys[0]).toBe("# WORLD");
  });

  test("every byte is attributed — the block sizes sum to the brief's length", () => {
    const brief = realBrief();
    expect(sumBytes(brief)).toBe(byteLength(brief));
  });

  test("the sum invariant survives multi-byte characters, blank lines and a trailing newline", () => {
    // Em dashes and curly quotes are all over a real brief; a naive `length` would under-count them.
    const text = "# WORLD\nA cold shore — “the Reach”.\n\n# NOW\nI look.\n";
    expect(sumBytes(text)).toBe(byteLength(text));
    expect(byteLength(text)).toBeGreaterThan(text.length); // the multi-byte chars are really there
  });

  test("a titled or qualified header keeps a stable key, and the verbatim header beside it", () => {
    const blocks = briefBlocks(
      [
        "# LOCATION — The Quay",
        "Wet stone.",
        "# CANON NAMES (already taken)",
        "- Oda",
        "# PRIOR NPC CLAIMS (speaker continuity only — NOT authoritative world truth)",
        "Veil said the lantern was spoken for.",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.key)).toEqual(["# LOCATION", "# CANON NAMES", "# PRIOR NPC CLAIMS"]);
    expect(blocks[0]!.header).toBe("# LOCATION — The Quay");
  });

  test("the resolved-mechanics rule opens its own block", () => {
    const blocks = briefBlocks("# NOW\nI swing.\n\n=== RESOLVED MECHANICS ===\nAttack hits for 5.");
    expect(blocks.map((b) => b.key)).toEqual(["# NOW", "=== RESOLVED MECHANICS"]);
  });

  test("a rule header closed with `===` around a dashed parenthetical still normalizes whole", () => {
    // Live shapes from a narrator brief. Stripping in the wrong order cuts the key
    // mid-phrase at the em dash INSIDE the parenthetical and leaves an unbalanced paren on it.
    const blocks = briefBlocks(
      [
        "=== SECRET LORE (GM eyes only — never quote verbatim) ===",
        "The grey lady buys paper.",
        "=== ALREADY HAPPENING THIS TURN (already shown to the player — do not repeat) ===",
        "Veil pointed at the board.",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.key)).toEqual(["=== SECRET LORE", "=== ALREADY HAPPENING THIS TURN"]);
  });

  test("an em-dash title and a parenthetical on the same header both come off", () => {
    expect(briefBlocks("# CASE — The Ledger (open)\nEvidence.")[0]!.key).toBe("# CASE");
  });

  test("structural blocks break their fields out; a transcript block does not", () => {
    const blocks = briefBlocks(
      [
        "# LOCATION — The Quay",
        "Exits: the east road",
        "Present: Oda, Veil",
        "Party (these and ONLY these travel with you): Oda",
        "# RECENT",
        'Oda: "We should go."',
        'Veil: "Not yet."',
      ].join("\n"),
    );
    const location = blocks.find((b) => b.key === "# LOCATION")!;
    expect(location.labels?.map((l) => l.label)).toEqual(["Exits", "Present", "Party"]);
    // `Oda:` in a transcript is a speaker, not a field — breaking it out would make every line of
    // dialogue a row. Its bytes still count toward `# RECENT`.
    const recent = blocks.find((b) => b.key === "# RECENT")!;
    expect(recent.labels).toBeUndefined();
    expect(recent.bytes).toBeGreaterThan(0);
  });

  test("content ahead of the first header is reported, never dropped", () => {
    const text = "Stay concise.\n# WORLD\nA shore.";
    const blocks = briefBlocks(text);
    expect(blocks[0]!.key).toBe(PREAMBLE_KEY);
    expect(sumBytes(text)).toBe(byteLength(text));
  });

  test("empty input yields no blocks", () => {
    expect(briefBlocks("")).toEqual([]);
  });

  test("the brief is picked out of a logged request by its `# NOW` cut point", () => {
    const messages = [
      { role: "system", content: "You are the GM. Be terse." },
      { role: "user", content: "# WORLD\nA shore.\n# NOW\nI look." },
    ];
    expect(briefFromMessages(messages)).toContain("# NOW");
  });

  test("with no `# NOW` anywhere, the longest message stands in; a request with no text is null", () => {
    const messages = [
      { role: "system", content: "short" },
      { role: "user", content: "a considerably longer message body" },
    ];
    expect(briefFromMessages(messages)).toBe("a considerably longer message body");
    expect(briefFromMessages([{ role: "user", content: 42 }])).toBeNull();
    expect(briefFromMessages(undefined)).toBeNull();
  });
});
