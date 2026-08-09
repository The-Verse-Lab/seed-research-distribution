/**
 * The party domain — inviting, joining, leaving, appointing a leader, hiring a mercenary, and the
 * contest when a leader will not let you go.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). Party membership
 * is deliberately not a safe harbour: a member can be recruited by stance, refuse to release you,
 * and betray you from inside. What this domain guarantees is only that every one of those is a
 * real, contested, reducer-backed transition rather than something the prose asserted.
 *
 * @author Runkai Zhang
 */
import { resolvedFromCheck, resolvedHardRefusal } from "../../agents/context.ts";
import type { NpcTemplate } from "../../content/schema.ts";
import type { DialogueIntent } from "../../modules/dialogue.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import { composeNpcTemplate, promoteAndEnrich } from "../../modules/party/enrich.ts";
import { agendaAskOf, chooseAgendaAction, pressureDc, resistanceDC, stance } from "../../rules/agenda.ts";
import { resolveCheck } from "../../rules/checks.ts";
import { ESCAPE_GRUDGE, decideInvite, escapeAbilityFrom, partyLeaderOf, pendingLeaveOf, type InviteMotive } from "../../rules/party.ts";
import { PARTY_WAGES_MODULE, RECRUIT_BOARD_MODULE, readPartyWagesSlice, readRecruitBoardSlice, recruitDayOf, recruitOfferId, seededMercName } from "../../rules/recruit.ts";
import { statusMods } from "../../rules/status-effects.ts";
import type { Command } from "../../world/commands.ts";
import type { Entity } from "../../world/entity.ts";
import { partyLocationOf, playerEntity } from "../../world/model.ts";
import type { TickContext } from "../tick.ts";
import type { TurnPlan } from "../turn-plan.ts";
import { actorNameOf } from "./names.ts";
import { pcCheckMods } from "./checks.ts";

/**
 * Resolve a grounded party action — invite / leave / appointLeader — with every DECISION from
 * code (agenda stance + seeded rolls); the model only phrases outcomes. Engine-side resolution
 * in the resolve phase, mirroring how Phase 1 resolved itemAction/trade.
 */
export async function resolvePartyAction(
  ctx: TickContext,
  plan: TurnPlan,
  input: string,
): Promise<NarrationIntent | undefined> {
  const player = playerEntity(ctx.model);
  const party = plan.party;
  if (!party || !player) return { trigger: input };
  if ((player.stats?.currentHp ?? 1) <= 0) {
    return {
      trigger: `You are down — the world swims dark and your hands will not answer. (Rest or victory can bring you back.)`,
    };
  }
  switch (party.verb) {
    case "invite":
      return await resolvePartyInvite(ctx, party.targetId, input, player);
    case "leave":
      return await resolvePartyLeave(ctx, party.targetId, input, player);
    case "appointLeader":
      return await resolvePartyAppoint(ctx, party.targetId, input, player);
    case "join":
      return await resolveJoinParty(ctx, party.targetId, input, player);
  }
}

/**
 * Invite a present NPC into the party. The ANSWER is computed in code from the NPC's agenda
 * stance toward the asker (`decideInvite`, src/rules/party.ts): devoted/helpful/neutral join,
 * wary/transactional join guardedly, exploitative/hostile refuse OR join to exploit on one seeded
 * roll — never hard-blocked (an exploitative member inside the camp is valid fiction). On
 * yes: the membership flag (reducer), Stage-B promotion (`promoteAndEnrich` — idempotent, an
 * authored significant fixture is untouched), and a live companion agent + heartbeat so the new
 * member speaks and acts. Joining applies no relationship or disposition change; agenda sees the
 * member exactly like any other NPC. Online, the acceptance line comes
 * from the normal dialogue path; the steer pins the coded outcome without softening anyone.
 */
export async function resolvePartyInvite(
  ctx: TickContext,
  targetId: string | null,
  input: string,
  player: Entity,
): Promise<NarrationIntent | undefined> {
  const model = ctx.model;
  const world = ctx.services.world;
  const target = targetId ? model.entities.get(targetId) : undefined;
  if (!target || target.locationId !== player.locationId) {
    return { trigger: `You look around for your would-be companion, but they are not here. ${input}` };
  }
  if (target.kind !== "npc") {
    return { trigger: `${target.name} is not one to walk beside you. ${input}` };
  }
  if (target.partyMember) {
    return { trigger: `${target.name} already travels with you.` };
  }
  ctx.emit({ kind: "dialogue", actorId: player.id, text: input, toId: target.id });

  // The stance template: the authored/enriched one, else the same deterministic floor the
  // promotion will record — so the decision and the enrichment describe the SAME character.
  const template = stanceTemplateFor(ctx, target);
  const npcStance = stance(template, player.id, model, world, ctx.services.campaign);
  const decision = decideInvite(npcStance, ctx.services.rng());

  if (!decision.accept) {
    return {
      trigger:
        `${target.name} refuses to join you — you are more use to them at arm's length. ` +
        `Narrate the refusal in ${target.name}'s own voice, true to their nature.`,
    };
  }

  // A statless authored fixture needs a body before it can hold membership: despawn + respawn
  // WITH stats through the reducer (the established promotion move). NOTE: entity flags do not
  // survive the respawn (SpawnSpec carries none) — statless scenery rarely holds any.
  if (!target.stats) {
    const maxHp = template.stats?.maxHp ?? 10;
    ctx.apply({ type: "despawnEntity", entityId: target.id });
    ctx.apply({
      type: "spawnEntity",
      entity: {
        id: target.id,
        kind: "npc",
        tier: target.tier,
        name: target.name,
        locationId: target.locationId,
        templateId: target.templateId,
        stats: { currentHp: maxHp, maxHp, inventory: [...template.inventory] },
      },
    });
  }
  const joined = ctx.apply({ type: "setPartyMembership", entityId: target.id, member: true });
  if (joined.rejected) {
    return { trigger: `${target.name} agrees — but something keeps them from falling in beside you. ${input}` };
  }
  // Stage-B promotion: transient/tracked members become permanent, enriched fixtures.
  await promoteAndEnrich(ctx, target.id);
  ctx.services.companions?.attach(target.id);
  ctx.emit({
    kind: "stateChanged",
    summary: `${target.name} joins the party.`,
    changes: { entityId: target.id, partyMember: true },
  });

  ctx.data.dialogue = {
    npcId: target.id,
    playerLine: input,
    steer: inviteSteer(ctx, decision.motive, player.id),
  } satisfies DialogueIntent;
  return undefined; // the companion's reply is the beat; no separate GM narration
}

/**
 * JOIN an NPC-led party — the mirror of invite (the hall-as-hub wave, Phase B). The player
 * subordinates themselves to a present LEADER: the NPC becomes a party member AND the appointed
 * `partyLeaderOf`, so the autonomy Director drives the band by leader proposals and — the whole
 * point — leaving is now gated by the contested hold (`resolvePartyLeave` → `contestLeaderHold`).
 * The leader must be leader-capable (authored `autonomy.level==="leader" && canLead`, e.g. Oda) or
 * already leading a party. Consent is the SAME stance machinery as invite (will they sign you on),
 * never hard-blocked. Reuses the invite tail (spawn-with-stats, promote, companion agent).
 */
export async function resolveJoinParty(
  ctx: TickContext,
  targetId: string | null,
  input: string,
  player: Entity,
): Promise<NarrationIntent | undefined> {
  const model = ctx.model;
  const world = ctx.services.world;
  const target = targetId ? model.entities.get(targetId) : undefined;
  if (!target || target.locationId !== player.locationId) {
    return { trigger: `You look for the one you'd throw in with, but they are not here. ${input}` };
  }
  if (target.kind !== "npc") {
    return { trigger: `${target.name} leads no company you could sign onto. ${input}` };
  }
  const template = stanceTemplateFor(ctx, target);
  const leaderCapable =
    (template.autonomy.level === "leader" && template.autonomy.canLead === true) ||
    partyLeaderOf(model.modules) === target.id;
  if (!leaderCapable) {
    return {
      trigger: `${target.name} is no captain with a crew to join — if you want their company, ask them to travel with YOU instead. ${input}`,
    };
  }
  if (target.partyMember && partyLeaderOf(model.modules) === target.id) {
    return { trigger: `You already follow ${target.name}.` };
  }
  ctx.emit({ kind: "dialogue", actorId: player.id, text: input, toId: target.id });

  // Consent: will the leader take the PC on? Same code path as invite, read the other direction.
  const npcStance = stance(template, player.id, model, world, ctx.services.campaign);
  const decision = decideInvite(npcStance, ctx.services.rng());
  if (!decision.accept) {
    return {
      trigger:
        `${target.name} looks you over and turns you down — you are not what their company needs. ` +
        `Narrate the refusal in ${target.name}'s own voice, true to their nature.`,
    };
  }

  // A statless authored leader needs a body before it can hold membership + lead (the invite move).
  if (!target.stats) {
    const maxHp = template.stats?.maxHp ?? 10;
    ctx.apply({ type: "despawnEntity", entityId: target.id });
    ctx.apply({
      type: "spawnEntity",
      entity: {
        id: target.id,
        kind: "npc",
        tier: target.tier,
        name: target.name,
        locationId: target.locationId,
        templateId: target.templateId,
        stats: { currentHp: maxHp, maxHp, inventory: [...template.inventory] },
      },
    });
  }
  const joined = ctx.apply({ type: "setPartyMembership", entityId: target.id, member: true });
  if (joined.rejected) {
    return { trigger: `${target.name} takes you on — but something keeps them from falling in with you. ${input}` };
  }
  // The reversal that makes this JOIN and not invite: the NPC leads, the PC follows (and the leave
  // gate engages).
  ctx.apply({ type: "setPartyLeader", entityId: target.id });
  await promoteAndEnrich(ctx, target.id);
  ctx.services.companions?.attach(target.id);
  ctx.emit({
    kind: "stateChanged",
    summary: `You sign on with ${target.name}'s party.`,
    changes: { entityId: target.id, partyMember: true, leaderId: target.id },
  });

  ctx.data.dialogue = {
    npcId: target.id,
    playerLine: input,
    steer:
      `${actorNameOf(ctx.services.world, ctx.services.campaign, player.id)} has just SIGNED ON to follow you — you lead now, and they take your orders. ` +
      `Accept them into your company in your own voice, and make the terms of following you plain.`,
  } satisfies DialogueIntent;
  return undefined; // the leader's reply is the beat
}

/** The reply steer for an accepted invite — pins the coded outcome, softens nothing. */
export function inviteSteer(
ctx: TickContext,motive: InviteMotive, playerId: string): string {
  const playerName = actorNameOf(ctx.services.world, ctx.services.campaign, playerId);
  switch (motive) {
    case "guarded":
      return `You have just agreed to join ${playerName}'s party — but on your own terms, for your own reasons. Hint at your price or your guard.`;
    case "opportunist":
      return `You have just agreed to join ${playerName}'s party because it serves your own appetite. Accept in whatever register fits you — and let nothing of what you are soften.`;
    default:
      return `You have just agreed to join ${playerName}'s party. Say so in your own voice.`;
  }
}

/**
 * HIRE A MERCENARY from the hall's recruit board (the hall-as-hub wave, Phase B). The offer is a
 * pure function of (hall, day, slot) — its identity is composed from the offer id via the same
 * seeded floor the board render used, so the sellsword who signs on IS the one shown. Coin is the
 * consent (no stance roll): pay the hall's `hireCp`, spawn the merc with stats, and run the invite
 * tail (membership → promote/enrich → live agent). The board never persists; the reducer records
 * only the hired offer id (so the seat empties) and the per-member wage (for the Phase-C upkeep).
 */
export async function resolveHireMercenary(ctx: TickContext, plan: TurnPlan, input: string): Promise<NarrationIntent> {
  const model = ctx.model;
  const world = ctx.services.world;
  const player = playerEntity(model);
  const from = partyLocationOf(model);
  if (!player?.stats || from === null) {
    return { trigger: "There is no one to hire here." };
  }
  const recruits = world.locations.find((l) => l.id === from)?.guild?.recruits;
  if (!recruits) {
    return { trigger: "There is no board of swords-for-hire here. Narrate the absence." };
  }
  const offerId = plan.recruit?.offerId;
  if (!offerId) {
    return { trigger: input };
  }
  const board = readRecruitBoardSlice(model.modules);
  if (board.hired.includes(offerId) || model.entities.has(offerId)) {
    return { trigger: "That sellsword has already been taken on — the seat is empty. Narrate the gap on the board." };
  }
  // Validate the offer belongs to THIS hall's board for the CURRENT day (never a stale/forged id).
  const day = recruitDayOf(model.clock);
  const onBoard = Array.from({ length: recruits.slots }, (_, i) => recruitOfferId(from, day, i)).includes(offerId);
  if (!onBoard) {
    return { trigger: "There is no such posting on the board. Narrate the confusion." };
  }
  const coins = player.stats.coins ?? 0;
  if (coins < recruits.hireCp) {
    return {
      trigger: `The going rate is ${recruits.hireCp} cp to sign a sword on — more coin than you carry. You cannot make the hire. Narrate turning away, short of coin.`,
      deterministic: true,
    };
  }
  // Compose the seeded identity from the offer id (the same person the board showed) — the id-keyed
  // name must match what the board rendered, including the PC-name avoidance (r4 P4), so both
  // sides pass the same avoid name.
  const pseudo: Entity = { id: offerId, kind: "npc", tier: "transient", name: seededMercName(offerId, player.name), locationId: from, partyMember: false, flags: {} };
  const template = composeNpcTemplate(world, pseudo);
  const maxHp = template.stats?.maxHp ?? 12;
  ctx.apply({ type: "adjustCoins", entityId: player.id, by: -recruits.hireCp });
  // Spawn TRANSIENT (not significant): promoteAndEnrich below composes + records + mirrors + promotes
  // to significant. Spawning significant would make promoteAndEnrich treat it as an authored fixture
  // and skip recording — the hired merc would then lose its template on reload (the Entity.flags/
  // statted-NPC gotcha). The durable record is what survives the round-trip.
  const spawn = ctx.apply({
    type: "spawnEntity",
    entity: {
      id: offerId,
      kind: "npc",
      tier: "transient",
      name: template.name,
      locationId: from,
      stats: { currentHp: maxHp, maxHp, inventory: [...template.inventory] },
    },
  });
  if (spawn.rejected) {
    ctx.apply({ type: "adjustCoins", entityId: player.id, by: recruits.hireCp }); // refund a failed hire
    return { trigger: `The hire falls through — the sellsword is gone before coin changes hands. ${input}` };
  }
  ctx.apply({ type: "setPartyMembership", entityId: offerId, member: true });
  await promoteAndEnrich(ctx, offerId);
  ctx.services.companions?.attach(offerId);
  // Record the taken seat + the wage (spent by the Phase-C upkeep tick).
  ctx.apply({ type: "modulePatch", module: RECRUIT_BOARD_MODULE, patch: { hired: [...board.hired, offerId] } });
  const wages = readPartyWagesSlice(model.modules);
  wages[offerId] = recruits.wageCp;
  ctx.apply({ type: "modulePatch", module: PARTY_WAGES_MODULE, patch: wages });
  ctx.emit({
    kind: "stateChanged",
    summary: `${template.name} signs on for ${recruits.hireCp} cp.`,
    changes: { entityId: offerId, partyMember: true },
  });
  return {
    trigger:
      `You count out ${recruits.hireCp} cp and ${template.name} takes it, shouldering their kit to fall in with you. ` +
      `Narrate the sellsword signing on — hired muscle on a day's wage, no illusions of friendship.`,
  };
}

/**
 * The leave gate. With no explicit leader (or the player leading), leaving is free: every NPC
 * member is released through the reducer — the engine is player-centric, so "the player leaves
 * the party" and "the party detaches from the player" are the same mechanical fact, and the
 * PC's own membership flag (which anchors playerEntity/moveParty) never ends up dropped.
 * A named target ("I part ways with Dorran") releases that SINGLE member, never the whole band.
 * Under an NPC leader EVERY departure — full leave, dismissing a member, or dismissing the
 * leader themself — runs through the contested hold (`contestLeaderHold`); anything less would
 * let the gate be picked apart one member at a time. This machinery is what makes an abusive
 * leader PLAYABLE — it is not a moral filter, and nothing here softens them.
 */
export async function resolvePartyLeave(
  ctx: TickContext,
  targetId: string | null,
  input: string,
  player: Entity,
): Promise<NarrationIntent> {
  const model = ctx.model;
  const members = [...model.entities.values()].filter((e) => e.kind === "npc" && e.partyMember);
  if (members.length === 0) {
    return { trigger: `You are your own company already — there is no party to leave. ${input}` };
  }
  // A named target is a single dismissal; null (or the player naming themself) is a full leave.
  let leaving = members;
  if (targetId && targetId !== player.id) {
    const target = model.entities.get(targetId);
    if (!target || target.kind !== "npc" || !target.partyMember) {
      return { trigger: `${target?.name ?? "They"} does not travel with you. ${input}` };
    }
    leaving = [target];
  }
  const leaderId = partyLeaderOf(model.modules);
  const leader = leaderId && leaderId !== player.id ? model.entities.get(leaderId) : undefined;
  if (!leader) {
    const departed = releaseParty(ctx, player.id, leaving);
    return { trigger: `You part ways with ${departed}. Narrate the parting.` };
  }

  ctx.emit({ kind: "dialogue", actorId: player.id, text: input, toId: leader.id });
  const hold = await contestLeaderHold(ctx, input, player, leader, "release");
  switch (hold.outcome) {
    case "unopposed": {
      const departed = releaseParty(ctx, player.id, leaving);
      return {
        trigger: `${leader.name} is down and in no state to hold anyone — you part ways with ${departed}. Narrate the parting over their body.`,
      };
    }
    case "granted": {
      const departed = releaseParty(ctx, player.id, leaving);
      return {
        trigger: `${leader.name} lets you go, and you part ways with ${departed}. Narrate the release in ${leader.name}'s voice.`,
        resolved: hold.resolved,
      };
    }
    case "refused":
      return {
        trigger: `${leader.name} refuses outright — you are not leaving. Narrate the refusal in ${leader.name}'s own voice.`,
        resolved: hold.resolved,
      };
    case "denied":
      return {
        trigger: `${leader.name} refuses to let you leave the party — and means it. Narrate the refusal in ${leader.name}'s own voice, true to their nature.`,
        resolved: hold.resolved,
      };
    case "brokeFree": {
      const departed = releaseParty(ctx, player.id, leaving);
      return {
        trigger: `You tear free of ${leader.name}'s hold and part ways with ${departed}. ${leader.name} will not forget it. Narrate the break.`,
        resolved: hold.resolved,
      };
    }
    case "held":
      return {
        trigger: `${leader.name} catches you before you slip away — you remain in the party, and there is a price.${hold.price} Narrate ${leader.name} reasserting their hold.`,
        resolved: hold.resolved,
      };
  }
}

/**
 * The contested hold an NPC leader has over the player — shared by the leave gate AND any
 * attempt to change who leads while they hold it (usurping the leader is an escape from the
 * SAME hold; without that, one free "make me the leader" would depose them and turn the whole
 * leave gate into dead code). All decisions are code + seeded dice; the model only phrases:
 *   downed leader   → "unopposed": a body at 0 HP contests nothing.
 *   first ask       → agenda ask (approach from phrasing) vs the leader's `resistanceDC` —
 *                     "granted" on success; "refused"/"denied" record `recordLeaveDenied`.
 *   after a denial  → CONTESTED ESCAPE: player ability (from phrasing) vs the leader-derived
 *                     `pressureDc` — "brokeFree" costs the leader's regard (ESCAPE_GRUDGE);
 *                     "held" applies the leader's agenda-chosen consequence, exactly like a
 *                     lost PendingAgendaPressure resist.
 */
export async function contestLeaderHold(
  ctx: TickContext,
  input: string,
  player: Entity,
  leader: Entity,
  contestNoun: "release" | "step-down",
): Promise<{
  outcome: "unopposed" | "granted" | "refused" | "denied" | "brokeFree" | "held";
  resolved?: NarrationIntent["resolved"];
  price: string;
}> {
  const model = ctx.model;
  const world = ctx.services.world;
  // A downed leader (0 HP, unconscious) cannot clamp down on anyone — the hold breaks with them.
  if (leader.stats !== undefined && leader.stats.currentHp <= 0) {
    return { outcome: "unopposed", price: "" };
  }
  const template = stanceTemplateFor(ctx, leader);
  const leaderStance = stance(template, player.id, model, world, ctx.services.campaign);
  const pc = ctx.services.campaign.characters.find((c) => c.id === player.id);
  const denied = pendingLeaveOf(model.modules)[player.id] !== undefined;

  // The classifier's closed reads for this turn (r8): WHICH ask the release was pressed as, and
  // WHICH ability the break-out rolls. Both live on the plan the party-action branch already
  // classified — no extra call. Each falls back to its prose floor when absent.
  const plan = ctx.data.plan as TurnPlan | undefined;

  if (!denied) {
    // First ask: a social contest against the leader's stance. The KIND is pinned to "favor" (a
    // release is always a favor asked of the leader) — only the APPROACH is read from the line,
    // and `agendaAskOf` prefers the classifier's closed answer over `inferAgendaAsk`'s cascade.
    const ask = {
      approach: agendaAskOf(plan?.socialAsk, input, "persuade").approach,
      kind: "favor" as const,
    };
    const dc = resistanceDC(template, ask, leaderStance);
    if (dc === "refused") {
      ctx.apply({ type: "recordLeaveDenied", entityId: player.id });
      return {
        outcome: "refused",
        resolved: resolvedHardRefusal(`${leader.name} ${contestNoun} refusal`),
        price: "",
      };
    }
    const skill =
      ask.approach === "intimidate" ? "intimidation" : ask.approach === "persuade" ? "persuasion" : undefined;
    const abilityScore = pc ? pc.stats.abilities.cha : 10;
    const bonus = skill && pc?.stats.proficiencies.includes(skill) ? 2 : 0;
    const label = `${leader.name} ${contestNoun} ${ask.approach} resistance`;
    const mods = pcCheckMods(model);
    const effectiveDc = dc + mods.dcAdjustment;
    if (ctx.services.client?.promptRoll) {
      await ctx.services.client.promptRoll({
        actorId: player.id,
        ability: "cha",
        skill,
        dc: effectiveDc,
        label: `${label}, DC ${effectiveDc}`,
      });
    }
    const smods = statusMods(ctx.model, player.id);
    const result = resolveCheck(
      { abilityScore, dc: effectiveDc, bonus: bonus + smods.check, disadvantage: mods.disadvantage || smods.disadvantage },
      ctx.services.rng,
    );
    ctx.emit({
      kind: "diceRolled",
      actorId: player.id,
      notation: "1d20",
      rolls: result.rolls,
      total: result.total,
      purpose: `${label} (DC ${effectiveDc})`,
      success: result.success,
    });
    if (result.success) return { outcome: "granted", resolved: resolvedFromCheck(label, result), price: "" };
    ctx.apply({ type: "recordLeaveDenied", entityId: player.id });
    return { outcome: "denied", resolved: resolvedFromCheck(label, result), price: "" };
  }

  // Already denied once: getting out from under the leader is now a contested escape. The ability
  // is the classifier's closed str/dex/cha answer, falling back to `escapeAbility`'s verb list —
  // whose `force` arm rolled STRENGTH on "I force a smile and sweet-talk my way out", and whose
  // failure branch then applies the leader's consequence (reproduced, r8 audit). `dex` stays the
  // terminal default, so a classifier outage behaves exactly as it does today.
  const ability = escapeAbilityFrom(plan?.escapeAbility, input);
  const dc = pressureDc(leaderStance, true);
  const abilityScore = pc ? pc.stats.abilities[ability] : 10;
  const label = `Escape ${leader.name}'s hold`;
  const mods = pcCheckMods(model);
  const effectiveDc = dc + mods.dcAdjustment;
  if (ctx.services.client?.promptRoll) {
    await ctx.services.client.promptRoll({
      actorId: player.id,
      ability,
      skill: undefined,
      dc: effectiveDc,
      label: `${label}, DC ${effectiveDc}`,
    });
  }
  const smods = statusMods(ctx.model, player.id);
  const result = resolveCheck(
    { abilityScore, dc: effectiveDc, bonus: smods.check, disadvantage: mods.disadvantage || smods.disadvantage },
    ctx.services.rng,
  );
  ctx.emit({
    kind: "diceRolled",
    actorId: player.id,
    notation: "1d20",
    rolls: result.rolls,
    total: result.total,
    purpose: `${label} (DC ${effectiveDc})`,
    success: result.success,
  });
  if (result.success) {
    ctx.apply({ type: "adjustRelationship", actorId: leader.id, targetId: player.id, by: ESCAPE_GRUDGE });
    return { outcome: "brokeFree", resolved: resolvedFromCheck(label, result), price: "" };

  }
  // Failure: the leader's agenda-chosen consequence lands (the same shape as losing a
  // PendingAgendaPressure resist).
  const action = chooseAgendaAction(template, leaderStance, model, world);
  const consequence: Command =
    action && (action.kind === "demand" || action.kind === "pressure")
      ? action.consequence
      : action && action.kind === "manipulate"
        ? action.command
        : { type: "adjustRelationship", actorId: leader.id, targetId: player.id, by: -3 };
  const applied = ctx.apply(consequence);
  if (applied.rejected) {
    ctx.emit({ kind: "system", level: "warn", message: `Leader consequence could not apply (${applied.rejected.reason}).` });
  }
  const price = action && (action.kind === "demand" || action.kind === "pressure") ? ` ${leader.name} ${action.summary}.` : "";
  return { outcome: "held", resolved: resolvedFromCheck(label, result), price };
}

/**
 * Release the given NPC members from the party — each through its own atomic reducer command
 * (flag + that member's pendingLeave + leadership reset when the leader departs, one replayable
 * unit). If the PLAYER carries a denied-leave record AND the release ends the hold it recorded
 * (the leader departs too, or no NPC leader remains), it is erased via a leave/rejoin pair on
 * the PC flag: membership=false is the single reducer path that clears a pendingLeave entry
 * (Stage A's atomic unit), and the immediate re-flag keeps the player-centric invariants
 * (playerEntity/moveParty anchor on the PC's membership) intact — two deltas, both fold-clean.
 * A single dismissal under a STANDING leader keeps the record: the hold itself persists.
 * Departed members lose their live agent + heartbeat (no longer companions) but KEEP their
 * enriched template and significant tier — they remain permanent fixtures of the world.
 */
export function releaseParty(ctx: TickContext, playerId: string, members: Entity[]): string {
  const leaderId = partyLeaderOf(ctx.model.modules);
  const holdRemains =
    leaderId !== null && leaderId !== playerId && !members.some((m) => m.id === leaderId);
  if (!holdRemains && pendingLeaveOf(ctx.model.modules)[playerId] !== undefined) {
    ctx.apply({ type: "setPartyMembership", entityId: playerId, member: false });
    ctx.apply({ type: "setPartyMembership", entityId: playerId, member: true });
  }
  const names: string[] = [];
  for (const m of members) {
    ctx.apply({ type: "setPartyMembership", entityId: m.id, member: false });
    ctx.services.companions?.detach(m.id);
    names.push(m.name);
  }
  const departed = names.join(", ") || "no one";
  const disbanded = ![...ctx.model.entities.values()].some((e) => e.kind === "npc" && e.partyMember);
  ctx.emit({
    kind: "stateChanged",
    summary: disbanded
      ? `The party disbands — you part ways with ${departed}.`
      : `You part ways with ${departed}.`,
    changes: { departedIds: members.map((m) => m.id) },
  });
  return departed;
}

/**
 * Appoint a party leader. A null target (or the player naming themselves) resets the slice to
 * its PC-leads default; a named target must be a current member — the reducer enforces it.
 * While an NPC HOLDS the lead, changing it is never free: the change runs through the same
 * contested hold as the leave gate (`contestLeaderHold`) — otherwise "make me the leader"
 * would depose an abusive leader for one sentence and bypass the entire gate. Leadership
 * grants exactly one thing: the autonomy Director treats the appointee as proposal-capable
 * (`canLeadNow`); nothing about the NPC itself changes.
 */
export async function resolvePartyAppoint(
  ctx: TickContext,
  targetId: string | null,
  input: string,
  player: Entity,
): Promise<NarrationIntent> {
  const model = ctx.model;
  const self = !targetId || targetId === player.id;
  const target = self ? undefined : model.entities.get(targetId as string);
  if (!self && (!target || target.locationId !== player.locationId)) {
    return { trigger: `There is no one here by that name to hand the lead to. ${input}` };
  }
  if (target && !target.partyMember && target.kind !== "pc") {
    return { trigger: `${target.name} is not of your party — only a member can lead it. ${input}` };
  }

  const leaderId = partyLeaderOf(model.modules);
  const leader = leaderId && leaderId !== player.id ? model.entities.get(leaderId) : undefined;
  if (leader && (!target || target.id !== leader.id)) {
    // A sitting NPC leader contests losing the lead exactly like they contest a leave.
    ctx.emit({ kind: "dialogue", actorId: player.id, text: input, toId: leader.id });
    const hold = await contestLeaderHold(ctx, input, player, leader, "step-down");
    switch (hold.outcome) {
      case "refused":
        return {
          trigger: `${leader.name} refuses to yield the lead — the party is theirs. Narrate the refusal in ${leader.name}'s own voice.`,
          resolved: hold.resolved,
        };
      case "denied":
        return {
          trigger: `${leader.name} refuses to give up the lead — and means it. Narrate the refusal in ${leader.name}'s own voice, true to their nature.`,
          resolved: hold.resolved,
        };
      case "held":
        return {
          trigger: `${leader.name} keeps their grip on the party — the lead is not yours to take, and there is a price.${hold.price} Narrate ${leader.name} reasserting their hold.`,
          resolved: hold.resolved,
        };
      case "unopposed":
      case "granted":
      case "brokeFree": {
        ctx.apply({ type: "setPartyLeader", entityId: target?.id ?? null });
        // The hold this contest just broke may have a standing denied-leave record — erase it
        // (the leave/rejoin pair, Stage A's single clearing path) so a FUTURE leader's gate
        // starts at the first ask, not the escalated escape.
        if (pendingLeaveOf(model.modules)[player.id] !== undefined) {
          ctx.apply({ type: "setPartyMembership", entityId: player.id, member: false });
          ctx.apply({ type: "setPartyMembership", entityId: player.id, member: true });
        }
        const newLeader = target ? target.name : "you";
        ctx.emit({
          kind: "stateChanged",
          summary: target ? `${target.name} now leads the party.` : `You take the lead of the party.`,
          changes: { leaderId: target?.id ?? null },
        });
        const how =
          hold.outcome === "unopposed"
            ? `${leader.name} is down and holds nothing now`
            : hold.outcome === "granted"
              ? `${leader.name} yields the lead`
              : `You wrench the lead from ${leader.name}, and they will not forget it`;
        return {
          trigger: `${how} — the party now follows ${newLeader}. Narrate the shift in authority.`,
          resolved: hold.resolved,
        };
      }
    }
  }

  if (self) {
    const res = ctx.apply({ type: "setPartyLeader", entityId: null });
    if (!res.mutated) return { trigger: `You already lead the party. ${input}` };
    ctx.emit({ kind: "stateChanged", summary: `You take the lead of the party.`, changes: { leaderId: null } });
    return { trigger: `You take the lead of the party. Narrate the shift in authority.` };
  }
  const res = ctx.apply({ type: "setPartyLeader", entityId: target!.id });
  if (res.rejected) {
    return { trigger: `${target!.name} is not of your party — only a member can lead it. ${input}` };
  }
  if (!res.mutated) return { trigger: `${target!.name} already leads the party.` };
  ctx.emit({ kind: "stateChanged", summary: `${target!.name} now leads the party.`, changes: { leaderId: target!.id } });
  return { trigger: `You hand the lead of the party to ${target!.name}. Narrate the shift in authority.` };
}

/**
 * The template the agenda/stance math reads for an entity, id-keyed to the ENTITY: stance()
 * reads relationships under `template.id` and `chooseAgendaAction` resolves the actor by it,
 * while grudges/consequences are recorded under entity ids — a spawned instance
 * (`npc.guard#1`) backed by a shared authored template would otherwise read a permanently
 * empty relationship row and never find its own body. Enriched templates already carry the
 * entity id; an authored shared one is shallow-rekeyed (copy — content is never mutated).
 */
export function stanceTemplateFor(
ctx: TickContext,entity: Entity): NpcTemplate {
  const template = ctx.services.companions?.templateFor(entity) ?? composeNpcTemplate(ctx.services.world, entity);
  return template.id === entity.id ? template : { ...structuredClone(template), id: entity.id };
}
