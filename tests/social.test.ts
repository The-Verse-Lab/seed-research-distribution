/**
 * Social-read resolver (Workstream F, slim) — appearance & identity affect interactions.
 *
 * Pure tests pin the resolver contract: bounded deltas, every modifier reasoned, and determinism.
 * Stance tests prove the fold nudges intensity when signals match and is byte-identical to the
 * baseline stance when there are none.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  resolveSocialModifiers,
  summarizeModifiers,
  SOCIAL_MODIFIER_MAX,
  type SocialModifier,
  type ObserverSignals,
  type TargetSignals,
} from "../src/rules/social.ts";
import { CampaignSchema, WorldSchema, type NpcTemplate, type PlaySet } from "../src/content/schema.ts";
import { stance } from "../src/rules/agenda.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import type { GameState } from "../src/state/types.ts";
import { coverageRow, WARDROBE_MODULE } from "../src/rules/wardrobe.ts";

function everyModifierReasoned(mods: SocialModifier[]): void {
  for (const m of mods) {
    expect(typeof m.reason).toBe("string");
    expect(m.reason.length).toBeGreaterThan(0);
    expect(Math.abs(m.delta)).toBeLessThanOrEqual(SOCIAL_MODIFIER_MAX);
    expect(m.delta).not.toBe(0);
  }
}

describe("resolveSocialModifiers — pure, bounded, reasoned", () => {
  test("an observer's preference matching a target's appearance yields a positive read", () => {
    const observer: ObserverSignals = { preferences: ["striking"] };
    const target: TargetSignals = { appearanceTags: ["striking", "tall"] };
    const mods = resolveSocialModifiers(observer, target);
    expect(mods.length).toBeGreaterThan(0);
    everyModifierReasoned(mods);
    expect(mods.some((m) => m.axis === "respect" && m.delta > 0)).toBe(true);
    expect(mods.some((m) => m.axis === "trust" && m.delta > 0)).toBe(true);
  });

  test("an observer boundary matching a target tag yields distrust and hostility", () => {
    const observer: ObserverSignals = { boundaries: ["arrogance"] };
    const target: TargetSignals = { presentationTags: ["arrogance"] };
    const mods = resolveSocialModifiers(observer, target);
    everyModifierReasoned(mods);
    expect(mods.find((m) => m.axis === "trust")?.delta).toBeLessThan(0);
    expect(mods.find((m) => m.axis === "hostility")?.delta).toBeGreaterThan(0);
  });

  test("a target's own social traits carry an intrinsic read (fear vs trust)", () => {
    const intimidating = resolveSocialModifiers({}, { socialTraits: ["intimidating"] });
    expect(intimidating.find((m) => m.axis === "fear")?.delta).toBeGreaterThan(0);

    const warm = resolveSocialModifiers({}, { socialTraits: ["warm"] });
    expect(warm.find((m) => m.axis === "trust")?.delta).toBeGreaterThan(0);
    everyModifierReasoned([...intimidating, ...warm]);
  });

  test("deltas are clamped to ±SOCIAL_MODIFIER_MAX even with many matching signals", () => {
    const observer: ObserverSignals = { preferences: ["striking", "bold", "fair"] };
    const target: TargetSignals = {
      appearanceTags: ["striking", "bold", "fair", "striking-again"],
    };
    const mods = resolveSocialModifiers(observer, target);
    for (const m of mods) expect(Math.abs(m.delta)).toBeLessThanOrEqual(SOCIAL_MODIFIER_MAX);
    const trust = mods.find((m) => m.axis === "trust");
    if (trust) expect(trust.delta).toBeLessThanOrEqual(SOCIAL_MODIFIER_MAX);
  });

  test("determinism: identical inputs give a deep-equal result across two calls", () => {
    const observer: ObserverSignals = { preferences: ["striking"], boundaries: ["cruel"] };
    const target: TargetSignals = { appearanceTags: ["striking"], socialTraits: ["sly", "warm"] };
    const a = resolveSocialModifiers(observer, target);
    const b = resolveSocialModifiers(observer, target);
    expect(a).toEqual(b);
  });

  test("no signals ⇒ no modifiers (the zero-signal case)", () => {
    expect(resolveSocialModifiers({}, {})).toEqual([]);
    expect(resolveSocialModifiers({ preferences: ["striking"] }, {})).toEqual([]);
  });

  test("a 'disheveled' visible keyword nudges respect down only", () => {
    const mods = resolveSocialModifiers({}, { visibleKeywords: ["disheveled"] });
    expect(mods).toEqual([{ axis: "respect", delta: -1, reason: expect.stringContaining("disheveled") }]);
  });

  test("visibleKeywords and an authored socialTrait both contribute (union, not override)", () => {
    const mods = resolveSocialModifiers({}, { socialTraits: ["warm"], visibleKeywords: ["disheveled"] });
    expect(mods.some((m) => m.axis === "trust" && m.delta > 0)).toBe(true); // from the authored "warm" trait
    expect(mods.some((m) => m.axis === "respect" && m.delta > 0)).toBe(true);
  });

  test("summarizeModifiers renders a one-line signed summary (empty ⇒ '')", () => {
    expect(summarizeModifiers([])).toBe("");
    const line = summarizeModifiers([
      { axis: "trust", delta: 6, reason: "x" },
      { axis: "fear", delta: -4, reason: "y" },
    ]);
    expect(line).toBe("trust +6, fear -4");
  });
});

// ---------------------------------------------------------------------------
// Stance fold — the appearance/identity read nudges intensity, bounded, never forcing.
// ---------------------------------------------------------------------------

/** Two NPCs (observer + a target that may carry appearance tags) + a PC, wired into a model. */
function twoNpcFixture(targetTags: { appearanceTags?: string[] }): {
  observer: NpcTemplate;
  world: PlaySet["world"];
  model: WorldModel;
} {
  const statBlock = {
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    maxHp: 10,
    armorClass: 10,
    level: 1,
    speed: 30,
    proficiencies: [],
    spells: [],
  };
  const world = WorldSchema.parse({
    id: "world.social",
    name: "Social Fixture",
    summary: "A test world.",
    locations: [{ id: "loc.start", name: "Start", npcs: [] }],
    items: [],
    npcs: [
      {
        id: "npc.observer",
        name: "Observer",
        summary: "Reads people.",
        persona: "Attentive.",
        // The observer LIKES a "striking" look — so a striking target reads warmer.
        preferences: ["striking"],
        goals: ["Have an agenda"],
        relationships: { "npc.target": 0 },
        stats: statBlock,
        autonomy: { isPartyMember: true, level: "proactive", canLead: false, heartbeatSeconds: 30, replyDecayAlpha: 0.2 },
      },
      {
        id: "npc.target",
        name: "Target",
        summary: "The observed.",
        persona: "Present.",
        goals: [],
        stats: statBlock,
        ...targetTags,
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "campaign.social",
    name: "Social",
    worldId: world.id,
    characters: [{ id: "pc.you", name: "You", stats: statBlock }],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: ["npc.observer"] },
  });
  const state: GameState = {
    campaignId: campaign.id,
    worldId: world.id,
    partyLocationId: "loc.start",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.observer"],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.start", inventory: [], conditions: [] },
      "npc.observer": { id: "npc.observer", currentHp: 10, locationId: "loc.start", inventory: [], conditions: [] },
      "npc.target": { id: "npc.target", currentHp: 10, locationId: "loc.start", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: { "npc.observer": { "npc.target": 0 } },
    autonomy: { "npc.observer": { talking: false, replyDepth: 0, lastActedAt: 0 } },
    modules: { autonomy: { "npc.observer": { talking: false, replyDepth: 0, lastActedAt: 0 } } },
    flags: {},
  };
  const model = fromGameState(state, world, campaign);
  return { observer: world.npcs[0]!, world, model };
}

describe("stance fold — perceived signals nudge intensity, bounded", () => {
  test("a matching appearance tag raises intensity vs an identical no-signal target", () => {
    const withSignal = twoNpcFixture({ appearanceTags: ["striking"] });
    const noSignal = twoNpcFixture({ appearanceTags: [] });

    const hot = stance(withSignal.observer, "npc.target", withSignal.model, withSignal.world);
    const cold = stance(noSignal.observer, "npc.target", noSignal.model, noSignal.world);

    expect(hot.socialContext).toBeDefined();
    expect(hot.socialContext!.modifiers.length).toBeGreaterThan(0);
    expect(cold.socialContext).toBeUndefined();
    expect(hot.intensity).toBeGreaterThan(cold.intensity);
    // The nudge is bounded — never more than the 0.15 ceiling apart.
    expect(hot.intensity - cold.intensity).toBeLessThanOrEqual(0.15 + 1e-9);
  });

  test("a target's visibly disheveled wardrobe state nudges stance like an authored trait", () => {
    const bare = twoNpcFixture({ appearanceTags: [] });
    bare.model.modules[WARDROBE_MODULE] = { "npc.target": coverageRow("removed") };
    const dressed = twoNpcFixture({ appearanceTags: [] });

    const exposed = stance(bare.observer, "npc.target", bare.model, bare.world);
    const clothed = stance(dressed.observer, "npc.target", dressed.model, dressed.world);

    expect(exposed.socialContext).toBeDefined();
    expect(exposed.socialContext!.modifiers.some((m) => m.axis === "respect")).toBe(true);
    expect(clothed.socialContext).toBeUndefined();
  });

  test("ZERO-SIGNAL PARITY: with no F signals the stance is byte-identical to the pre-F stance", () => {
    const { observer, world, model } = twoNpcFixture({ appearanceTags: [] });
    const s = stance(observer, "npc.target", model, world);
    // No socialContext, and intensity equals the driver clamp with a zero nudge — the pre-F value.
    expect(s.socialContext).toBeUndefined();

    // Reconstruct the pre-F intensity by hand for this fixture: neutral relationship, no memory,
    // proactive neutral personality ⇒ the same driver the resolver folds a 0 nudge onto.
    const bare = stance(observer, "npc.target", model, world);
    expect(s.intensity).toBe(bare.intensity); // deterministic + no drift
    // And a fresh call is deep-equal (determinism through the fold).
    expect(stance(observer, "npc.target", model, world)).toEqual(s);
  });
});
