/**
 * Progression tests — the XP curve, level-up folding, the effective-stat overlay, and the two
 * reducer commands (grantXp / learnSpell) with their replay invariant. Pure + deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  applyXpGain,
  cumulativeXpToReach,
  effectiveStatBlock,
  HP_PER_LEVEL,
  levelProgress,
  MAX_LEVEL,
  progressionBonusHp,
  progressionOf,
  readProgressionSlice,
  xpForDefeat,
  xpToNext,
  xpToNextFrom,
  type ProgressionEntry,
} from "../src/rules/progression.ts";
import type { StatBlock } from "../src/content/schema.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import type { WorldModel } from "../src/world/model.ts";
import { loadExample } from "./support/harness.ts";
import type { PlaySet } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { applyDelta } from "./support/replay.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";

const entry = (over: Partial<ProgressionEntry> = {}): ProgressionEntry => ({
  xp: 0,
  level: 1,
  learned: [],
  credits: 0,
  ...over,
});

describe("XP curve", () => {
  test("cumulative thresholds follow 50·L·(L−1)", () => {
    expect(cumulativeXpToReach(1)).toBe(0);
    expect(cumulativeXpToReach(2)).toBe(100);
    expect(cumulativeXpToReach(3)).toBe(300);
    expect(cumulativeXpToReach(4)).toBe(600);
    expect(xpToNext(1)).toBe(100);
    expect(xpToNext(3)).toBe(300);
  });

  test("xpForDefeat scales with foe level and floors at level 1", () => {
    expect(xpForDefeat(1)).toBe(35);
    expect(xpForDefeat(3)).toBe(75);
    expect(xpForDefeat(0)).toBe(35); // clamped up to 1
    expect(xpForDefeat(-5)).toBe(35);
  });
});

describe("applyXpGain", () => {
  test("no level-up below the next threshold", () => {
    const r = applyXpGain(entry({ level: 1, xp: 0 }), 50);
    expect(r.levelsGained).toBe(0);
    expect(r.next.level).toBe(1);
    expect(r.next.xp).toBe(50);
    expect(r.hpGain).toBe(0);
    expect(r.creditsGained).toBe(0);
  });

  test("a single level-up grants HP and a study credit", () => {
    const r = applyXpGain(entry({ level: 1, xp: 0 }), 100);
    expect(r.levelsGained).toBe(1);
    expect(r.next.level).toBe(2);
    expect(r.hpGain).toBe(HP_PER_LEVEL);
    expect(r.next.credits).toBe(1);
    expect(r.reached).toEqual([2]);
  });

  test("a big grant cascades multiple level-ups", () => {
    // From level 1 with 0 xp, 600 xp reaches level 4 (thresholds 100/300/600).
    const r = applyXpGain(entry({ level: 1, xp: 0 }), 600);
    expect(r.next.level).toBe(4);
    expect(r.levelsGained).toBe(3);
    expect(r.hpGain).toBe(3 * HP_PER_LEVEL);
    expect(r.next.credits).toBe(3);
    expect(r.reached).toEqual([2, 3, 4]);
  });

  test("never advances past the cap", () => {
    const r = applyXpGain(entry({ level: MAX_LEVEL, xp: cumulativeXpToReach(MAX_LEVEL) }), 1_000_000);
    expect(r.next.level).toBe(MAX_LEVEL);
    expect(r.levelsGained).toBe(0);
    expect(xpToNextFrom(r.next)).toBe(0);
    expect(levelProgress(r.next)).toBe(1);
  });

  test("does not mutate the input entry", () => {
    const e = entry({ level: 1, xp: 0 });
    applyXpGain(e, 500);
    expect(e).toEqual(entry({ level: 1, xp: 0 }));
  });
});

describe("effectiveStatBlock overlay", () => {
  const base: StatBlock = {
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    maxHp: 24,
    armorClass: 12,
    level: 3,
    speed: 30,
    proficiencies: [],
    spells: ["spell.a"],
  };

  test("returns the SAME reference when there is nothing to overlay", () => {
    expect(effectiveStatBlock(base, undefined)).toBe(base);
    expect(effectiveStatBlock(base, entry({ level: 3, learned: [] }), base.maxHp)).toBe(base);
  });

  test("raises level, unions learned spells, and reflects the live maxHp", () => {
    const eff = effectiveStatBlock(base, entry({ level: 5, learned: ["spell.b", "spell.a"] }), 36);
    expect(eff.level).toBe(5);
    expect(eff.maxHp).toBe(36);
    expect(eff.spells).toEqual(["spell.a", "spell.b"]); // deduped — authored a not repeated
    expect(base.spells).toEqual(["spell.a"]); // input untouched
  });

  test("progressionBonusHp is the per-level bonus over the authored level", () => {
    expect(progressionBonusHp(entry({ level: 3 }), 3)).toBe(0);
    expect(progressionBonusHp(entry({ level: 5 }), 3)).toBe(2 * HP_PER_LEVEL);
    expect(progressionBonusHp(undefined, 3)).toBe(0);
  });
});

describe("progressionOf seeding", () => {
  test("seeds an absent entry from the authored level", () => {
    const p = progressionOf({}, "pc.you", 3);
    expect(p).toEqual({ xp: 300, level: 3, learned: [], credits: 0 });
  });
  test("returns the existing entry verbatim when present", () => {
    const existing = entry({ level: 4, xp: 700, learned: ["spell.x"], credits: 1 });
    const p = progressionOf({ progression: { "pc.you": existing } }, "pc.you", 3);
    expect(p).toBe(existing);
  });
});

/** A started engine's projected model, seeded from the example world (PC is level 3 / 24 HP). */
async function exampleModel(): Promise<{ model: WorldModel; playset: PlaySet }> {
  const playset = await loadExample();
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  const model = fromGameState(engine.getState(), playset.world, playset.campaign);
  return { model, playset };
}

describe("grantXp reducer", () => {
  test("seeds the slice from baseLevel and accrues XP with no level-up", () => {
    // Fresh model, no slice yet. A sub-threshold grant just banks XP.
    const modules: Record<string, unknown> = {};
    const res = applyCommand({ modules } as unknown as WorldModel, {
      type: "grantXp",
      entityId: "pc.you",
      by: 50,
      baseLevel: 3,
    });
    expect(res.mutated).toBe(true);
    const slice = readProgressionSlice(modules);
    expect(slice["pc.you"]).toEqual({ xp: 350, level: 3, learned: [], credits: 0 });
    expect(res.deltas).toEqual([{ kind: "modulePatched", module: "progression", patch: { "pc.you": slice["pc.you"] } }]);
  });

  test("a level-up raises maxHp and heals the same amount, and emits an hpChanged delta", async () => {
    const { model } = await exampleModel();
    const before = model.entities.get("pc.you")!.stats!;
    expect(before.maxHp).toBe(24);
    expect(before.currentHp).toBe(24);
    // From level 3 (300 xp) a 300 grant reaches level 4 (threshold 600).
    const res = applyCommand(model, { type: "grantXp", entityId: "pc.you", by: 300, baseLevel: 3 });
    const after = model.entities.get("pc.you")!.stats!;
    expect(after.maxHp).toBe(24 + HP_PER_LEVEL);
    expect(after.currentHp).toBe(24 + HP_PER_LEVEL);
    const slice = readProgressionSlice(model.modules);
    expect(slice["pc.you"]!.level).toBe(4);
    expect(slice["pc.you"]!.credits).toBe(1);
    // Both a modulePatched and an hpChanged delta land.
    expect(res.deltas.map((d) => d.kind).sort()).toEqual(["hpChanged", "modulePatched"]);
  });

  test("a zero/negative grant is a noop", () => {
    const modules: Record<string, unknown> = {};
    const res = applyCommand({ modules } as unknown as WorldModel, {
      type: "grantXp",
      entityId: "pc.you",
      by: 0,
      baseLevel: 3,
    });
    expect(res.mutated).toBe(false);
    expect(readProgressionSlice(modules)["pc.you"]).toBeUndefined();
  });
});

describe("learnSpell reducer", () => {
  test("unions a spell into the earned list; a duplicate is a noop", () => {
    const modules: Record<string, unknown> = {};
    const m = { modules } as unknown as WorldModel;
    const r1 = applyCommand(m, { type: "learnSpell", entityId: "pc.you", spellId: "spell.x", baseLevel: 3 });
    expect(r1.mutated).toBe(true);
    expect(readProgressionSlice(modules)["pc.you"]!.learned).toEqual(["spell.x"]);
    const r2 = applyCommand(m, { type: "learnSpell", entityId: "pc.you", spellId: "spell.x", baseLevel: 3 });
    expect(r2.mutated).toBe(false);
  });

  test("spendCredit decrements an available study credit", () => {
    const modules = { progression: { "pc.you": entry({ level: 4, xp: 600, credits: 2 }) } };
    const m = { modules } as unknown as WorldModel;
    applyCommand(m, { type: "learnSpell", entityId: "pc.you", spellId: "spell.y", baseLevel: 3, spendCredit: true });
    const p = readProgressionSlice(modules)["pc.you"]!;
    expect(p.learned).toEqual(["spell.y"]);
    expect(p.credits).toBe(1);
  });

  test("spendCredit with no credit is a no-op — never mints the spell for free", () => {
    const modules = { progression: { "pc.you": entry({ level: 4, xp: 600, credits: 0 }) } };
    const m = { modules } as unknown as WorldModel;
    const r = applyCommand(m, {
      type: "learnSpell",
      entityId: "pc.you",
      spellId: "spell.z",
      baseLevel: 3,
      spendCredit: true,
    });
    expect(r.mutated).toBe(false);
    const p = readProgressionSlice(modules)["pc.you"]!;
    expect(p.learned).toEqual([]); // the spell was NOT appended
    expect(p.credits).toBe(0); // ...and the balance stays clamped-but-honest, not negative
  });
});

describe("progression persistence + replay", () => {
  test("earned HP and learned spells survive a GameState round-trip", async () => {
    const { model, playset } = await exampleModel();
    applyCommand(model, { type: "grantXp", entityId: "pc.you", by: 700, baseLevel: 3 }); // 300→1000 xp → level 5, +12 HP
    applyCommand(model, { type: "learnSpell", entityId: "pc.you", spellId: "spell.brine-lash", baseLevel: 3 });
    const gs = toGameState(model);
    const reloaded = fromGameState(gs, playset.world, playset.campaign);
    const stats = reloaded.entities.get("pc.you")!.stats!;
    // maxHp re-derived from the persisted slice (24 + 2×6 for levels 4 and 5).
    expect(stats.maxHp).toBe(24 + 2 * HP_PER_LEVEL);
    const slice = readProgressionSlice(reloaded.modules);
    expect(slice["pc.you"]!.level).toBe(5);
    expect(slice["pc.you"]!.learned).toEqual(["spell.brine-lash"]);
  });

  test("snapshot == fold(deltas) for grantXp (the replay invariant)", async () => {
    const { model } = await exampleModel();
    const res = applyCommand(model, { type: "grantXp", entityId: "pc.you", by: 300, baseLevel: 3 });
    // Fold the emitted deltas onto a fresh, empty model and check the progression slice agrees with
    // the mutated model's — snapshot == fold(deltas).
    const folded = { modules: {}, entities: new Map() } as unknown as WorldModel;
    for (const d of res.deltas) applyDelta(folded, d as DeltaEvent);
    expect(readProgressionSlice(folded.modules)["pc.you"]).toEqual(readProgressionSlice(model.modules)["pc.you"]!);
  });
});
