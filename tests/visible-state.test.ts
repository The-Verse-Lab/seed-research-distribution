/**
 * visibleStateOf — the one shared derivation of what a bystander can see about an entity
 * (attire from the paper-doll wardrobe, status-effect kinds with a narrative phrase).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { ATTIRE_FACT_ID, occupiedCoverageOf, visibleStateOf } from "../src/rules/visible-state.ts";
import { statusEffectPhrase, type StatusEffect } from "../src/rules/status-effects.ts";
import { coverageRow, type WardrobeSlotId } from "../src/rules/wardrobe.ts";
import { CharacterSchema, type Character } from "../src/content/schema.ts";

function character(description?: string): Character {
  return CharacterSchema.parse({
    id: "pc.you",
    name: "You",
    ...(description ? { description } : {}),
    stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 },
  });
}

function maimed(turnsRemaining = 2): StatusEffect {
  return { kind: "maimed", turnsRemaining, mods: { check: -2 } };
}

describe("occupiedCoverageOf", () => {
  test("undefined without a character sheet — downstream keeps the conservative all-slots read", () => {
    expect(occupiedCoverageOf(undefined)).toBeUndefined();
  });

  test("garmentless prose still yields the paper-doll's fallback pair", () => {
    expect(occupiedCoverageOf(character("A tall, scarred woman with grey eyes."))).toEqual(
      new Set<WardrobeSlotId>(["upper", "lower"]),
    );
  });

  test("prose garments union with the fallback pair", () => {
    expect(occupiedCoverageOf(character("Wears a homespun tunic, a patched skirt, and a deep hood."))).toEqual(
      new Set<WardrobeSlotId>(["head", "upper", "lower"]),
    );
  });

  // Regex audit §10e. Occupancy is term-matched out of prose, and a term match can't tell a garment
  // someone WEARS from one they explicitly LACK. The first string below is `npc.sorrel-runaway`'s
  // shipped description, verbatim; reproduced against the shipped function it returned
  // {over-upper, upper, lower}, so with her top and bottoms removed `attireStateOf` answered
  // "disheveled" where an identically stripped character with no garment word answered "bare".
  describe("a DENIED garment does not dress anyone (§10e)", () => {
    const denied = [
      "Sorrel is thin in the way of someone recently and involuntarily hungry, wind-chapped from three days on the open road with no coat to speak of.",
      "He came down the pass without a cloak, arms bare to the wind.",
      "Barefoot and lacking boots of any kind.",
      "A traveller missing one glove, knuckles split from the rope.",
      "Come down from the hills with no proper winter coat.",
    ];
    test("the negated mention is dropped — occupancy falls back to the paper-doll pair", () => {
      for (const prose of denied) {
        expect([prose, occupiedCoverageOf(character(prose))]).toEqual([
          prose,
          new Set<WardrobeSlotId>(["upper", "lower"]),
        ]);
      }
    });

    // The other direction, and the reason the guard is TIGHT rather than "drop anything near a no":
    // a garment that is actually worn must still count, and a stray "no" elsewhere in the sentence
    // must not undress anybody.
    const worn: [string, WardrobeSlotId[]][] = [
      ["A broad, weather-cured man in a Guild-issue coat gone grey at the seams.", ["over-upper", "upper", "lower"]],
      ["There is no fear in her at all, and her coat is grey with road dust.", ["over-upper", "upper", "lower"]],
      ["No one knows her age; she is wrapped in a heavy cloak.", ["over-upper", "upper", "lower"]],
      ["He wears no rank, but the coat is a captain's.", ["over-upper", "upper", "lower"]],
    ];
    test("a garment that IS worn still counts", () => {
      for (const [prose, slots] of worn) {
        expect([prose, occupiedCoverageOf(character(prose))]).toEqual([prose, new Set(slots)]);
      }
    });
  });
});

describe("visibleStateOf — attire source", () => {
  test("no facts for an unremarkable entity (no module runtime at all)", () => {
    expect(visibleStateOf({}, "pc.you")).toEqual([]);
    expect(visibleStateOf({ modules: {} }, "pc.you", character())).toEqual([]);
  });

  test("a full strip yields ONE bare attire fact with the descriptor brief", () => {
    const source = { modules: { wardrobe: { "pc.you": coverageRow("removed") } } };
    expect(visibleStateOf(source, "pc.you")).toEqual([
      {
        id: ATTIRE_FACT_ID,
        brief: "bare — no clothing worn",
        socialKeywords: ["disheveled"],
        memory: { kind: "attireObserved", summary: "wore no clothing" },
      },
    ]);
  });

  test("a displaced garment reads disheveled with its own keyword", () => {
    const source = { modules: { wardrobe: { "pc.you": { upper: "displaced" } } } };
    expect(visibleStateOf(source, "pc.you")).toEqual([
      {
        id: ATTIRE_FACT_ID,
        brief: "disheveled — clothing displaced or removed, not fully dressed",
        socialKeywords: ["disheveled"],
        memory: { kind: "attireObserved", summary: "was not fully dressed" },
      },
    ]);
  });

  test("occupancy narrows bare to the garments the character actually dresses", () => {
    const source = { modules: { wardrobe: { "pc.you": { upper: "removed", lower: "removed" } } } };
    // Without a sheet: conservative all-slots read — merely disheveled.
    expect(visibleStateOf(source, "pc.you")[0]?.socialKeywords).toEqual(["disheveled"]);
    // With a two-garment sheet: those two removed IS bare.
    expect(visibleStateOf(source, "pc.you", character("Wears a homespun tunic and a patched skirt."))[0]?.socialKeywords).toEqual(
      ["disheveled"],
    );
  });

  // A robe occupies over-upper+upper+lower by design (it covers all three); the fact list must
  // treat that as ONE garment band — a single attire fact — never three per-slot mentions.
  test("a multi-slot garment (robe) stripped is one attire fact, not three", () => {
    const source = {
      modules: {
        wardrobe: { "pc.you": { "over-upper": "removed", upper: "removed", lower: "removed" } },
      },
    };
    const facts = visibleStateOf(source, "pc.you", character("Draped in a woolen robe."));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      id: ATTIRE_FACT_ID,
      brief: "bare — no clothing worn",
      socialKeywords: ["disheveled"],
      memory: { kind: "attireObserved", summary: "wore no clothing" },
    });
  });
});

describe("visibleStateOf — status-effect source", () => {
  test("an active kind with a narrative phrase surfaces as a status fact", () => {
    const source = { modules: { statusEffects: { active: { "pc.you": [maimed()] } } } };
    expect(visibleStateOf(source, "pc.you")).toEqual([
      { id: "status:maimed", brief: "hobbled by a crippling wound", socialKeywords: ["maimed"] },
    ]);
    expect(statusEffectPhrase("maimed")).toBe("hobbled by a crippling wound");
  });

  test("a kind without a phrase stays mechanics-only — no fact", () => {
    const winded: StatusEffect = { kind: "winded", turnsRemaining: 1, mods: { energy: 1 } };
    const source = { modules: { statusEffects: { active: { "pc.you": [winded] } } } };
    expect(visibleStateOf(source, "pc.you")).toEqual([]);
    expect(statusEffectPhrase("winded")).toBeUndefined();
  });

  test("duplicate active kinds dedupe to one fact; other entities' effects don't leak", () => {
    const source = {
      modules: { statusEffects: { active: { "pc.you": [maimed(2), maimed(5)], "npc.other": [maimed()] } } },
    };
    expect(visibleStateOf(source, "pc.you")).toHaveLength(1);
    expect(visibleStateOf(source, "pc.someone-else")).toEqual([]);
  });

  test("attire and status combine, attire first", () => {
    const source = {
      modules: {
        wardrobe: { "pc.you": coverageRow("removed") },
        statusEffects: { active: { "pc.you": [maimed()] } },
      },
    };
    const facts = visibleStateOf(source, "pc.you");
    expect(facts.map((f) => f.id)).toEqual([ATTIRE_FACT_ID, "status:maimed"]);
  });
});
