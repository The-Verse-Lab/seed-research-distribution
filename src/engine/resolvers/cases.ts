/**
 * The case domain — the player's verdict, the claims NPCs make about a case, and the culprit's
 * answer when named.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). The case spine
 * itself lives in `src/rules/cases.ts`; this is the turn-shaped layer over it — what an accusation
 * does, which authored effects a verdict fires, and how the accused responds.
 *
 * @author Runkai Zhang
 */
import type { Case, Effect } from "../../content/schema.ts";
import { caseRuntimeOf, classifyCaseClaim, effectiveBeliefs, joinFactTexts } from "../../rules/cases.ts";
import { partyHostileFlag } from "../../rules/betrayal.ts";
import { effectToCommands } from "../../modules/events/effect-to-command.ts";
import { displayName, isConscious, type Entity } from "../../world/entity.ts";
import { entitiesAt, partyLocationOf, playerEntity } from "../../world/model.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import type { TickContext } from "../tick.ts";
import type { TurnCaseClaim, TurnPlan } from "../turn-plan.ts";

/**
 * Resolve a formal case action (mystery wave). `present` hands an NPC a fact they LEARN (and
 * overturns any herring that fact refutes); `accuse` runs the verdict IN CODE: correct + every
 * required core fact known ⇒ solve (quest complete + culprit response); correct-but-unproven ⇒ an
 * honest refusal naming missing evidence CATEGORIES, never facts; wrong ⇒ a spent wrong-accusation
 * with standing/credibility damage, failing the case once the budget is exhausted.
 */
export function resolveCaseAction(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const cp = plan.case;
  const model = ctx.model;
  const caseDef = cp?.caseId ? ctx.services.campaign.cases.find((c) => c.id === cp.caseId) : undefined;
  // Re-check at execution time — the classifier context could be stale.
  if (!cp || !caseDef || model.quests.get(caseDef.questId) !== "active") {
    return { trigger: `You make to press the matter, but there is no open case to press. ${input}` };
  }
  if (caseRuntimeOf(model.modules, caseDef.id).status !== "open") {
    return { trigger: `That matter is already closed.` };
  }
  const suspect = cp.suspectId ? model.entities.get(cp.suspectId) : undefined;
  const suspectName = suspect?.name ?? cp.suspectId ?? "them";
  const playerId = playerEntity(model)?.id ?? "pc.you";

  if (cp.verb === "present") {
    if (!suspect) return { trigger: `You have no one here to lay the evidence before. ${input}` };
    for (const factId of cp.factIds) {
      if (!caseRuntimeOf(model.modules, caseDef.id).playerKnown.includes(factId)) continue;
      ctx.apply({ type: "npcLearnCaseFact", caseId: caseDef.id, npcId: suspect.id, factId });
      // Presenting a refuting fact overturns a herring the NPC still believed.
      for (const herring of caseDef.redHerrings) {
        if (
          herring.refutedBy.includes(factId) &&
          effectiveBeliefs(caseDef, caseRuntimeOf(model.modules, caseDef.id), suspect.id).includes(herring.id)
        ) {
          ctx.apply({ type: "npcDropCaseBelief", caseId: caseDef.id, npcId: suspect.id, beliefId: herring.id });
        }
      }
    }
    const shown = joinFactTexts(
      cp.factIds.map((id) => caseDef.facts.find((f) => f.id === id)?.text).filter((t): t is string => !!t),
    );
    return { trigger: `You lay the evidence before ${suspectName}: ${shown || "what you have"}.` };
  }

  // verb === "accuse" — the verdict is code's.
  const required = caseDef.accusation.requiredCoreFacts;
  const known = caseRuntimeOf(model.modules, caseDef.id).playerKnown;
  const correct = cp.suspectId === caseDef.truth.culpritId;
  const proven = required.every((fid) => known.includes(fid));

  if (correct && proven) {
    ctx.apply({ type: "resolveCase", caseId: caseDef.id, status: "solved" });
    ctx.apply({ type: "setQuestState", questId: caseDef.questId, state: "complete" });
    applyCaseEffects(ctx, caseDef.accusation.successEffects);
    const beat = applyCulpritResponse(ctx, caseDef, suspect);
    ctx.emit({ kind: "stateChanged", summary: `Case solved: ${caseDef.name}.`, changes: { caseId: caseDef.id, caseStatus: "solved" } });
    return { trigger: `You name ${suspectName} — and the proof holds. ${beat}` };
  }

  if (correct && !proven) {
    // Right suspect, no proof: name the missing CATEGORIES (fact kinds), never the facts themselves.
    const missing = new Set<string>();
    for (const fid of required) {
      if (!known.includes(fid)) {
        const kind = caseDef.facts.find((f) => f.id === fid)?.kind;
        if (kind) missing.add(kind);
      }
    }
    const cats = [...missing].join(", ");
    return {
      trigger: `You could name ${suspectName} — but you cannot yet PROVE it. You still lack ${cats || "hard proof"}, and without it no one will act on the accusation.`,
    };
  }

  // Wrong suspect: spend a wrong accusation, bruise standing, and fail the case if the budget is gone.
  ctx.apply({ type: "recordWrongAccusation", caseId: caseDef.id });
  if (suspect) {
    ctx.apply({ type: "adjustRelationship", actorId: suspect.id, targetId: playerId, by: -8 });
    ctx.apply({ type: "adjustCaseCredibility", caseId: caseDef.id, npcId: suspect.id, by: -2 });
  }
  applyCaseEffects(ctx, caseDef.accusation.wrongAccusationEffects);
  const spent = caseRuntimeOf(model.modules, caseDef.id).wrongAccusations;
  const budget = caseDef.accusation.maxWrongAccusations;
  if (spent >= budget) {
    ctx.apply({ type: "resolveCase", caseId: caseDef.id, status: "failed" });
    ctx.apply({ type: "setQuestState", questId: caseDef.questId, state: "failed" });
    applyCaseEffects(ctx, caseDef.accusation.failEffects);
    ctx.emit({ kind: "stateChanged", summary: `Case failed: ${caseDef.name}.`, changes: { caseId: caseDef.id, caseStatus: "failed" } });
    return { trigger: `You accuse ${suspectName} — wrongly, and for the last time. The trail is cold now; the case is lost.` };
  }
  const left = budget - spent;
  return {
    trigger: `You accuse ${suspectName} — but it doesn't hold, and the wild charge costs you. (${left} more before the case is lost.)`,
  };
}

/**
 * Resolve the case-claim side-channel (mystery lie/credibility ledger) riding a `dialogueToNpc`
 * line — the player asserting or denying known case facts to the NPC they addressed, with NO extra
 * model call (the physical-effects-channel precedent). Each grounded claim (factId ∈ playerKnown, an
 * active + open case) lands per {@link classifyCaseClaim}: `learn` — the NPC comes to know the fact
 * (and drops any belief that fact refutes, as `present` does); `caught` — the player is caught
 * DENYING a fact the NPC knows to be true (credibility −2, standing −4); `noop` — a denial the NPC
 * has no basis to disprove (logged, no penalty). Every claim joins the bounded ledger. Returns
 * player-facing beat leads (prepended to the exchange's narration like the effects channel) so the
 * outcome always shows even when the NPC's own reply is vague. The distrust rail the credibility
 * drop arms is read live by the SAME turn's reply brief (claims apply before the dialogue module).
 */
export function resolveCaseClaims(ctx: TickContext, npcId: string, claims: readonly TurnCaseClaim[]): string[] {
  const model = ctx.model;
  const name = model.entities.get(npcId)?.name ?? npcId;
  const playerId = playerEntity(model)?.id ?? "pc.you";
  let learned = 0;
  let caught = 0;
  let withheld = 0;
  for (const claim of claims) {
    const caseDef = ctx.services.campaign.cases.find((c) => c.id === claim.caseId);
    if (!caseDef || model.quests.get(caseDef.questId) !== "active") continue;
    const runtime = caseRuntimeOf(model.modules, caseDef.id);
    if (runtime.status !== "open") continue;
    if (!runtime.playerKnown.includes(claim.factId)) continue; // re-check at execution time (stale ctx)
    const verdict = classifyCaseClaim(caseDef, runtime, npcId, claim.stance, claim.factId);
    ctx.apply({
      type: "recordCaseClaim",
      caseId: caseDef.id,
      claim: { npcId, factId: claim.factId, stance: claim.stance, caught: verdict === "caught", clock: model.clock },
    });
    if (verdict === "learn") {
      ctx.apply({ type: "npcLearnCaseFact", caseId: caseDef.id, npcId, factId: claim.factId });
      // Sharing a refuting fact overturns a herring the NPC still believed (mirrors the `present` verb).
      for (const herring of caseDef.redHerrings) {
        if (
          herring.refutedBy.includes(claim.factId) &&
          effectiveBeliefs(caseDef, caseRuntimeOf(model.modules, caseDef.id), npcId).includes(herring.id)
        ) {
          ctx.apply({ type: "npcDropCaseBelief", caseId: caseDef.id, npcId, beliefId: herring.id });
        }
      }
      learned += 1;
    } else if (verdict === "caught") {
      ctx.apply({ type: "adjustCaseCredibility", caseId: caseDef.id, npcId, by: -2 });
      ctx.apply({ type: "adjustRelationship", actorId: npcId, targetId: playerId, by: -4 });
      caught += 1;
    } else if (verdict === "withheld") {
      // r4 P2: an explicit refusal to show evidence was executed as its OPPOSITE, and once that
      // was fixed it recorded nothing at all. Refusing is a legitimate mystery move, so the world
      // remembers it — and NO credibility damage: credibility is the caught-LYING band, and
      // declining to show someone something is honest. The cost is a small chill, applied once
      // (`mutated` gates it, so stonewalling the same person twice costs nothing new).
      const res = ctx.apply({ type: "recordCaseWithhold", caseId: caseDef.id, npcId, factIds: [claim.factId] });
      if (res.mutated) {
        ctx.apply({ type: "adjustRelationship", actorId: npcId, targetId: playerId, by: -2 });
        withheld += 1;
      }
    }
  }
  const leads: string[] = [];
  if (caught > 0) leads.push(`${name} catches you in the lie — you feel your standing with them harden.`);
  if (learned > 0) leads.push(`${name} takes in what you've laid out.`);
  if (withheld > 0) leads.push(`${name} sees you keep it back, and does not miss it.`);
  return leads;
}

/** The culprit's authored reaction to a PROVEN accusation: confess & leave, bolt, or turn to fight. */
export function applyCulpritResponse(ctx: TickContext, caseDef: Case, accused: Entity | undefined): string {
  const model = ctx.model;
  const culpritId = caseDef.truth.culpritId;
  const culprit = model.entities.get(culpritId);
  const name = culprit?.name ?? accused?.name ?? culpritId;
  switch (caseDef.accusation.culpritResponse) {
    case "flee": {
      if (culprit?.partyMember) ctx.apply({ type: "setPartyMembership", entityId: culpritId, member: false });
      if (culprit) ctx.apply({ type: "despawnEntity", entityId: culpritId });
      return `${name} breaks and runs — gone into the dark before a hand can land on them.`;
    }
    case "fight": {
      if (!culprit) return `${name} is nowhere to be found — but the truth is out at last.`;
      const loc = culprit.locationId ?? partyLocationOf(model) ?? "";
      const playerId = playerEntity(model)?.id ?? "pc.you";
      ctx.apply({ type: "setPartyMembership", entityId: culpritId, member: false });
      ctx.apply({ type: "setFlag", scope: "world", key: partyHostileFlag(culpritId), value: true });
      const order = [
        culpritId,
        ...entitiesAt(model, loc)
          .filter((e) => e.id !== culpritId && (e.partyMember || e.id === playerId) && (e.stats?.currentHp ?? 1) > 0)
          .map((e) => e.id),
      ];
      ctx.enqueue({ type: "startCombat", locationId: loc, order, round: 1, turnIndex: order.length > 1 ? 1 : 0 });
      return `${name} gives no confession — only a drawn blade. They turn on you.`;
    }
    default: {
      // surrender (the default): the culprit confesses and, if a companion, leaves the party.
      if (culprit?.partyMember) ctx.apply({ type: "setPartyMembership", entityId: culpritId, member: false });
      return `${name} goes still — then the fight drains out of them, and they confess.`;
    }
  }
}

/** Expand a case accusation's authored Effects (rewards/flags/narration) at resolve time. */
export function applyCaseEffects(ctx: TickContext, effects: readonly Effect[]): void {
  if (effects.length === 0) return;
  const model = ctx.model;
  const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
  for (const eff of effects) {
    if (eff.kind === "narrate") {
      beats.push(eff.text);
      continue;
    }
    for (const cmd of effectToCommands(eff, ctx.services.world, model, ctx.queue, ctx.services.campaign)) {
      ctx.apply(cmd);
    }
  }
  if (beats.length > 0) ctx.data.eventBeats = beats;
}
