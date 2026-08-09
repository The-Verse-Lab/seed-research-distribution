/**
 * Per-scene narrator (Concordia transfer #8, `NEXT_GAME_MASTER`). Pins the three contracts:
 * `narrationSceneOf` derives the owning scene from state with the classifier's precedence; a live
 * scene DROPS whole grounding blocks from the brief while free play stays byte-identical (the
 * golden test guards that half); and the GM system prompt gains a stance paragraph per scene while
 * the sceneless prompt is byte-identical to the historic one.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  buildNarrationContext,
  GROUNDING_BLOCKS,
  narrationSceneOf,
  SCENE_BLOCK_DROPS,
} from "../src/agents/context.ts";
import { DungeonMaster, type NarratorScene } from "../src/agents/dm.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { BRIEF_FIXTURES, briefWorld } from "./support/brief-fixtures.ts";
import { LODGING_LOCATION_ID } from "../src/world/lodging.ts";
import type { GameState } from "../src/state/types.ts";

const stateWith = (over: Partial<GameState>): GameState =>
  ({ ...(BRIEF_FIXTURES.groundingStack!.state as GameState), ...over }) as GameState;

describe("narrationSceneOf", () => {
  test("free play is undefined; each slice claims its scene; combat outranks everything", () => {
    expect(narrationSceneOf(stateWith({}))).toBeUndefined();
    expect(narrationSceneOf(stateWith({ modules: { combat: { active: true } } } as Partial<GameState>))).toBe("combat");
    expect(narrationSceneOf(stateWith({ modules: { captivity: { active: true } } } as Partial<GameState>))).toBe("captivity");
    expect(narrationSceneOf(stateWith({ partyLocationId: LODGING_LOCATION_ID }))).toBe("lodging");
    expect(
      narrationSceneOf(
        stateWith({
          partyLocationId: LODGING_LOCATION_ID,
          modules: { combat: { active: true }, captivity: { active: true } },
        } as Partial<GameState>),
      ),
    ).toBe("combat");
  });
});

describe("per-scene brief slimming", () => {
  test("every SCENE_BLOCK_DROPS key names a real grounding block", () => {
    const known = new Set(GROUNDING_BLOCKS.map((b) => b.key));
    for (const drops of Object.values(SCENE_BLOCK_DROPS)) {
      for (const key of drops) expect(known.has(key)).toBe(true);
    }
  });

  test("a combat turn drops the story/claims blocks the free turn carries; spine headers survive", () => {
    const free = buildNarrationContext(BRIEF_FIXTURES.groundingStack!);
    expect(free.contextText).toContain("# STORY SO FAR");
    expect(free.contextText).toContain("# PRIOR NPC CLAIMS");
    expect(free.scene).toBeUndefined();

    const combat = buildNarrationContext({
      ...BRIEF_FIXTURES.groundingStack!,
      state: stateWith({ modules: { combat: { active: true } } } as Partial<GameState>),
    });
    expect(combat.scene).toBe("combat");
    expect(combat.contextText).not.toContain("# STORY SO FAR");
    expect(combat.contextText).not.toContain("# PRIOR NPC CLAIMS");
    // The spine is untouchable — dropping blocks may never move a contract header.
    for (const header of ["# WORLD", "# LOCATION", "# RECENT", "# NOW"]) {
      expect(combat.contextText).toContain(header);
    }
  });

  test("lodging drops nothing — the quiet inn still grounds fully", () => {
    const lodging = buildNarrationContext({
      ...BRIEF_FIXTURES.groundingStack!,
      state: stateWith({ partyLocationId: LODGING_LOCATION_ID }),
    });
    expect(lodging.scene).toBe("lodging");
    expect(lodging.contextText).toContain("# STORY SO FAR");
    expect(lodging.contextText).toContain("# PRIOR NPC CLAIMS");
  });
});

describe("per-scene GM stance", () => {
  const dm = new DungeonMaster(new OfflineGateway(), briefWorld);

  test("no scene ⇒ byte-identical historic prompt", () => {
    expect(dm.buildSystemPrompt(undefined)).toBe(dm.buildSystemPrompt());
    expect(dm.buildSystemPrompt()).not.toContain("Scene stance");
  });

  test("each scene appends its stance AFTER every hard rule, changing nothing above it", () => {
    const base = dm.buildSystemPrompt();
    const scenes: NarratorScene[] = ["combat", "captivity", "lodging"];
    for (const scene of scenes) {
      const prompt = dm.buildSystemPrompt(scene);
      expect(prompt.startsWith(base)).toBe(true); // stance is purely additive, rules identical
      expect(prompt).toContain("Scene stance");
    }
    expect(dm.buildSystemPrompt("combat")).toContain("COMBAT is live");
    expect(dm.buildSystemPrompt("lodging")).toContain("ABED");
  });
});
