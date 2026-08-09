/**
 * Combat resolver tests — pure, deterministic M3 rules math.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { StatBlock } from "../src/content/schema.ts";
import {
  proficiencyBonus,
  resolveAttack,
  resolveSave,
  rollInitiative,
  type Combatant,
} from "../src/rules/combat.ts";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { getCondition, getWeapon, SRD_CONDITIONS, SRD_WEAPONS, UNARMED } from "../src/rules/srd/index.ts";

function scriptedRng(values: number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error(`scripted rng exhausted at roll ${index}`);
    return value;
  };
}

function statBlock(opts: {
  abilities?: Partial<StatBlock["abilities"]>;
  armorClass?: number;
  maxHp?: number;
  level?: number;
} = {}): StatBlock {
  return {
    abilities: {
      str: 10,
      dex: 10,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
      ...opts.abilities,
    },
    maxHp: opts.maxHp ?? 10,
    armorClass: opts.armorClass ?? 10,
    level: opts.level ?? 1,
    speed: 30,
    proficiencies: [],
    spells: [],
  };
}

function combatant(id: string, stats: StatBlock): Combatant {
  return { id, stats, currentHp: stats.maxHp };
}

function weapon(id: string) {
  const profile = getWeapon(id);
  if (!profile) throw new Error(`missing test weapon ${id}`);
  return profile;
}

describe("SRD loader", () => {
  test("validates the bundled weapon and condition shapes", () => {
    expect(SRD_WEAPONS).toHaveLength(11);
    expect(SRD_CONDITIONS).toHaveLength(9);
    expect(getWeapon("weapon.dagger")).toMatchObject({
      name: "Dagger",
      damage: "1d4",
      damageType: "piercing",
      finesse: true,
      ranged: false,
      versatile: null,
    });
    expect(getCondition("unconscious")?.name).toBe("Unconscious");
    expect(UNARMED.id).toBe("weapon.unarmed");
  });
});

describe("proficiencyBonus()", () => {
  test("matches the 5e level bands", () => {
    expect(proficiencyBonus(1)).toBe(2);
    expect(proficiencyBonus(4)).toBe(2);
    expect(proficiencyBonus(5)).toBe(3);
    expect(proficiencyBonus(17)).toBe(6);
  });
});

describe("rollInitiative()", () => {
  test("rolls d20 plus DEX and breaks ties by DEX then input order", () => {
    const slow = combatant("slow", statBlock({ abilities: { dex: 10 } }));
    const fastA = combatant("fast-a", statBlock({ abilities: { dex: 14 } }));
    const fastB = combatant("fast-b", statBlock({ abilities: { dex: 14 } }));

    const order = rollInitiative([slow, fastA, fastB], scriptedRng([0.55, 0.45, 0.45]));

    expect(order).toEqual([
      { id: "fast-a", initiative: 12 },
      { id: "fast-b", initiative: 12 },
      { id: "slow", initiative: 12 },
    ]);
  });
});

describe("resolveAttack()", () => {
  test("is deterministic with a fixed seed", () => {
    const attacker = combatant("pc", statBlock({ abilities: { str: 16 }, level: 3 }));
    const defender = combatant("foe", statBlock({ armorClass: 13 }));

    const a = resolveAttack(attacker, defender, weapon("weapon.longsword"), mulberry32(20260629));
    const b = resolveAttack(attacker, defender, weapon("weapon.longsword"), mulberry32(20260629));

    expect(a).toEqual(b);
  });

  test("accepts exhaustion-style attack penalties and disadvantage", () => {
    const attacker = combatant("pc", statBlock({ abilities: { str: 16 }, level: 3 }));
    const defender = combatant("foe", statBlock({ armorClass: 99 }));

    const result = resolveAttack(
      attacker,
      defender,
      weapon("weapon.longsword"),
      scriptedRng([0.9, 0.1]),
      { toHit: -2, disadvantage: true },
    );

    expect(result.natural).toBe(3);
    expect(result.attackRoll).toBe(6);
    expect(result.hit).toBe(false);
  });

  test("uses DEX for finesse weapons when it is better than STR", () => {
    const attacker = combatant("rogue", statBlock({ abilities: { str: 8, dex: 16 } }));
    const defender = combatant("guard", statBlock({ armorClass: 15 }));

    const result = resolveAttack(attacker, defender, weapon("weapon.dagger"), scriptedRng([0.5, 0.75]));

    expect(result).toMatchObject({
      hit: true,
      natural: 11,
      attackRoll: 16,
      targetAc: 15,
      damage: 7,
      damageType: "piercing",
      damageNotation: "1d4+3",
      critical: false,
      fumble: false,
    });
  });

  test("natural 20 always hits and doubles weapon damage dice", () => {
    const attacker = combatant("fighter", statBlock({ abilities: { str: 16 } }));
    const defender = combatant("stone", statBlock({ armorClass: 99 }));

    const result = resolveAttack(attacker, defender, weapon("weapon.longsword"), scriptedRng([0.999, 0.5, 0.25]));

    expect(result).toMatchObject({
      hit: true,
      natural: 20,
      attackRoll: 25,
      damage: 11,
      critical: true,
      fumble: false,
    });
  });

  test("crit is natural-20-only: a natural 19 with a big modifier hits high but is NOT critical (W3)", () => {
    // A hard-hitting attacker: STR 20 (+5) at level 20 (prof +6) → +11 to hit. This is exactly the
    // "(critical) on a 21-29 total" the playtest flagged — those totals are legitimate non-crit hits.
    const attacker = combatant("champion", statBlock({ abilities: { str: 20 }, level: 20 }));
    const defender = combatant("target", statBlock({ armorClass: 12 }));

    // rng 0.9 → rollDie(20) = 1 + floor(0.9 * 20) = 19 (a natural 19). Damage roll follows (0.5).
    const nat19 = resolveAttack(attacker, defender, weapon("weapon.longsword"), scriptedRng([0.9, 0.5]));
    expect(nat19.natural).toBe(19);
    expect(nat19.attackRoll).toBe(30); // 19 + 11 — a big, hitting total…
    expect(nat19.hit).toBe(true);
    expect(nat19.critical).toBe(false); // …but NOT a crit. Only a natural 20 crits.

    // rng 0.95 → rollDie(20) = 1 + floor(0.95 * 20) = 20 (a natural 20) → a crit (two damage rolls).
    const nat20 = resolveAttack(attacker, defender, weapon("weapon.longsword"), scriptedRng([0.95, 0.5, 0.5]));
    expect(nat20.natural).toBe(20);
    expect(nat20.hit).toBe(true);
    expect(nat20.critical).toBe(true);
  });

  test("natural 1 always misses", () => {
    const attacker = combatant("hero", statBlock({ abilities: { str: 20 }, level: 20 }));
    const defender = combatant("dummy", statBlock({ armorClass: 1 }));

    const result = resolveAttack(attacker, defender, weapon("weapon.greataxe"), scriptedRng([0]));

    expect(result.hit).toBe(false);
    expect(result.natural).toBe(1);
    expect(result.fumble).toBe(true);
    expect(result.damage).toBe(0);
  });

  test("landed damage is floored at 1", () => {
    const attacker = combatant("weak", statBlock({ abilities: { str: 1 } }));
    const defender = combatant("target", statBlock({ armorClass: 7 }));

    const result = resolveAttack(attacker, defender, weapon("weapon.club"), scriptedRng([0.45, 0]));

    expect(result.hit).toBe(true);
    expect(result.attackRoll).toBe(7);
    expect(result.damage).toBe(1);
  });
});

describe("resolveSave()", () => {
  test("wraps resolveCheck for saving throws", () => {
    const target = combatant("scout", statBlock({ abilities: { dex: 14 } }));

    const result = resolveSave(target, "dex", 15, scriptedRng([0.6]));

    expect(result).toEqual({
      success: true,
      rolls: [13],
      natural: 13,
      modifier: 2,
      total: 15,
      dc: 15,
      critical: null,
    });
  });
});
