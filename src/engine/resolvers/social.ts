/**
 * The social domain — an NPC's standing demand, a targeted ask, and the plain contested check
 * behind both.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). The rule this
 * domain holds: a demand HONORS THE ANSWER. Complying is not a roll, refusing is a contest at +2,
 * and the resolved block forbids the narrator from writing compliance the player never gave
 * (playtest r7). Addressing someone who is not here resolves against their absence, never against
 * a stand-in who happens to be standing nearby.
 *
 * @author Runkai Zhang
 */
import type { NpcTemplate } from "../../content/schema.ts";
import { resolvedFromCheck, resolvedHardRefusal } from "../../agents/context.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import { agendaAskOf, pressureAnswerFrom, resistanceDC, stance, type AgendaAsk, type PendingAgendaPressure } from "../../rules/agenda.ts";
import { resolveCheck } from "../../rules/checks.ts";
import { grievanceBump } from "../../rules/grievance.ts";
import { habitOf, readSightingsSlice, renderHabitLine } from "../../rules/sightings.ts";
import { statusMods } from "../../rules/status-effects.ts";
import type { AutonomyRuntime } from "../../state/types.ts";
import { displayName, type Entity } from "../../world/entity.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { ABILITY_NAMES } from "./phrasing.ts";
import { nowOf, type TickContext } from "../tick.ts";
import type { CheckAbility, TurnPlan } from "../turn-plan.ts";
import { actorNameOf } from "./names.ts";
import { pcCheckMods } from "./checks.ts";

/** Resolve an uncertain attempt: roll deterministic dice, emit the roll, return what to narrate. */
export async function resolveCheckIntent(
  check: {
    ability: CheckAbility | null;
    skill: string | null;
    dc: number | null;
    reason?: string;
    /** Closed-enum purpose from the classifier; the combat evasion-calm keys on it. */
    purpose?: "disengage" | "harm" | "other" | null;
  },
  input: string,
  ctx: TickContext,
  targetId?: string | null,
  /** The classifier's closed social-ask read (r8) — see `resolveTargetedNpcAsk`. */
  namedAsk?: AgendaAsk | null,
): Promise<NarrationIntent> {
  const agenda = await resolveTargetedNpcAsk(check, input, ctx, targetId, namedAsk);
  if (agenda) return agenda;

  const state = ctx.state();
  const player = state.party[0] ?? "pc.you";
  const ability = check.ability ?? "wis";
  const dc = check.dc ?? 13;
  const skill = check.skill ?? undefined;
  const pc = ctx.services.campaign.characters.find((c) => c.id === player);
  const abilityScore = pc ? pc.stats.abilities[ability] : 10;
  const bonus = skill && pc?.stats.proficiencies.includes(skill) ? 2 : 0;
  const label = `${ABILITY_NAMES[ability]}${skill ? ` (${skill})` : ""} check`;
  const mods = pcCheckMods(ctx.model);
  const effectiveDc = dc + mods.dcAdjustment;

  // Click-to-roll: let the client gate the roll if it wants to.
  if (ctx.services.client?.promptRoll) {
    await ctx.services.client.promptRoll({
      actorId: player,
      ability,
      skill,
      dc: effectiveDc,
      label: `${label}, DC ${effectiveDc}`,
    });
  }

  const smods = statusMods(ctx.model, player);
  const result = resolveCheck(
    { abilityScore, dc: effectiveDc, bonus: bonus + smods.check, disadvantage: mods.disadvantage || smods.disadvantage },
    ctx.services.rng,
  );
  ctx.emit({
    kind: "diceRolled",
    actorId: player,
    notation: "1d20",
    rolls: result.rolls,
    total: result.total,
    purpose: `${label} (DC ${effectiveDc})`,
    success: result.success,
  });
  // Scratch for downstream modules (combat's evasion-calm, r7 P0): what the roll was FOR and how
  // it went. A passed distract/hide/slip check against the only hostile must be able to END the
  // fight — the run-7 death chain began with a fight the fiction had already resolved.
  //
  // `purpose` is the CLASSIFIER's closed-enum answer, and it is what the calm keys on. The `text`
  // beside it is kept for prose/telemetry only: keyword-matching THAT is how an ordinary attack
  // ("I throw the table over onto the wight") used to end the encounter and durably calm every
  // foe, because `check.reason` is model free text and the player's line is unbounded.
  ctx.data.checkOutcome = {
    success: result.success,
    purpose: check.purpose ?? null,
    text: `${check.reason ?? ""} ${input}`.trim(),
  };
  // The deterministic floor carries the OUTCOME, never the player's own sentence (r4 P2: a
  // successful case-cracking deduction degraded to an echo of the input and read as "the roll
  // found nothing"). The verdict suffix (label/total/DC) is auto-appended by triggerEcho.
  return {
    trigger: `You attempt: ${input}`,
    resolved: resolvedFromCheck(label, result),
    echoFallback: result.success
      ? "It works — the attempt holds, though the full telling is lost to the moment."
      : "It fails — the attempt slips away from you.",
  };
}


export async function resolveTargetedNpcAsk(
  check: { ability: CheckAbility | null; skill: string | null; dc: number | null },
  input: string,
  ctx: TickContext,
  targetId?: string | null,
  /**
   * The classifier's closed `TurnPlan.socialAsk` (r8). It names WHICH of the ten authored ask
   * kinds was made; `resistanceDC` + `offLimitsFor` remain the sole authority over the DC and
   * over whether the ask is hard-refusable. Null/absent ⇒ the legacy prose cascade, whose
   * `/\b(steal|rob|take)\b/` arm turned "Can you take me to the market?" into an off-limits
   * `steal` and drew an unrollable refusal from the friendliest NPC in town (reproduced).
   */
  namedAsk?: AgendaAsk | null,
): Promise<NarrationIntent | null> {
  if (!targetId) return null;
  const target = ctx.model.entities.get(targetId);
  if (!target || target.kind !== "npc") return null;
  // WHETHER this turn is a social contest at all. Three signals, in order of trust: the roll is a
  // CHA roll; the classifier's closed `socialAsk` says the line asked this person for something;
  // or the line names a social verb outright (the floor, for a scripted/legacy plan).
  //
  // `lie` is NOT in that verb list, r8 regex audit. It is a noun and an intransitive verb at least
  // as often as it is an act of deception ("that's a lie", "the papers lie on the counter", "let
  // it lie"), and it carried a whole turn: reproduced against the shipped engine, the insight read
  //
  //   "I watch Brann's face while he answers — is that a lie?"   (wis/insight, DC 12)
  //
  // came back as `Wisdom (insight) vs Brann (DC 15)` — the scene's DC replaced by the NPC's
  // RESISTANCE, `ctx.data.socialAsk` stamped for the consequence binder, and the turn narrated as
  // "You press Brann", i.e. reading someone became pressuring them. The control line ("is he
  // telling the truth?") rolled the plain DC-12 check it should have.
  //
  // Deception is not lost with it: a lie the player actually tells is a CHA roll (the first
  // signal), and a classifier that names `socialAsk` carries it too (the second) — both verified.
  const social =
    check.ability === "cha" ||
    (namedAsk !== null && namedAsk !== undefined) ||
    /\b(persuade|convince|intimidate|threaten|bribe|coerce|blackmail|deceive|charm|haggle)\b/i.test(input);
  if (!social) return null;

  const npc = ctx.services.world.npcs.find((n) => n.id === targetId);
  if (!npc) return null;
  const player = playerEntity(ctx.model)?.id ?? ctx.state().party[0] ?? "pc.you";
  const fallback = check.skill?.toLowerCase().includes("intimid") ? "intimidate" : "persuade";
  const ask = agendaAskOf(namedAsk, input, fallback);
  const npcStance = stance(npc, player, ctx.model, ctx.services.world, ctx.services.campaign);
  const dc = resistanceDC(npc, ask, npcStance);
  const npcName = target.name || npc.name || targetId;
  const label = `${npcName} ${ask.kind} ${ask.approach} resistance`;

  if (dc === "refused") {
    return {
      trigger: `${npcName} refuses outright: ${input}`,
      resolved: resolvedHardRefusal(label),
      echoFallback: `${npcName} refuses outright — no roll would move them.`,
    };
  }

  const ability = check.ability ?? "cha";
  const skill = check.skill ?? undefined;
  const pc = ctx.services.campaign.characters.find((c) => c.id === player);
  const abilityScore = pc ? pc.stats.abilities[ability] : 10;
  const bonus = skill && pc?.stats.proficiencies.includes(skill) ? 2 : 0;
  const rollLabel = `${ABILITY_NAMES[ability]}${skill ? ` (${skill})` : ""} vs ${npcName}`;
  const mods = pcCheckMods(ctx.model);
  const effectiveDc = dc + mods.dcAdjustment;

  if (ctx.services.client?.promptRoll) {
    await ctx.services.client.promptRoll({
      actorId: player,
      ability,
      skill,
      dc: effectiveDc,
      label: `${rollLabel}, DC ${effectiveDc}`,
    });
  }

  const smods = statusMods(ctx.model, player);
  const result = resolveCheck(
    { abilityScore, dc: effectiveDc, bonus: bonus + smods.check, disadvantage: mods.disadvantage || smods.disadvantage },
    ctx.services.rng,
  );
  ctx.emit({
    kind: "diceRolled",
    actorId: player,
    notation: "1d20",
    rolls: result.rolls,
    total: result.total,
    purpose: `${rollLabel} (DC ${effectiveDc})`,
    success: result.success,
  });
  // Stash the resolved ask for the consequence binder (Phase 3): a WON persuade/intimidate/bribe
  // GRANTS the asked-for thing (a real interaction unlock + warmed regard) instead of a bare
  // "success"; a LOST one cools them. Read only by `bindConsequences` on a social-domain turn.
  ctx.data.socialAsk = { targetId, askKind: ask.kind, success: result.success };
  return {
    trigger: `You press ${npcName}: ${input}`,
    resolved: resolvedFromCheck(rollLabel, result),
    echoFallback: result.success ? `${npcName} yields the point.` : `${npcName} gives no ground.`,
  };
}


export async function resolveAgendaPressure(
  pressure: PendingAgendaPressure,
  input: string,
  ctx: TickContext,
  /** This turn's classified plan, for its closed `pressureAnswer`. Undefined ⇒ the prose floor. */
  answerPlan?: TurnPlan,
): Promise<NarrationIntent> {
  const player = playerEntity(ctx.model)?.id ?? ctx.state().party[0] ?? "pc.you";
  const ability = pressure.resist.ability as CheckAbility;
  const pc = ctx.services.campaign.characters.find((c) => c.id === player);
  const abilityScore = pc ? pc.stats.abilities[ability] : 10;
  const label = `${ABILITY_NAMES[ability]} resist: ${pressure.resist.label}`;
  const mods = pcCheckMods(ctx.model);
  const effectiveDc = pressure.resist.dc + mods.dcAdjustment;

  // The player's answer is a move, not decoration. An explicit compliance hands the thing over
  // without a roll; an explicit refusal is a real resist attempt (+2 for standing firm) and the
  // fiction is TOLD the player refused, so a lost roll reads as being worn down — never as
  // willing compliance the player did not choose.
  //
  // The read is the classifier's closed comply/refuse/neutral (r8), because the word-lists behind
  // `pressureAnswerOf` cannot survive a concessive sentence: "Fine. But you will have to pry it
  // from me." hit the `fine` arm and scored COMPLY, so the item transferred with no roll and the
  // RESOLVED block below instructed the narrator to describe a willing handover of the thing the
  // player had just refused to give up (reproduced against the shipped regex). Absent a model
  // answer, `pressureAnswerFrom` runs the prose floor with `comply` CLAMPED OUT — the floor may
  // still say `refuse` (+2, the safe direction) and everything else lands on `neutral`, the bare
  // contested roll — so an outage can never reach the free-handover branch below.
  const answer = pressureAnswerFrom(answerPlan?.pressureAnswer, input);

  if (answer === "comply") {
    const applied = ctx.apply(pressure.consequence);
    if (applied.rejected) {
      ctx.emit({
        kind: "system",
        level: "warn",
        message: `Agenda consequence could not apply (${applied.rejected.reason}).`,
      });
    }
    return {
      trigger: `${actorNameOf(ctx.services.world, ctx.services.campaign, pressure.npcId)} ${pressure.summary}; you give in: "${input}"`,
      resolved: {
        label,
        total: 0,
        success: true,
        critical: null,
        note: "The player COMPLIES willingly — no roll; narrate a reluctant or easy handover, never a resisted one.",
      },
      echoFallback: `You give ${actorNameOf(ctx.services.world, ctx.services.campaign, pressure.npcId)} what they want.`,
    };
  }

  const refused = answer === "refuse";
  const resistBonus = refused ? 2 : 0;
  const stakes = `${pressure.resist.label} — resist (${ABILITY_NAMES[ability]} DC ${effectiveDc}) or lose it. Comply, refuse, or answer in your own words.`;
  if (ctx.services.client?.promptRoll) {
    await ctx.services.client.promptRoll({
      actorId: player,
      ability,
      skill: undefined,
      dc: effectiveDc,
      label: refused
        ? `${label}, DC ${effectiveDc} (you refuse: +2)`
        : stakes,
    });
  }

  const smods = statusMods(ctx.model, player);
  const result = resolveCheck(
    {
      abilityScore,
      dc: effectiveDc,
      bonus: smods.check + resistBonus,
      disadvantage: mods.disadvantage || smods.disadvantage,
    },
    ctx.services.rng,
  );
  ctx.emit({
    kind: "diceRolled",
    actorId: player,
    notation: "1d20",
    rolls: result.rolls,
    total: result.total,
    purpose: `${label} (DC ${effectiveDc})${refused ? " — you refused" : ""}`,
    success: result.success,
  });

  if (!result.success) {
    const applied = ctx.apply(pressure.consequence);
    if (applied.rejected) {
      ctx.emit({
        kind: "system",
        level: "warn",
        message: `Agenda consequence could not apply (${applied.rejected.reason}).`,
      });
    }
  } else {
    // Feature 3: standing up to the press (a resisted demand) needles a leader — it nurses the grudge,
    // hardening its next disciplinary response. Harmless for a non-leader presser (never read).
    bumpGrievance(ctx, ctx.model, pressure.npcId);
  }

  // Clean fiction only: the press is woven as prose (`${name} presses a debt; you answer…`),
  // never a mechanical parenthetical — the resolved block below already carries the label for
  // the model, and the offline gateway echoes this trigger verbatim to the player. A refusal
  // that LOST the roll is narrated as coercion overcoming resistance, never as compliance.
  const answerText = refused ? `you refuse: "${input}"` : `you answer: "${input}"`;
  const resolved = resolvedFromCheck(label, result);
  if (refused) {
    resolved.note = result.success
      ? "The player REFUSED — the refusal holds; they back down, for now."
      : "The player REFUSED. They take it anyway — over the player's protest, by pressure or force. Do NOT narrate the player agreeing or handing it over willingly.";
  }
  return {
    trigger: `${actorNameOf(ctx.services.world, ctx.services.campaign, pressure.npcId)} ${pressure.summary}; ${answerText}`,
    resolved,
    echoFallback: result.success
      ? `You hold your ground against ${actorNameOf(ctx.services.world, ctx.services.campaign, pressure.npcId)}.`
      : refused
        ? `${actorNameOf(ctx.services.world, ctx.services.campaign, pressure.npcId)} takes it despite your refusal.`
        : `${actorNameOf(ctx.services.world, ctx.services.campaign, pressure.npcId)}'s press finds its mark.`,
  };
}

/**
 * Honest prose for addressing someone who is not in the scene, or `null` when the line names
 * nobody the world knows (talking to the room stays legitimate).
 *
 * The r4 playtest paid an NPC to produce a person, was told in prose "she's here", sat down,
 * addressed her — and got the content-free stub. The cause is structural, not a bug in the
 * stub: `reconcilePlan` clamps `targetId` to PRESENT_ENTITIES (classify.ts), so a person the
 * player has only been TOLD about can never ground, and the turn lands on the generic branch.
 * So the grounding happens here instead, against the raw line and the AUTHORED roster.
 *
 * The hint is what the PLAYER has personally witnessed (`habitOf` over the sightings slice) —
 * never the NPC's true schedule. No omniscience: a save shows only what it has seen.
 */
export function absentAddressee(
  ctx: TickContext,
  input: string,
  model: WorldModel,
  target: Entity | undefined,
  /** The engine's absent-NPC name lookup. Passed in: it rides a set of nameable-NPC guards that
   *  belongs to the classifier grounding surface, not to this domain. */
  findAbsentNamed: (input: string, presentNames: ReadonlySet<string>) => NpcTemplate | undefined,
): string | null {
  const world = ctx.services.world;
  const loc = partyLocationOf(model);
  // A present name must never trip this — "the guard" while a guard stands here is a real
  // address, and a downed/elsewhere grounded target is named from the entity we already have.
  const presentNames = new Set<string>(
    (loc === null ? [] : entitiesAt(model, loc)).map((e) => displayName(e).trim().toLowerCase()),
  );
  const named = target ?? findAbsentNamed(input, presentNames);
  if (!named) return null;
  const id = "id" in named ? named.id : "";
  const name = "kind" in named ? displayName(named) : named.name;
  if (presentNames.has(name.trim().toLowerCase()) && !target) return null;

  const locName = (locId: string): string => world.locations.find((l) => l.id === locId)?.name ?? locId;
  // Honest about DOWN vs DEAD (r7 P3): the old "there is no one left in there to hear you"
  // repeated verbatim and read as a death notice — the player spent several turns believing a
  // living companion was gone, while the party panel said HERE. Say what a bystander would see.
  const downed = !!target?.stats && target.stats.currentHp <= 0;
  if (downed) return `${name} does not answer — unconscious, past hearing you, but breathing still.`;

  // A grounded target STANDING RIGHT HERE is not an absent addressee, whatever its kind. The
  // present-name guard above is skipped when a target is passed, so a present MONSTER — not
  // addressable by the NPC reply machinery — fell through to "There is no sign of Ash Hound
  // here." while that same hound was actively mauling the player (r14, fixture-combat t16). Absence
  // prose is for the absent; a present target hands the moment back to the caller.
  if (target && target.locationId === loc) return null;

  const habit = habitOf(readSightingsSlice(model.modules).byNpc[id] ?? []);
  const hint = habit ? ` You have seen them ${renderHabitLine(habit, locName)}.` : "";
  return `There is no sign of ${name} here.${hint}`;
}

/**
 * Feature 3 — record that the PC crossed a leader (declined/overrode its plan, or resisted its
 * demand), bumping that NPC's grievance (decayed-then-+1, capped) so its disciplinary response
 * hardens. Silent bookkeeping write, mirroring `resetReplyDepth`. Harmless for a non-leader — only
 * the leader path (chooseLeaderDiscipline) ever reads grievance.
 */
export function bumpGrievance(
ctx: TickContext,model: WorldModel, npcId: string): void {
  const autonomy = (model.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};
  ctx.applySilent({
    type: "modulePatch",
    module: "autonomy",
    patch: { [npcId]: grievanceBump(autonomy[npcId], nowOf(ctx)) },
  });
}
