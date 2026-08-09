/**
 * journeyFabrication — the scene stays where the player actually is (r5 fix wave).
 *
 * The r4 defect this is fixtured on: "take a cot in the loft" fired MAKE CAMP, and the morning
 * prose put the player "waking on the east road out of the city with a six-day journey ahead"
 * while the Navigator still read THE UNDERCROFT. Position is the substrate of every plan; when it
 * is untrustworthy nothing above it can be planned.
 *
 * (The OTHER paragraph from that run — the raw `--- You carry: … Exits: … ---` block leaking
 * mid-narration — is already dead: r4's `stripBriefBlocks` cuts it, and prose-scrub runs BEFORE the
 * Judge. Fixturing this check on that text would have shipped a green unit test and no behavior.)
 *
 * `spatialDrift` cannot cover this. It asks "did you claim to ARRIVE with no move authorized?" —
 * the defect carries no arrival verb, and any real move that turn suppresses it entirely, which is
 * exactly when prose about the WRONG destination is most dangerous.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { checkJourneyFabrication, screen, type VerificationBundle } from "../src/rules/continuity.ts";

const HERE = "The Undercroft";
const locale = (over: Partial<NonNullable<VerificationBundle["locale"]>> = {}) => ({
  here: HERE,
  exits: ["the stair up to the Old Quarter", "the drain-tunnel west"],
  foreign: ["The Salt Market", "Vellmere", "The Long Market"],
  ...over,
});

describe("journeyFabrication — displacement from where the party stands", () => {
  test("the r4 cot-to-camp defect: waking on a road out of the place you are IN", () => {
    const v = checkJourneyFabrication(
      "You wake on the east road out of the Undercroft, six days of walking still ahead of you.",
      locale(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("journeyFabrication");
    expect(v[0]!.correction).toContain("The scene is IN The Undercroft");
  });

  test("a stated distance from here flags", () => {
    expect(
      checkJourneyFabrication("You are some miles west of the Undercroft when the rain starts.", locale()),
    ).toHaveLength(1);
  });

  test("a route BACK to the place you are standing in flags", () => {
    expect(checkJourneyFabrication("The track runs back east to the Undercroft.", locale())).toHaveLength(1);
  });

  test("the correction names the real exits, so the regeneration has somewhere legal to go", () => {
    const v = checkJourneyFabrication("You stand a league north of the Undercroft.", locale());
    expect(v[0]!.correction).toContain("the stair up to the Old Quarter");
  });

  test("an INTERIOR feature named with a direction is not a journey", () => {
    // "the north wall of the Undercroft" / "the east gate of the Undercroft" are parts of the place
    // the party is standing in — a road word is required before an "out of" for exactly this reason.
    expect(
      checkJourneyFabrication("You set your back to the north wall of the Undercroft.", locale()),
    ).toEqual([]);
    expect(checkJourneyFabrication("The east gate of the Undercroft is chained.", locale())).toEqual([]);
  });

  test("a FEATURE of this place, and a sound from beyond it, are not displacement (07-27 harden)", () => {
    // Reproduced: all three flagged, each of them staging the scene exactly where the party stands.
    // A possessive names a part of here; "from outside" places the listener INSIDE.
    expect(checkJourneyFabrication("You look past the Undercroft's altar to the far wall.", locale())).toEqual([]);
    expect(
      checkJourneyFabrication("You are in the Undercroft; someone shouts past the Undercroft's inner door.", locale()),
    ).toEqual([]);
    expect(
      checkJourneyFabrication("The noise from outside the Undercroft never quite stops.", locale()),
    ).toEqual([]);
    // Being genuinely outside still flags, and a possessive does NOT excuse a stated compass
    // displacement — "west of Vellmere's walls" is still west of Vellmere.
    expect(checkJourneyFabrication("You wait outside the Undercroft until the bell.", locale())).toHaveLength(1);
    expect(
      checkJourneyFabrication("You are two miles west of Vellmere's walls.", locale({ here: "Vellmere" })),
    ).toHaveLength(1);
  });

  test("simply BEING here is not a violation", () => {
    expect(checkJourneyFabrication("You are in the Undercroft, and the damp is in everything.", locale())).toEqual([]);
  });
});

describe("journeyFabrication — staging the scene at a foreign place", () => {
  test("a present-scene locative plus a foreign place name flags", () => {
    expect(
      checkJourneyFabrication("You are standing in the Salt Market as the tide-bell rings.", locale()),
    ).toHaveLength(1);
  });

  test("MENTIONING a foreign place without staging the scene there is legal", () => {
    // Plans and memories must stay free — this is the failure mode that made r3's pronoun check useless.
    expect(
      checkJourneyFabrication("Brann says the Salt Market will have emptied by dusk.", locale()),
    ).toEqual([]);
  });

  test("a PARTIAL token match never flags — SR's places are generic-noun phrases", () => {
    // "The Long Market" shares 'market' with half the world's prose; requiring ALL salient tokens
    // is what keeps "around you the market wakes" from tripping several times a session.
    expect(checkJourneyFabrication("Around you the market wakes, loud and wet.", locale())).toEqual([]);
    expect(checkJourneyFabrication("You are standing where the long shadows fall.", locale())).toEqual([]);
  });

  test("SCATTERED tokens of a foreign name are a coincidence, not a location (07-27 harden)", () => {
    // Reproduced against `foreign: ["The Long Market"]` — "all salient tokens present" is satisfied
    // by any sentence that happens to use both words, and each of these staged the party in a place
    // they had never been. The name has to arrive as a PHRASE.
    expect(
      checkJourneyFabrication("You are standing in the market, and the long day is only starting.", locale()),
    ).toEqual([]);
    expect(checkJourneyFabrication("You stand in the market; long shadows cut it.", locale())).toEqual([]);
    // The phrase itself still flags, and survives losing its article.
    expect(
      checkJourneyFabrication("You are standing in the Long Market as the bell rings.", locale()),
    ).toHaveLength(1);
    expect(
      checkJourneyFabrication("You are standing in Long Market as the bell rings.", locale()),
    ).toHaveLength(1);
    // …as does a name whose own connective sits inside it.
    expect(
      checkJourneyFabrication("You are standing in the Widow of the Tor's yard.", locale({ foreign: ["The Widow of the Tor"] })),
    ).toHaveLength(1);
  });

  test("a whitelisted name is not foreign — the caller subtracts exits, region, camp and journeys", () => {
    // `foreign` arrives pre-filtered, so an exit destination simply is not in the list.
    expect(
      checkJourneyFabrication("You are standing in the Old Quarter.", locale({ foreign: ["Vellmere"] })),
    ).toEqual([]);
  });
});

describe("journeyFabrication — gating and wiring", () => {
  test("no locale ⇒ the check is skipped entirely (opt-in, like carried/dayPhases)", () => {
    expect(checkJourneyFabrication("You are some miles west of the Undercroft.", undefined)).toEqual([]);
    expect(checkJourneyFabrication("You are some miles west of the Undercroft.", locale({ here: "" }))).toEqual([]);
  });

  test("at most one violation per prose", () => {
    const v = checkJourneyFabrication(
      "You are some miles west of the Undercroft. You are standing in the Salt Market. The road runs back to the Undercroft.",
      locale(),
    );
    expect(v).toHaveLength(1);
  });

  test("screen() runs it for narration bundles carrying a locale, and never for a whisper", () => {
    const prose = "You wake on the east road out of the Undercroft.";
    const narration = screen({ prose, mode: "narration", locale: locale() });
    expect(narration.some((v) => v.kind === "journeyFabrication")).toBe(true);
    const whisper = screen({ prose, mode: "whisper", locale: locale() });
    expect(whisper.some((v) => v.kind === "journeyFabrication")).toBe(false);
    const noLocale = screen({ prose, mode: "narration" });
    expect(noLocale.some((v) => v.kind === "journeyFabrication")).toBe(false);
  });

  test("a location name with regex metacharacters cannot break the check", () => {
    // `expandWorld` mints names at runtime and the world editor ships, so `here` is not a literal.
    expect(() =>
      checkJourneyFabrication("You are west of Ash (Old) Ford.", locale({ here: "Ash (Old) Ford" })),
    ).not.toThrow();
  });
});

describe("journeyFabrication — r12 precision (quoted plans, generic-word names, real arrivals)", () => {
  test("an NPC OFFERING the road out in dialogue is a plan, not staging (r12 fixture-travel t1)", () => {
    expect(
      checkJourneyFabrication(
        `Oda ticks the compass with his chin. "If you're of a mind to walk out of the Undercroft with somebody who's walked it before, I'll take that walk with you."`,
        locale(),
      ),
    ).toEqual([]);
  });

  test("the same displacement OUTSIDE quotes still flags", () => {
    expect(checkJourneyFabrication("You walk out of the Undercroft onto the flats.", locale())).toHaveLength(1);
  });

  test("a foreign name whose salient handle is ONE generic word binds only its capitalized form", () => {
    // "The Old Quarter" → salient token "quarter" ("old" is name-table noise). The r12 sweep bound
    // it on the lowercase common noun ("the quarter goes about its business" — the district the
    // party stands IN) and on the VERB ("you quarter the visible roads").
    const loc = locale({ foreign: ["The Old Quarter"] });
    expect(
      checkJourneyFabrication("Around you the quarter goes about its business on the planks.", loc),
    ).toEqual([]);
    expect(
      checkJourneyFabrication("You stand at the edge of the common and quarter the visible roads.", loc),
    ).toEqual([]);
    // The proper noun is still a staging claim.
    expect(checkJourneyFabrication("Around you the Quarter hums with evening trade.", loc)).toHaveLength(1);
    // Multi-token names keep the adjacency rule — no capitalization required.
    expect(
      checkJourneyFabrication(
        "You are standing in the long market as the stalls open.",
        locale({ foreign: ["The Long Market"] }),
      ),
    ).toHaveLength(1);
  });

  test("arrival prose on a turn that really MOVED here is legal; without the move it flags (r12)", () => {
    const prose = "The west road delivers you back into the Undercroft at dusk.";
    expect(checkJourneyFabrication(prose, locale(), true)).toEqual([]);
    expect(checkJourneyFabrication(prose, locale())).toHaveLength(1);
    // The other displacement arms stay live even on an arrival turn — staging the scene at a
    // distance from the place you just reached is still a fabrication.
    expect(
      checkJourneyFabrication("You are some miles west of the Undercroft when the rain starts.", locale(), true),
    ).toHaveLength(1);
  });

  test("screen() threads arrivedHere from the bundle", () => {
    const prose = "The track brings you back to the Undercroft.";
    const flagged = screen({ prose, mode: "narration", locale: locale() });
    expect(flagged.some((v) => v.kind === "journeyFabrication")).toBe(true);
    const arrived = screen({ prose, mode: "narration", locale: locale(), arrivedHere: true });
    expect(arrived.some((v) => v.kind === "journeyFabrication")).toBe(false);
  });
});
