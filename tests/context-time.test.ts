/**
 * In-world time in the narrator brief — dayPhaseOf buckets and the `Time:` line placement.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { buildNarrationContext, dayPhaseOf, exertionLineOf, timeLineOf } from "../src/agents/context.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

describe("dayPhaseOf", () => {
  test("buckets the clock into six phases and wraps at midnight", () => {
    expect(dayPhaseOf(0)).toBe("deep night");
    expect(dayPhaseOf(320)).toBe("dawn");
    expect(dayPhaseOf(600)).toBe("morning");
    expect(dayPhaseOf(900)).toBe("afternoon");
    expect(dayPhaseOf(1100)).toBe("dusk");
    expect(dayPhaseOf(1300)).toBe("night");
    expect(dayPhaseOf(1440 + 600)).toBe("morning"); // next day wraps
  });

  test("timeLineOf counts campaign days", () => {
    expect(timeLineOf(0)).toBe("Time: deep night (day 1)");
    expect(timeLineOf(1440 * 2 + 600)).toBe("Time: morning (day 3)");
  });

  test("exertionLineOf is omitted when fresh and labels tired states", () => {
    expect(exertionLineOf(0)).toBeNull();
    expect(exertionLineOf(undefined)).toBeNull();
    expect(exertionLineOf(3)).toBe("Exertion: Fatigued — fatigued, hands unsteady");
  });
});

describe("the brief carries the time line", () => {
  test("Time: sits in the # LOCATION block, before # RECENT", () => {
    const world = WorldSchema.parse({
      id: "w.t",
      name: "T",
      summary: "s",
      locations: [{ id: "loc.a", name: "A", description: "d" }],
      npcs: [],
    });
    const campaign = CampaignSchema.parse({
      id: "c.t",
      name: "T",
      worldId: "w.t",
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
      campaignId: "c.t",
      worldId: "w.t",
      partyLocationId: "loc.a",
      clock: 900,
      party: ["pc.you"],
      companions: [],
      actors: {},
      quests: {},
      relationships: {},
      autonomy: {},
      modules: {},
      flags: {},
    };
    const ctx = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "look" });
    const text = ctx.contextText;
    expect(text).toContain("Time: afternoon (day 1)");
    expect(text).not.toContain("Exertion:");
    expect(text.indexOf("Time: afternoon")).toBeGreaterThan(text.indexOf("# LOCATION"));
    expect(text.indexOf("Time: afternoon")).toBeLessThan(text.indexOf("# RECENT"));
  });

  test("Exertion: appears after Time: only once the PC is tired", () => {
    const world = WorldSchema.parse({
      id: "w.t",
      name: "T",
      summary: "s",
      locations: [{ id: "loc.a", name: "A", description: "d" }],
      npcs: [],
    });
    const campaign = CampaignSchema.parse({
      id: "c.t",
      name: "T",
      worldId: "w.t",
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
      campaignId: "c.t",
      worldId: "w.t",
      partyLocationId: "loc.a",
      clock: 900,
      party: ["pc.you"],
      companions: [],
      actors: {
        "pc.you": {
          id: "pc.you",
          currentHp: 10,
          locationId: "loc.a",
          inventory: [],
          conditions: [],
          exhaustion: 2,
        },
      },
      quests: {},
      relationships: {},
      autonomy: {},
      modules: {},
      flags: {},
    };
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "look" }).contextText;
    expect(text).toContain("Time: afternoon (day 1)\nExertion: Weary");
    expect(text.indexOf("Exertion:")).toBeGreaterThan(text.indexOf("Time: afternoon"));
    expect(text.indexOf("Exertion:")).toBeLessThan(text.indexOf("# RECENT"));
  });

  test("a camped brief anchors the Camp room to its origin; a non-camp brief carries no such line (r4)", () => {
    const world = WorldSchema.parse({
      id: "w.t",
      name: "T",
      summary: "s",
      locations: [
        { id: "loc.a", name: "The Broken Crown", description: "d" },
        { id: "loc.__camp__", name: "Camp", description: "A ring of bedrolls." },
      ],
      npcs: [],
    });
    const campaign = CampaignSchema.parse({
      id: "c.t",
      name: "T",
      worldId: "w.t",
      characters: [
        {
          id: "pc.you",
          name: "You",
          stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 },
        },
      ],
      startingState: { locationId: "loc.a", party: ["pc.you"], companions: [] },
    });
    const base: GameState = {
      campaignId: "c.t",
      worldId: "w.t",
      partyLocationId: "loc.__camp__",
      clock: 900,
      party: ["pc.you"],
      companions: [],
      actors: {},
      quests: {},
      relationships: {},
      autonomy: {},
      modules: { camp: { active: true, returnLocationId: "loc.a", memberIds: ["pc.you"], enteredClock: 900 } },
      flags: {},
    };
    const camped = buildNarrationContext({ world, campaign, state: base, recentEvents: [], trigger: "rest" }).contextText;
    expect(camped).toContain("This camp lies just outside The Broken Crown");
    expect(camped).toContain("the party has NOT traveled");

    const home = buildNarrationContext({
      world,
      campaign,
      state: { ...base, partyLocationId: "loc.a", modules: {} },
      recentEvents: [],
      trigger: "look",
    }).contextText;
    expect(home).not.toContain("This camp lies");
  });
});
