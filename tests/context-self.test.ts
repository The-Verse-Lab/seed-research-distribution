/**
 * Stage 1 self-perception — the `# YOU` block + trailing `Adjacent:` peek line an autonomous NPC's
 * decide brief gets (never the GM/player brief).
 *
 * The contract under test: `buildNarrationContext`'s new optional `self` field is gated behind a
 * NEW param that the GM/player brief path never passes, so that brief stays BYTE-IDENTICAL to
 * before Stage 1 existed (omit-when-empty, byte-stable-header contract). Only when a caller (the
 * autonomy module) supplies a `self` struct does the block render, and every line inside it is
 * itself omit-when-empty so a statless/bare NPC degrades gracefully.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  buildNarrationContext,
  playerKitLines,
  renderConsequencesBlock,
  renderSelfBlock,
  type SelfInfo,
} from "../src/agents/context.ts";
import { CampaignSchema, WorldSchema, type World } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

function makeWorld(): World {
  return WorldSchema.parse({
    id: "w.self",
    name: "Self",
    summary: "s",
    locations: [
      {
        id: "loc.a",
        name: "A",
        description: "d",
        exits: [
          { to: "loc.market", name: "North Gate" },
          { to: "loc.almshouse", direction: "east" },
        ],
      },
      { id: "loc.market", name: "Market", description: "d" },
      { id: "loc.almshouse", name: "Almshouse", description: "d" },
    ],
    npcs: [],
    items: [
      { id: "itm.dagger", name: "Dagger", kind: "weapon" },
      { id: "itm.potion", name: "Healing Potion", kind: "consumable" },
      { id: "itm.sword", name: "Longsword", kind: "weapon" },
    ],
  });
}

const campaign = CampaignSchema.parse({
  id: "c.self",
  name: "Self",
  worldId: "w.self",
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
  campaignId: "c.self",
  worldId: "w.self",
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

const FULL_SELF: SelfInfo = {
  currentHp: 12,
  maxHp: 20,
  energy: 45,
  maxEnergy: 100,
  exhaustion: 2,
  conditions: ["poisoned", "prone"],
  inventory: ["itm.dagger", "itm.potion", "itm.dagger"],
  coins: 15,
  equipped: ["itm.sword"],
  aim: "find the missing ledger",
  party: "leader",
  adjacent: [
    { name: "North Gate", destination: "Market" },
    { direction: "east", destination: "Almshouse" },
  ],
};

describe("renderSelfBlock", () => {
  test("returns null for an entirely empty self (statless NPC)", () => {
    expect(renderSelfBlock(makeWorld(), {})).toBeNull();
  });

  test("renders every line, resolving item ids to display names and collapsing dupes", () => {
    const block = renderSelfBlock(makeWorld(), FULL_SELF);
    expect(block).toBe(
      [
        "# YOU",
        "Health: 12/20 HP",
        "Energy: 45/100",
        "Exhaustion: 2",
        "Conditions: poisoned, prone",
        "Carrying: Dagger x2, Healing Potion, 1 sp 5 cp",
        "Equipped: Longsword",
        "Your aim: find the missing ledger",
        "Party: leader",
        "Adjacent: through the North Gate lies the Market; the Almshouse lies east.",
      ].join("\n"),
    );
  });

  test("omits Exhaustion at 0/absent, Conditions/Carrying/Equipped when empty, and Party phrasing varies", () => {
    const bare: SelfInfo = { currentHp: 5, maxHp: 5, party: "member" };
    const block = renderSelfBlock(makeWorld(), bare);
    expect(block).toBe(["# YOU", "Health: 5/5 HP", "Party: travelling with the party"].join("\n"));
    expect(block).not.toContain("Exhaustion");
    expect(block).not.toContain("Conditions");
    expect(block).not.toContain("Carrying");
    expect(block).not.toContain("Equipped");

    const notInParty = renderSelfBlock(makeWorld(), { party: "none" });
    expect(notInParty).toBe("# YOU\nParty: not in the party");
  });

  test("a bare direction-less, name-less exit still renders (falls back to 'lies beyond')", () => {
    const block = renderSelfBlock(makeWorld(), { adjacent: [{ destination: "Cellar" }] });
    expect(block).toBe("# YOU\nAdjacent: the Cellar lies beyond.");
  });
});

describe("playerKitLines — the GM brief's real-kit lines (finding #5)", () => {
  test("an empty pack + no coins + nothing equipped ⇒ NO lines (byte-stable)", () => {
    expect(playerKitLines(makeWorld(), { inventory: [], coins: 0, equipped: {} })).toEqual([]);
    expect(playerKitLines(makeWorld(), undefined)).toEqual([]);
  });

  test("carrying items/coins renders a 'You carry:' line with collapsed stacks + names", () => {
    const lines = playerKitLines(makeWorld(), { inventory: ["itm.dagger", "itm.dagger", "itm.potion"], coins: 15 });
    expect(lines).toHaveLength(1);
    const carry = lines[0] ?? "";
    expect(carry.startsWith("You carry:")).toBe(true);
    expect(carry).toContain("Dagger x2");
    expect(carry).toContain("1 sp 5 cp");
  });

  test("equipped gear renders a 'Wielding/worn:' line, resolving ids to names", () => {
    expect(playerKitLines(makeWorld(), { equipped: { weapon: "itm.sword" } })).toEqual(["Wielding/worn: Longsword"]);
  });
});

describe("the GM brief's real-kit line (finding #5)", () => {
  test("the GM/player brief carries the PC's real kit when holding something — never a # YOU block", () => {
    const kitState: GameState = {
      ...state,
      actors: {
        "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.a", inventory: ["itm.dagger"], coins: 8, equipped: { weapon: "itm.sword" }, conditions: [] },
      },
    };
    const ctx = buildNarrationContext({ world: makeWorld(), campaign, state: kitState, recentEvents: [], trigger: "look" });
    expect(ctx.contextText).toContain("You carry:");
    expect(ctx.contextText).toContain("Dagger");
    expect(ctx.contextText).toContain("Wielding/worn: Longsword");
    expect(ctx.contextText).not.toContain("# YOU"); // the kit rides in # LOCATION, not the NPC-decide block
  });

  test("an empty-pack PC keeps the brief byte-identical (omit-when-empty)", () => {
    const emptyState: GameState = {
      ...state,
      actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.a", inventory: [], conditions: [] } },
    };
    const ctx = buildNarrationContext({ world: makeWorld(), campaign, state: emptyState, recentEvents: [], trigger: "look" });
    expect(ctx.contextText).not.toContain("You carry:");
    expect(ctx.contextText).not.toContain("Wielding/worn:");
  });
});

describe("the CONSEQUENCES brief block (Phase 3)", () => {
  test("renderConsequencesBlock renders authoritative outcome lines", () => {
    const block = renderConsequencesBlock(["Maro's regard for you hardens.", "Your notoriety in the region grows."]);
    expect(block).toContain("=== CONSEQUENCES");
    expect(block).toContain("- Maro's regard for you hardens.");
    expect(block).toContain("already happened");
  });

  test("the GM brief carries the block when consequences were bound this turn", () => {
    const ctx = buildNarrationContext({
      world: makeWorld(),
      campaign,
      state,
      recentEvents: [],
      trigger: "look",
      consequences: ["Your notoriety in the region grows."],
    });
    expect(ctx.contextText).toContain("=== CONSEQUENCES");
    expect(ctx.contextText).toContain("Your notoriety in the region grows.");
  });

  test("absent OR empty consequences ⇒ byte-identical (no block)", () => {
    const withNone = buildNarrationContext({ world: makeWorld(), campaign, state, recentEvents: [], trigger: "look" });
    const withEmpty = buildNarrationContext({
      world: makeWorld(),
      campaign,
      state,
      recentEvents: [],
      trigger: "look",
      consequences: [],
    });
    expect(withNone.contextText).toBe(withEmpty.contextText);
    expect(withNone.contextText).not.toContain("CONSEQUENCES");
  });
});

describe("the brief's # YOU / Adjacent: block", () => {
  test("(a) the GM/player brief (no `self` passed) is byte-identical to before Stage 1 existed", () => {
    const withoutSelf = buildNarrationContext({ world: makeWorld(), campaign, state, recentEvents: [], trigger: "look" });
    const explicitlyUndefined = buildNarrationContext({
      world: makeWorld(),
      campaign,
      state,
      recentEvents: [],
      trigger: "look",
      self: undefined,
    });
    expect(withoutSelf.contextText).toBe(explicitlyUndefined.contextText);
    expect(withoutSelf.contextText).not.toContain("# YOU");
    expect(withoutSelf.contextText).not.toContain("Adjacent:");
    // The existing tested header contract is untouched: Body-less LOCATION block still ends the
    // same way, directly into # RECENT.
    expect(withoutSelf.contextText).toContain("Present:");
  });

  test("(b) an NPC decide brief with a populated `self` renders # YOU + Adjacent after LOCATION, before # NOW", () => {
    const ctx = buildNarrationContext({
      world: makeWorld(),
      campaign,
      state,
      recentEvents: [],
      trigger: "Considers what to do.",
      self: FULL_SELF,
    });
    const text = ctx.contextText;
    expect(text).toContain("# YOU");
    expect(text).toContain("Health: 12/20 HP");
    expect(text).toContain("Adjacent: through the North Gate lies the Market; the Almshouse lies east.");
    expect(text.indexOf("# YOU")).toBeGreaterThan(text.indexOf("# LOCATION"));
    expect(text.indexOf("# YOU")).toBeLessThan(text.indexOf("# NOW"));
    expect(text.indexOf("Adjacent:")).toBeLessThan(text.indexOf("# NOW"));
  });

  test("(c) a statless NPC (self: {}) renders neither block — same brief as no `self` at all", () => {
    const statless = buildNarrationContext({
      world: makeWorld(),
      campaign,
      state,
      recentEvents: [],
      trigger: "Considers what to do.",
      self: {},
    });
    const omitted = buildNarrationContext({
      world: makeWorld(),
      campaign,
      state,
      recentEvents: [],
      trigger: "Considers what to do.",
    });
    expect(statless.contextText).toBe(omitted.contextText);
    expect(statless.contextText).not.toContain("# YOU");
    expect(statless.contextText).not.toContain("Adjacent:");
  });
});
