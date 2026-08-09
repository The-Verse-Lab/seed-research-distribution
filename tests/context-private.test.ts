/**
 * Narration-brief private-thread filtering (Phase 6, click-to-chat) — `# RECENT` visibility.
 *
 * Asserts the seam in `buildNarrationContext`: a dialogue event carrying `channel:"private"` is
 * EXCLUDED from `# RECENT` for every consumer except a brief built for one of its two parties
 * (`privateFor` matching `actorId` or `toId`) — the GM and bystander NPCs narrate around private
 * asides; the addressed NPC keeps its own side of the thread. A campaign with zero private
 * messages renders a byte-identical brief whether or not `privateFor` is passed, and a brief with
 * private lines filtered out is byte-identical to one where those events never existed. Pure
 * builder, no engine/gateway/state.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { buildNarrationContext, type ContextInput } from "../src/agents/context.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

const PUBLIC_EVENTS: GameEvent[] = [
  { id: "1", at: 0, seq: 0, kind: "narration", text: "The hall settles into quiet." },
  { id: "2", at: 0, seq: 1, kind: "dialogue", actorId: "pc.you", text: "Fine evening, all.", toId: "npc.a" },
];

const PRIVATE_EVENTS: GameEvent[] = [
  { id: "3", at: 0, seq: 2, kind: "dialogue", actorId: "pc.you", text: "The password is zanzibar.", toId: "npc.a", channel: "private" },
  { id: "4", at: 0, seq: 3, kind: "dialogue", actorId: "npc.a", text: "I will keep it close.", toId: "pc.you", channel: "private" },
];

function baseInput(overrides: Partial<ContextInput> = {}): ContextInput {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Testhold",
    summary: "A quiet vale.",
    locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
    npcs: [{ id: "npc.a", name: "Aster", persona: "Reserved." }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.t",
    name: "C",
    worldId: "w.t",
    characters: [{ id: "pc.you", name: "You", stats: STATS }],
    startingState: { locationId: "loc.room", party: ["pc.you"] },
  });
  const state: GameState = {
    campaignId: "c.t",
    worldId: "w.t",
    partyLocationId: "loc.room",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.room", inventory: [], conditions: [] } },
    quests: {},
    relationships: {},
    autonomy: {},
    flags: {},
  };
  return {
    world,
    campaign,
    state,
    recentEvents: [...PUBLIC_EVENTS, ...PRIVATE_EVENTS],
    trigger: "You look around.",
    ...overrides,
  };
}

describe("buildNarrationContext — private-thread # RECENT filtering", () => {
  test("default (no privateFor — the GM/public path) excludes every private line, keeps public ones", () => {
    const text = buildNarrationContext(baseInput()).contextText;
    expect(text).toContain("Fine evening, all.");
    expect(text).not.toContain("zanzibar");
    expect(text).not.toContain("I will keep it close.");
  });

  test("privateFor = the addressed NPC includes both sides of its own thread", () => {
    const text = buildNarrationContext(baseInput({ privateFor: "npc.a" })).contextText;
    expect(text).toContain("The password is zanzibar.");
    expect(text).toContain("I will keep it close.");
  });

  test("privateFor = the PC (the other party) also includes the thread", () => {
    const text = buildNarrationContext(baseInput({ privateFor: "pc.you" })).contextText;
    expect(text).toContain("zanzibar");
  });

  test("privateFor = an uninvolved third NPC excludes the thread (bystanders never see asides)", () => {
    const text = buildNarrationContext(baseInput({ privateFor: "npc.b" })).contextText;
    expect(text).not.toContain("zanzibar");
    expect(text).not.toContain("I will keep it close.");
  });

  test("a filtered brief is byte-identical to one where the private events never existed", () => {
    const withPrivate = buildNarrationContext(baseInput()).contextText;
    const without = buildNarrationContext(baseInput({ recentEvents: [...PUBLIC_EVENTS] })).contextText;
    expect(withPrivate).toBe(without);
  });

  test("zero private messages ⇒ byte-identical brief with or without privateFor (the filter is inert)", () => {
    const plain = buildNarrationContext(baseInput({ recentEvents: [...PUBLIC_EVENTS] })).contextText;
    const scoped = buildNarrationContext(
      baseInput({ recentEvents: [...PUBLIC_EVENTS], privateFor: "npc.a" }),
    ).contextText;
    expect(scoped).toBe(plain);
  });
});
