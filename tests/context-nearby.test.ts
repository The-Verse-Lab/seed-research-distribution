/**
 * The `Nearby:` gazetteer line — Phase 3 guidance in the narrator brief and the CLI's /look.
 *
 * The contract under test: a world with NO gazetteer renders a brief BYTE-IDENTICAL to before the
 * line existed (omit-when-empty — the tested `# LOCATION` header contract is untouched), and a
 * world WITH entries gets one `Nearby:` line directly after `Exits:`, comma style matching, kinds
 * as one-word tags. `nearbyLineOf` is the single shared formatter (brief + /look), so asserting it
 * here covers both surfaces.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildNarrationContext, nearbyLineOf } from "../src/agents/context.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { CampaignSchema, WorldSchema, type World } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

function makeWorld(gazetteer?: unknown): World {
  return WorldSchema.parse({
    id: "w.g",
    name: "G",
    summary: "s",
    locations: [
      {
        id: "loc.a",
        name: "A",
        description: "d",
        exits: [{ to: "loc.b", name: "the mill path" }],
      },
      { id: "loc.b", name: "B", description: "d" },
    ],
    npcs: [],
    ...(gazetteer !== undefined ? { gazetteer } : {}),
  });
}

const campaign = CampaignSchema.parse({
  id: "c.g",
  name: "G",
  worldId: "w.g",
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
  campaignId: "c.g",
  worldId: "w.g",
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

const ENTRIES = [
  { id: "gaz.thornmere", name: "Thornmere", kind: "town", summary: "a swamp town, somewhere east" },
  { id: "gaz.fane", name: "The Sunken Fane", kind: "ruin", summary: "a drowned shrine" },
];

describe("nearbyLineOf", () => {
  test("returns null when the world has no gazetteer (absent OR empty)", () => {
    expect(nearbyLineOf(makeWorld())).toBeNull();
    expect(nearbyLineOf(makeWorld([]))).toBeNull();
  });

  test("renders entries as Name (kind) in authored order, comma style matching Exits:", () => {
    expect(nearbyLineOf(makeWorld(ENTRIES))).toBe("Nearby: Thornmere (town), The Sunken Fane (ruin)");
  });
});

describe("the brief's Nearby: line", () => {
  test("a gazetteer-less world's brief is byte-identical (no Nearby: line at all)", () => {
    const absent = buildNarrationContext({ world: makeWorld(), campaign, state, recentEvents: [], trigger: "look" });
    const empty = buildNarrationContext({ world: makeWorld([]), campaign, state, recentEvents: [], trigger: "look" });
    expect(absent.contextText).toBe(empty.contextText);
    expect(absent.contextText).not.toContain("Nearby:");
    // The existing # LOCATION contract stays intact: Exits: directly followed by Present:.
    expect(absent.contextText).toContain("Exits: the mill path\nPresent:");
  });

  test("a populated gazetteer renders one line directly after Exits:, inside # LOCATION", () => {
    const ctx = buildNarrationContext({
      world: makeWorld(ENTRIES),
      campaign,
      state,
      recentEvents: [],
      trigger: "look",
    });
    const text = ctx.contextText;
    // Exact adjacency: Exits: line, then Nearby:, then Present: — same block, same comma style.
    expect(text).toContain(
      "Exits: the mill path\nNearby: Thornmere (town), The Sunken Fane (ruin)\nPresent:",
    );
    // Grounding region only — far before the guard's # NOW cut point.
    expect(text.indexOf("Nearby:")).toBeGreaterThan(text.indexOf("# LOCATION"));
    expect(text.indexOf("Nearby:")).toBeLessThan(text.indexOf("# NOW"));
  });

  test("the bundled thistledown world authors a gazetteer and its brief renders the Nearby: line", async () => {
    // Phase 4: thistledown ships 3-4 hand-authored entries, so a bundled world exercises the
    // gazetteer surfaces (brief + /look) out of the box. worlds/example stays
    // gazetteer-less — the byte-stability test above is its contract.
    const dir = fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url));
    const { world, campaign: tdCampaign } = await loadPlaySetFromDir(dir);
    expect(world.gazetteer?.length).toBeGreaterThanOrEqual(3);
    expect(world.gazetteer?.length).toBeLessThanOrEqual(4);
    for (const entry of world.gazetteer ?? []) expect(entry.id.startsWith("gaz.")).toBe(true);

    const tdState: GameState = {
      ...state,
      campaignId: tdCampaign.id,
      worldId: world.id,
      partyLocationId: tdCampaign.startingState.locationId,
      party: [...tdCampaign.startingState.party],
      companions: [...tdCampaign.startingState.companions],
    };
    const ctx = buildNarrationContext({ world, campaign: tdCampaign, state: tdState, recentEvents: [], trigger: "look" });
    const line = nearbyLineOf(world)!;
    expect(line).toContain("Gorse Hill (town)");
    expect(ctx.contextText).toContain(`\n${line}\nPresent:`);
  });
});
