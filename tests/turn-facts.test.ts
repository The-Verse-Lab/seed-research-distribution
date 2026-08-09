/**
 * TURN FACTS — the narrator's positive ground truth (`src/rules/turn-facts.ts`).
 *
 * Pins the rendered fact line for every whitelisted command kind (player vs NPC phrasing), the
 * whitelist boundary (silent bookkeeping renders nothing, so briefs stay byte-identical), the
 * flood cap, and the block renderer's framing text.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { TURN_FACT_COMMANDS, turnFactLines } from "../src/rules/turn-facts.ts";
import { renderTurnFactsBlock } from "../src/agents/context.ts";
import type { Command } from "../src/world/commands.ts";
import type { WorldModel } from "../src/world/model.ts";
import type { Entity } from "../src/world/entity.ts";
import type { Item, World } from "../src/content/schema.ts";

const ent = (id: string, name: string, kind: Entity["kind"], partyMember = false): [string, Entity] => [
  id,
  { id, kind, tier: "significant", name, locationId: "loc.inn", partyMember, flags: {} },
];

const model = {
  entities: new Map<string, Entity>([
    ent("pc.you", "Ash", "pc", true),
    ent("npc.sela", "Sela", "npc"),
    ent("mon.rev", "Salt Revenant", "monster"),
  ]),
} as WorldModel;

const world: Pick<World, "items" | "locations"> = {
  items: [
    { id: "it.club", name: "Club" } as Item,
    { id: "it.stew", name: "Bowl of Stew" } as Item,
  ],
  locations: [{ id: "loc.yard", name: "Way-house Yard" }] as World["locations"],
};

const facts = (...commands: Command[]): string[] => turnFactLines(world, model, commands);

describe("turnFactLines", () => {
  test("item transfers phrase by direction (drop / pickup / give / receive)", () => {
    expect(facts({ type: "transferItem", itemId: "it.club", from: "pc.you", to: null })).toEqual([
      "You set down the Club — it is no longer in your possession.",
    ]);
    expect(facts({ type: "transferItem", itemId: "it.club", from: null, to: "pc.you" })).toEqual([
      "You picked up the Club — it is now in your pack.",
    ]);
    expect(facts({ type: "transferItem", itemId: "it.stew", from: "pc.you", to: "npc.sela" })).toEqual([
      "You gave the Bowl of Stew to Sela.",
    ]);
    expect(facts({ type: "transferItem", itemId: "it.stew", from: "npc.sela", to: "pc.you" })).toEqual([
      "Sela gave you the Bowl of Stew.",
    ]);
  });

  test("trades carry vendor, direction, and the formatted price", () => {
    expect(
      facts({ type: "tradeWith", pcId: "pc.you", vendorId: "npc.sela", itemId: "it.stew", direction: "buy", priceCp: 20 }),
    ).toEqual(["You bought the Bowl of Stew from Sela for 2 sp."]);
    expect(
      facts({ type: "tradeWith", pcId: "pc.you", vendorId: "npc.sela", itemId: "it.club", direction: "sell", priceCp: 105 }),
    ).toEqual(["You sold the Club to Sela for 1 gp 5 cp."]);
  });

  test("coin adjustments read as paid/received; zero renders nothing", () => {
    expect(facts({ type: "adjustCoins", entityId: "pc.you", by: -20 })).toEqual([
      "You paid out 2 sp — your purse is lighter by exactly that.",
    ]);
    expect(facts({ type: "adjustCoins", entityId: "pc.you", by: 350 })).toEqual([
      "You received 3 gp 5 sp into your purse.",
    ]);
    expect(facts({ type: "adjustCoins", entityId: "npc.sela", by: -10 })).toEqual(["Sela paid out 1 sp."]);
    expect(facts({ type: "adjustCoins", entityId: "pc.you", by: 0 })).toEqual([]);
  });

  test("equip, condition, XP, and party movement each render one salient line", () => {
    expect(facts({ type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: "it.club" })).toEqual([
      "You equipped the Club.",
    ]);
    expect(facts({ type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: null })).toEqual([
      "You unequipped the weapon.",
    ]);
    expect(facts({ type: "setCondition", entityId: "mon.rev", condition: "unconscious", active: true })).toEqual([
      "Salt Revenant went DOWN — unconscious.",
    ]);
    expect(facts({ type: "setCondition", entityId: "pc.you", condition: "restrained", active: false })).toEqual([
      "You are no longer restrained.",
    ]);
    expect(facts({ type: "grantXp", entityId: "pc.you", by: 35, baseLevel: 1 })).toEqual(["You gained 35 XP."]);
    expect(facts({ type: "moveParty", to: "loc.yard", solo: true })).toEqual(["You moved to Way-house Yard."]);
    expect(facts({ type: "moveParty", to: "loc.yard" })).toEqual(["You and your party moved to Way-house Yard."]);
  });

  test("silent bookkeeping renders NOTHING (whitelist boundary — briefs stay byte-identical)", () => {
    expect(
      facts(
        { type: "advanceClock", by: 30 },
        { type: "adjustEnergy", entityId: "pc.you", by: -5 },
        { type: "modulePatch", module: "sightings", patch: {} },
      ),
    ).toEqual([]);
    expect(TURN_FACT_COMMANDS.has("advanceClock")).toBe(false);
    expect(TURN_FACT_COMMANDS.has("adjustEnergy")).toBe(false);
  });

  test("a flood of commands caps at 12 lines (prompt-bloat guard)", () => {
    const many: Command[] = Array.from({ length: 20 }, () => ({
      type: "transferItem" as const,
      itemId: "it.club",
      from: "pc.you",
      to: null,
    }));
    expect(facts(...many).length).toBe(12);
  });

  test("unknown ids degrade to a readable display name, never throw", () => {
    // Playtest r9 F-9: a raw id leaking into player-facing text ("item.strongbox" on the sheet) is
    // a labels-contract break — unresolved ids now render through itemDisplayNameOf everywhere.
    expect(facts({ type: "transferItem", itemId: "it.mystery", from: "npc.ghost", to: "pc.you" })).toEqual([
      "npc.ghost gave you the Mystery.",
    ]);
  });
});

describe("renderTurnFactsBlock", () => {
  test("frames the lines as the ONLY changes and forbids confirming anything else", () => {
    const block = renderTurnFactsBlock(["You paid out 2 sp — your purse is lighter by exactly that."]);
    expect(block).toContain("=== TURN FACTS (authoritative — the only mechanical changes this turn) ===");
    expect(block).toContain("- You paid out 2 sp");
    expect(block).toContain("did NOT mechanically happen");
  });
});
