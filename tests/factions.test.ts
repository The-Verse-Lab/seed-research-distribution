/**
 * Living faction system — player↔faction standing, ally/enemy bleed, band labels, the brief render,
 * the reducer command, and the stance bend. Pure functions where possible; a minimal WorldModel for
 * the reducer + stance integration.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  FACTION_BLEED_FRACTION,
  factionOf,
  factionStandingCommands,
  factionStandingLines,
  factionStandingOf,
  giftFactionWarmth,
  standingBand,
} from "../src/rules/factions.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { applyDelta } from "./support/replay.ts";
import { stance } from "../src/rules/agenda.ts";
import type { WorldModel } from "../src/world/model.ts";
import type { NpcTemplate, World } from "../src/content/schema.ts";

const WORLD = {
  factions: [
    { id: "faction.river", name: "River Guild", relationships: { "faction.tide": -40, "faction.lance": 20 } },
    { id: "faction.tide", name: "Tideborn", relationships: { "faction.river": -40 } },
    { id: "faction.lance", name: "Free Lances", relationships: {} },
  ],
  npcs: [
    { id: "npc.a", factionId: "faction.river" },
    { id: "npc.loner" },
  ],
} as unknown as World;

describe("factionOf", () => {
  test("reads the authored template id, then the spawn base-id, else undefined", () => {
    expect(factionOf(WORLD, "npc.a")).toBe("faction.river");
    expect(factionOf(WORLD, "npc.a#3")).toBe("faction.river"); // spawn instance
    expect(factionOf(WORLD, "npc.loner")).toBeUndefined();
    expect(factionOf(WORLD, "npc.ghost")).toBeUndefined();
  });
});

describe("factionStandingOf", () => {
  test("reads the modules slice, defaults 0, clamps, and ignores an absent faction", () => {
    const modules = { factionStanding: { byPc: { "pc.you": { "faction.river": 30, "faction.over": 250 } } } };
    expect(factionStandingOf(modules, "pc.you", "faction.river")).toBe(30);
    expect(factionStandingOf(modules, "pc.you", "faction.over")).toBe(100); // clamped
    expect(factionStandingOf(modules, "pc.you", "faction.none")).toBe(0);
    expect(factionStandingOf(modules, "pc.you", undefined)).toBe(0);
    expect(factionStandingOf(undefined, "pc.you", "faction.river")).toBe(0);
  });
});

describe("standingBand", () => {
  test("bands the score into legible labels", () => {
    expect(standingBand(80)).toBe("allied");
    expect(standingBand(60)).toBe("allied");
    expect(standingBand(30)).toBe("friendly");
    expect(standingBand(0)).toBe("neutral");
    expect(standingBand(-19)).toBe("neutral");
    expect(standingBand(-20)).toBe("wary");
    expect(standingBand(-60)).toBe("hostile");
  });
});

describe("giftFactionWarmth", () => {
  test("scales small and clamps to [1,4]", () => {
    expect(giftFactionWarmth(0)).toBe(1);
    expect(giftFactionWarmth(50)).toBe(1);
    expect(giftFactionWarmth(150)).toBe(3);
    expect(giftFactionWarmth(9999)).toBe(4);
    expect(giftFactionWarmth(NaN)).toBe(1);
  });
});

describe("factionStandingCommands (primary + ally/enemy bleed)", () => {
  test("primary only when the faction authors no relationships", () => {
    const cmds = factionStandingCommands(WORLD, "pc.you", "faction.lance", 10);
    expect(cmds).toEqual([{ type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.lance", by: 10 }]);
  });

  test("bleeds a fraction to allies (same sign) and enemies (opposite) through the matrix", () => {
    const cmds = factionStandingCommands(WORLD, "pc.you", "faction.river", 10);
    // primary +10 to river; enemy tide (−40) ⇒ round(10 * −0.4 * 0.5) = −2; ally lance (+20) ⇒ round(10*0.2*0.5)=+1
    expect(cmds).toEqual([
      { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.river", by: 10 },
      { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.tide", by: -2 },
      { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.lance", by: 1 },
    ]);
    expect(FACTION_BLEED_FRACTION).toBe(0.5);
  });

  test("a negative primary flips the bleed signs (attacking river warms its enemy)", () => {
    const cmds = factionStandingCommands(WORLD, "pc.you", "faction.river", -12);
    expect(cmds).toContainEqual({ type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.tide", by: 2 });
  });

  test("drops bleeds that round to zero, and returns nothing for a no-op / unknown input", () => {
    // by=1 with tide −40 ⇒ round(1*−0.4*0.5) = round(−0.2) = 0 ⇒ dropped; lance +20 ⇒ round(0.1)=0 ⇒ dropped
    expect(factionStandingCommands(WORLD, "pc.you", "faction.river", 1)).toEqual([
      { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.river", by: 1 },
    ]);
    expect(factionStandingCommands(WORLD, "pc.you", "faction.river", 0)).toEqual([]);
    expect(factionStandingCommands(WORLD, "pc.you", undefined, 10)).toEqual([]);
    // unknown faction: primary still emitted (slice is id-keyed), no bleed
    expect(factionStandingCommands(WORLD, "pc.you", "faction.ghost", 5)).toEqual([
      { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.ghost", by: 5 },
    ]);
  });
});

describe("factionStandingLines (brief render)", () => {
  test("non-neutral standings, most-extreme first, signed, omit-when-empty", () => {
    const modules = {
      factionStanding: { byPc: { "pc.you": { "faction.river": 30, "faction.tide": -60, "faction.lance": 0 } } },
    };
    expect(factionStandingLines(modules, WORLD, "pc.you")).toEqual([
      "- Tideborn: hostile (-60)",
      "- River Guild: friendly (+30)",
    ]);
    expect(factionStandingLines({}, WORLD, "pc.you")).toEqual([]);
    expect(factionStandingLines(undefined, WORLD, "pc.you")).toEqual([]);
  });
});

describe("adjustFactionStanding reducer command", () => {
  test("writes the slice, clamps, emits an absolute delta, and no-ops when unchanged", () => {
    const model = { modules: {} } as unknown as WorldModel;
    const res = applyCommand(model, { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.river", by: 30 });
    expect(res.mutated).toBe(true);
    expect(res.deltas).toEqual([
      { kind: "factionStandingChanged", pcId: "pc.you", factionId: "faction.river", value: 30, by: 30 },
    ]);
    expect(factionStandingOf(model.modules, "pc.you", "faction.river")).toBe(30);

    // clamp on the high side: +90 from 30 ⇒ 100, effective by 70
    const res2 = applyCommand(model, { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.river", by: 90 });
    expect(res2.deltas).toEqual([
      { kind: "factionStandingChanged", pcId: "pc.you", factionId: "faction.river", value: 100, by: 70 },
    ]);

    // already at the ceiling ⇒ no delta
    const res3 = applyCommand(model, { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.river", by: 5 });
    expect(res3.mutated).toBe(false);
    expect(res3.deltas).toEqual([]);
  });

  test("the emitted delta folds to the same slice on replay (persistence round-trip)", () => {
    const live = { modules: {} } as unknown as WorldModel;
    const replayed = { modules: {} } as unknown as WorldModel;
    for (const by of [30, 90]) {
      const { deltas } = applyCommand(live, { type: "adjustFactionStanding", pcId: "pc.you", factionId: "faction.river", by });
      for (const d of deltas) applyDelta(replayed, { id: "x", at: 0, seq: 0, ...d });
    }
    expect(replayed.modules.factionStanding).toEqual(live.modules.factionStanding);
  });
});

describe("stance() faction bend (P3)", () => {
  const npc = {
    id: "npc.a",
    name: "Lys",
    factionId: "faction.river",
    alignment: "tn",
    personalityTemplate: undefined,
  } as unknown as NpcTemplate;

  function modelWithStanding(standing: number): WorldModel {
    return {
      entities: new Map([
        ["npc.a", { id: "npc.a", locationId: "loc.x" }],
        ["pc.you", { id: "pc.you", locationId: "loc.x" }],
      ]),
      relationships: new Map(),
      modules: standing === 0 ? {} : { factionStanding: { byPc: { "pc.you": { "faction.river": standing } } } },
    } as unknown as WorldModel;
  }

  test("a PC hostile to the NPC's faction is met warier than a neutral PC", () => {
    const neutral = stance(npc, "pc.you", modelWithStanding(0), WORLD);
    const hated = stance(npc, "pc.you", modelWithStanding(-80), WORLD);
    const dispositionRank = { exploitative: 0, wary: 1, transactional: 2, neutral: 3, helpful: 4, devoted: 5 } as const;
    expect(dispositionRank[hated.disposition]).toBeLessThanOrEqual(dispositionRank[neutral.disposition]);
  });

  test("faction standing 0 leaves the stance byte-identical to a factionless read", () => {
    const withZero = stance(npc, "pc.you", modelWithStanding(0), WORLD);
    const factionless = stance(
      { ...npc, factionId: undefined } as NpcTemplate,
      "pc.you",
      modelWithStanding(0),
      WORLD,
    );
    expect(withZero.disposition).toBe(factionless.disposition);
    expect(withZero.intensity).toBeCloseTo(factionless.intensity, 10);
  });
});
