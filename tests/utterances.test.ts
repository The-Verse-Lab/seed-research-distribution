/**
 * Utterance dedup (W6) — a companion never loops the exact same words twice.
 *
 * Two layers under test:
 *  1. the pure math-leaf `src/rules/utterances.ts` — normalization, the recent-duplicate read, and
 *     the bounded FIFO push (never grows past MAX_RECENT, blank lines record nothing);
 *  2. the wiring on a live, deterministic engine — the offline gateway returns the SAME direct-reply
 *     line on every address, so a second identical turn must fall silent (a "says nothing" system
 *     beat, no dialogue event) while the utterance slice keeps exactly one normalized line, bounded.
 *
 * Everything is offline + seeded: no network, no clock reliance. The temporal dedup
 * (`MIN_DEDUP_MS`) is a different, independent gate — this suite drives fresh player turns (never
 * back-to-back heartbeats) so only the SAME-WORDS guard is exercised.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { byKind, makeEngine } from "./support/harness.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { freeformPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import {
  isRecentDuplicate,
  MAX_RECENT,
  normalizeUtterance,
  pushUtterance,
  UTTERANCES_MODULE,
  type UtterancesSlice,
} from "../src/rules/utterances.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

// ===========================================================================
// The pure math-leaf — normalization, recent-duplicate read, bounded push.
// ===========================================================================

describe("normalizeUtterance", () => {
  test("lowercases, collapses whitespace, and strips trailing punctuation", () => {
    expect(normalizeUtterance("Well  met.")).toBe("well met");
    expect(normalizeUtterance("well met")).toBe("well met");
    expect(normalizeUtterance("  WELL   MET!!! ")).toBe("well met");
    expect(normalizeUtterance("Not here — follow me…")).toBe("not here — follow me");
  });

  test("an all-punctuation or blank line normalizes to empty", () => {
    expect(normalizeUtterance("")).toBe("");
    expect(normalizeUtterance("   ")).toBe("");
    expect(normalizeUtterance("...")).toBe("");
  });

  // Regex audit §8g, reproduced against the shipped function: the edge strip was the trailing
  // sentence-punctuation class alone, which stops dead on a closing quote —
  // normalizeUtterance('"Well met."') was '"well met."' against normalizeUtterance("Well met.")
  // === "well met". A line the pipeline delivered quoted once and bare once was therefore NOT a
  // recent duplicate, and the companion said the same words twice: the W6 loop this module exists
  // to stop. Markdown emphasis had the same problem, from both edges.
  test("wrapping quotes, guillemets and markdown emphasis are peeled off both edges", () => {
    const dressed = ['"Well met."', "'Well met.'", "“Well met.”", "«Well met!»", "**Well met!**", "*well met*", "— Well met"];
    for (const line of dressed) expect(normalizeUtterance(line)).toBe("well met");
  });

  test("interior wording is never rewritten — two different lines stay different", () => {
    expect(normalizeUtterance('She said "run" and left.')).toBe('she said "run" and left');
    expect(normalizeUtterance('She said "run" and left.')).not.toBe(normalizeUtterance("She said run and left."));
    expect(normalizeUtterance("Not here — follow me…")).toBe("not here — follow me");
  });
});

describe("isRecentDuplicate — the quoted/bare delivery of one line (regex audit §8g)", () => {
  test("a quoted repeat of a bare line IS a recent duplicate (it was not, before the edge peel)", () => {
    const modules = { [UTTERANCES_MODULE]: { "npc.oda": ["Well met."] } };
    expect(isRecentDuplicate(modules, "npc.oda", '"Well met."')).toBe(true);
    expect(isRecentDuplicate(modules, "npc.oda", "**Well met!**")).toBe(true);
    // …and a genuinely different line still gets said.
    expect(isRecentDuplicate(modules, "npc.oda", '"Well met, and mind the stair."')).toBe(false);
  });
});

describe("isRecentDuplicate", () => {
  const modules = { [UTTERANCES_MODULE]: { "npc.a": ["Well met, traveler."] } };

  test("matches a prior line under normalization (case / punctuation / whitespace)", () => {
    expect(isRecentDuplicate(modules, "npc.a", "well met, traveler")).toBe(true);
    expect(isRecentDuplicate(modules, "npc.a", "WELL  MET, TRAVELER!!!")).toBe(true);
  });

  test("a different line is not a duplicate; a blank candidate never is", () => {
    expect(isRecentDuplicate(modules, "npc.a", "Something new.")).toBe(false);
    expect(isRecentDuplicate(modules, "npc.a", "   ")).toBe(false);
  });

  test("reads defensively — a missing slice / missing NPC / foreign shape is no duplicate", () => {
    expect(isRecentDuplicate({}, "npc.a", "well met")).toBe(false);
    expect(isRecentDuplicate(modules, "npc.z", "well met")).toBe(false);
    expect(isRecentDuplicate({ [UTTERANCES_MODULE]: { "npc.a": "oops" } }, "npc.a", "oops")).toBe(false);
  });
});

describe("pushUtterance", () => {
  test("appends and stays bounded to the most-recent MAX_RECENT lines (FIFO)", () => {
    let modules: Record<string, unknown> = {};
    const say = (npc: string, line: string) => {
      modules = { ...modules, [UTTERANCES_MODULE]: { ...(modules[UTTERANCES_MODULE] as UtterancesSlice), [npc]: pushUtterance(modules, npc, line) } };
    };
    say("npc.a", "one");
    say("npc.a", "two");
    say("npc.a", "three");
    say("npc.a", "four");
    const slice = modules[UTTERANCES_MODULE] as UtterancesSlice;
    expect(slice["npc.a"]).toEqual(["two", "three", "four"]);
    expect(slice["npc.a"]?.length).toBe(MAX_RECENT);
  });

  test("a blank line records nothing (returns the existing list unchanged)", () => {
    const modules = { [UTTERANCES_MODULE]: { "npc.a": ["kept"] } };
    expect(pushUtterance(modules, "npc.a", "   ")).toEqual(["kept"]);
    expect(pushUtterance(modules, "npc.a", "")).toEqual(["kept"]);
  });
});

// ===========================================================================
// The wiring — a companion reply that repeats verbatim is suppressed.
// ===========================================================================

/** A two-companion hall; the offline gateway gives the SAME direct-reply line every time. */
function buildPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.utt",
    name: "Echo Hall",
    summary: "A close-quarters repeat-line test world.",
    locations: [{ id: "loc.hall", name: "The Hall", description: "A stone hall." }],
    npcs: [
      { id: "npc.ash", name: "Ash", persona: "An even-keeled scout.", autonomy: { isPartyMember: true, level: "reactive" } },
      { id: "npc.bee", name: "Bee", persona: "A talkative tinker.", autonomy: { isPartyMember: true, level: "reactive" } },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.utt",
    name: "Utterances",
    worldId: "w.utt",
    characters: [{ id: "pc.you", name: "You", stats: STATS }],
    startingState: { locationId: "loc.hall", party: ["pc.you"], companions: ["npc.ash", "npc.bee"] },
  });
  return { world, campaign };
}

/** Pins every turn to "the player addressed Ash" so the DialogueModule always asks Ash for a reply. */
const addressAsh: TurnClassifier = {
  classify: () => Promise.resolve({ ...freeformPlan(), kind: "dialogueToNpc" as const, targetId: "npc.ash" }),
};

/** The public reply Ash gives, and its normalized form (the offline gateway's constant). */
const OFFLINE_REPLY = "I hear you. (Offline reply — set an LLM endpoint for live companion dialogue.)";

describe("companion verbatim-repeat dedup (public)", () => {
  test("the first address speaks; an identical second address falls silent (says-nothing beat)", async () => {
    // rng pinned high so priority-B never chimes in — we isolate the addressed companion's reply.
    const { engine, events, beats } = await makeEngine({ playset: buildPlayset(), classifier: addressAsh, rng: () => 0.99 });

    events.length = 0;
    beats.length = 0;
    await engine.submitPlayerInput("Ash, what do you see?");
    // Public NPC speech is now a DM-narrated beat, not a raw dialogue bubble.
    const first = beats.filter((b) => b.actorId === "npc.ash");
    expect(first.length).toBe(1);
    expect(first[0]?.dialogue).toBe(OFFLINE_REPLY);

    events.length = 0;
    beats.length = 0;
    await engine.submitPlayerInput("Ash, and now?");
    engine.stop();

    // Second turn: the reply is byte-identical, so it is suppressed — no beat from Ash. The
    // suppression is INTERNAL: it used to surface as a `"<name> says nothing."` system line, which the
    // client treated like an error banner (playtest 07-24 P3), so it now emits nothing at all.
    expect(beats.some((b) => b.actorId === "npc.ash")).toBe(false);
    expect(byKind(events, "system").some((s) => /says nothing/.test(s.message))).toBe(false);
  });

  test("the utterance slice keeps ONE normalized line and stays bounded to MAX_RECENT", async () => {
    const { engine } = await makeEngine({ playset: buildPlayset(), classifier: addressAsh, rng: () => 0.99 });

    // Four identical addresses: only the first records (the rest are duplicates), so the slice
    // never grows beyond a single entry — and could never exceed MAX_RECENT even with variety.
    for (let i = 0; i < 4; i++) await engine.submitPlayerInput(`Ash, again ${i}?`);
    engine.stop();

    const slice = engine.getState().modules?.utterances as UtterancesSlice | undefined;
    expect(slice?.["npc.ash"]).toEqual([OFFLINE_REPLY]);
    expect((slice?.["npc.ash"] ?? []).length).toBeLessThanOrEqual(MAX_RECENT);
  });
});

describe("companion verbatim-repeat dedup (private thread)", () => {
  test("a private reply that repeats verbatim is suppressed too (same slice)", async () => {
    const { engine, events } = await makeEngine({ playset: buildPlayset() });

    events.length = 0;
    await engine.submitPlayerInput("a quiet word", { toId: "npc.ash" });
    const first = byKind(events, "dialogue").filter((d) => d.actorId === "npc.ash");
    expect(first.length).toBe(1);
    expect(first[0]?.channel).toBe("private");

    events.length = 0;
    await engine.submitPlayerInput("another quiet word", { toId: "npc.ash" });
    engine.stop();

    // The private reply is the identical offline line → suppressed. No second private dialogue, and
    // no player-facing "says nothing" noise standing in for it (see the public case above).
    expect(byKind(events, "dialogue").some((d) => d.actorId === "npc.ash")).toBe(false);
    expect(byKind(events, "system").some((s) => /says nothing/.test(s.message))).toBe(false);

    // Public and private replies share the ONE slice — still a single recorded line.
    const slice = engine.getState().modules?.utterances as UtterancesSlice | undefined;
    expect(slice?.["npc.ash"]).toEqual([OFFLINE_REPLY]);
  });
});
