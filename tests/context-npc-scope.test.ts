/**
 * NPC-brief witness scoping (r4) — `# RECENT` co-presence filtering.
 *
 * A brief built FOR a specific NPC (`privateFor` — only NPC reply/decide briefs set it) drops
 * narration/dialogue/stateChanged rows whose `presentIds` stamp excludes that NPC: an absent NPC
 * must not quote a scene from across the city (run 4: Oda, waiting at the stair, repeated names
 * spoken only in the Undercroft — including one adjacent to a private whisper). Unstamped rows
 * are fail-open (legacy events, pre-model emits) and the GM/player brief (`privateFor` undefined)
 * is byte-identical with or without stamps. Pure builder, no engine/gateway.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { buildNarrationContext, type ContextInput } from "../src/agents/context.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

// A scene witnessed by the PC and Brann only (npc.oda absent), then an unstamped legacy row.
const EVENTS: GameEvent[] = [
  {
    id: "1",
    at: 0,
    seq: 0,
    kind: "narration",
    text: "In the Undercroft, Brann names the Widow of the Tor.",
    presentIds: ["pc.you", "npc.brann"],
  },
  {
    id: "2",
    at: 0,
    seq: 1,
    kind: "dialogue",
    actorId: "npc.brann",
    text: "Sorrel sold the list. Ask the Paper-Wife.",
    presentIds: ["pc.you", "npc.brann"],
  },
  {
    id: "3",
    at: 0,
    seq: 2,
    kind: "stateChanged",
    summary: "Brann pockets twenty silver.",
    presentIds: ["pc.you", "npc.brann"],
  },
  { id: "4", at: 0, seq: 3, kind: "narration", text: "Bells ring across Anchorfall." }, // unstamped legacy
];

function baseInput(overrides: Partial<ContextInput> = {}): ContextInput {
  const world = WorldSchema.parse({
    id: "w.s",
    name: "Scopehold",
    summary: "A city of quarters.",
    locations: [{ id: "loc.market", name: "The Market", description: "Stalls and salt." }],
    npcs: [
      { id: "npc.oda", name: "Oda", persona: "A wayfarer." },
      { id: "npc.brann", name: "Brann", persona: "A broker." },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.s",
    name: "C",
    worldId: "w.s",
    characters: [{ id: "pc.you", name: "You", stats: STATS }],
    startingState: { locationId: "loc.market", party: ["pc.you"] },
  });
  const state: GameState = {
    campaignId: "c.s",
    worldId: "w.s",
    partyLocationId: "loc.market",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.market", inventory: [], conditions: [] } },
    quests: {},
    relationships: {},
    autonomy: {},
    flags: {},
  };
  return { world, campaign, state, recentEvents: EVENTS, trigger: "You return to the market.", ...overrides };
}

describe("buildNarrationContext — witness scoping of # RECENT for NPC briefs", () => {
  test("an NPC absent from the stamped scene loses all three row kinds; unstamped rows survive", () => {
    const text = buildNarrationContext(baseInput({ privateFor: "npc.oda" })).contextText;
    expect(text).not.toContain("names the Widow of the Tor");
    expect(text).not.toContain("Sorrel sold the list");
    expect(text).not.toContain("pockets twenty silver");
    expect(text).toContain("Bells ring across Anchorfall."); // fail-open legacy row
  });

  test("a witness keeps the rows it saw", () => {
    const text = buildNarrationContext(baseInput({ privateFor: "npc.brann" })).contextText;
    expect(text).toContain("names the Widow of the Tor");
    expect(text).toContain("Sorrel sold the list");
    expect(text).toContain("pockets twenty silver");
  });

  test("the GM/player brief (no privateFor) ignores stamps entirely — byte-identical scene history", () => {
    const text = buildNarrationContext(baseInput()).contextText;
    expect(text).toContain("names the Widow of the Tor");
    expect(text).toContain("Sorrel sold the list");
    expect(text).toContain("pockets twenty silver");
    expect(text).toContain("Bells ring across Anchorfall.");
  });
});
