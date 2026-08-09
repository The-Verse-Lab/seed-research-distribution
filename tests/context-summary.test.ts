/**
 * Narration-brief rolling-summary injection (M4 follow-up) — the `# STORY SO FAR` section.
 *
 * Asserts the seam in `buildNarrationContext`: the campaign rolling-summary is injected as a section
 * in the GROUNDING region — after `# LOCATION`, BEFORE `# NOW` (so the guard's `# NOW` cut point is
 * unchanged and it isn't over-screened) — and is OMITTED entirely when empty/absent/whitespace, so a
 * no-summary campaign's brief is byte-identical to before the feature existed. Pure builder, no
 * engine/gateway/state.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { buildNarrationContext, type ContextInput } from "../src/agents/context.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

function baseInput(overrides: Partial<ContextInput> = {}): ContextInput {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Testhold",
    summary: "A quiet vale.",
    locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
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
  return { world, campaign, state, recentEvents: [], trigger: "You look around.", ...overrides };
}

describe("buildNarrationContext — # STORY SO FAR injection", () => {
  test("omitted entirely when no summary is supplied", () => {
    const text = buildNarrationContext(baseInput()).contextText;
    expect(text).not.toContain("# STORY SO FAR");
  });

  test("byte-identical brief whether the summary is absent, undefined, empty, or whitespace", () => {
    const noKey = buildNarrationContext(baseInput()).contextText;
    const undef = buildNarrationContext(baseInput({ storySoFar: undefined })).contextText;
    const empty = buildNarrationContext(baseInput({ storySoFar: "" })).contextText;
    const blank = buildNarrationContext(baseInput({ storySoFar: "   \n  " })).contextText;
    expect(undef).toBe(noKey);
    expect(empty).toBe(noKey);
    expect(blank).toBe(noKey);
  });

  test("appears with content, as a labeled section, after # LOCATION and BEFORE # NOW", () => {
    const text = buildNarrationContext(
      baseInput({ storySoFar: "The party crossed the moor and reached the keep." }),
    ).contextText;

    expect(text).toContain("# STORY SO FAR");
    expect(text).toContain("The party crossed the moor and reached the keep.");

    const locIdx = text.indexOf("# LOCATION");
    const storyIdx = text.indexOf("# STORY SO FAR");
    const recentIdx = text.indexOf("# RECENT");
    const nowIdx = text.indexOf(BRIEF_MARKERS.now);
    expect(locIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeGreaterThan(locIdx); // grounding region, after location
    expect(storyIdx).toBeLessThan(recentIdx); // before the transcript
    expect(storyIdx).toBeLessThan(nowIdx); // BEFORE the current-action marker (not screened)
  });

  test("the summary section is the only difference vs the no-summary brief (no other bytes move)", () => {
    const without = buildNarrationContext(baseInput()).contextText;
    const withSummary = buildNarrationContext(baseInput({ storySoFar: "A prior deed." })).contextText;
    // Splicing the section back out must reproduce the original brief exactly.
    const spliced = withSummary.replace("# STORY SO FAR\nA prior deed.\n\n", "");
    expect(spliced).toBe(without);
  });

  test("co-exists with # RELEVANT LORE: story precedes recent, lore follows it, all before # NOW", () => {
    const text = buildNarrationContext(
      baseInput({ storySoFar: "Earlier events.", lore: ["‣ A: lore body."] }),
    ).contextText;
    const storyIdx = text.indexOf("# STORY SO FAR");
    const recentIdx = text.indexOf("# RECENT");
    const loreIdx = text.indexOf("# RELEVANT LORE");
    const nowIdx = text.indexOf(BRIEF_MARKERS.now);
    expect(storyIdx).toBeLessThan(recentIdx);
    expect(recentIdx).toBeLessThan(loreIdx);
    expect(loreIdx).toBeLessThan(nowIdx);
  });
});
