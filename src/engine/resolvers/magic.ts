/**
 * The magic domain — casting a known working, and acquiring a new one.
 *
 * Extracted verbatim from `GameEngine`. Every number comes from `src/rules/magic.ts` (seeded), the
 * resulting commands are preflighted on a clone and applied atomically, and the model only ever
 * narrates the result — the one-writer rule and the mechanics-in-code rule both hold unchanged
 * across the move.
 *
 * @author Runkai Zhang
 */
import type { NarrationIntent } from "../../modules/narration.ts";
import { formatCoins, resolveItem } from "../../rules/items.ts";
import { isCombatActive } from "../../world/queries.ts";
import { resolveSpell, spellAim, spellCommands } from "../../rules/magic.ts";
import { effectiveStatBlock, progressionOf } from "../../rules/progression.ts";
import { isPartyHostile } from "../../rules/betrayal.ts";
import { displayName, type Entity } from "../../world/entity.ts";
import { entitiesAt, playerEntity } from "../../world/model.ts";
import type { TickContext } from "../tick.ts";
import type { TurnPlan } from "../turn-plan.ts";
import { hostOf } from "./host.ts";
import { awardCastKillXp, combatantOf, statBlockOf } from "./progression.ts";

/**
 * Resolve a player CAST — "I cast witch-cold bolt at the wight", "I mend the strap", "I heal Oda".
 * The magic analogue of the item-action resolver: every number comes from `resolveSpell` (seeded,
 * in `src/rules/magic.ts`), the resulting reducer commands are preflighted then applied atomically
 * (the defeat-outcome transaction), and a completed cast mid-fight SPENDS the player's combat turn
 * via `ctx.data.itemActionTurn` — so the combat module drives the enemy side and a lethal spell
 * ends the fight through the existing end-of-combat path. A spell with no `mechanic` (or a
 * `utility` one) casts as narrative-only: a real turn, narrated, no dice.
 */
export function resolveCast(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const host = hostOf(ctx);
  const model = ctx.model;
  const player = playerEntity(model);
  const spellId = plan.cast?.spellId ?? null;
  const spell = spellId ? ctx.services.world.spells.find((s) => s.id === spellId) : undefined;
  if (!plan.cast || !spell || !player?.stats) return { trigger: input };
  const casterStats = statBlockOf(host, player);
  // Defense in depth — the classifier already grounds the spell to the caster's known list, but a
  // click/wire path could set one directly; a spell the PC has not learned is just narrated.
  if (!casterStats || !casterStats.spells.includes(spell.id)) {
    return { trigger: `You reach for a working you have never learned. ${input}` };
  }
  if (player.stats.currentHp <= 0) {
    return { trigger: `You are down — the world swims dark and no words of power will come. (Rest or victory can bring you back.)` };
  }

  const spendCombatTurn = (): void => {
    if (isCombatActive(model)) ctx.data.itemActionTurn = { actorId: player.id };
  };

  const mech = spell.mechanic;
  // Narrative-only: no mechanic, or an explicit utility working (mending, ward, light). A real
  // turn — narrated with the spell as grounding — but no dice and no state change.
  if (!mech || mech.kind === "utility") {
    spendCombatTurn();
    return { trigger: `You cast ${spell.name}. ${input}` };
  }

  // Ground the target off the spell's aim (authored `targeting`, else inferred from the mechanic):
  // self-aimed hits the caster, ally-aimed a named ally else the caster, enemy-aimed a named foe.
  // Only an offensive enemy-aimed working needs a present, living target — an ungrounded one degrades
  // to a narrated fizzle (never a crash). A self/ally aim never fizzles for "no foe".
  const targetId = plan.cast.targetId ?? plan.targetId ?? null;
  const aim = spellAim(spell);
  const offensive = mech.kind === "attack-damage" || mech.kind === "save-damage" || mech.kind === "save-debuff";
  let targetEntity: Entity | undefined;
  if (aim === "self") {
    targetEntity = player;
  } else if (aim === "ally") {
    targetEntity = targetId && targetId !== player.id ? model.entities.get(targetId) : player;
  } else {
    targetEntity = targetId ? model.entities.get(targetId) : undefined;
  }
  const needsFoe = offensive && aim === "enemy";
  if (needsFoe) {
    if (!targetEntity || targetEntity.locationId !== player.locationId || (targetEntity.stats?.currentHp ?? 0) <= 0) {
      return { trigger: `You shape ${spell.name}, but there is no target for it here. ${input}` };
    }
  }
  const targetCombatant = targetEntity ? combatantOf(host, model, targetEntity) : undefined;
  if (needsFoe && !targetCombatant) {
    return { trigger: `You loose ${spell.name}, but it finds nothing to bite. ${input}` };
  }

  const resolution = resolveSpell(casterStats, player.id, spell, targetCombatant ?? undefined, ctx.services.rng);

  // Emit the roll line (the deterministic tracker, no model call): the caster's spell attack, or
  // the target's saving throw.
  if (resolution.kind === "attack-damage" && resolution.natural !== undefined) {
    ctx.emit({
      kind: "diceRolled",
      actorId: player.id,
      notation: "1d20",
      rolls: [resolution.natural],
      total: resolution.attackTotal ?? resolution.natural,
      purpose: resolution.label,
      success: resolution.hit,
    });
  } else if (resolution.save && resolution.targetId) {
    ctx.emit({
      kind: "diceRolled",
      actorId: resolution.targetId,
      notation: "1d20",
      rolls: [resolution.save.natural],
      total: resolution.save.total,
      purpose: resolution.label,
      success: resolution.save.success,
    });
  }

  // Apply the resolved commands atomically: preflight every command on a clone, commit only if all
  // pass (a malformed spell drops cleanly, never half-applies) — the defeat-outcome transaction.
  const commands = spellCommands(resolution);
  const applied = commands.length > 0 && commands.every((c) => !ctx.dryRun(c).rejected);
  if (applied) for (const c of commands) ctx.apply(c);

  const targetName = targetEntity ? displayName(targetEntity) : "";
  const afterHp = targetEntity?.stats?.currentHp ?? 0;
  const maxHp = targetCombatant?.stats.maxHp ?? targetEntity?.stats?.maxHp;
  const hpText = maxHp !== undefined ? `${afterHp}/${maxHp} HP` : `${afterHp} HP`;

  // A spell that drops a combat target sets `unconscious` (mirrors the combat module's afterSwing),
  // so the downed-checks and end-of-combat read consistently regardless of what dealt the blow.
  if (applied && (resolution.damage ?? 0) > 0 && targetEntity && afterHp <= 0) {
    ctx.apply({ type: "setCondition", entityId: targetEntity.id, condition: "unconscious", active: true });
    // A lethal cast is the mage's kill — award the same challenge-scaled XP a weapon down grants
    // (the combat module's `afterSwing` path). Casts resolve OUTSIDE the combat tick, so without
    // this a spell-focused fight would end with no progression. Enemy-side victim only (a foe the
    // PC is fighting: hostile-flagged or simply not a party ally), never a downed companion.
    const foe = targetEntity.id !== player.id && (isPartyHostile(model, targetEntity.id) || !targetEntity.partyMember);
    if (foe) awardCastKillXp(host, targetEntity);
  }

  // The deterministic effect tracker line (a `· …` stateChanged beat), then the narrator trigger.
  if (resolution.kind === "attack-damage") {
    if (resolution.hit && (resolution.damage ?? 0) > 0) {
      const crit = resolution.critical ? " (critical — natural 20)" : "";
      ctx.emit({
        kind: "stateChanged",
        summary: `${targetName}: ${resolution.damage} ${resolution.damageType} (${spell.name})${crit} → ${hpText}${afterHp <= 0 ? " (down)" : ""}`,
        changes: { entityId: targetEntity?.id, hp: afterHp, damage: resolution.damage },
      });
      spendCombatTurn();
      return { trigger: `Your ${spell.name} strikes ${targetName} for ${resolution.damage} ${resolution.damageType} damage${afterHp <= 0 ? ", and they fall" : ""}. Narrate the hit in a sentence or two.` };
    }
    spendCombatTurn();
    return { trigger: `Your ${spell.name} goes wide of ${targetName}. Narrate the near miss in a sentence.` };
  }

  if (resolution.kind === "save-damage") {
    if ((resolution.damage ?? 0) > 0) {
      ctx.emit({
        kind: "stateChanged",
        summary: `${targetName}: ${resolution.damage} ${resolution.damageType} (${spell.name}, ${resolution.save?.success ? "saved" : "failed"}) → ${hpText}${afterHp <= 0 ? " (down)" : ""}`,
        changes: { entityId: targetEntity?.id, hp: afterHp, damage: resolution.damage },
      });
      spendCombatTurn();
      return { trigger: `Your ${spell.name} ${resolution.save?.success ? "half-catches" : "engulfs"} ${targetName} for ${resolution.damage} ${resolution.damageType} damage${afterHp <= 0 ? ", dropping them" : ""}. Narrate it in a sentence or two.` };
    }
    spendCombatTurn();
    return { trigger: `${targetName} twists clear of your ${spell.name}, taking nothing. Narrate the dodge in a sentence.` };
  }

  if (resolution.kind === "save-debuff") {
    if (resolution.status) {
      ctx.emit({
        kind: "stateChanged",
        summary: `${targetName}: ${resolution.status.kind} (${spell.name})`,
        changes: { entityId: targetEntity?.id, status: resolution.status.kind },
      });
      spendCombatTurn();
      return { trigger: `Your ${spell.name} takes hold of ${targetName} — they are ${resolution.status.kind}. Narrate the working landing in a sentence or two.` };
    }
    spendCombatTurn();
    return { trigger: `${targetName} shrugs off your ${spell.name}. Narrate the resistance in a sentence.` };
  }

  // heal
  const healed = resolution.heal ?? 0;
  if (healed > 0) {
    ctx.emit({
      kind: "stateChanged",
      summary: `${targetName}: +${healed} HP (${spell.name}) → ${hpText}`,
      changes: { entityId: targetEntity?.id, healed },
    });
  }
  spendCombatTurn();
  return {
    trigger:
      healed > 0
        ? `Your ${spell.name} knits ${healed} points of hurt closed on ${targetName || "you"}. Narrate the mending in a sentence or two.`
        : `Your ${spell.name} settles over ${targetName || "you"}, though no wound needed it. Narrate briefly.`,
  };
}

/**
 * Resolve a player LEARN — acquiring a new spell. Three acquisition surfaces, re-derived from the
 * live world (the plan's `sourceId` is only a hint — never trusted to charge or consume): a carried
 * SCROLL teaching it (consumed), a present TRAINER teaching it (coin tuition), or a level-up STUDY
 * credit (a caster picking freely from the world spellbook). The `learnSpell` command is the one
 * writer of the earned-spell list; this function spends the cost and narrates.
 */
export function resolveLearn(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const world = ctx.services.world;
  const model = ctx.model;
  const player = playerEntity(model);
  const spellId = plan.learn?.spellId ?? null;
  const spell = spellId ? world.spells.find((s) => s.id === spellId) : undefined;
  if (!plan.learn || !spell || !player) return { trigger: input };
  if (isCombatActive(model)) {
    return { trigger: `There is no studying a new working in the middle of a fight. ${input}` };
  }

  const base = ctx.services.campaign.characters.find((c) => c.id === player.id)?.stats;
  const baseLevel = base?.level ?? 1;
  const prog = progressionOf(model.modules, player.id, baseLevel);
  const known = new Set(base ? effectiveStatBlock(base, prog).spells : []);
  if (known.has(spell.id)) return { trigger: `You already know ${spell.name}. ${input}` };

  // Enumerate the real sources, then pick by the player's named hint, else scroll → trainer → study.
  const scrollId = (player.stats?.inventory ?? []).find(
    (itemId) => resolveItem(world, itemId)?.properties?.teachesSpell === spell.id,
  );
  let trainer: { id: string; name: string; costCoins: number } | undefined;
  for (const e of entitiesAt(model, player.locationId ?? "")) {
    if (e.id === player.id) continue;
    const t = world.npcs.find((n) => n.id === (e.templateId ?? e.id))?.teaches?.find((x) => x.spellId === spell.id);
    if (t) {
      trainer = { id: e.id, name: e.name, costCoins: t.costCoins };
      break;
    }
  }
  const canStudy = prog.credits > 0 && known.size > 0 && spell.level <= prog.level;

  // An EXPLICIT source the player named wins outright — never silently substitute another surface
  // for it (the study-vs-scroll bug: picking "study" must not consume a scroll or charge tuition).
  // When the named surface is not actually available here, the learn fails cleanly below rather than
  // falling through to a different, costly one. A plan with no named source keeps the historic
  // hint→scroll→trainer→study order.
  const named = plan.learn.source ?? null;
  const hint = plan.learn.sourceId;
  let choice: "scroll" | "trainer" | "study" | null = null;
  if (named === "study") choice = canStudy ? "study" : null;
  else if (named === "scroll") choice = scrollId ? "scroll" : null;
  else if (named === "trainer") choice = trainer ? "trainer" : null;
  else if (hint && scrollId === hint) choice = "scroll";
  else if (hint && trainer?.id === hint) choice = "trainer";
  else if (scrollId) choice = "scroll";
  else if (trainer) choice = "trainer";
  else if (canStudy) choice = "study";
  if (!choice) {
    return {
      trigger: `You cannot learn ${spell.name} here — that would take a teacher, a scroll, or the readiness a new level brings. ${input}`,
    };
  }

  if (choice === "trainer" && trainer) {
    const coins = player.stats?.coins ?? 0;
    if (trainer.costCoins > coins) {
      return {
        trigger: `${trainer.name} will teach ${spell.name} for ${formatCoins(trainer.costCoins)}, but you cannot cover the tuition. ${input}`,
      };
    }
    if (trainer.costCoins > 0) ctx.apply({ type: "adjustCoins", entityId: player.id, by: -trainer.costCoins });
  } else if (choice === "scroll" && scrollId) {
    // The scroll is spent in the reading — one instance leaves the pack (to:null unmakes it).
    ctx.apply({ type: "transferItem", itemId: scrollId, from: player.id, to: null });
  }

  ctx.apply({
    type: "learnSpell",
    entityId: player.id,
    spellId: spell.id,
    baseLevel,
    spendCredit: choice === "study",
  });

  const via =
    choice === "trainer" && trainer
      ? `${trainer.name} teaches you ${spell.name}`
      : choice === "scroll"
        ? `You study the scroll and take ${spell.name} into memory; the parchment crumbles to ash`
        : `You reach the readiness for a new working and learn ${spell.name}`;
  ctx.emit({
    kind: "stateChanged",
    summary: `Learned ${spell.name}.`,
    changes: { entityId: player.id, spellId: spell.id, source: choice },
  });
  return { trigger: `${via}. Narrate the moment it settles into you in a sentence or two. ${input}` };
}
