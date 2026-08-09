/**
 * The `Roads:` line — authored travel times in the narrator brief (r6, from the r5 playtest).
 *
 * The defect it answers: a quest-giver priced the road to the search area at "four days east by
 * wagon, two and a half by river barge" and named a way-house beyond it, while the same journey on
 * the map is a few hours' walk — and a two-day bond was hung on that invented distance. Nothing in
 * the brief had ever stated a travel time, so every speaker invented one, and the deadline (the
 * game's best pressure device) became unplannable noise.
 *
 * The contract: one `Roads:` line directly after `Exits:`, hours off the authored `Exit.minutes`,
 * and NO line at all when nothing authored a time — a world without travel times keeps a
 * byte-identical brief, so the tested `# LOCATION` header contract is untouched.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { buildNarrationContext } from "../src/agents/context.ts";
import { CampaignSchema, WorldSchema, type World } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

function makeWorld(exits: unknown[]): World {
  return WorldSchema.parse({
    id: "w.r",
    name: "R",
    summary: "s",
    locations: [
      { id: "loc.a", name: "A", description: "d", exits },
      { id: "loc.b", name: "B", description: "d" },
      { id: "loc.c", name: "C", description: "d" },
    ],
    npcs: [],
  });
}

const campaign = CampaignSchema.parse({
  id: "c.r",
  name: "R",
  worldId: "w.r",
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
  campaignId: "c.r",
  worldId: "w.r",
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

const briefOf = (world: World): string =>
  buildNarrationContext({ world, campaign, state, trigger: "look", recentEvents: [] }).contextText;

describe("the Roads: brief line", () => {
  test("renders each authored way out with its real travel time and direction", () => {
    const brief = briefOf(
      makeWorld([
        { to: "loc.b", name: "the east road to B", minutes: 375, direction: "east" },
        { to: "loc.c", name: "the west road to C", minutes: 495, direction: "west" },
      ]),
    );
    expect(brief).toContain("Roads: the east road to B — 6.25h east; the west road to C — 8.25h west");
  });

  test("a short hop reads in minutes, and a hidden way out is never advertised", () => {
    const brief = briefOf(
      makeWorld([
        { to: "loc.b", name: "the mill path", minutes: 15 },
        { to: "loc.c", name: "the smugglers' stair", minutes: 30, hidden: true },
      ]),
    );
    expect(brief).toContain("Roads: the mill path — 15min");
    expect(brief).not.toContain("smugglers");
  });

  test("no authored times ⇒ no line at all (the brief stays byte-identical)", () => {
    const brief = briefOf(makeWorld([{ to: "loc.b", name: "the mill path" }]));
    expect(brief).not.toContain("Roads:");
  });
});
