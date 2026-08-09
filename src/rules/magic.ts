/**
 * Magic — deterministic spell resolution.
 *
 * The magic analogue of `combat.ts`: pure, seeded, and state-free. The LLM may decide a spell is
 * cast and narrate its effect, but every number — attack roll, save, damage, heal — comes from the
 * seeded RNG here. A spell's mechanical shape is the typed `SpellMechanic` (`content/schema.ts`);
 * this module reads it and returns a `SpellResolution`. The caller (the engine's `resolveCast` for
 * the player, `CombatModule` for enemies) translates that resolution into reducer `Command`s via
 * {@link spellCommands} and applies them through the one writer — this file never mutates state.
 *
 * A spell WITHOUT a `mechanic` (or a `utility` one) resolves to a `narrative` result: no dice, no
 * commands — it still spends time/energy and is narrated. That is the graceful floor for spells
 * authored before this layer existed.
 *
 * @author Runkai Zhang
 */
import type { Spell, StatBlock } from "../content/schema.ts";
import type { Command } from "../world/commands.ts";
import { abilityModifier, roll, rollD20, type Rng } from "./dice.ts";
import { proficiencyBonus, resolveSave, type AbilityKey, type Combatant } from "./combat.ts";
import type { StatusEffect } from "./status-effects.ts";

/** The three mental abilities a caster's spell DC / attack bonus may key on. */
const MENTAL_ABILITIES: readonly AbilityKey[] = ["int", "wis", "cha"] as const;

export interface SpellcastingProfile {
  /** The mental ability the caster leans on (their best of int/wis/cha). */
  ability: AbilityKey;
  mod: number;
  /** Spell save DC = 8 + proficiency + ability modifier. */
  dc: number;
  /** Spell attack bonus = proficiency + ability modifier. */
  attackBonus: number;
}

/**
 * A caster's spellcasting profile derived from their stat block. There is no class system: the
 * casting ability is simply the caster's best mental score (int/wis/cha), so any statted entity can
 * be given known spells and cast them coherently.
 */
export function spellcasting(stats: StatBlock): SpellcastingProfile {
  const ability = MENTAL_ABILITIES.reduce(
    (best, a) => (stats.abilities[a] > stats.abilities[best] ? a : best),
    MENTAL_ABILITIES[0]!,
  );
  const mod = abilityModifier(stats.abilities[ability]);
  const prof = proficiencyBonus(stats.level);
  return { ability, mod, dc: 8 + prof + mod, attackBonus: prof + mod };
}

export interface SpellSaveOutcome {
  ability: AbilityKey;
  dc: number;
  natural: number;
  total: number;
  success: boolean;
}

export interface SpellResolution {
  spellId: string;
  /** Human-readable tracker label, e.g. "Witch-Cold Bolt vs AC 13" or "Ward-Word — WIS save DC 13". */
  label: string;
  /** The mechanic that resolved, or "narrative" for a mechanic-less / utility spell. */
  kind: "attack-damage" | "save-damage" | "heal" | "save-debuff" | "utility" | "narrative";
  targetId?: string;
  /** Spell-attack fields (attack-damage). */
  hit?: boolean;
  critical?: boolean;
  natural?: number;
  attackTotal?: number;
  targetAc?: number;
  /** Saving-throw fields (save-damage / save-debuff). */
  save?: SpellSaveOutcome;
  /** HP the target should LOSE (already 0 on a miss / negated save). */
  damage?: number;
  damageType?: string;
  /** HP the target should GAIN (heal). */
  heal?: number;
  /** The status effect to impose (save-debuff, only present when the save failed). */
  status?: StatusEffect;
  /** The dice notation actually rolled, for the roll line. */
  notation?: string;
}

/** Sum of the dice rolled for a damage/heal notation (the flat modifier is included in `RollResult.total`). */
function rollTotal(notation: string, rng: Rng): { total: number; notation: string } {
  const r = roll(notation, rng);
  return { total: Math.max(0, r.total), notation: r.notation };
}

/**
 * Resolve a spell cast by `caster` (optionally at `target`). Pure and seeded. `target` is a
 * {@link Combatant} whose `stats.armorClass` the caller has already resolved to a DERIVED AC (worn
 * armor + shield), exactly as `CombatModule.combatantOf` does, so a spell attack respects gear. A
 * spell with no mechanic (or a `utility` one), or a targeted mechanic with no `target`, resolves to
 * a harmless `narrative` result.
 */
export function resolveSpell(
  caster: StatBlock,
  casterId: string,
  spell: Spell,
  target: Combatant | undefined,
  rng: Rng = Math.random,
): SpellResolution {
  const mech = spell.mechanic;
  const base: SpellResolution = { spellId: spell.id, kind: "narrative", label: spell.name };
  if (!mech || mech.kind === "utility") return base;

  const profile = spellcasting(caster);

  if (mech.kind === "heal") {
    // Self/ally heal — a heal with no explicit target restores the caster.
    const healTargetId = target?.id ?? casterId;
    const { total, notation } = rollTotal(mech.dice, rng);
    return { ...base, kind: "heal", targetId: healTargetId, heal: total, notation, label: `${spell.name} — heal ${notation}` };
  }

  // Every remaining mechanic needs a target.
  if (!target) return base;

  if (mech.kind === "attack-damage") {
    const d20 = rollD20({ modifier: profile.attackBonus }, rng);
    const critical = d20.picked === 20;
    const fumble = d20.picked === 1;
    const hit = critical || (!fumble && d20.total >= target.stats.armorClass);
    let damage = 0;
    if (hit) {
      const first = roll(mech.dice, rng);
      const dice = first.rolls.reduce((s, d) => s + d, 0);
      const critDice = critical ? roll(mech.dice, rng).rolls.reduce((s, d) => s + d, 0) : 0;
      damage = Math.max(1, dice + critDice + first.modifier);
    }
    return {
      ...base,
      kind: "attack-damage",
      targetId: target.id,
      hit,
      critical: critical && hit,
      natural: d20.picked,
      attackTotal: d20.total,
      targetAc: target.stats.armorClass,
      damage,
      damageType: mech.damageType,
      notation: mech.dice,
      label: `${spell.name} vs AC ${target.stats.armorClass}`,
    };
  }

  if (mech.kind === "save-damage") {
    const saveResult = resolveSave(target, mech.save, profile.dc, rng);
    const rolled = roll(mech.dice, rng);
    const full = Math.max(0, rolled.rolls.reduce((s, d) => s + d, 0) + rolled.modifier);
    const damage = saveResult.success ? (mech.half ? Math.floor(full / 2) : 0) : full;
    return {
      ...base,
      kind: "save-damage",
      targetId: target.id,
      save: { ability: mech.save, dc: saveResult.dc, natural: saveResult.natural, total: saveResult.total, success: saveResult.success },
      damage,
      damageType: mech.damageType,
      notation: mech.dice,
      label: `${spell.name} — ${mech.save.toUpperCase()} save DC ${saveResult.dc}`,
    };
  }

  // save-debuff
  const saveResult = resolveSave(target, mech.save, profile.dc, rng);
  const status: StatusEffect | undefined = saveResult.success
    ? undefined
    : { kind: mech.status.kind, turnsRemaining: mech.status.turnsRemaining, mods: { ...mech.status.mods }, source: spell.id };
  return {
    ...base,
    kind: "save-debuff",
    targetId: target.id,
    save: { ability: mech.save, dc: saveResult.dc, natural: saveResult.natural, total: saveResult.total, success: saveResult.success },
    status,
    label: `${spell.name} — ${mech.save.toUpperCase()} save DC ${saveResult.dc}`,
  };
}

/**
 * Translate a {@link SpellResolution} into the reducer `Command`s that realize it. Pure — the caller
 * preflights each command via `ctx.dryRun` and only commits the batch if all pass (the atomic
 * transaction the defeat-outcome engine uses), so a malformed spell never half-applies. Returns an
 * empty list for a narrative/miss/negated result (nothing to mutate).
 */
export function spellCommands(resolution: SpellResolution): Command[] {
  const commands: Command[] = [];
  if (!resolution.targetId) return commands;
  if (resolution.damage && resolution.damage > 0) {
    commands.push({ type: "adjustHp", entityId: resolution.targetId, by: -resolution.damage });
  }
  if (resolution.heal && resolution.heal > 0) {
    commands.push({ type: "adjustHp", entityId: resolution.targetId, by: resolution.heal });
  }
  if (resolution.status) {
    commands.push({ type: "applyStatusEffect", entityId: resolution.targetId, effect: resolution.status });
  }
  return commands;
}

/** Whether a spell's mechanic is offensive — the set an enemy caster may open with. */
export function isOffensiveSpell(spell: Spell): boolean {
  const k = spell.mechanic?.kind;
  return k === "attack-damage" || k === "save-damage" || k === "save-debuff";
}

/** Who a cast is aimed at, for target grounding. */
export type SpellAim = "self" | "ally" | "enemy" | "object";

/**
 * The effective target kind for grounding a cast: the authored `spell.targeting` when present, else
 * inferred from the mechanic (offensive ⇒ enemy · heal ⇒ ally · utility/none ⇒ object). The engine's
 * `resolveCast` uses this to pick a default target and to decide whether the cast needs a present foe,
 * so an authored `targeting` genuinely steers grounding rather than being ignored.
 */
export function spellAim(spell: Spell): SpellAim {
  if (spell.targeting) return spell.targeting;
  const k = spell.mechanic?.kind;
  if (!k || k === "utility") return "object";
  if (k === "heal") return "ally";
  return "enemy";
}
