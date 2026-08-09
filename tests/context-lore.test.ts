/**
 * Narration-brief lore injection (M4, Part A) — the `# RELEVANT LORE` section.
 *
 * Asserts the read-only retrieval seam in `buildNarrationContext`: relevant lore is injected as a
 * section AFTER `# RECENT` and BEFORE `# NOW` (grounding context, not the screened current action),
 * and is OMITTED entirely when there is no hit — so a no-lore world's brief is byte-identical to
 * before retrieval existed. Pure builder, no engine/gateway/state.
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

describe("buildNarrationContext — # RELEVANT LORE injection", () => {
  test("omitted entirely when no lore is supplied", () => {
    const text = buildNarrationContext(baseInput()).contextText;
    expect(text).not.toContain("# RELEVANT LORE");
  });

  test("byte-identical brief whether lore is absent, undefined, or an empty array", () => {
    const noKey = buildNarrationContext(baseInput()).contextText;
    const undef = buildNarrationContext(baseInput({ lore: undefined })).contextText;
    const empty = buildNarrationContext(baseInput({ lore: [] })).contextText;
    expect(undef).toBe(noKey);
    expect(empty).toBe(noKey);
  });

  test("appears with hits, as a labeled section, between # RECENT and # NOW", () => {
    const text = buildNarrationContext(
      baseInput({ lore: ["‣ Dragons: they hoard gold.", "‣ Stones: seven wardens ring the vale."] }),
    ).contextText;

    expect(text).toContain("# RELEVANT LORE");
    expect(text).toContain("‣ Dragons: they hoard gold.");
    expect(text).toContain("‣ Stones: seven wardens ring the vale.");

    const recentIdx = text.indexOf("# RECENT");
    const loreIdx = text.indexOf("# RELEVANT LORE");
    const nowIdx = text.indexOf(BRIEF_MARKERS.now);
    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(loreIdx).toBeGreaterThan(recentIdx); // after the transcript
    expect(loreIdx).toBeLessThan(nowIdx); // BEFORE the current-action marker (not screened)
  });

  test("the lore section is the only difference vs the no-lore brief (no other bytes move)", () => {
    const without = buildNarrationContext(baseInput()).contextText;
    const withLore = buildNarrationContext(baseInput({ lore: ["‣ A: body."] })).contextText;
    // Splicing the section back out must reproduce the original brief exactly.
    const spliced = withLore.replace("# RELEVANT LORE\n‣ A: body.\n\n", "");
    expect(spliced).toBe(without);
  });
});
