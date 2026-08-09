/**
 * The PC's paper-doll wardrobe state reaching the shared narrator/NPC brief — the `Attire:` line —
 * plus the generalized `Visibly:` line (non-attire visible facts) that rides directly after it.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { attireLineOf, buildNarrationContext, visiblyLineOf } from "../src/agents/context.ts";
import {
  attireDescriptor,
  attireStateOf,
  coverageRow,
  escalateCoverageRow,
  isClothingText,
  occupiedSlotsOf,
  SLOT_STATE_RANK,
  strongerSlotState,
  wardrobeLockOf,
  type WardrobeSlotId,
  type WardrobeSlotState,
} from "../src/rules/wardrobe.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

describe("escalateCoverageRow (monotone strip — never re-dresses)", () => {
  test("shared strongerSlotState is commutative and always returns the maximum severity", () => {
    const states: WardrobeSlotState[] = ["worn", "displaced", "removed"];
    for (const a of states) {
      for (const b of states) {
        const expected = SLOT_STATE_RANK[a] >= SLOT_STATE_RANK[b] ? a : b;
        expect(strongerSlotState(a, b)).toBe(expected);
        expect(strongerSlotState(b, a)).toBe(expected);
      }
    }
  });

  test("from an EMPTY row it is exactly coverageRow(state) — the pinned monotone-write equality", () => {
    expect(escalateCoverageRow({}, "displaced")).toEqual(coverageRow("displaced"));
    expect(escalateCoverageRow({}, "removed")).toEqual(coverageRow("removed"));
  });

  test("escalating a `displaced` band to `removed` removes every coverage slot", () => {
    expect(escalateCoverageRow(coverageRow("displaced"), "removed")).toEqual(coverageRow("removed"));
  });

  test("seeding `displaced` over an already-`removed` band keeps `removed` (no re-dress)", () => {
    expect(escalateCoverageRow(coverageRow("removed"), "displaced")).toEqual(coverageRow("removed"));
  });

  test("per-slot: only slots below the target advance; stronger slots are untouched", () => {
    const mixed = { upper: "removed" as const, lower: "worn" as const };
    const out = escalateCoverageRow(mixed, "displaced");
    expect(out.upper).toBe("removed"); // already stronger — kept
    expect(out.lower).toBe("displaced"); // was worn — escalated
  });
});

describe("wardrobeLockOf", () => {
  test("projects one reason for combat and captivity", () => {
    expect(wardrobeLockOf({ modules: {} })).toEqual({ locked: false });
    expect(wardrobeLockOf({ modules: { combat: { active: true } } })).toEqual({
      locked: true,
      reason: "Not while blades are out — sort your clothing after the fight.",
    });
    expect(wardrobeLockOf({ modules: { captivity: { active: true } } })).toEqual({
      locked: true,
      reason: "Your clothing is out of reach while you are held captive.",
    });
  });

  test("combat retains priority when stale lock modules overlap", () => {
    expect(
      wardrobeLockOf({
        modules: {
          combat: { active: true },
          captivity: { active: true },
        },
      }).reason,
    ).toContain("blades are out");
  });
});

describe("attireStateOf", () => {
  test("undefined when every coverage slot is worn or unset", () => {
    expect(attireStateOf(undefined)).toBeUndefined();
    expect(attireStateOf({})).toBeUndefined();
    expect(attireStateOf({ upper: "worn", lower: "worn" })).toBeUndefined();
  });

  test("removing accessories only (head/hands/feet) never reads as undressed", () => {
    expect(attireStateOf({ head: "removed", hands: "removed", feet: "removed" })).toBeUndefined();
  });

  test("disheveled once any coverage slot is displaced or removed, short of all", () => {
    expect(attireStateOf({ upper: "removed" })).toBe("disheveled");
    expect(attireStateOf({ lower: "displaced" })).toBe("disheveled");
  });

  test("bare only when every coverage slot is removed", () => {
    const allRemoved = {
      "over-upper": "removed",
      upper: "removed",
      "under-upper": "removed",
      "over-lower": "removed",
      lower: "removed",
      "under-lower": "removed",
    } as const;
    expect(attireStateOf(allRemoved)).toBe("bare");
  });

  test("attireDescriptor phrases each state as a plain fact", () => {
    expect(attireDescriptor("bare")).toBe("no clothing worn");
    expect(attireDescriptor("disheveled")).toContain("not fully dressed");
  });

  // Occupancy: without it, the four coverage slots a two-garment character never dresses default to
  // "worn" forever, so a full strip of everything they actually own reads merely "disheveled".
  test("a two-garment character reaches bare by removing only what they own", () => {
    const occupied = new Set<WardrobeSlotId>(["upper", "lower"]);
    expect(attireStateOf({ upper: "removed", lower: "removed" }, occupied)).toBe("bare");
    expect(attireStateOf({ upper: "removed" }, occupied)).toBe("disheveled");
    expect(attireStateOf({ upper: "worn", lower: "worn" }, occupied)).toBeUndefined();
  });

  test("a fully-occupied character still needs all six coverage slots removed for bare", () => {
    const occupied = new Set<WardrobeSlotId>([
      "over-upper",
      "upper",
      "under-upper",
      "over-lower",
      "lower",
      "under-lower",
    ]);
    expect(attireStateOf({ upper: "removed", lower: "removed" }, occupied)).toBe("disheveled");
    expect(attireStateOf(coverageRow("removed"), occupied)).toBe("bare");
  });

  test("an empty occupancy signal keeps today's conservative all-slots read", () => {
    expect(attireStateOf({ upper: "removed", lower: "removed" }, new Set())).toBe("disheveled");
    expect(attireStateOf(coverageRow("removed"), new Set())).toBe("bare");
  });

  // Accessory-only occupancy: the character dresses NO coverage slot, so there is nothing whose
  // removal could make them "bare" relative to their own baseline — no attire state to report.
  test("accessory-only occupancy (no coverage garments) reports no attire state", () => {
    const occupied = new Set<WardrobeSlotId>(["head", "hands", "feet"]);
    expect(attireStateOf({ upper: "removed", lower: "removed" }, occupied)).toBeUndefined();
    expect(attireStateOf(coverageRow("removed"), occupied)).toBeUndefined();
  });

  test("coverageRow writes the whole coverage band at one state", () => {
    expect(attireStateOf(coverageRow("removed"))).toBe("bare");
    expect(attireStateOf(coverageRow("displaced"))).toBe("disheveled");
    expect(attireStateOf(coverageRow("worn"))).toBeUndefined();
  });
});

describe("occupiedSlotsOf", () => {
  test("maps clothing terms in a text blob to the slots they cover", () => {
    expect(occupiedSlotsOf("She wears a homespun tunic and a patched skirt.")).toEqual(
      new Set<WardrobeSlotId>(["upper", "lower"]),
    );
  });

  test("scans one blob for however many slots it names, accessories and layers alike", () => {
    const slots = occupiedSlotsOf("A weathered cloak over a shirt, breeches, gloves, and mud-caked boots; a deep hood.");
    expect(slots).toEqual(new Set<WardrobeSlotId>(["head", "over-upper", "upper", "hands", "lower", "feet"]));
  });

  test("case-insensitive, and underclothes cover both underlayers", () => {
    expect(occupiedSlotsOf("A LEATHER CORSET and TROUSERS")).toEqual(new Set<WardrobeSlotId>(["under-upper", "lower"]));
    const under = occupiedSlotsOf("plain underclothes");
    expect(under.has("under-upper")).toBe(true);
    expect(under.has("under-lower")).toBe(true);
  });

  test("no clothing terms is a legitimate empty result — no per-item upper default here", () => {
    expect(occupiedSlotsOf("")).toEqual(new Set());
    expect(occupiedSlotsOf("A tall, scarred woman with grey eyes and a limp.")).toEqual(new Set());
  });

  test("isClothingText gates on any garment mention at all", () => {
    expect(isClothingText("a woolen tunic")).toBe(true);
    expect(isClothingText("a plain iron sword")).toBe(false);
  });
});

describe("attireLineOf", () => {
  test("omitted while dressed, present once undressed", () => {
    expect(attireLineOf(undefined)).toBeNull();
    expect(attireLineOf({ upper: "worn" })).toBeNull();
    expect(attireLineOf({ upper: "removed" })).toBe("Attire: disheveled — clothing displaced or removed, not fully dressed");
  });

  test("occupancy threads through: the same two-slot strip reads bare instead of disheveled", () => {
    const row = { upper: "removed", lower: "removed" } as const;
    expect(attireLineOf(row)).toBe("Attire: disheveled — clothing displaced or removed, not fully dressed");
    expect(attireLineOf(row, new Set<WardrobeSlotId>(["upper", "lower"]))).toBe(
      "Attire: bare — no clothing worn",
    );
  });
});

function baseWorldAndCampaign() {
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
  return { world, campaign };
}

function stateWith(modules: GameState["modules"]): GameState {
  return {
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
    modules,
    flags: {},
  };
}

describe("the brief carries the attire line", () => {

  test("no Attire: line for a fresh save with an empty wardrobe slice", () => {
    const { world, campaign } = baseWorldAndCampaign();
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
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "what do I look like?" }).contextText;
    expect(text).not.toContain("Attire:");
  });

  // Regression: stripping via the paper-doll UI only ever patched `modules.wardrobe` — never
  // reached the DM or NPC brief, so "what do I look like" kept describing the authored baseline
  // and NPCs had no way to notice. The Attire: line is the fix — same shared contextText both read.
  test("Attire: appears once the PC's wardrobe slice reads bare, visible to DM and NPC alike", () => {
    const { world, campaign } = baseWorldAndCampaign();
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
      modules: {
        wardrobe: {
          "pc.you": {
            "over-upper": "removed",
            upper: "removed",
            "under-upper": "removed",
            "over-lower": "removed",
            lower: "removed",
            "under-lower": "removed",
          },
        },
      },
      flags: {},
    };
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "am I wearing anything?" }).contextText;
    expect(text).toContain("Attire: bare — no clothing worn");
    expect(text.indexOf("Attire:")).toBeGreaterThan(text.indexOf("# LOCATION"));
    expect(text.indexOf("Attire:")).toBeLessThan(text.indexOf("# RECENT"));
  });

  // The bug this occupancy read fixes: a PC who canonically wears TWO garments stripped both via
  // the paper-doll, yet the four coverage slots they never dress kept defaulting to "worn" — bare
  // was unreachable and the brief said "disheveled" forever.
  test("a two-garment PC (occupancy from appearance prose) reads bare once those two are removed", () => {
    const { world } = baseWorldAndCampaign();
    const campaign = CampaignSchema.parse({
      id: "c.t",
      name: "T",
      worldId: "w.t",
      characters: [
        {
          id: "pc.you",
          name: "You",
          description: "Wears a homespun tunic and a patched skirt.",
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
      modules: { wardrobe: { "pc.you": { upper: "removed", lower: "removed" } } },
      flags: {},
    };
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "am I wearing anything?" }).contextText;
    expect(text).toContain("Attire: bare — no clothing worn");
  });

  // The paper-doll's guaranteed fallback pair (Everyday top/bottoms → upper/lower) always counts,
  // so a PC whose prose names NO garment still reaches bare by stripping the two garments the doll
  // actually shows — instead of the unreachable all-slots fallback.
  test("a garmentless-prose PC reaches bare by stripping the doll's fallback pair", () => {
    const { world, campaign } = baseWorldAndCampaign();
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
      modules: { wardrobe: { "pc.you": { upper: "removed", lower: "removed" } } },
      flags: {},
    };
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "am I wearing anything?" }).contextText;
    expect(text).toContain("Attire: bare — no clothing worn");
  });

  // A prose garment the doll cannot toggle (a coat with no item behind it) keeps pinning the state:
  // stripping the doll's visible pair reads disheveled — never bare, and never NO line at all (the
  // regression a prose-only occupancy would cause: upper/lower outside the occupied set, line gone).
  test("a coat-only-prose PC stripping the doll's pair reads disheveled, not bare or nothing", () => {
    const { world } = baseWorldAndCampaign();
    const campaign = CampaignSchema.parse({
      id: "c.t",
      name: "T",
      worldId: "w.t",
      characters: [
        {
          id: "pc.you",
          name: "You",
          description: "A lean scholar in a rain-dark coat.",
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
      modules: { wardrobe: { "pc.you": { upper: "removed", lower: "removed" } } },
      flags: {},
    };
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "am I wearing anything?" }).contextText;
    expect(text).toContain("Attire: disheveled");
    expect(text).not.toContain("Attire: bare");
  });
});

describe("the brief carries the Visibly: line", () => {
  const maimed = { kind: "maimed", turnsRemaining: 2, mods: { check: -2 } };

  test("visiblyLineOf renders only non-attire facts and is null when there are none", () => {
    expect(visiblyLineOf([])).toBeNull();
    expect(
      visiblyLineOf([{ id: "attire", brief: "bare — no clothing worn", socialKeywords: ["disheveled"] }]),
    ).toBeNull();
    expect(
      visiblyLineOf([
        { id: "attire", brief: "bare — no clothing worn", socialKeywords: ["disheveled"] },
        { id: "status:maimed", brief: "hobbled by a crippling wound", socialKeywords: ["maimed"] },
      ]),
    ).toBe("Visibly: hobbled by a crippling wound");
  });

  test("no Visibly: line for a PC with no phrased status effects — dressed or bare alike", () => {
    const { world, campaign } = baseWorldAndCampaign();
    const dressed = buildNarrationContext({
      world,
      campaign,
      state: stateWith({}),
      recentEvents: [],
      trigger: "look around",
    }).contextText;
    expect(dressed).not.toContain("Visibly:");

    // Attire never double-reports on the Visibly: line — it has its own line above.
    const bare = buildNarrationContext({
      world,
      campaign,
      state: stateWith({ wardrobe: { "pc.you": coverageRow("removed") } }),
      recentEvents: [],
      trigger: "look around",
    }).contextText;
    expect(bare).toContain("Attire: bare");
    expect(bare).not.toContain("Visibly:");
  });

  test("a bare + status-active PC gets the exact Visibly: line directly after Attire:", () => {
    const { world, campaign } = baseWorldAndCampaign();
    const state = stateWith({
      wardrobe: { "pc.you": coverageRow("removed") },
      statusEffects: { active: { "pc.you": [maimed] } },
    });
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "look around" }).contextText;
    expect(text).toContain("Attire: bare — no clothing worn\nVisibly: hobbled by a crippling wound");
    // Grounding region: inside # LOCATION, well before the guard's # NOW cut point.
    expect(text.indexOf("Visibly:")).toBeLessThan(text.indexOf("# RECENT"));
  });

  test("a dressed but wounded PC gets Visibly: without any Attire: line", () => {
    const { world, campaign } = baseWorldAndCampaign();
    const state = stateWith({ statusEffects: { active: { "pc.you": [maimed] } } });
    const text = buildNarrationContext({ world, campaign, state, recentEvents: [], trigger: "look around" }).contextText;
    expect(text).not.toContain("Attire:");
    expect(text).toContain("Visibly: hobbled by a crippling wound");
  });
});
