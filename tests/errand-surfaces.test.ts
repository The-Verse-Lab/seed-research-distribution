/**
 * Errand surfaces — THE RECORD rows and the Party panel (r5 fix wave).
 *
 * Two things the r4 run had no way to see: that a companion was away because the player SENT them
 * (the panel said a bare "Elsewhere", indistinguishable from wandering off), and what they came
 * back with. The ledger rows also make both facts ESTABLISHED for the narrator, so an NPC cannot
 * wonder aloud where someone went or re-litigate a report already delivered.
 *
 * The byte-stability assertion is the load-bearing one: a campaign that has never run an errand
 * must render an identical brief.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { recordBriefLines } from "../src/agents/context.ts";
import { ERRANDS_MODULE, defaultErrandsSlice, type Errand, type ErrandReport } from "../src/rules/errands.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

const world = WorldSchema.parse({
  id: "w.surf",
  name: "Surfaces",
  summary: "A test world.",
  locations: [
    { id: "loc.here", name: "The Taproom", description: "A low room.", npcs: ["npc.oda"] },
    { id: "loc.there", name: "The Counting-House", description: "A hall of ledgers." },
  ],
  npcs: [{ id: "npc.oda", name: "Oda", persona: "A wayfarer.", age: 50 }],
});

const campaign = CampaignSchema.parse({
  id: "c.surf",
  name: "Surfaces",
  worldId: "w.surf",
  characters: [
    {
      id: "pc.you",
      name: "You",
      stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 },
      age: 30,
    },
  ],
  startingState: { locationId: "loc.here", party: ["pc.you"] },
});

const ERRAND: Errand = {
  id: "err:npc.oda:480",
  runnerId: "npc.oda",
  task: { kind: "ask", subjectId: "npc.oda", topic: "the ledger" },
  destinationId: "loc.there",
  reportLocationId: "loc.here",
  homeLocationId: "loc.here",
  departedAtClock: 480,
  dueAtClock: 1200,
  feeCp: 20,
};

const REPORT: ErrandReport = {
  errandId: ERRAND.id,
  runnerId: "npc.oda",
  atClock: 1300,
  outcome: "delivered",
  findings: ["Oda asked at The Counting-House. What came back: the bond was signed twice."],
};

function stateWith(modules: Record<string, unknown>): GameState {
  return {
    campaignId: "c.surf",
    worldId: "w.surf",
    partyLocationId: "loc.here",
    clock: 600,
    party: ["pc.you"],
    companions: [],
    actors: {},
    authoredNpcs: {},
    quests: {},
    flags: {},
    modules,
  } as unknown as GameState;
}

describe("THE RECORD carries errands", () => {
  test("an errand in flight renders an [ERRAND] row with the real place and a real ETA", () => {
    const slice = defaultErrandsSlice();
    slice.active["npc.oda"] = ERRAND;
    const lines = recordBriefLines(campaign, stateWith({ [ERRANDS_MODULE]: slice }), world);
    expect(lines.join("\n")).toContain("- [ERRAND] Oda is away at The Counting-House");
    expect(lines.join("\n")).toContain("day 1");
  });

  test("a delivered report renders a [REPORTED] row carrying the finding verbatim", () => {
    const slice = defaultErrandsSlice();
    slice.reports["npc.oda"] = REPORT;
    const lines = recordBriefLines(campaign, stateWith({ [ERRANDS_MODULE]: slice }), world);
    expect(lines.join("\n")).toContain("- [REPORTED] Oda brought back: Oda asked at The Counting-House.");
  });

  test("an errand-ONLY ledger still gets its header — the rows count toward the emptiness check", () => {
    const slice = defaultErrandsSlice();
    slice.active["npc.oda"] = ERRAND;
    expect(recordBriefLines(campaign, stateWith({ [ERRANDS_MODULE]: slice }), world)[0]).toBe("# THE RECORD");
  });

  test("a campaign with no errands renders a byte-identical ledger (none at all here)", () => {
    expect(recordBriefLines(campaign, stateWith({}), world)).toEqual([]);
    expect(recordBriefLines(campaign, stateWith({ [ERRANDS_MODULE]: defaultErrandsSlice() }), world)).toEqual([]);
  });

  test("without the world arg the rows are omitted rather than rendering bare ids", () => {
    const slice = defaultErrandsSlice();
    slice.active["npc.oda"] = ERRAND;
    expect(recordBriefLines(campaign, stateWith({ [ERRANDS_MODULE]: slice }))).toEqual([]);
  });
});
