/**
 * Input shapes for the narrator brief, shared by the byte-identity spec and the fixture generator.
 *
 * They live here rather than inside the spec so the golden file and the assertions can never drift
 * apart: regenerating the golden and checking it are the same inputs by construction. Each fixture
 * exists to toggle a different set of blocks on — an empty world, a full `# LOCATION` line-stack, the
 * grounding stack, every current-action block at once, and an NPC audience (which must NOT receive
 * narrator-only authority).
 *
 * @author Runkai Zhang
 */
import type { ContextInput } from "../../src/agents/context.ts";
import { CampaignSchema, WorldSchema, type Campaign, type World } from "../../src/content/schema.ts";
import type { GameState } from "../../src/state/types.ts";

export const briefWorld: World = WorldSchema.parse({
  id: "w.reg",
  name: "Registry",
  summary: "A cold shore where the tide keeps the accounts.",
  locations: [
    {
      id: "loc.quay",
      name: "The Quay",
      description: "Wet stone, rope, and the smell of low tide.",
      region: "harbor",
      // Rostering matters: an NPC on no location roster is a spawn-only crowd template, and the
      // canon-name registry deliberately ignores those. Veil is near, Oda is a region away — so
      // these two fixtures exercise BOTH canon tiers.
      npcs: ["npc.veil"],
      exits: [{ to: "loc.road", name: "the east road", minutes: 60, direction: "east" }],
    },
    { id: "loc.road", name: "The East Road", description: "Ruts and gorse.", region: "inland", npcs: ["npc.oda"] },
  ],
  npcs: [
    {
      id: "npc.veil",
      name: "Veil",
      summary: "A muster-clerk who reads the crowd like a tide table.",
      sex: "female",
      socialRole: "muster-clerk",
      persona: "Flat, unhurried, scarred.",
      knowledge: [],
    },
    {
      id: "npc.oda",
      name: "Oda",
      summary: "A wayfarer with a compass-rose tattoo.",
      sex: "male",
      persona: "Patient.",
      knowledge: [],
    },
  ],
});

export const briefCampaign: Campaign = CampaignSchema.parse({
  id: "c.reg",
  name: "Registry",
  worldId: "w.reg",
  characters: [
    {
      id: "pc.you",
      name: "You",
      stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 },
    },
  ],
  startingState: { locationId: "loc.quay", party: ["pc.you"], companions: [] },
});

const baseState: GameState = {
  campaignId: "c.reg",
  worldId: "w.reg",
  partyLocationId: "loc.quay",
  clock: 480,
  party: ["pc.you"],
  companions: [],
  actors: {},
  quests: {},
  relationships: {},
  autonomy: {},
  modules: {},
  flags: {},
};

export const BRIEF_FIXTURES: Record<string, ContextInput> = {
  minimal: {
    world: briefWorld,
    campaign: briefCampaign,
    state: baseState,
    trigger: "I look around.",
    recentEvents: [],
  },
  locationStack: {
    world: briefWorld,
    campaign: briefCampaign,
    state: { ...baseState, clock: 1250 },
    trigger: "I watch the crowd.",
    recentEvents: [],
    exits: ["the east road"],
    present: [
      { id: "npc.veil", name: "Veil", summary: "A muster-clerk.", sex: "female", looks: "Scarred brow." },
      { id: "npc.oda", name: "Oda", summary: "A wayfarer.", sex: "male", partyMember: true },
      { id: "x.crowd", name: "A porter", local: true },
    ],
  },
  groundingStack: {
    world: briefWorld,
    campaign: briefCampaign,
    state: baseState,
    trigger: "I ask about the caravan.",
    recentEvents: [],
    storySoFar: "You came ashore at Anchorfall and took the bond-writ.",
    established: ["Veil said the lantern was spoken for.", "Oda claims the west road is watched."],
    lore: ["The coast broke in the Long Winter."],
  },
  actionStack: {
    world: briefWorld,
    campaign: briefCampaign,
    state: baseState,
    trigger: "I swing at the wight.",
    recentEvents: [],
    resolved: { label: "Attack", dc: 12, total: 17, success: true, critical: null, damage: 5, damageType: "slashing" },
    consequences: ["Veil's regard falls."],
    turnFacts: ["You lose 5 HP."],
    turnEvents: ["The lantern gutters."],
  },
  npcAudience: {
    world: briefWorld,
    campaign: briefCampaign,
    state: baseState,
    trigger: "Veil, what do you know?",
    recentEvents: [],
    audience: { kind: "npc", npcId: "npc.veil" },
    storySoFar: "This must not reach a character's prompt.",
    present: [{ id: "npc.veil", name: "Veil", summary: "A muster-clerk." }],
  },
};
