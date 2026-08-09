/**
 * Combat — deterministic initiative, attack/damage, and saving-throw resolution.
 *
 * Mechanics live here, never in the model: the LLM may decide a swing happens and narrate
 * the result, but every number comes from a seeded RNG in this module.
 *
 * @author Runkai Zhang
 */
import type { StatBlock } from "../content/schema.ts";
import type { Equipped } from "../world/entity.ts";
import { resolveCheck } from "./checks.ts";
import { abilityModifier, roll, rollD20, type Rng } from "./dice.ts";
import { isArmor, isShield, type ResolvedItem } from "./items.ts";
import type { WeaponProfile } from "./srd/index.ts";

export interface Combatant {
  id: string;
  stats: StatBlock;
  currentHp: number;
}

export interface InitiativeEntry {
  id: string;
  initiative: number;
}

export type AbilityKey = keyof StatBlock["abilities"];

/** 5e proficiency bonus by level/CR: +2 at 1-4, +3 at 5-8, and so on. */
export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

function attackAbility(stats: StatBlock, weapon: WeaponProfile): AbilityKey {
  if (weapon.ranged) return "dex";
  if (weapon.finesse) return stats.abilities.dex >= stats.abilities.str ? "dex" : "str";
  return "str";
}

/** Roll initiative for each combatant and return them in turn order (desc). */
export function rollInitiative(combatants: Combatant[], rng: Rng = Math.random): InitiativeEntry[] {
  return combatants
    .map((combatant, index) => {
      const dex = combatant.stats.abilities.dex;
      const initiative = rollD20({ modifier: abilityModifier(dex) }, rng).total;
      return { id: combatant.id, initiative, dex, index };
    })
    .sort((a, b) => b.initiative - a.initiative || b.dex - a.dex || a.index - b.index)
    .map(({ id, initiative }) => ({ id, initiative }));
}

/**
 * AC derived from what is actually worn (Phase 1 equip): armor base `ac` + the dex modifier
 * capped by the armor's `dexCap` (null/absent = uncapped light, 2 medium, 0 heavy — heavy armor
 * IGNORES dex entirely per SRD 5.1, so a clumsy brute in plate is not easier to hit) + a
 * shield's `ac` bonus (+2 by SRD) when a real shield is raised. With no resolvable armor
 * equipped the authored `stats.armorClass` stands verbatim — monsters and unequipped humanoids
 * are untouched — though a raised shield still adds on top. Properties are read defensively;
 * this never throws.
 */
export function derivedAc(
  stats: Pick<StatBlock, "armorClass" | "abilities">,
  equipped: Equipped | undefined,
  resolve: (itemId: string) => ResolvedItem | undefined,
  acMod = 0,
): number {
  const shieldItem = equipped?.shield ? resolve(equipped.shield) : undefined;
  const shieldBonus =
    shieldItem && isShield(shieldItem)
      ? typeof shieldItem.properties.ac === "number"
        ? shieldItem.properties.ac
        : 2
      : 0;

  const armorItem = equipped?.armor ? resolve(equipped.armor) : undefined;
  let ac = stats.armorClass;
  if (armorItem && isArmor(armorItem) && typeof armorItem.properties.ac === "number") {
    const dexMod = abilityModifier(stats.abilities.dex);
    const dexCap = armorItem.properties.dexCap;
    // dexCap 0 (heavy) means "no dex modifier at all", not a ceiling negative dex slips under.
    const dexPart = typeof dexCap === "number" ? (dexCap === 0 ? 0 : Math.min(dexMod, dexCap)) : dexMod;
    ac = armorItem.properties.ac + dexPart;
  }
  return ac + shieldBonus + acMod;
}

export interface AttackResult {
  hit: boolean;
  /** The natural d20 result before modifiers. */
  natural: number;
  attackRoll: number;
  targetAc: number;
  damage: number;
  damageType: string;
  damageNotation: string;
  critical: boolean;
  fumble: boolean;
}

export interface AttackOptions {
  toHit?: number;
  advantage?: boolean;
  disadvantage?: boolean;
}

/** Resolve a single attack from attacker against defender. */
export function resolveAttack(
  attacker: Combatant,
  defender: Combatant,
  weapon: WeaponProfile,
  rng: Rng = Math.random,
  opts: AttackOptions = {},
): AttackResult {
  const ability = attackAbility(attacker.stats, weapon);
  const abilityMod = abilityModifier(attacker.stats.abilities[ability]);
  const attackMod = abilityMod + proficiencyBonus(attacker.stats.level) + (opts.toHit ?? 0);
  const d20 = rollD20({ modifier: attackMod, advantage: opts.advantage, disadvantage: opts.disadvantage }, rng);

  const critical = d20.picked === 20;
  const fumble = d20.picked === 1;
  const hit = critical || (!fumble && d20.total >= defender.stats.armorClass);

  let damage = 0;
  if (hit) {
    const base = roll(weapon.damage, rng);
    const baseDice = base.rolls.reduce((sum, die) => sum + die, 0);
    const criticalDice = critical ? roll(weapon.damage, rng).rolls.reduce((sum, die) => sum + die, 0) : 0;
    damage = Math.max(1, baseDice + criticalDice + base.modifier + abilityMod);
  }

  return {
    hit,
    natural: d20.picked,
    attackRoll: d20.total,
    targetAc: defender.stats.armorClass,
    damage,
    damageType: weapon.damageType,
    damageNotation: `${weapon.damage}${abilityMod >= 0 ? `+${abilityMod}` : abilityMod}`,
    critical: critical && hit,
    fumble,
  };
}

export interface SaveResult {
  success: boolean;
  rolls: number[];
  natural: number;
  modifier: number;
  total: number;
  dc: number;
  critical: "success" | "failure" | null;
}

/** Resolve a saving throw with the target's ability modifier against a DC. */
export function resolveSave(
  target: Combatant,
  ability: AbilityKey,
  dc: number,
  rng: Rng = Math.random,
): SaveResult {
  const result = resolveCheck({ abilityScore: target.stats.abilities[ability], dc }, rng);
  return {
    success: result.success,
    rolls: result.rolls,
    natural: result.picked,
    modifier: result.modifier,
    total: result.total,
    dc: result.dc,
    critical: result.critical,
  };
}
