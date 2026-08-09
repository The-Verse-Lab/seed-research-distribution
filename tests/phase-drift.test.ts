/**
 * #phaseDrift (2026-07-25 fix wave) — the Tier-1 candidate check that catches prose STAGING the
 * current scene at a time of day the campaign clock contradicts (r3 P2: evening stew scenes
 * narrated against morning state for many turns). Conservative by design: predicative present-
 * scene markers only, coarse day-vs-dark buckets, and skipped on night-crossing turns — plans,
 * memories, and deadline idioms never match.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { checkPhaseDrift, screen } from "../src/rules/continuity.ts";

describe("checkPhaseDrift", () => {
  test("dark scenery on a morning clock flags; the correction names the real phase", () => {
    const v = checkPhaseDrift("Night has fallen over the market, and the evening stew steams.", ["morning"], 1);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("phaseDrift");
    expect(v[0]!.correction).toContain("morning");
  });

  test("day scenery on a night clock flags too (the inverse bucket)", () => {
    const v = checkPhaseDrift("The sun beats down on the yard as you cross it.", ["night"], 1);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("phaseDrift");
  });

  test("plans, memories, and deadline idioms never match — only present-scene staging counts", () => {
    expect(checkPhaseDrift("We leave at dawn. Rest while you can.", ["dusk"], 1)).toHaveLength(0);
    expect(checkPhaseDrift("Be back by dusk, or the gate closes.", ["morning"], 1)).toHaveLength(0);
    expect(checkPhaseDrift("She remembers the night the sun set on the old pier.", ["morning"], 1)).toHaveLength(0);
  });

  test("what an NPC SAYS is not where the scene is staged (07-27 harden)", () => {
    // Reproduced against a morning clock. A quoted line is precisely where a plan, a memory or a
    // deadline gets said out loud in the predicative present — the middle one IS a deadline, the
    // idiom this check's own header promises is safe — and all three regenerated a good turn.
    expect(checkPhaseDrift(`"The moon rises before we reach the ford," Oda says.`, ["morning"], 1)).toHaveLength(0);
    expect(
      checkPhaseDrift(`"Night has fallen on better men than you," she says, and laughs.`, ["morning"], 1),
    ).toHaveLength(0);
    expect(
      checkPhaseDrift(`Brann leans in. "The sun sets and the gate shuts. Be quick."`, ["morning"], 1),
    ).toHaveLength(0);
    // The narrator's OWN staging in the same turn still flags — stripping speech is not a mute.
    expect(
      checkPhaseDrift(`Night has fallen over the market. "Told you," she says.`, ["morning"], 1),
    ).toHaveLength(1);
  });

  test("scenery matching EITHER spanned phase is legal (a turn ending at dusk may stage dusk)", () => {
    expect(checkPhaseDrift("Dusk settles over the road as you arrive.", ["afternoon", "dusk"], 200)).toHaveLength(0);
    expect(checkPhaseDrift("Dusk settles over the road.", ["dusk"], 1)).toHaveLength(0);
  });

  test("a phase-crossing ARRIVAL staged in the wrong phase class flags (r9 F-10)", () => {
    // Nine hours' walk, morning→dusk: the crossing skip used to wave the whole turn through, and
    // "Morning in the Saltmarket" shipped over `Time: dusk`. With arrivalPhase given, staging the
    // PRESENT arrival in daylight escalates; recalling the road's morning inside quotes stays legal.
    const prose = "The morning sun climbs over the Saltmarket as you arrive, the crowd shouting under a bright sky.";
    const v = checkPhaseDrift(prose, ["morning", "dusk"], 535, "dusk");
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("phaseDrift");
    expect(v[0]!.correction).toContain("dusk");
    // The inverse bucket: a dawn arrival staged at night.
    const w = checkPhaseDrift("Night has fallen over the gate as you come through.", ["dusk", "dawn"], 535, "dawn");
    expect(w).toHaveLength(1);
    // Arrival staged in ITS OWN phase is clean, whatever the road spanned.
    expect(checkPhaseDrift("Dusk lays copper light over the market as you arrive.", ["morning", "dusk"], 535, "dusk")).toHaveLength(0);
    // No arrivalPhase ⇒ the old crossing skip is byte-identical.
    expect(checkPhaseDrift(prose, ["morning", "dusk"], 535)).toHaveLength(0);
  });

  test("skipped on night-crossing turns and when the caller opts out", () => {
    // A real rest legitimately narrates the hours between its endpoints.
    expect(checkPhaseDrift("Night has fallen; the fire burns low.", ["morning"], 480)).toHaveLength(0);
    // No dayPhases ⇒ caller opted out (whisper bundles, older tests).
    expect(checkPhaseDrift("Night has fallen.", undefined, 1)).toHaveLength(0);
    expect(checkPhaseDrift("Night has fallen.", [], 1)).toHaveLength(0);
  });

  test("screen() runs the check only for narration bundles that carry dayPhases", () => {
    const flagged = screen({
      prose: "The evening crowd thickens around you.",
      mode: "narration",
      dayPhases: ["morning"],
      clockMinutes: 1,
    });
    expect(flagged.some((v) => v.kind === "phaseDrift")).toBe(true);
    const optedOut = screen({ prose: "The evening crowd thickens.", mode: "narration", clockMinutes: 1 });
    expect(optedOut.some((v) => v.kind === "phaseDrift")).toBe(false);
  });
});
