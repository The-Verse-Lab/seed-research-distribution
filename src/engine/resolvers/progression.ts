/**
 * Character progression at the engine layer — effective stat blocks, XP grants, level beats.
 *
 * The arithmetic lives in `src/rules/progression.ts`; this is the thin layer that reads the live
 * world for a base block, routes the grant through the reducer (`grantXp` is the slice's one
 * writer), and narrates the level reached. Split out of `GameEngine` because three unrelated
 * domains grant XP — quest rewards, combat kills, and lethal casts — and each was reaching into
 * the same private methods on the god class.
 *
 * A grant previews the fold only to phrase the beat; the authoritative fold is the reducer's.
 *
 * @author Runkai Zhang
 */
import type { StatBlock } from "../../content/schema.ts";
import { derivedAc, type Combatant } from "../../rules/combat.ts";
import { resolveItem } from "../../rules/items.ts";
import { applyXpGain, effectiveStatBlock, progressionOf, readProgressionSlice, xpForDefeat } from "../../rules/progression.ts";
import { statusMods } from "../../rules/status-effects.ts";
import { displayName, type Entity } from "../../world/entity.ts";
import { playerEntity, type WorldModel } from "../../world/model.ts";
import type { EngineHost } from "./host.ts";

/**
 * The entity's EFFECTIVE stat block: the authored base (a PC's on the campaign character, a
 * monster's/NPC's on the world template — runtime entity stats hold only currentHp/inventory) with
 * earned progression overlaid (level ⇒ proficiency, learned spells, grown maxHp). Null when nothing
 * authored a block. Mirrors `CombatModule.statBlockFor`.
 */
export function statBlockOf(host: EngineHost, entity: Entity): StatBlock | null {
  let base: StatBlock | null | undefined;
  if (entity.kind === "pc") {
    base = host.campaign.characters.find((c) => c.id === entity.id)?.stats;
  } else if (entity.kind === "monster") {
    base = host.world.monsters.find((m) => m.id === (entity.templateId ?? entity.id))?.stats;
  } else {
    base = host.world.npcs.find((n) => n.id === (entity.templateId ?? entity.id))?.stats;
  }
  if (!base) return null;
  const entry = readProgressionSlice(host.model().modules)[entity.id];
  return effectiveStatBlock(base, entry, entity.stats?.maxHp);
}

/**
 * The entity as a {@link Combatant} with DERIVED AC (worn armor + shield + status) — the same shape
 * `CombatModule.combatantOf` builds, so a spell attack respects gear and a save reads the target's
 * real abilities. Null when the entity has no stats/block.
 */
export function combatantOf(host: EngineHost, model: WorldModel, entity: Entity): Combatant | null {
  const base = statBlockOf(host, entity);
  if (!base || !entity.stats) return null;
  const ac = derivedAc(base, entity.stats.equipped, (id) => resolveItem(host.world, id), statusMods(model, entity.id).ac);
  return { id: entity.id, stats: ac === base.armorClass ? base : { ...base, armorClass: ac }, currentHp: entity.stats.currentHp };
}

/** The character's authored starting level (un-overlaid) — the seed for a first XP/learn grant. */
export function authoredLevelOf(host: EngineHost, entityId: string): number {
  return (
    host.campaign.characters.find((c) => c.id === entityId)?.stats.level ??
    host.world.npcs.find((n) => n.id === entityId)?.stats?.level ??
    1
  );
}

/** Whether the entity currently knows at least one spell (authored + learned) — a caster. The study
 *  credit is only usable by a caster, so beats/HUDs gate the "learn a working" prompt on this. */
export function knowsAnySpell(host: EngineHost, entityId: string): boolean {
  const base = host.campaign.characters.find((c) => c.id === entityId)?.stats;
  if (!base) return false;
  const prog = readProgressionSlice(host.model().modules)[entityId];
  return effectiveStatBlock(base, prog).spells.length > 0;
}

/**
 * Grant experience to a character (usually the PC) through the reducer, then narrate any level
 * reached. The `grantXp` command is the single writer of the progression slice; this wrapper only
 * previews the fold to phrase the beat (and only ever announces a level-up, never the raw award —
 * that is left to the caller's own reward line).
 */
export function awardXp(host: EngineHost, entityId: string, by: number): void {
  if (by <= 0) return;
  const baseLevel = authoredLevelOf(host, entityId);
  const before = progressionOf(host.model().modules, entityId, baseLevel);
  const preview = applyXpGain(before, by);
  host.apply({ type: "grantXp", entityId, by, baseLevel });
  if (preview.levelsGained > 0) {
    // Only a caster can turn a study credit into a spell (the study surface needs an existing known
    // working to build on), so a martial character is never promised a working they cannot learn.
    const credit =
      preview.creditsGained > 0 && knowsAnySpell(host, entityId)
        ? " A new working is within reach — you may learn one."
        : "";
    host.emit({
      kind: "stateChanged",
      summary: `You reach level ${preview.next.level}! (+${preview.hpGain} HP)${credit}`,
      changes: { entityId, level: preview.next.level, hpGain: preview.hpGain },
    });
  }
}

/**
 * Award a party kill's challenge-scaled XP to the PC when a lethal CAST (not a weapon swing) drops a
 * foe. Casts resolve outside the combat tick, so the combat module's `afterSwing` XP path never sees
 * them; this mirrors its beat exactly (+N XP, and any level reached). The credit hint is shown only
 * for a caster — which the PC, having just cast, always is here.
 */
export function awardCastKillXp(host: EngineHost, victim: Entity): void {
  const player = playerEntity(host.model());
  if (!player) return;
  const foeLevel = statBlockOf(host, victim)?.level ?? 1;
  const xp = xpForDefeat(foeLevel);
  const baseLevel = authoredLevelOf(host, player.id);
  const preview = applyXpGain(progressionOf(host.model().modules, player.id, baseLevel), xp);
  host.apply({ type: "grantXp", entityId: player.id, by: xp, baseLevel });
  const levelText =
    preview.levelsGained > 0
      ? ` You reach level ${preview.next.level}! (+${preview.hpGain} HP${preview.creditsGained > 0 && knowsAnySpell(host, player.id) ? `, a new working to learn` : ""})`
      : "";
  host.emit({
    kind: "stateChanged",
    summary: `${displayName(victim)} is defeated. (+${xp} XP)${levelText}`,
    changes: { xp, entityId: player.id, level: preview.next.level },
  });
}
