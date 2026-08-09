/** Neutral regressions for the shared distinctive-token name binder. */
import { describe, expect, test } from "bun:test";
import { absentReferencedNames, absentReferencedNpcs } from "../src/agents/context.ts";
import { WorldSchema, type World } from "../src/content/schema.ts";
import {
  distinctiveNameTokens,
  findNameMention,
  nameHandleTokens,
  nameMentionedIn,
  nameTokens,
  sharesNameToken,
} from "../src/rules/name-match.ts";
import { checkCastPresence, stripSentencesMentioning } from "../src/rules/continuity.ts";
import { matchItemLoosely } from "../src/rules/items.ts";
import { placeTokensOf } from "../src/rules/place-tokens.ts";
import { nameMentioned } from "../src/rules/sightings.ts";

const ROAD_PROSE =
  "You step back onto the coast road. One of the drovers says the old ferry has not run in a year. " +
  "A nightjar calls from the reeds.";

const FIXTURE = WorldSchema.parse({
  id: "world.name-fixture",
  name: "Name Fixture",
  locations: [
    { id: "loc.harbor", name: "Harbor", description: "A quay.", npcs: ["npc.oda"] },
    { id: "loc.ashfield", name: "Ashfield", description: "A road." },
    { id: "loc.undercroft", name: "Undercroft", description: "A cellar." },
  ],
  npcs: [
    { id: "npc.oda", name: "Oda the Wayfarer", persona: "Watchful." },
    { id: "npc.corle", name: "Old Corle", persona: "Quiet." },
    { id: "npc.nightjar", name: "Nightjar", persona: "Patient." },
    { id: "npc.dray", name: "Dray", persona: "Practical." },
    { id: "npc.sela", name: "Sela of Ashfield", persona: "Warm." },
    { id: "npc.local", name: "Harbor Local", persona: "Reserved." },
  ],
});

describe("name token tiers", () => {
  test("drops articles, quantifiers, ranks, and ordinary dictionary words", () => {
    expect(nameHandleTokens("Oda the Wayfarer")).toEqual(["oda", "wayfarer"]);
    expect(nameHandleTokens("Sergeant Veil")).toEqual(["veil"]);
    expect(nameHandleTokens("Old Corle")).toEqual(["corle"]);
    expect(nameHandleTokens("One of the Standing")).toEqual(["standing"]);
    expect(nameHandleTokens("The Elder")).toEqual([]);
    expect(distinctiveNameTokens("Lys the Quiet")).toEqual(["lys"]);
    expect(distinctiveNameTokens("Dray Kessler")).toEqual(["kessler"]);
    expect(distinctiveNameTokens("Coast Farmhand")).toEqual([]);
  });

  test("keeps raw tokens for shape gates and detects shared real handles", () => {
    expect(nameTokens("One of the Standing")).toEqual(["one", "of", "the", "standing"]);
    expect(sharesNameToken("Oda the Wayfarer", "Oda")).toBe(true);
    expect(sharesNameToken("Old Corle", "Old Wenna")).toBe(false);
  });
});

describe("binding", () => {
  test("ordinary scene prose does not conjure a person", () => {
    expect(nameMentionedIn(ROAD_PROSE, "Old Corle")).toBe(false);
    expect(nameMentionedIn(ROAD_PROSE, "Nightjar")).toBe(false);
    expect(nameMentionedIn(ROAD_PROSE, "Coast Farmhand")).toBe(false);
  });

  test("uses all matches rather than stopping inside a longer word", () => {
    expect(findNameMention("The pagoda burned; Oda said so.", "Oda the Wayfarer")).toEqual({
      handle: "oda",
      index: 19,
      tier: "distinctive",
    });
    expect(nameMentionedIn("The pagoda burned to the sills.", "Oda the Wayfarer")).toBe(false);
  });

  test("capitalized real mentions bind and metacharacters stay literal", () => {
    expect(nameMentionedIn("Oda leans on the rail.", "Oda the Wayfarer")).toBe(true);
    expect(nameMentionedIn("Nightjar leans on the rail.", "Nightjar")).toBe(true);
    expect(nameMentionedIn("Rook (the Ferryman) waves.", "Rook (the Ferryman)")).toBe(true);
    expect(nameMentionedIn("nothing here", "a.*")).toBe(false);
  });

  test("uncased player input still requires evidence for ordinary-name readings", () => {
    expect(nameMentionedIn("i ask oda about the road", "Oda the Wayfarer", { surface: "uncased" })).toBe(true);
    expect(nameMentionedIn("I hitch the dray", "Dray", { surface: "uncased" })).toBe(false);
    expect(nameMentionedIn("I ask Dray for the ledger", "Dray", { surface: "uncased" })).toBe(true);
    expect(nameMentionedIn("The Dray rolls past.", "Dray Kessler", { surface: "uncased" })).toBe(false);
  });

  test("player-query is the narrow caller-vouched relaxation", () => {
    expect(nameMentionedIn("where can i find dray?", "Dray", { surface: "player-query" })).toBe(true);
    expect(nameMentionedIn("I hitch the dray", "Dray", { surface: "uncased" })).toBe(false);
    expect(nameMentionedIn("give me a hand", "Isles Hand", { surface: "player-query" })).toBe(false);
    expect(nameMentionedIn("where is the isles hand?", "Isles Hand", { surface: "player-query" })).toBe(true);
    expect(nameMentionedIn("The Dray rolls past.", "Dray Kessler", { surface: "player-query" })).toBe(false);
  });

  test("every neutral-fixture NPC binds its own display name", () => {
    expect(FIXTURE.npcs.filter((npc) => !nameMentionedIn(npc.name, npc.name))).toEqual([]);
    expect(FIXTURE.npcs.filter((npc) => nameMentionedIn(ROAD_PROSE, npc.name))).toEqual([]);
  });
});

describe("context and continuity call sites", () => {
  test("a scene-setting line names no absent fixture NPC", () => {
    expect(absentReferencedNpcs(FIXTURE, [], ROAD_PROSE)).toEqual([]);
    expect(absentReferencedNames(FIXTURE, [], "Oda walks beside you, silent.")).toEqual(["Oda the Wayfarer"]);
  });

  test("ordinary adjectives do not stage or scrub a title-bearing absentee", () => {
    const prose = "The room goes quiet as the tide turns. Bram nods.";
    expect(checkCastPresence(prose, ["Bram"], ["Lys the Quiet"])).toEqual([]);
    expect(stripSentencesMentioning(prose, ["Lys the Quiet"])).toBe(prose);
    expect(checkCastPresence("Lys steps out of the dark.", ["Bram"], ["Lys the Quiet"])).toHaveLength(1);
  });
});

describe("place-token suppression", () => {
  const places = placeTokensOf(FIXTURE);

  test("a place alone never binds a place-plus-role person", () => {
    expect(nameMentionedIn("You reach Harbor by dusk.", "Harbor Local", { placeTokens: places })).toBe(false);
    expect(nameMentionedIn("Ashfield is a day west.", "Sela of Ashfield", { placeTokens: places })).toBe(false);
    expect(checkCastPresence("The Undercroft stairs are wet.", ["Oda"], ["Undercroft Shadow"], places)).toEqual([]);
  });

  test("the full person and a non-place handle remain nameable", () => {
    expect(nameMentionedIn("A Harbor Local watches you pass.", "Harbor Local", { placeTokens: places })).toBe(true);
    expect(nameMentionedIn("Sela pours the stew.", "Sela of Ashfield", { placeTokens: places })).toBe(true);
  });

  test("without world vocabulary the pre-suppression behavior remains available", () => {
    expect(nameMentionedIn("You reach Harbor by dusk.", "Harbor Local")).toBe(true);
  });
});

describe("adapted call sites", () => {
  test("sightings distinguish an ordinary dray from a queried person", () => {
    expect(nameMentioned("I hitch the dray and load the crates", "Dray")).toBe(false);
    expect(nameMentioned("where can i find oda?", "Oda the Wayfarer")).toBe(true);
    expect(nameMentioned("The pagoda burned; Oda said so.", "Oda the Wayfarer")).toBe(true);
  });

  test("item matching keeps ordinary item words but drops function words", () => {
    const world = { items: [] } as unknown as Pick<World, "items">;
    expect(matchItemLoosely("rope", ["item.rope-hempen-50-ft", "item.torch"], world)).toBe("item.rope-hempen-50-ft");
    expect(matchItemLoosely("lantern", ["item.lantern-hooded", "item.rations-1-day"], world)).toBe("item.lantern-hooded");
    expect(matchItemLoosely("flask of oil", ["item.vial-of-acid"], world)).toBeNull();
  });
});
