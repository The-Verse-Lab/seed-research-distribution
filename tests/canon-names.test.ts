/**
 * The canon-name registry — the block that stops the narrator minting a character on top of a real
 * one, and the two tiers that stop it costing a fifth of every prompt.
 *
 * The bug it answers (r2 P1): the narrator invented a girl and named her Tamsin. Every later NPC
 * reply grounded that name to the real, MALE Tamsin, and two days of play were void. So the property
 * that actually matters is COMPLETENESS of the name list — a name missing from the block is a name
 * free to be reused. The flat version of this block silently capped at 60 rows on a 66-NPC world,
 * which is exactly the hole it was built to close.
 *
 * The tiering is the size fix: a described row (name + sex + role) for people this scene could
 * plausibly discuss, a bare name for everyone else under a rail saying they are unknown here. On the
 * shipped world that is ~67% smaller and, unlike the flat list, drops nothing.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { buildNarrationContext } from "../src/agents/context.ts";
import { CampaignSchema, WorldSchema, type World } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

function makeWorld(): World {
  return WorldSchema.parse({
    id: "w.canon",
    name: "Canon",
    summary: "s",
    locations: [
      { id: "loc.here", name: "Here", description: "d", region: "near", npcs: ["npc.near", "npc.present"] },
      { id: "loc.there", name: "There", description: "d", region: "far", npcs: ["npc.far", "npc.discussed"] },
    ],
    npcs: [
      {
        id: "npc.near",
        name: "Sergeant Veil",
        summary: "A muster-clerk.",
        persona: "Flat.",
        sex: "female",
        socialRole: "the Free Lances' muster-clerk, keeper of the Anchorfall contract-board",
        knowledge: [],
      },
      { id: "npc.present", name: "Oda", summary: "A wayfarer.", persona: "Patient.", sex: "male", socialRole: "caravan-guide", knowledge: [] },
      { id: "npc.far", name: "Osric, the Tithe-Clerk", summary: "A clerk.", persona: "Dry.", sex: "male", socialRole: "tithe-clerk", knowledge: [] },
      { id: "npc.discussed", name: "Tamsin", summary: "A salvager.", persona: "Wry.", sex: "male", socialRole: "freelance salvager", knowledge: [] },
      // Spawn-only: on NO location roster. A generic crowd label is not a name the world introduced.
      { id: "npc.crowd", name: "Undercroft Shadow", summary: "Scenery.", persona: "Silent.", knowledge: [] },
    ],
  });
}

const campaign = CampaignSchema.parse({
  id: "c.canon",
  name: "Canon",
  worldId: "w.canon",
  characters: [
    {
      id: "pc.you",
      name: "You",
      stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 },
    },
  ],
  startingState: { locationId: "loc.here", party: ["pc.you"], companions: [] },
});

const state: GameState = {
  campaignId: "c.canon",
  worldId: "w.canon",
  partyLocationId: "loc.here",
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

const world = makeWorld();
const briefOf = (extra: Record<string, unknown> = {}): string =>
  buildNarrationContext({
    world,
    campaign,
    state,
    trigger: "I look around.",
    recentEvents: [],
    ...extra,
  } as Parameters<typeof buildNarrationContext>[0]).contextText;

/** The `# CANON NAMES` block only, without the surrounding brief. */
function canonBlock(brief: string): string {
  const at = brief.indexOf("# CANON NAMES");
  if (at < 0) return "";
  return brief.slice(at).split("\n\n")[0]!;
}

describe("the canon-name registry", () => {
  test("someone in this region gets a described row; someone a region away is name-only", () => {
    const block = canonBlock(briefOf());
    expect(block).toContain("- Sergeant Veil (female) — the Free Lances' muster-clerk");
    expect(block).toContain("Also taken (unknown here):");
    expect(block).toContain("Osric, the Tithe-Clerk");
    // The distant person is listed, but WITHOUT a role — nothing for the narrator to build on.
    expect(block).not.toContain("- Osric, the Tithe-Clerk (male)");
  });

  test("the role is cut to its head clause — the identity, not the colour", () => {
    // Authored `socialRole` runs to a full editorial sentence; across a 60-name roster that phrasing
    // was the single largest block in the brief.
    expect(canonBlock(briefOf())).not.toContain("keeper of the Anchorfall contract-board");
  });

  test("a distant person the scene is already discussing earns their role back", () => {
    // The turn is ABOUT them, so their identity is exactly what must not be improvised.
    const block = canonBlock(briefOf({ established: ["Tamsin was seen at the diggings."] }));
    expect(block).toContain("- Tamsin (male) — freelance salvager");
  });

  test("every rostered name appears somewhere — the list is never truncated", () => {
    // Completeness is the load-bearing property: a name missing here is a name free to be reused.
    const block = canonBlock(briefOf());
    for (const name of ["Sergeant Veil", "Osric, the Tithe-Clerk", "Tamsin"]) expect(block).toContain(name);
  });

  test("a spawn-only crowd template is not a canon name", () => {
    expect(canonBlock(briefOf())).not.toContain("Undercroft Shadow");
  });

  test("a present NPC is omitted — the Present: line already establishes them", () => {
    const block = canonBlock(briefOf({ present: [{ id: "npc.present", name: "Oda", summary: "A wayfarer." }] }));
    expect(block).not.toContain("Oda");
  });

  test("names carrying their own commas survive the bare list", () => {
    // ` · ` rather than ", ": "Osric, the Tithe-Clerk" would otherwise read as two people.
    const bare = canonBlock(briefOf()).split("Also taken (unknown here): ")[1]!;
    expect(bare.split(" · ")).toContain("Osric, the Tithe-Clerk");
  });

  test("an NPC-projected brief carries no registry at all", () => {
    // A character does not invent named characters, so the block would be pure token cost AND a leak
    // of the whole world roster into one person's knowledge.
    const brief = briefOf({ audience: { kind: "npc", npcId: "npc.near" } });
    expect(brief).not.toContain("# CANON NAMES");
  });

  test("on the bundled world it stays cheap and still names everyone", async () => {
    // The size claim only means anything beyond the tiny fixture above. This guards both prompt
    // cost and completeness on the complete bundled recurring cast.
    const { loadPlaySetFromDir } = await import("../src/content/loader.ts");
    const { isRosteredNpc } = await import("../src/world/queries.ts");
    const ps = await loadPlaySetFromDir("worlds/wakeward-isles");
    const brief = buildNarrationContext({
      world: ps.world,
      campaign: ps.campaign,
      state: {
        ...state,
        campaignId: ps.campaign.id,
        worldId: ps.world.id,
        partyLocationId: ps.campaign.startingState.locationId,
        party: ps.campaign.startingState.party,
      },
      trigger: "I look around.",
      recentEvents: [],
    }).contextText;
    const block = canonBlock(brief);
    expect(block.length).toBeLessThan(2000);
    // Every rostered name is still spent — described or bare, but never dropped.
    for (const npc of ps.world.npcs) {
      if (isRosteredNpc(ps.world, npc)) expect(block, `missing canon name: ${npc.name}`).toContain(npc.name);
    }
  });
});
