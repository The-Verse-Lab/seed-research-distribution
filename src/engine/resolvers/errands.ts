/**
 * The errand domain — sending a companion off to do a thing, and dispatching it when they agree.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). An errand is the
 * one player action whose effect lands OFF-SCREEN, so the dispatch half is what turns an agreed
 * plan into world state the player will only see the result of.
 *
 * @author Runkai Zhang
 */
import { TURN_COSTS } from "../../rules/costs.ts";
import { ERRAND_CAP, ERRAND_MAX_MINUTES, ERRANDS_MODULE, errandDueClock, errandEtaLabel, errandFee, readErrandsSlice, type ErrandTask } from "../../rules/errands.ts";
import { stance } from "../../rules/agenda.ts";
import { dayOf, readRoutinesSlice } from "../../rules/routine.ts";
import { displayName, isConscious, type Entity } from "../../world/entity.ts";
import { entitiesAt, partyLocationOf, playerEntity } from "../../world/model.ts";
import { findRoute, firstBarredLeg } from "../../world/pathfind.ts";
import type { DialogueIntent } from "../../modules/dialogue.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import { describeWalkDuration } from "./phrasing.ts";
import type { TickContext } from "../tick.ts";
import type { TurnPlan } from "../turn-plan.ts";
import { locationNameOf, npcNameOf } from "./names.ts";

/**
 * An errand quoted last turn, awaiting the player's word — the runner has stated the terms in their
 * own voice and only a "yes" spends the coin and sends them. The engine holds exactly one of these,
 * unpersisted and good for a single following turn: a quote that survived a reload would send
 * someone on a trip the player never agreed to.
 */
export interface PendingErrand {
  runnerId: string;
  runnerName: string;
  task: ErrandTask;
  destinationId: string;
  destinationName: string;
  reportLocationId: string;
  homeLocationId: string;
  routeMinutes: number;
  feeCp: number;
}

/**
 * The QUOTE turn. Nothing moves and no coin is spent: the runner is grounded, the route is
 * priced off real roads, willingness is read from their stance, and the terms go out in THEIR
 * voice so the player learns the ETA and the fee before agreeing to either. A bare "yes" next
 * turn commits (`dispatchErrand`); anything else lets the quote lapse.
 *
 * Every refusal is honest and specific — no road, exhausted patience, too far, already out —
 * and priced at a full beat rather than a one-minute shrug (r4's "a reach-miss is a beat").
 */
export function resolveErrand(
  ctx: TickContext,
  plan: TurnPlan,
  input: string,
  /** Arm the engine's one-turn errand quote. Passed in rather than reached for: the quote is engine
   *  scratch, deliberately unpersisted, and this resolver only decides WHAT to quote. */
  arm: (quote: PendingErrand) => void,
): NarrationIntent {
  const model = ctx.model;
  const errand = plan.errand;
  const runner = errand?.runnerId ? model.entities.get(errand.runnerId) : undefined;
  if (!errand || !runner || runner.kind !== "npc" || !isConscious(runner)) {
    return { trigger: `There is no one here to send. ${input}`, echoFallback: "There is no one here to send." };
  }
  const runnerName = displayName(runner);
  const slice = readErrandsSlice(model.modules);
  if (slice.active[runner.id]) {
    const standing = slice.active[runner.id]!;
    return {
      trigger: `${runnerName} is already away — ${locationNameOf(ctx.services.world, standing.destinationId)}, and not back yet.`,
      deterministic: true,
    };
  }
  if (Object.keys(slice.active).length >= ERRAND_CAP) {
    return { trigger: `You already have as many errands running as you can keep track of.`, deterministic: true };
  }

  // Where they would go: for ask/bring it is wherever the subject actually STANDS right now —
  // never a guess, and never a place the subject merely used to be.
  const subject = errand.subjectId ? model.entities.get(errand.subjectId) : undefined;
  const destinationId =
    errand.verb === "ask" || errand.verb === "bring" ? (subject?.locationId ?? null) : errand.destinationId;
  if (!destinationId) {
    const who = errand.subjectId ? npcNameOf(ctx.model, ctx.services.world, errand.subjectId) : "that";
    return { trigger: `Nobody here knows where to find ${who}.`, deterministic: true };
  }

  const from = runner.locationId ?? partyLocationOf(model) ?? "";
  const route = findRoute(model, from, destinationId, { defaultLegMinutes: TURN_COSTS.movement.minutes });
  const destinationName = locationNameOf(ctx.services.world, destinationId);
  if (!route) {
    const barred = firstBarredLeg(model, from, destinationId, { defaultLegMinutes: TURN_COSTS.movement.minutes });
    const why = barred
      ? `the way through ${locationNameOf(ctx.services.world, barred.from)} toward ${locationNameOf(ctx.services.world, barred.to)} is barred`
      : `no road they know runs there`;
    return {
      trigger: `${runnerName} shakes their head at ${destinationName} — ${why}.`,
      deterministic: true,
    };
  }
  const dueAtClock = errandDueClock(model.clock, route.totalMinutes);
  if (dueAtClock - model.clock > ERRAND_MAX_MINUTES) {
    return {
      trigger: `${destinationName} is too far to send anyone and wait — that is a journey, not an errand.`,
      deterministic: true,
    };
  }

  // Willingness is code-owned, off the same stance machinery every other social ask uses.
  const template = ctx.services.world.npcs.find((n) => n.id === (runner.templateId ?? runner.id));
  const playerId = playerEntity(model)?.id ?? "pc.you";
  const runnerStance = template
    ? stance(template, playerId, model, ctx.services.world, ctx.services.campaign)
    : null;
  const feeCp = runner.partyMember ? 0 : errandFee(route.totalMinutes);
  if (!runner.partyMember) {
    const willing =
      runnerStance !== null &&
      runnerStance.disposition !== "exploitative" &&
      runnerStance.disposition !== "wary" &&
      runnerStance.relationship > -20;
    if (!willing) {
      return { trigger: `${runnerName} is not running anyone's errands for you.`, deterministic: true };
    }
    const coins = playerEntity(model)?.stats?.coins ?? 0;
    if (coins < feeCp) {
      return {
        trigger: `${runnerName} names a price of ${feeCp}cp for the walk to ${destinationName}. You do not have it.`,
        deterministic: true,
      };
    }
  }

  const task: ErrandTask =
    errand.verb === "ask"
      ? { kind: "ask", subjectId: errand.subjectId!, topic: errand.topic }
      : errand.verb === "bring"
        ? { kind: "bring", subjectId: errand.subjectId! }
        : errand.verb === "fetch"
          ? { kind: "fetch", locationId: destinationId, itemId: errand.itemId ?? "" }
          : { kind: "scout", locationId: destinationId };
  if (task.kind === "fetch" && !task.itemId) {
    return { trigger: `${runnerName} needs to know what to bring back.`, deterministic: true };
  }

  const reportLocationId = partyLocationOf(model) ?? from;
  arm({
    runnerId: runner.id,
    runnerName,
    task,
    destinationId,
    destinationName,
    reportLocationId,
    homeLocationId: runner.locationId ?? reportLocationId,
    routeMinutes: route.totalMinutes,
    feeCp,
  });

  // The terms in the runner's own voice (the workInquiry pattern) — with a deterministic trigger
  // carrying the same numbers, so a blank narrator still delivers them.
  const eta = errandEtaLabel(dueAtClock);
  const terms = [
    `${describeWalkDuration(route.totalMinutes)} each way to ${destinationName}`,
    feeCp > 0 ? `${feeCp}cp for the trouble` : `no charge — you travel together`,
    `back by ${eta}`,
  ];
  ctx.data.dialogue = { npcId: runner.id, playerLine: input, errandQuote: terms } satisfies DialogueIntent;
  return {
    trigger:
      `${runnerName} weighs it: ${terms.join("; ")}. Say the word and they go.`,
    deterministic: true,
  };
}

/** The COMMIT turn: coin moves, the runner walks, and the errand starts ticking. */
export function dispatchErrand(ctx: TickContext, armed: PendingErrand): NarrationIntent {
  const model = ctx.model;
  const playerId = playerEntity(model)?.id;
  const dueAtClock = errandDueClock(model.clock, armed.routeMinutes);
  if (armed.feeCp > 0 && playerId) {
    ctx.apply({ type: "adjustCoins", entityId: playerId, by: -armed.feeCp });
    // Only a body that can hold coin gets paid; a statless fixture would reject and burn it.
    if (model.entities.get(armed.runnerId)?.stats) {
      ctx.apply({ type: "adjustCoins", entityId: armed.runnerId, by: armed.feeCp });
    }
  }
  ctx.apply({ type: "moveEntity", entityId: armed.runnerId, to: armed.destinationId, teleport: true });

  // Pin them for the trip, or the next phase boundary reconciles them straight back into their
  // own schedule slot and the errand's runner is standing in the wrong town.
  const routines = readRoutinesSlice(model.modules);
  routines.overrides[armed.runnerId] = {
    locationId: armed.destinationId,
    activity: "away on an errand",
    untilDay: dayOf(dueAtClock) + 1,
  };
  routines.activity[armed.runnerId] = "away on an errand";
  delete routines.venues[armed.runnerId];
  ctx.applySilent({ type: "modulePatch", module: "routines", patch: { ...routines } });

  const slice = readErrandsSlice(model.modules);
  slice.active[armed.runnerId] = {
    id: `err:${armed.runnerId}:${model.clock}`,
    runnerId: armed.runnerId,
    task: armed.task,
    destinationId: armed.destinationId,
    reportLocationId: armed.reportLocationId,
    homeLocationId: armed.homeLocationId,
    departedAtClock: model.clock,
    dueAtClock,
    feeCp: armed.feeCp,
  };
  ctx.applySilent({
    type: "modulePatch",
    module: ERRANDS_MODULE,
    patch: { active: slice.active, reports: slice.reports },
  });
  ctx.apply({
    type: "recordNpcMemory",
    npcId: armed.runnerId,
    entry: { at: model.clock, kind: "errandTaken", summary: `Sent to ${armed.destinationName} on your word.` },
  });
  ctx.data.persist = true;
  return {
    trigger: `${armed.runnerName} sets out for ${armed.destinationName} — back by ${errandEtaLabel(dueAtClock)}.`,
    deterministic: true,
  };
}
