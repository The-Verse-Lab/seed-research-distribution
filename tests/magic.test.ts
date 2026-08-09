/**
 * Magic tests — the spell resolver and its engine wiring.
 *
 * Covers the pure, seeded resolver (`src/rules/magic.ts`): the casting profile, every mechanic kind
 * (attack-damage, save-damage half/negate, heal, save-debuff), the command translation, and the
 * narrative floor for a mechanic-less spell. Then the intent seams: reconcilePlan grounds a `cast`
 * against the caster's known spells (hallucinated ⇒ freeform), and the engine resolves a player cast
 * end-to-end (out-of-combat self-heal) plus an enemy caster loosing a spell on its combat turn. Also
 * pins the combat `advantage` source added alongside. Offline/seeded throughout — deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet, type Spell, type StatBlock } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { reconcilePlan, type TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { resolveAttack, type Combatant } from "../src/rules/combat.ts";
import { UNARMED } from "../src/rules/srd/index.ts";
import { isOffensiveSpell, resolveSpell, spellAim, spellCommands, spellcasting } from "../src/rules/magic.ts";
import { readProgressionSlice, xpForDefeat } from "../src/rules/progression.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

function scriptedRng(values: number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index++];
    if (value === undefined) throw new Error(`scripted rng exhausted at roll ${index}`);
    return value;
  };
}

function statBlock(
  opts: { abilities?: Partial<StatBlock["abilities"]>; maxHp?: number; armorClass?: number; level?: number; spells?: string[] } = {},
): StatBlock {
  return {
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...opts.abilities },
    maxHp: opts.maxHp ?? 20,
    armorClass: opts.armorClass ?? 12,
    level: opts.level ?? 2,
    speed: 30,
    proficiencies: [],
    spells: opts.spells ?? [],
  };
}

const combatant = (id: string, stats: StatBlock, hp = stats.maxHp): Combatant => ({ id, stats, currentHp: hp });

const spell = (over: Partial<Spell> & Pick<Spell, "id" | "mechanic">): Spell => ({
  id: over.id,
  name: over.name ?? over.id,
  level: over.level ?? 0,
  description: over.description ?? "",
  effect: over.effect ?? {},
  mechanic: over.mechanic,
  targeting: over.targeting,
});

// --- target aim (grounding) --------------------------------------------------

describe("spellAim", () => {
  test("an authored `targeting` wins outright", () => {
    expect(spellAim(spell({ id: "s", mechanic: { kind: "save-debuff", save: "wis", status: { kind: "frightened", turnsRemaining: 2, mods: {} } }, targeting: "self" }))).toBe("self");
    expect(spellAim(spell({ id: "s", mechanic: { kind: "attack-damage", dice: "1d10", damageType: "cold" }, targeting: "ally" }))).toBe("ally");
    expect(spellAim(spell({ id: "s", mechanic: { kind: "utility" }, targeting: "enemy" }))).toBe("enemy");
  });

  test("absent `targeting` is inferred from the mechanic (offensive⇒enemy, heal⇒ally, utility/none⇒object)", () => {
    expect(spellAim(spell({ id: "s", mechanic: { kind: "attack-damage", dice: "1d6", damageType: "fire" } }))).toBe("enemy");
    expect(spellAim(spell({ id: "s", mechanic: { kind: "save-damage", dice: "2d6", damageType: "cold", save: "dex", half: true } }))).toBe("enemy");
    expect(spellAim(spell({ id: "s", mechanic: { kind: "heal", dice: "1d8" } }))).toBe("ally");
    expect(spellAim(spell({ id: "s", mechanic: { kind: "utility" } }))).toBe("object");
    expect(spellAim(spell({ id: "s", mechanic: undefined }))).toBe("object");
  });
});

// --- spellcasting profile ----------------------------------------------------

describe("spellcasting", () => {
  test("keys on the best mental ability; DC = 8 + prof + mod, attack = prof + mod", () => {
    // level 5 ⇒ prof +3; best mental is int 18 ⇒ mod +4.
    const p = spellcasting(statBlock({ abilities: { int: 18, wis: 12, cha: 8 }, level: 5 }));
    expect(p.ability).toBe("int");
    expect(p.mod).toBe(4);
    expect(p.dc).toBe(8 + 3 + 4);
    expect(p.attackBonus).toBe(3 + 4);
  });

  test("wis wins when it is the highest mental score", () => {
    expect(spellcasting(statBlock({ abilities: { int: 11, wis: 17, cha: 14 } })).ability).toBe("wis");
  });
});

// --- resolveSpell by mechanic kind ------------------------------------------

const caster = statBlock({ abilities: { wis: 16 }, level: 2 }); // prof +2, wis +3 ⇒ dc 13, attack +5

describe("resolveSpell", () => {
  test("attack-damage: a high d20 hits AC and deals rolled damage", () => {
    const s = spell({ id: "s.bolt", mechanic: { kind: "attack-damage", dice: "1d10", damageType: "cold" } });
    const target = combatant("foe", statBlock({ armorClass: 12 }));
    // d20 roll 15 (+5 = 20 ≥ 12 hit, not nat20/1), then damage die 7. (rollDie = floor(rng·sides)+1.)
    const r = resolveSpell(caster, "pc", s, target, scriptedRng([14.5 / 20, 6.5 / 10]));
    expect(r.kind).toBe("attack-damage");
    expect(r.hit).toBe(true);
    expect(r.damage).toBe(7);
    expect(r.damageType).toBe("cold");
  });

  test("attack-damage: a low d20 misses and deals nothing", () => {
    const s = spell({ id: "s.bolt", mechanic: { kind: "attack-damage", dice: "1d10", damageType: "cold" } });
    const target = combatant("foe", statBlock({ armorClass: 18 }));
    const r = resolveSpell(caster, "pc", s, target, scriptedRng([1.5 / 20]));
    expect(r.hit).toBe(false);
    expect(r.damage).toBe(0);
  });

  test("save-damage: a failed save takes full, a made save takes half when half=true", () => {
    const s = spell({ id: "s.lash", mechanic: { kind: "save-damage", dice: "2d6", damageType: "cold", save: "dex", half: true } });
    const weakFoe = combatant("foe", statBlock({ abilities: { dex: 6 } })); // dex -2, needs 15 raw to beat DC13
    // fail: target d20 = 3 (+(-2)=1 < 13 fail), damage dice 4+5=9.
    const failed = resolveSpell(caster, "pc", s, weakFoe, scriptedRng([2.5 / 20, 3.5 / 6, 4.5 / 6]));
    expect(failed.save?.success).toBe(false);
    expect(failed.damage).toBe(9);
    // made: target d20 = 20 (+(-2)=18 ≥ 13 success), dice 4+5=9 ⇒ half = 4.
    const made = resolveSpell(caster, "pc", s, weakFoe, scriptedRng([19.5 / 20, 3.5 / 6, 4.5 / 6]));
    expect(made.save?.success).toBe(true);
    expect(made.damage).toBe(4);
  });

  test("heal: restores rolled HP, defaults to the caster when no target given", () => {
    const s = spell({ id: "s.knit", mechanic: { kind: "heal", dice: "1d8" } });
    const r = resolveSpell(caster, "pc", s, undefined, scriptedRng([5.5 / 8]));
    expect(r.kind).toBe("heal");
    expect(r.heal).toBe(6);
    expect(r.targetId).toBe("pc");
  });

  test("save-debuff: a failed save imposes the status; a made save imposes nothing", () => {
    const s = spell({
      id: "s.grip",
      mechanic: { kind: "save-debuff", save: "wis", status: { kind: "mire-gripped", turnsRemaining: 3, mods: { disadvantage: true, attack: -2 } } },
    });
    const foe = combatant("foe", statBlock({ abilities: { wis: 8 } })); // wis -1
    const failed = resolveSpell(caster, "pc", s, foe, scriptedRng([1.5 / 20]));
    expect(failed.save?.success).toBe(false);
    expect(failed.status).toEqual({ kind: "mire-gripped", turnsRemaining: 3, mods: { disadvantage: true, attack: -2 }, source: "s.grip" });
    const made = resolveSpell(caster, "pc", s, foe, scriptedRng([19.5 / 20]));
    expect(made.save?.success).toBe(true);
    expect(made.status).toBeUndefined();
  });

  test("a mechanic-less or utility spell resolves to a harmless narrative result", () => {
    const util = spell({ id: "s.mend", mechanic: { kind: "utility" } });
    const none = spell({ id: "s.flavor", mechanic: undefined as unknown as Spell["mechanic"] });
    for (const s of [util, none]) {
      const r = resolveSpell(caster, "pc", s, undefined, scriptedRng([]));
      expect(r.kind).toBe("narrative");
      expect(r.damage).toBeUndefined();
      expect(r.heal).toBeUndefined();
    }
  });

  test("an offensive mechanic with no target resolves to narrative (nothing to bite)", () => {
    const s = spell({ id: "s.bolt", mechanic: { kind: "attack-damage", dice: "1d10", damageType: "cold" } });
    expect(resolveSpell(caster, "pc", s, undefined, scriptedRng([])).kind).toBe("narrative");
  });
});

// --- spellCommands + isOffensiveSpell ---------------------------------------

describe("spellCommands", () => {
  test("damage ⇒ negative adjustHp; heal ⇒ positive; status ⇒ applyStatusEffect", () => {
    expect(spellCommands({ spellId: "x", label: "", kind: "attack-damage", targetId: "foe", hit: true, damage: 5 })).toEqual([
      { type: "adjustHp", entityId: "foe", by: -5 },
    ]);
    expect(spellCommands({ spellId: "x", label: "", kind: "heal", targetId: "pc", heal: 4 })).toEqual([
      { type: "adjustHp", entityId: "pc", by: 4 },
    ]);
    const status = { kind: "mire-gripped", turnsRemaining: 3, mods: { disadvantage: true } };
    expect(spellCommands({ spellId: "x", label: "", kind: "save-debuff", targetId: "foe", status })).toEqual([
      { type: "applyStatusEffect", entityId: "foe", effect: status },
    ]);
  });

  test("a miss / negated result yields no commands", () => {
    expect(spellCommands({ spellId: "x", label: "", kind: "attack-damage", targetId: "foe", hit: false, damage: 0 })).toEqual([]);
    expect(spellCommands({ spellId: "x", label: "", kind: "narrative" })).toEqual([]);
  });
});

describe("isOffensiveSpell", () => {
  test("attack/save-damage/save-debuff are offensive; heal/utility/none are not", () => {
    const off = (m: Spell["mechanic"]) => isOffensiveSpell(spell({ id: "s", mechanic: m }));
    expect(off({ kind: "attack-damage", dice: "1d6", damageType: "fire" })).toBe(true);
    expect(off({ kind: "save-damage", dice: "1d6", damageType: "fire", save: "dex", half: false })).toBe(true);
    expect(off({ kind: "save-debuff", save: "wis", status: { kind: "x", turnsRemaining: 1, mods: {} } })).toBe(true);
    expect(off({ kind: "heal", dice: "1d8" })).toBe(false);
    expect(off({ kind: "utility" })).toBe(false);
    expect(off(undefined)).toBe(false);
  });
});

// --- combat advantage source -------------------------------------------------

describe("resolveAttack advantage", () => {
  test("advantage rolls two dice and keeps the higher", () => {
    const atk = combatant("a", statBlock({ abilities: { str: 10 }, level: 1 }));
    const def = combatant("d", statBlock({ armorClass: 30 })); // unreachable AC so only the picked die matters
    // two d20s: 4 then 17 — advantage keeps 17.
    const r = resolveAttack(atk, def, UNARMED, scriptedRng([3.5 / 20, 16.5 / 20]), { advantage: true });
    expect(r.natural).toBe(17);
  });
});

// --- reconcilePlan cast grounding -------------------------------------------

function castCtx(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    playerActorId: "pc.you",
    locationId: "loc.a",
    locationName: "A",
    exits: [],
    presentEntities: [{ id: "foe", name: "Wight" }],
    companionIds: [],
    knownSpells: [{ id: "spell.bolt", name: "Bolt" }],
    ...overrides,
  };
}

const rawCast = (cast: Record<string, unknown> | null): unknown => ({
  kind: "cast",
  targetId: null,
  destinationLocationId: null,
  check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
  cast,
  confidence: 0.9,
});

describe("reconcilePlan cast grounding", () => {
  test("a known spell + present target grounds", () => {
    const plan = reconcilePlan(rawCast({ spellId: "spell.bolt", targetId: "foe" }), castCtx());
    expect(plan.kind).toBe("cast");
    expect(plan.cast).toEqual({ spellId: "spell.bolt", targetId: "foe" });
  });

  test("an unknown spell drops the payload and downgrades to freeform", () => {
    const plan = reconcilePlan(rawCast({ spellId: "spell.ghost", targetId: "foe" }), castCtx());
    expect(plan.kind).toBe("freeformNarrative");
    expect(plan.cast).toBeUndefined();
  });

  test("a known spell with a hallucinated target keeps the cast but nulls the target (self/object)", () => {
    const plan = reconcilePlan(rawCast({ spellId: "spell.bolt", targetId: "nobody" }), castCtx());
    expect(plan.kind).toBe("cast");
    expect(plan.cast).toEqual({ spellId: "spell.bolt", targetId: null });
  });

  test("no known spells ⇒ a cast never grounds", () => {
    const plan = reconcilePlan(rawCast({ spellId: "spell.bolt", targetId: "foe" }), castCtx({ knownSpells: [] }));
    expect(plan.kind).toBe("freeformNarrative");
  });
});

// --- engine-wired cast -------------------------------------------------------

const PC = "pc.you";

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}

function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
}

const castPlan = (spellId: string, targetId: string | null): TurnPlan =>
  planOf({ kind: "cast", targetId, cast: { spellId, targetId } });

function castPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.magic",
    name: "Magic Test",
    summary: "A test range.",
    locations: [{ id: "loc.a", name: "Range", description: "A flat range.", connections: [], npcs: ["npc.gob"] }],
    // A carried item makes the NPC a statted registry row (the `seedStatlessNpc` carriesGoods rule),
    // so it is a real combatant — the same reason authored fighters like the Saltmother carry gear.
    items: [{ id: "item.hexstone", name: "Hex-Stone", kind: "misc" }],
    npcs: [
      {
        id: "npc.gob",
        name: "Hex-Goblin",
        summary: "A spiteful little caster.",
        persona: "Cruel and sly.",
        appearance: "A wiry goblin muttering hexes.",
        goals: ["Win the fight"],
        knowledge: [],
        relationships: {},
        inventory: ["item.hexstone"],
        stats: { abilities: { str: 10, dex: 8, con: 12, int: 12, wis: 10, cha: 8 }, maxHp: 40, armorClass: 8, level: 2, spells: ["spell.hex"] },
        autonomy: { isPartyMember: false, level: "passive", canLead: false, heartbeatSeconds: 40, replyDecayAlpha: 0.2 },
      },
    ],
    spells: [
      { id: "spell.knit", name: "Knit-Flesh", level: 1, mechanic: { kind: "heal", dice: "1d8" }, targeting: "self" },
      { id: "spell.bolt", name: "Bolt", level: 0, mechanic: { kind: "attack-damage", dice: "1d10", damageType: "cold" }, targeting: "enemy" },
      { id: "spell.hex", name: "Drowning Hex", level: 1, mechanic: { kind: "save-damage", dice: "2d6", damageType: "cold", save: "dex", half: false }, targeting: "enemy" },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.magic",
    name: "Magic Campaign",
    worldId: "w.magic",
    characters: [
      {
        id: PC,
        name: "You",
        age: 30,
        stats: { abilities: { str: 12, dex: 12, con: 12, int: 11, wis: 16, cha: 11 }, maxHp: 20, armorClass: 12, level: 2, spells: ["spell.knit", "spell.bolt"] },
      },
    ],
    startingState: { locationId: "loc.a", party: [PC], companions: [] },
  });
  return { world, campaign };
}

async function runCast(plans: TurnPlan[], rng: Rng): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const engine = new GameEngine({
    classifier: scriptedClassifier(plans),
    playset: castPlayset(),
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng,
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  for (const _p of plans) {
    events.length = 0;
    await engine.submitPlayerInput("(cast)");
  }
  return { engine, events };
}

describe("engine cast", () => {
  test("a player self-heal out of combat resolves the heal through the reducer", async () => {
    const { events } = await runCast([castPlan("spell.knit", null)], mulberry32(3));
    // The heal resolves end-to-end and emits its tracker line (the +HP amount; clamped at max HP).
    expect(events.some((e) => e.kind === "stateChanged" && /Knit-Flesh/.test((e as { summary: string }).summary))).toBe(true);
  });

  test("an unknown spell degrades to a narrated non-cast (no crash, no state change)", async () => {
    const { engine } = await runCast([castPlan("spell.nope", null)], mulberry32(3));
    // HP unchanged (no heal applied); the turn still resolved without throwing.
    expect(engine.getState().actors[PC]?.currentHp).toBe(20);
  });

  test("a player offensive cast resolves a spell attack against a present foe", async () => {
    const { events } = await runCast([castPlan("spell.bolt", "npc.gob")], mulberry32(9));
    // The spell attack always rolls (hit or miss), emitting the deterministic roll line — proof the
    // bolt resolved through the magic resolver rather than the weapon path.
    const rolled = events.some((e) => e.kind === "diceRolled" && /Bolt/.test((e as { purpose?: string }).purpose ?? ""));
    expect(rolled).toBe(true);
  });

  test("a lethal cast awards the PC kill XP (casts feed combat progression too)", async () => {
    // A fragile foe the bolt one-shots: 1 HP + a floor AC so the spell attack lands. The kill must
    // route the same challenge-scaled XP a weapon down grants (the pre-fix bug: cast kills gave none).
    const playset = castPlayset();
    const gob = playset.world.npcs.find((n) => n.id === "npc.gob")!;
    gob.stats!.maxHp = 1;
    gob.stats!.armorClass = 1;
    const engine = new GameEngine({
      classifier: scriptedClassifier([castPlan("spell.bolt", "npc.gob")]),
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(9),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    await engine.submitPlayerInput("(cast)");

    const prog = readProgressionSlice(engine.getState().modules)[PC];
    // The PC starts at the authored level-2 XP floor (100); a level-2 foe adds xpForDefeat(2) = 55.
    expect(prog?.xp).toBe(100 + xpForDefeat(2));
    expect(events.some((e) => e.kind === "stateChanged" && /is defeated\. \(\+\d+ XP\)/.test((e as { summary: string }).summary))).toBe(true);
  });

  test("an enemy caster looses its known spell on its combat turn", async () => {
    // Attack the goblin to open combat, then keep casting so it gets several turns; its keyed
    // cast decision fires deterministically and the Drowning Hex must land on the PC at least once.
    const plans = [
      planOf({ kind: "attack", targetId: "npc.gob" }),
      castPlan("spell.bolt", "npc.gob"),
      castPlan("spell.bolt", "npc.gob"),
      castPlan("spell.bolt", "npc.gob"),
    ];
    const engine = new GameEngine({
      classifier: scriptedClassifier(plans),
      playset: castPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(9),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    for (const _p of plans) await engine.submitPlayerInput("(go)");
    const enemyCast = events.some(
      (e) =>
        (e.kind === "stateChanged" && /Drowning Hex/.test((e as { summary: string }).summary)) ||
        (e.kind === "diceRolled" && /Drowning Hex/.test((e as { purpose?: string }).purpose ?? "")),
    );
    expect(enemyCast).toBe(true);
  });
});
