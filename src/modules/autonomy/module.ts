/**
 * Autonomy module — the Director, as a TickModule. The project's defining feature: proactive,
 * bounded-autonomy companions, built on the world-model tick spine (docs/PROACTIVE-NPCS.md).
 *
 * It does not narrate; it SCHEDULES and GATES the NPC agents and routes their free-text intent
 * through grounding into validated Commands (the world only moves through the reducer). Priority
 * A > B > C:
 *  - A (player / direct address) is core's job (resetReplyDepth on a player tick).
 *  - B (reactive) — on a player tick, after the addressed companion's direct reply, a *second*
 *    present companion may chime in. Gated by talk-lock + reply-chain decay + arbitration.
 *  - C (spontaneous) — only on a heartbeat tick for an idle proactive/leader companion. Gated by
 *    talk-lock + idle guard + dedup + arbitration. A `leader` leads by *proposing* (an
 *    NpcProposal the table can accept/override/ignore); a `proactive` companion chimes in.
 * A leader companion's pending proposal is acted on (tacit consent) on its next quiet heartbeat
 * once the beat has elapsed; a player input cancels it (priority A override) — but the cancelled
 * proposal is stashed into per-tick scratch (`ctx.data.pendingProposals`) so the engine's resolve
 * phase can read an explicit player "yes"/"no" as an answer to it. A leader never re-proposes
 * while its own proposal is still pending, and after one it cools down for a few beats
 * (`PROPOSAL_COOLDOWN_BEATS`) — spontaneous lines in that window stay plain dialogue.
 *
 * Everything here is offline-safe and never-stall: decide → ground → emit is wrapped so a broken
 * gateway warns and releases the talk-lock instead of throwing out of the tick.
 *
 * @author Runkai Zhang
 */
import type { World } from "../../content/schema.ts";
import { roll, type Rng, type RollResult } from "../../rules/dice.ts";
import type { AutonomyRuntime } from "../../state/types.ts";
import type { Command } from "../../world/commands.ts";
import { displayName, isConscious, type Entity } from "../../world/entity.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { exitsFrom } from "../../world/map.ts";
import { isFrontierId, FRONTIER_FALLBACK_NAME, frontierExpansionEnabled } from "../../world/expansion.ts";
import { barredExitsAt } from "../../world/traversal.ts";
import { isCombatActive, modelExits, modelPresence, WorldView } from "../../world/queries.ts";
import { buildNarrationContext, recordNpcBeat, recordSocialRead, type SelfInfo } from "../../agents/context.ts";
import { spokenLineOf, type NpcAgent } from "../../agents/npc.ts";
import { shouldContinueReply, pickReplyTarget } from "../../director/arbitration.ts";
import type { HeartbeatScheduler } from "../../director/heartbeat.ts";
import { nowOf, type TickContext, type TickModule } from "../../engine/tick.ts";
import { isPartyHostile } from "../../rules/betrayal.ts";
import { decayedGrievance } from "../../rules/grievance.ts";
import {
  agendaTarget,
  chooseAgendaAction,
  chooseLeaderDiscipline,
  stance,
  type AgendaAction,
  type PendingAgendaPressure,
} from "../../rules/agenda.ts";
import { summarizeModifiers, type SocialModifier } from "../../rules/social.ts";
import { turnContext } from "../../logging/turn-context.ts";
import { partyLeaderOf } from "../../rules/party.ts";
import { resolveItem } from "../../rules/items.ts";
import { energyOf, maxEnergyOf } from "../../rules/costs.ts";
import { exhaustionOf, workingCap } from "../../rules/exhaustion.ts";
import { whisperSteerOf } from "../../rules/whispers.ts";
import { offersPatch } from "../../rules/pending-offers.ts";
import { isRecentDuplicate, pushUtterance, UTTERANCES_MODULE } from "../../rules/utterances.ts";
import { relationshipProfileFromState, renderRelationshipProfile } from "../../rules/relationships.ts";
import {
  actCandidates,
  groundToCommand,
  groundingFallbackReason,
  renderActCandidates,
  type GroundedAction,
  type GroundingResult,
} from "./grounding.ts";
import type { NpcAct } from "../../rules/npc-act.ts";
import { consentBlockFor, consentBlockInPlan, type ConsentBlock, type ConsentPath } from "./consent.ts";
import { renderRecall } from "../npc-memory/state.ts";
import { renderHistoryBlock } from "../../memory/npc-history.ts";
import { caseBriefForNpc, planCaseShare, caseRuntimeOf, type CaseShare } from "../../rules/cases.ts";
import { resolveCheck, type CheckResult } from "../../rules/checks.ts";
import { barrierDescription, type ExitRuntimeState } from "../../rules/exit-state.ts";

/** Skip an autonomous action if this NPC acted within the last N ms (anti-restate dedup). */
export const MIN_DEDUP_MS = 5000;

/** Default reply-chain decay rate if a template omits one. */
const DEFAULT_ALPHA = 0.2;
/** Hard cap on consecutive UNPROMPTED quiet beats (heartbeat priority C) since the player last
 *  spoke — the idle budget (playtest r9 F-12). Player input resets replyDepth, reopening it. */
const HEARTBEAT_QUIET_CAP = 2;

/**
 * Baseline chance a present companion volunteers a priority-B reaction after the player addresses
 * *someone else*. Reply-chain decay only bounds NPC↔NPC chains, not the first reaction — so without
 * this gate a second companion chimes in on EVERY address, which reads as spam. The chance is
 * scaled up by the reactor's regard for the addressed companion (reply-focus made mechanical), so
 * close allies speak up readily while bystanders mostly stay quiet. The one knob for B chattiness —
 * lowered from 0.3 after the 2026-07-05 playtest flagged party chatter as the biggest UX drag.
 */
export const B_REACTION_CHANCE = 0.12;

/**
 * Stage 3 — present non-party world NPCs. A merchant/guard/rival present with the player may take a
 * single bounded autonomous beat on a player tick, but only when NO companion priority-B reaction
 * fired (companions win) and only rarely: most player turns stay quiet so the world feels alive
 * without turning into a barrage. Two knobs, both deliberately calmer than the companion path:
 *  - WORLD_NPC_DEDUP_MS — the per-NPC cooldown after a world beat (a calmer window than companions'
 *    `MIN_DEDUP_MS`, so a present shopkeeper doesn't chime every few seconds).
 *  - WORLD_NPC_CHANCE — the low probability an eligible present NPC actually acts on a given tick
 *    (seeded via `this.rng`); below it, the tick stays quiet.
 */
export const WORLD_NPC_DEDUP_MS = 45000;
export const WORLD_NPC_CHANCE = 0.25;

/**
 * Beats a leader must wait after emitting a proposal before arming another (in units of its own
 * heartbeat). Within the window a spontaneous line is demoted to plain dialogue — the leader
 * still speaks, but the table isn't re-asked every beat. `lastProposedAt` absent ⇒ 0 ⇒ the
 * first proposal always fires.
 */
export const PROPOSAL_COOLDOWN_BEATS = 3;

/**
 * The same cooldown measured in IN-WORLD MINUTES — the one the engine enforces.
 *
 * The wall-clock window (3 × the leader's 40s heartbeat = 120s) was shorter than a single narrated
 * turn on a reasoning model, so it expired for free while the player read and typed and the leader
 * re-armed on nearly every beat (2026-07-24 playtest: three proposals in a row while shopping,
 * three more mid-march). The campaign clock only moves on PLAYER turns, so counting in in-world
 * minutes makes this a genuine conversational pause: roughly three exchanges of dialogue (1 minute
 * each) or one real action, whatever the model's latency happens to be.
 */
export const PROPOSAL_COOLDOWN_MINUTES = 3;

/**
 * How many of the leader's own heartbeats a proposal waits before tacit consent executes it. One
 * beat (40s) was less than a single narrated turn, so an unanswered proposal fired while the player
 * was still typing their answer ("Meeting no objection…", 2026-07-24 playtest). Paired with the
 * composing hold, which stops the deadline entirely while the composer has text in it.
 */
export const PROPOSAL_CONSENT_BEATS = 3;

/**
 * Beats an NPC must wait after ARMING a demand/pressure agenda action before arming another (in
 * units of its own heartbeat) — the `PROPOSAL_COOLDOWN_BEATS`/`lastProposedAt` precedent applied
 * to agenda pressure. Within the window `planAgendaAction` skips demand/pressure kinds, so the
 * beat is plain dialogue instead of another resist the player must spend a turn answering (a live
 * playtest saw the identical press eat three consecutive turns). `lastPressedAt` absent ⇒ 0 ⇒
 * the first press always fires.
 */
export const PRESSURE_COOLDOWN_BEATS = 3;


/**
 * A proposal cancelled by this player tick's priority-A override, handed to the resolve phase
 * through per-tick scratch (`ctx.data.pendingProposals`) so an explicit "yes"/"no" can answer it.
 * Scratch only — never state, never a delta; it dies with the tick.
 */
export interface CancelledProposal {
  npcId: string;
  text: string;
  commands: Command[];
  /** Party location when the plan was grounded — the accept path refuses a stale plan (see types.ts). */
  originLocationId?: string;
}

/** A pending autonomous line for the narrate phase to realize (decide → ground → emit). */
interface AutonomyDialogueItem {
  npcId: string;
  stimulus: string;
  replyDepth: number;
  priority: "B" | "C";
  /**
   * Stage 3: this beat belongs to a PRESENT NON-PARTY world NPC (a merchant/guard/rival acting on
   * its own), not a companion. A world beat flows decide → ground → emit through the SAME grounder,
   * but never drives agenda pressure (present NPCs already have that path) and never proposes (a
   * non-party NPC does not lead the table). Absent/false ⇒ an ordinary companion B/C beat.
   */
  world?: boolean;
}

/** Read the namespaced autonomy runtime slice off the model (always cast — it is `unknown`). */
function autonomyOf(model: WorldModel): Record<string, AutonomyRuntime> {
  return (model.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};
}

export class AutonomyModule implements TickModule {
  readonly id = "autonomy";
  /** Run after core (depth reset / proposal-cancel ordering) and after the reactive modules. */
  readonly after = ["core", "dialogue", "events"];
  readonly phases: TickModule["phases"];
  /** Heartbeats are registered once, on the first tick (the engine is fully wired by then). */
  private initialized = false;
  /**
   * Stage 3: module-side cache of agents built for PRESENT NON-PARTY world NPCs via `agentFactory`,
   * so a present shopkeeper/guard isn't rebuilt every player tick. Companions always resolve through
   * `this.npcs` first; this only holds the non-companion agents the world path summons.
   */
  private readonly worldAgents = new Map<string, NpcAgent>();

  constructor(
    private readonly npcs: Map<string, NpcAgent>,
    private readonly heartbeat: HeartbeatScheduler,
    private readonly world: World,
    private readonly rng: Rng,
    private readonly pendingAgendaPressures: Map<string, PendingAgendaPressure> = new Map(),
    /**
     * Stage 3: build an NpcAgent for ANY world NPC by id (the module only holds COMPANION agents in
     * `this.npcs`). Optional so existing constructions still compile — absent ⇒ no world beats ever
     * fire (a present non-party NPC has no agent to decide with, so `reactWorldNpc` finds none).
     */
    private readonly agentFactory?: (npcId: string) => NpcAgent | undefined,
  ) {
    this.phases = {
      perceive: (ctx) => this.onPerceive(ctx),
      react: (ctx) => this.onReact(ctx),
      narrate: (ctx) => this.onNarrate(ctx),
    };
  }

  // --- perceive: heartbeat registration + proposal lifecycle -----------------

  private onPerceive(ctx: TickContext): void {
    if (isCombatActive(ctx.model)) {
      this.heartbeat.stop();
      this.initialized = false;
      return;
    }

    this.ensureHeartbeats();

    if (ctx.trigger.kind === "player") {
      // Priority-A override: a player input cancels every companion's pending proposal. Runs
      // after core's resetReplyDepth (this module is `after: ["core"]`).
      this.cancelAllProposals(ctx);
      return;
    }

    // Heartbeat: tacit consent — if the heartbeating leader has a proposal whose beat has
    // elapsed with no player objection, act on it now and clear it (priority C, quiet table).
    this.consumeExpiredProposal(ctx, ctx.trigger.npcId);
  }

  /** Lazily register a heartbeat for each *companion* (never iterate world.npcs). Idempotent. */
  private ensureHeartbeats(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const npcId of this.npcs.keys()) {
      const template = this.world.npcs.find((n) => n.id === npcId);
      if (template) this.heartbeat.register(npcId, template.autonomy.heartbeatSeconds);
    }
  }

  /**
   * Clear every companion's pending proposal (player priority-A override) — but first stash the
   * cancelled proposals into per-tick scratch so the engine's resolve phase (which runs after
   * perceive) can treat an explicit player "yes"/"no" as an answer instead of a silent cancel.
   */
  private cancelAllProposals(ctx: TickContext): void {
    const autonomy = autonomyOf(ctx.model);
    const patch: Record<string, AutonomyRuntime> = {};
    const stash: CancelledProposal[] = [];
    // Stash in player-visible order: appointed leader
    // first, then slice order) — a typed "yes" answers stashed[0], and with two companions holding
    // plans the executed command must be the one on the card the player is looking at (2026-07-25
    // playtest: a card reading "get inside Vellmere" executed a different leader's stale move).
    const leaderId = partyLeaderOf(ctx.model.modules);
    const ids = Object.keys(autonomy);
    const ordered = leaderId && ids.includes(leaderId) ? [leaderId, ...ids.filter((id) => id !== leaderId)] : ids;
    for (const id of ordered) {
      const a = autonomy[id]!;
      if (a.pendingProposal) {
        stash.push({
          npcId: id,
          text: a.pendingProposal.text ?? "",
          commands: a.pendingProposal.commands,
          originLocationId: a.pendingProposal.originLocationId,
        });
        patch[id] = stripProposal(a);
      }
    }
    if (stash.length > 0) ctx.data.pendingProposals = stash;
    if (Object.keys(patch).length > 0) {
      ctx.applySilent({ type: "modulePatch", module: "autonomy", patch });
    }
  }

  /**
   * Has this leader waited long enough since its last proposal to arm another?
   *
   * Measured on the campaign CLOCK, which only advances on player turns — so the pause is a fixed
   * number of the player's own beats no matter how long the model takes to produce them. The legacy
   * wall-clock stamp is still consulted as a floor for saves written before `lastProposedClock`
   * existed, so a resumed campaign cannot suddenly re-propose on the very next beat.
   */
  private proposalCooledDown(ctx: TickContext, npcId: string, template?: { autonomy: { heartbeatSeconds: number } }): boolean {
    const a = autonomyOf(ctx.model)[npcId];
    if (a?.lastProposedClock !== undefined) {
      return ctx.model.clock - a.lastProposedClock >= PROPOSAL_COOLDOWN_MINUTES;
    }
    const heartbeatMs = (template?.autonomy.heartbeatSeconds ?? 40) * 1000;
    return nowOf(ctx) - (a?.lastProposedAt ?? 0) >= PROPOSAL_COOLDOWN_BEATS * heartbeatMs;
  }

  /**
   * Whether this companion may lead the party right now: authored as a `canLead` leader, OR
   * appointed as the party's leader through the party slice (Phase 2 — `setPartyLeader`). The
   * appointment grants nothing beyond the leader role: no disposition change, no new powers —
   * proposals still flow through the same NpcProposal/tacit-consent machinery and gates.
   */
  private canLeadNow(ctx: TickContext, npcId: string): boolean {
    // Leading the PARTY requires actually BEING in the party. An authored `canLead` NPC may exist as
    // a non-party rival until recruited; before that its heartbeat must never move or propose for the
    // player's party (`moveParty` would drag everyone without consent, and a frontier proposal could
    // soft-lock them). Once recruited it becomes a party member and leads normally. The appointed
    // leader (`setPartyLeader`) is a party member by construction; this guard also correctly drops one
    // who has since left. Co-location follows: `moveParty` only moves party members at party location.
    if (ctx.model.entities.get(npcId)?.partyMember !== true) return false;
    const template = this.world.npcs.find((n) => n.id === npcId);
    if (template?.autonomy.level === "leader" && template.autonomy.canLead === true) return true;
    return partyLeaderOf(ctx.model.modules) === npcId;
  }

  /**
   * If the heartbeating leader has a proposal whose beat has elapsed, act on it (tacit consent)
   * and clear it. Only a leading companion's proposal (authored `canLead` leader or the appointed
   * party leader) ever auto-executes.
   */
  private consumeExpiredProposal(ctx: TickContext, npcId: string): void {
    if (!this.canLeadNow(ctx, npcId)) return;
    // A downed leader cannot enact a plan — a proposal armed before it fell must not tacit-consent
    // execute while it lies unconscious (mirrors the `eligible` consciousness gate; audit #5).
    if (!isConscious(ctx.model.entities.get(npcId))) return;
    const a = autonomyOf(ctx.model)[npcId];
    const proposal = a?.pendingProposal;
    if (!a || !proposal) return;
    if (nowOf(ctx) < proposal.expiresAt) return;
    const heartbeatMs = (this.world.npcs.find((n) => n.id === npcId)?.autonomy.heartbeatSeconds ?? 40) * 1000;
    // COMPOSING HOLD: tacit consent means "no objection", and someone mid-sentence is objecting — they
    // just haven't finished saying so. The 2026-07-24 playtest watched "Meeting no objection, Oda
    // follows through" resolve the scene while the player was still typing an answer to it. Push the
    // deadline out a beat and let them finish; the world keeps ticking around them either way.
    if (ctx.services.isComposing?.()) {
      ctx.applySilent({
        type: "modulePatch",
        module: "autonomy",
        patch: { [npcId]: { ...a, pendingProposal: { ...proposal, expiresAt: nowOf(ctx) + heartbeatMs } } },
      });
      ctx.data.persist = true;
      return;
    }
    // The deadline is WALL-CLOCK. Autonomy pauses at zero viewers, so while the player is away no tick
    // advances the world but real time keeps passing — the deadline can lapse mid-absence. If it lapsed
    // by MORE than a full heartbeat interval, treat this first tick back as a returning player and give
    // ONE fresh interval to react rather than tacit-consenting on the very tick they reconnected. Normal
    // in-session elapse (gap ~0, the tick that fires right at the deadline) falls through and executes (audit #10).
    if (nowOf(ctx) - proposal.expiresAt > heartbeatMs) {
      ctx.applySilent({
        type: "modulePatch",
        module: "autonomy",
        patch: { [npcId]: { ...a, pendingProposal: { ...proposal, expiresAt: nowOf(ctx) + heartbeatMs } } },
      });
      ctx.data.persist = true;
      return;
    }
    const leaderName = ctx.model.entities.get(npcId)?.name ?? this.world.npcs.find((n) => n.id === npcId)?.name ?? npcId;
    const plan = proposal.text ? `"${proposal.text}"` : "the plan";
    // The proposal resolves this tick either way — strip it now so a later heartbeat can't re-consume it.
    ctx.applySilent({ type: "modulePatch", module: "autonomy", patch: { [npcId]: stripProposal(a) } });
    ctx.data.persist = true;
    // CONSENT GATE (`./consent.ts`; playtest r9 F-1, generalizing the 2026-07-25 movement ban).
    // Silence is not consent. A plan that would move the party, spend the player's things, or
    // commit them to a job needs an actual answer — the accept path executes it whole on an
    // explicit "yes"; unanswered, it narrates a nudge and dies here. Only a plan scoped to the
    // leader's OWN business (its gear, its stamina, a door it can open, its own property) enacts
    // on a quiet table. The allowlist defaults to asking, so a verb added to grounding later can
    // never inherit auto-execution by omission — which is exactly how `take_job` slipped past the
    // movement ban and took a contract nobody answered.
    const block = consentBlockInPlan(proposal.commands, { actorId: npcId, path: "tacit", model: ctx.model });
    if (block) {
      this.recordConsentBlock(npcId, block, "tacit");
      const subject = block.reason === "movement" ? `${leaderName}'s plan to move on` : `${leaderName}'s plan`;
      ctx.data.narration = {
        trigger: `${subject} — ${plan} — waits on your word; with no answer given, ${leaderName} lets it rest for now.`,
      };
      return;
    }
    // A plan grounded at another location is stale: its commands were aimed at a room the party
    // has since left. Refuse rather than fire them against the wrong backdrop.
    if (proposal.originLocationId !== undefined && partyLocationOf(ctx.model) !== proposal.originLocationId) {
      ctx.data.narration = {
        trigger: `${leaderName} lets ${plan} drop — it was made for somewhere you've since left.`,
      };
      return;
    }
    // Dry-run the rest — a plan whose way is no longer open narrates "comes to nothing" instead of
    // a phantom success (mirrors the player accept branch in resolvePlayer). A pure-suggestion
    // proposal (no commands) just narrates the beat.
    const executable = proposal.commands.length > 0 && proposal.commands.every((c) => !ctx.dryRun(c).rejected);
    if (proposal.commands.length > 0 && !executable) {
      ctx.data.narration = {
        trigger: `${leaderName} moves to follow through on ${plan}, but it comes to nothing — the way it hinged on is no longer open.`,
      };
      return;
    }
    for (const cmd of proposal.commands) ctx.enqueue(cmd);
    ctx.data.narration = {
      trigger: `Meeting no objection, ${leaderName} follows through on ${plan}.`,
    };
  }

  // --- react: choose who (if anyone) acts; queue intents for narrate ---------

  private onReact(ctx: TickContext): void {
    // A GROUNDED UI action (a clicked accept-quest / buy / equip / rest…) arrives as a player tick
    // carrying a pre-built `trigger.plan`; a freeform TYPED line does not (it is classified mid-tick).
    // Such a mechanical action is not a conversational stimulus, yet `ctx.recent` still holds the
    // player's LAST spoken line — so letting a world NPC take its spontaneous Stage-3 beat here made it
    // re-answer that stale question right after e.g. "Quest accepted" (the duplicate-reply bug). Gate
    // the world beat off grounded ticks; a companion's directed reactions (reactPlayer, driven by
    // ctx.data.dialogue which these never set) already no-op, so mechanical turns stay quiet unless a
    // real in-world beat warrants otherwise.
    const groundedAction = ctx.trigger.kind === "player" && ctx.trigger.plan != null;
    // Heartbeat ⇒ a companion's spontaneous (C) beat. Player tick ⇒ a companion's reactive (B) chime
    // WINS; only if none fires may ONE present non-party world NPC take a single bounded beat (Stage
    // 3). The `??` short-circuit is the priority guarantee: reactWorldNpc never even runs (never draws
    // rng, never picks) when a companion reacted, so autonomous output stays capped at ≤1 beat/tick.
    const item =
      ctx.trigger.kind === "heartbeat"
        ? this.reactHeartbeat(ctx)
        : (this.reactPlayer(ctx) ?? (groundedAction ? null : this.reactWorldNpc(ctx)));
    if (!item) return;
    this.acquireLock(ctx, item.npcId);
    const queue = (ctx.data.autonomyDialogue as AutonomyDialogueItem[] | undefined) ?? [];
    queue.push(item);
    ctx.data.autonomyDialogue = queue;
  }

  /** Priority C: a single idle proactive/leader companion may self-initiate on its heartbeat. */
  private reactHeartbeat(ctx: TickContext): AutonomyDialogueItem | null {
    const npcId = ctx.trigger.kind === "heartbeat" ? ctx.trigger.npcId : "";
    if (!this.npcs.has(npcId)) return null;
    const template = this.world.npcs.find((n) => n.id === npcId);
    const level = template?.autonomy.level;
    // An appointed party leader (slice) self-initiates like an authored leader, whatever its
    // authored level — leading IS the license to speak up on a quiet beat.
    if (level !== "proactive" && level !== "leader" && !this.canLeadNow(ctx, npcId)) return null;
    // Never self-initiate while this NPC's own proposal is still pending: the beat belongs to the
    // standing question, not a new one. This is what kills duplicate proposals — and, since a new
    // emit no longer slides the expiry forward, what lets tacit consent (consumeExpiredProposal in
    // perceive, which strips the proposal before react runs) actually fire on a later quiet beat.
    if (autonomyOf(ctx.model)[npcId]?.pendingProposal) return null;
    if (!this.eligible(ctx, npcId)) return null;

    const depth = autonomyOf(ctx.model)[npcId]?.replyDepth ?? 0;
    // IDLE BUDGET (playtest r9 F-12): a quiet-beat chain is bounded by a hard cap, not only the
    // probabilistic decay. Decay never STOPS a chain before depth 6 — a failed roll just skips one
    // heartbeat and re-rolls 40s later — so an idle player watched five long re-stagings of the
    // same props (strongbox/brazier/pallet) queue ahead of their own input, each a full narrator
    // call. Two unprompted beats say everything a scene needs; past that the NPC holds its peace
    // until the player speaks (any player input resets replyDepth to 0).
    if (depth >= HEARTBEAT_QUIET_CAP) return null;
    const alpha = template?.autonomy.replyDecayAlpha ?? DEFAULT_ALPHA;
    if (!shouldContinueReply(depth, alpha, this.rng)) return null;

    return { npcId, stimulus: this.idleStimulus(ctx, npcId), replyDepth: depth, priority: "C" };
  }

  /** Priority B: after the player addresses a companion, a *second* present companion may react. */
  private reactPlayer(ctx: TickContext): AutonomyDialogueItem | null {
    const dialogue = ctx.data.dialogue as
      | { npcId: string; playerLine: string; channel?: "private" }
      | undefined;
    if (!dialogue) return null; // B only fires when the player addressed a companion
    // A PRIVATE line (Phase 6) is inaudible to bystanders: no second companion may react to (or
    // quote) an aside it never heard, and reply-focus arbitration must not run over it at all.
    if (dialogue.channel === "private") return null;
    const addressedId = dialogue.npcId;

    const playerId = playerEntity(ctx.model)?.id ?? "pc.you";
    const loc = partyLocationOf(ctx.model);
    if (loc === null) return null;

    // Eligible reactors: present companions, not the addressed one, reactive+ and not busy.
    const eligible: string[] = [];
    for (const e of entitiesAt(ctx.model, loc)) {
      if (e.id === addressedId || !this.npcs.has(e.id)) continue;
      const lvl = this.world.npcs.find((n) => n.id === e.id)?.autonomy.level;
      if (lvl !== "reactive" && lvl !== "proactive" && lvl !== "leader") continue;
      if (this.eligible(ctx, e.id)) eligible.push(e.id);
    }
    if (eligible.length === 0) return null;

    // Reply-focus: the addressed companion's closest ally chimes in alongside them.
    const relMap = Object.fromEntries(ctx.model.relationships.get(addressedId) ?? new Map());
    const reactorId = pickReplyTarget(eligible, relMap, this.rng) ?? eligible[0];
    if (!reactorId) return null;

    // Don't let every address trigger a chime-in. Gate priority-B on a probability that rises with
    // the reactor's regard for the addressed companion — bystanders mostly stay quiet, close allies
    // often speak up. This is what tames B-spam (the first reaction isn't bounded by reply decay).
    const affinity = Math.max(0, ctx.model.relationships.get(reactorId)?.get(addressedId) ?? 0);
    const chance = Math.min(0.9, B_REACTION_CHANCE + affinity / 300);
    if (this.rng() >= chance) return null;

    const depth = autonomyOf(ctx.model)[reactorId]?.replyDepth ?? 0;
    const alpha = this.world.npcs.find((n) => n.id === reactorId)?.autonomy.replyDecayAlpha ?? DEFAULT_ALPHA;
    if (!shouldContinueReply(depth, alpha, this.rng)) return null;

    const stimulus = `${this.nameOf(ctx, playerId)} just said to ${this.nameOf(ctx, addressedId)}: "${dialogue.playerLine}"`;
    return { npcId: reactorId, stimulus, replyDepth: depth, priority: "B" };
  }

  /**
   * Stage 3 — a single PRESENT NON-PARTY world NPC may take one bounded autonomous beat on a player
   * tick, but ONLY when no companion reacted (this method is called after `reactPlayer` returns
   * null). Player-tick-scoped by construction: it never runs off-screen, never registers a heartbeat,
   * and caps at ≤1 world beat per tick (one candidate, gated by cooldown + a low probability). Only
   * `proactive`/`leader`-authored present NPCs qualify — a reactive/passive local stays quiet unless
   * the player addresses it (that path is the dialogue module's, untouched here).
   */
  private reactWorldNpc(ctx: TickContext): AutonomyDialogueItem | null {
    // A live scene is already suppressed at the top of onReact; combat is the other hard mute — a
    // present shopkeeper does not banter mid-brawl (heartbeats are stopped in combat, but a player
    // tick still runs react, so guard it here explicitly).
    if (isCombatActive(ctx.model)) return null;
    const loc = partyLocationOf(ctx.model);
    if (loc === null) return null;

    // Candidates: present NPCs, NOT in the party, whose authored autonomy invites initiative, not
    // turned hostile, and past their own talk-lock/world-cooldown gate.
    const candidates: string[] = [];
    for (const e of entitiesAt(ctx.model, loc)) {
      if (e.kind !== "npc" || e.partyMember) continue;
      const level = this.world.npcs.find((n) => n.id === (e.templateId ?? e.id))?.autonomy.level;
      if (level !== "proactive" && level !== "leader") continue;
      if (isPartyHostile(ctx.model, e.id)) continue;
      if (!this.eligibleWorld(ctx, e.id)) continue;
      candidates.push(e.id);
    }
    if (candidates.length === 0) return null;

    // Pick ONE deterministically (seeded), then a low probability gate so most turns stay quiet.
    // Draw the pick FIRST, always, so the seeded stream is stable regardless of the chance outcome.
    const npcId = candidates[Math.floor(this.rng() * candidates.length)] ?? candidates[0]!;
    if (this.rng() >= WORLD_NPC_CHANCE) return null;

    return { npcId, stimulus: this.worldStimulus(ctx, npcId), replyDepth: 0, priority: "C", world: true };
  }

  // --- narrate: realize queued intents (decide → ground → emit) --------------

  private async onNarrate(ctx: TickContext): Promise<void> {
    const queue = (ctx.data.autonomyDialogue as AutonomyDialogueItem[] | undefined) ?? [];
    for (const item of queue) await this.realize(ctx, item);
  }

  /** Run one queued intent end-to-end, always releasing the talk-lock (success OR error). */
  private async realize(ctx: TickContext, item: AutonomyDialogueItem): Promise<void> {
    // Stage 3: a companion resolves through `this.npcs`; a present non-party world NPC through the
    // module-side agent cache/factory. Either way it decides through the SAME NpcAgent pipeline.
    const agent = this.agentFor(item.npcId);
    if (!agent) return;
    try {
      const template = this.world.npcs.find((n) => n.id === item.npcId);
      // A WORLD beat never drives agenda pressure: exploitation/agenda already own the present-NPC path
      // (planAgendaAction), and a world beat must not double-drive it. Companions keep the C path.
      const agendaAction =
        template && item.priority === "C" && !item.world
          ? this.planAgendaAction(ctx, template, item.npcId)
          : null;
      // Code-owned case knowledge (mystery wave) — this NPC's facts/beliefs as `# THE CASE AS YOU
      // KNOW IT`. Also closes the old gap that the autonomous decide path was lore-less. Empty ⇒
      // npc.ts omits the block (byte-identical decide prompt for an NPC with no case stake).
      const caseFile = caseBriefForNpc(ctx.services.campaign, ctx.state(), item.npcId);
      // Derived per-person conversation history (best-effort cache) — continuity, never truth.
      const historyBlock = renderHistoryBlock(ctx.services.npcHistory?.get(item.npcId));
      // Mystery wave — proactive collaboration: the ONE case fact this NPC volunteers this beat (null
      // when nothing is shareable, its cooldown is unspent, or it is busy pressing an agenda). The
      // idle/world stimulus already carries the matching `situationHint` nudge naming this fact; we
      // hold the pick here so a delivered SPOKEN beat mints the code-owned reveal below.
      const share = agendaAction
        ? null
        : planCaseShare(ctx.services.campaign, ctx.state(), item.npcId, ctx.model.clock);
      // Feature 1: a LEADER grounds a move into `moveParty` and may take up an on-offer job. The
      // offered-quest list (player-visible names + ids) is supplied so grounding stays pure. Both
      // are resolved BEFORE the model is asked, because the candidate table the NPC picks its act
      // from is the same table grounding looks the act up in — a leader is offered `moveParty`
      // destinations and the jobs on the board; an ordinary companion is offered neither.
      const leadsParty = this.canLeadNow(ctx, item.npcId);
      const offeredQuests = leadsParty
        ? ctx.services.campaign.quests
            .filter((q) => ctx.model.quests.get(q.id) === "offered")
            .map((q) => ({ id: q.id, name: q.name }))
        : undefined;
      // `characters` reaches grounding for exactly one thing: the attire-occupancy baseline an
      // `attireState` barrier condition is judged against (regex audit §10d — without it the
      // barrier seam read a stripped PC as "disheveled" where every other surface said "bare").
      const groundingCtx = { leadsParty, offeredQuests, characters: ctx.services.campaign.characters };
      const intentObj = await agent.decideTurn(ctx.state(), {
        contextText: this.briefFor(ctx, item.npcId),
        stimulus: item.stimulus,
        replyDepth: item.replyDepth,
        agendaDirective: agendaAction?.action.directive,
        relationship: this.relationshipLineFor(ctx, item.npcId),
        // Recalled memory (M4 Part B): the NPC's recent journal beats, read-only off the slice.
        // Empty ⇒ npc.ts omits the `# YOU REMEMBER` block (byte-identical decide prompt).
        memory: renderRecall(ctx.model, item.npcId, undefined, ctx.services.world),
        // Derived per-person history (epistemic plan §12.2): the same continuity-only block the
        // reply path carries, so an autonomous beat remembers the conversation it grew out of.
        // NEVER authoritative truth — a derived cache; omit-when-empty (byte-identical prompt).
        ...(historyBlock.length > 0 ? { history: historyBlock } : {}),
        ...(caseFile.length > 0 ? { caseFile } : {}),
        // The closed act table (r8): everything this NPC may legally do from where it stands, as
        // `# CANDIDATE ACTIONS`. The model may only NAME one of these; `groundToCommand` looks the
        // named act back up in the SAME table, so an id that was never offered can never mutate the
        // world. Empty ⇒ npc.ts omits the block (byte-identical prompt for an affordance-less scene).
        actCandidates: renderActCandidates(actCandidates(item.npcId, ctx.model, this.world, groundingCtx)),
      });
      // The clean words the NPC says (display + beats). The world act it attempts is now a separate,
      // CLOSED field — never inferred from this prose. (It used to be: grounding keyword-scored a
      // splice of the free-text `command` + `visibleAction` + `visibleSpeech`, so the confidence of
      // a real plan was diluted by the sentence around it — the dilution that forced the proposal
      // gate open into a `priority === "C"` catch-all and minted AGREE/DECLINE cards with no commands
      // behind them, 2026-07-24 playtest P2. See src/rules/npc-act.ts.)
      const spoken = spokenLineOf(intentObj.visibleSpeech);
      const facts = intentObj.factsAsserted && intentObj.factsAsserted.length > 0 ? intentObj.factsAsserted : undefined;

      if (agendaAction) {
        // Display surface: the emitted line is the clean spoken words. Mechanics ride the action.
        this.emitAgendaAction(
          ctx,
          item.npcId,
          spoken,
          agendaAction.action,
          agendaAction.discreet,
          agendaAction.modifiers,
        );
        ctx.data.persist = true;
        return;
      }

      // A gateway block/outage is real silence, not the literal action "observe quietly" and not an
      // empty beat for the GM to turn into "acted". Release bookkeeping in `finally`, but expose no
      // invented character choice to the player. (A beat carrying ONLY a named act is not silence —
      // the NPC does the thing wordlessly.)
      if (!spoken.trim() && !intentObj.visibleAction?.trim() && !intentObj.desiredAct) {
        ctx.data.persist = true;
        return;
      }

      // PROSE-TO-CODE §2.1 — a beat that PRICES a ware aloud (a hawker calling out a lantern) binds
      // the same scene-scoped offer the reply path binds, so the counter honours the fiction whether
      // the vendor was answering the player or working the crowd. Self-reported, reducer-written.
      const beatLoc = ctx.model.entities.get(item.npcId)?.locationId;
      if (intentObj.offers && intentObj.offers.length > 0 && beatLoc) {
        ctx.applySilent({
          type: "modulePatch",
          ...offersPatch(ctx.model.modules, item.npcId, intentObj.offers, beatLoc, ctx.model.clock),
        });
      }

      // Ground the named act ONCE up front — the single grounding call per realize, reused by both
      // the proposal and the direct-act branches. A table lookup over the SAME candidates the NPC
      // chose from; the DISPLAYED line is the clean spoken words.
      const ground = groundToCommand(item.npcId, intentObj.desiredAct, ctx.model, this.world, groundingCtx);

      // Only a leading companion (authored `canLead` leader or the appointed party leader) issues
      // executable party-level proposals, and ONLY when its line GROUNDS TO A CONCRETE WORLD MOVE —
      // the grounding oracle (the same source of truth that decides whether the line is executable at
      // all) IS the "reads like a plan" test, replacing the old brittle keyword net: a proposal only
      // has teeth when there's a real command to auto-execute on tacit consent, so a leader's
      // pure-speech reaction stays plain dialogue. A non-leader's "let's go" is just spoken.
      //
      // That last sentence used to be a lie. The gate carried an `item.priority === "C"` disjunct, and
      // `reactHeartbeat` builds EVERY spontaneous beat with priority "C" — so it was always true on a
      // heartbeat and short-circuited the grounding test entirely. Every quiet-beat line a leading
      // companion said became an AGREE/DECLINE card with `commands: []` behind it: the 2026-07-24
      // playtest got three consecutive "be careful" proposals mid-march and three more while shopping.
      // Advice is dialogue. A card is for a plan.
      //
      // Proposal cooldown: within PROPOSAL_COOLDOWN_BEATS *player turns* of the last one the line is
      // demoted to plain dialogue — the leader still speaks, no proposal machinery is re-armed.
      // Default-open: absent counter ⇒ the first proposal fires.
      // A WORLD beat never proposes: a non-party NPC does not lead the table (canLeadNow is already
      // false for one, but an authored present `leader` rival could slip through — guard explicitly).
      const canPropose = !item.world && this.canLeadNow(ctx, item.npcId);
      const cooledDown = this.proposalCooledDown(ctx, item.npcId, template);
      // A `barrierAttempt`/`consumeItem` is a SEEDED direct act the actor takes now, not a party-level
      // suggestion — a proposal only carries `commands`, so routing one through emitProposal would arm
      // a teeth-less no-op (the old dead-barrierAttempt-proposal bug, Feature 1e). Keep them out of the
      // proposal path so they always fall to the direct-act branch below and actually resolve.
      const actsDirect = ground.action.kind === "barrierAttempt" || ground.action.kind === "consumeItem";
      const propose = canPropose && cooledDown && !actsDirect && ground.action.kind === "command";
      // CONSENT GATE on the direct-act branch (`./consent.ts`; playtest r9 F-1). When the proposal
      // path is closed — one already pending, or the cooldown holding — a grounded command used to
      // fall straight through and EXECUTE on a heartbeat, with no card and nothing to answer. The
      // same allowlist tacit consent uses decides here: the NPC's own business enacts, anything
      // that binds the player is held as a spoken nudge and waits for a plan they can answer.
      const directBlock =
        ground.action.kind === "command"
          ? consentBlockFor(ground.action.command, { actorId: item.npcId, path: "direct", model: ctx.model })
          : null;

      // Mystery wave — set when a real spoken line is delivered this beat (not suppressed, not a pure
      // action or a proposal): only then may a proactive `share` mint its code-owned reveal below.
      let didSpeak = false;
      if (propose) {
        // Pass the CLEAN spoken line. A proposal is player-facing dialogue; when grounding scored a
        // keyword-rich splice of command + staging + speech, feeding that combined string to
        // emitProposal surfaced "move to the forge. walks toward the gate. Let's go." as the NPC's
        // words (spokenLineOf can't recover just the speech from it).
        this.emitProposal(ctx, item.npcId, ground, spoken, template);
      } else {
        this.recordGroundingFallback(item.npcId, ground, intentObj.desiredAct);
        if (ground.action.kind === "barrierAttempt") {
          // Stage 2b: a pick/force is a SEEDED skill check, not a free reducer command — resolve the
          // roll (code, never the model) and, on success, enqueue the setExitState it earns.
          this.emitBarrierAttempt(ctx, item.npcId, ground.action, spoken, facts);
        } else if (ground.action.kind === "consumeItem") {
          // Feature 1d: the NPC quaffs/eats a consumable it owns — a seeded heal roll + the consume
          // transfer, resolved in the module (mirrors emitBarrierAttempt; the PC-coupled resolveItemAction
          // is untouched).
          this.emitItemUse(ctx, item.npcId, ground.action.itemId, spoken, facts);
        } else if (ground.action.kind === "speak") {
          // The displayed line is ALWAYS the clean spoken words (`spokenLineOf(visibleSpeech)`).
          // The speak fallback deliberately carries no text of its own: when it did, it held the
          // keyword-rich `command. action. speech` splice grounding scored on, and spokenLineOf
          // couldn't recover just the speech from it (no quote delimiters) — the whole splice was
          // spoken verbatim ("move to the Long Hall by Eastgate. I gesture… Long Hall's that way…",
          // live 07-19). An empty `spoken` means the intent was staging-only (no words) — say
          // nothing rather than narrate staging.
          const line = spoken;
          // Verbatim-repeat guard (W6): a pure spoken line that only restates what this NPC just
          // said is suppressed to a "says nothing" beat — no re-decide, no looped words.
          if (!line.trim() || isRecentDuplicate(ctx.model.modules, item.npcId, line)) {
            this.emitSaysNothing(ctx, item.npcId);
          } else {
            // No raw bubble — the DM delivers this NPC's words as staged prose from the beat below.
            recordNpcBeat(ctx.data, {
              actorId: item.npcId,
              name: this.nameOf(ctx, item.npcId),
              dialogue: line,
              ...(intentObj.lines && intentObj.lines.length > 0 ? { lines: intentObj.lines } : {}),
              accepted: true, // a pure spoken beat enqueues no command
              ...(facts ? { factsAsserted: facts } : {}),
            });
            this.recordUtterance(ctx, item.npcId, line);
            if (facts) ctx.services.disclosure?.record(item.npcId, facts);
            didSpeak = true;
          }
        } else if (directBlock) {
          // Held for the player's word (see `directBlock` above). The r9 run watched this branch
          // relocate the party twice and auto-complete a quest objective while the player idled;
          // a leader's urge without consent is a nudge, never the act. Speak the line (if fresh)
          // and let the standing plan wait for an answer.
          this.recordConsentBlock(item.npcId, directBlock, "direct");
          const line = spoken;
          const repeat = line.trim().length > 0 && isRecentDuplicate(ctx.model.modules, item.npcId, line);
          if (line.trim() && !repeat) {
            recordNpcBeat(ctx.data, {
              actorId: item.npcId,
              name: this.nameOf(ctx, item.npcId),
              dialogue: line,
              ...(intentObj.lines && intentObj.lines.length > 0 ? { lines: intentObj.lines } : {}),
              accepted: true, // the urge is delivered as words; no command is enqueued
              ...(facts ? { factsAsserted: facts } : {}),
            });
            this.recordUtterance(ctx, item.npcId, line);
            if (facts) ctx.services.disclosure?.record(item.npcId, facts);
            didSpeak = true;
          } else {
            this.emitSaysNothing(ctx, item.npcId);
          }
        } else {
          ctx.enqueue(ground.action.command);
          // Validate the grounded command against a model CLONE — the accepted/rejected oracle for the
          // signed TurnOutcome. The command still applies for real at commit (one-writer); the verdict
          // only tells the GM whether it will land, so it never narrates a rejected move as success.
          const verdict = ctx.dryRun(ground.action.command);
          // Surface the clean spoken words that motivated the action (a verbatim repeat drops only the
          // words; the move still happens). An action-only beat with no words emits no dialogue.
          const line = spoken;
          const repeat = line.trim().length > 0 && isRecentDuplicate(ctx.model.modules, item.npcId, line);
          // No raw bubble — the DM delivers the words + staging as prose from the beat below. Still
          // record the spoken line for the verbatim-repeat guard so the NPC won't loop it next turn.
          if (line.trim() && !repeat) {
            this.recordUtterance(ctx, item.npcId, line);
          }
          recordNpcBeat(ctx.data, {
            actorId: item.npcId,
            name: this.nameOf(ctx, item.npcId),
            ...(!repeat && line.trim() ? { dialogue: line } : {}),
            ...(!repeat && line.trim() && intentObj.lines && intentObj.lines.length > 0 ? { lines: intentObj.lines } : {}),
            action: summarizeCommand(ground.action.command, ctx, this.world),
            accepted: !verdict.rejected,
            ...(verdict.rejected ? { rejectedReason: verdict.rejected.reason } : {}),
            ...(facts ? { factsAsserted: facts } : {}),
          });
          if (facts) ctx.services.disclosure?.record(item.npcId, facts);
          didSpeak = line.trim().length > 0 && !repeat;
        }
      }
      // Mystery wave — a spoken beat carried the proactive share: mint the code-owned reveal (the
      // player + present NPCs learn the fact) and stamp the share cooldown. Enqueued through the same
      // commit chokepoint as every other grounded command (one writer, replay-safe).
      if (share && didSpeak) this.enqueueCaseShare(ctx, item.npcId, share);
      ctx.data.persist = true;
    } catch (err) {
      console.error("Autonomous NPC realization failed", err);
      ctx.emit({
        kind: "system",
        level: "warn",
        message: `${this.nameOf(ctx, item.npcId)}'s action could not be resolved.`,
      });
    } finally {
      // Release the talk-lock, advance reply-chain depth, and stamp the dedup clock — whether the
      // line landed or errored, so a broken gateway can't leave an NPC stuck "talking".
      this.releaseLock(ctx, item.npcId);
    }
  }

  /**
   * Plan this NPC's autonomous agenda move, plus whether the line stays DISCREET (Phase 6). The
   * discretion rule is deliberately simple and code-owned: an agenda line targeting the PC alone
   * goes private when (a) the NPC's stance toward the PC is `exploitative` — concealed manipulation
   * belongs in an aside —
   * or (b) the PC has a standing private thread with this NPC (a recorded whisper steer): an
   * opened private channel keeps carrying the NPC's PC-directed moves. Everything else stays
   * public, byte-identical to before the channel existed.
   */
  private planAgendaAction(
    ctx: TickContext,
    template: NonNullable<World["npcs"][number]>,
    npcId: string,
  ): { action: AgendaAction; discreet: boolean; modifiers?: SocialModifier[] } | null {
    const targetId = agendaTarget(ctx.model);
    if (!targetId) return null;
    // Pass the campaign so the appearance/identity read (Workstream F) can gate a PC target's minor
    // status from the sheet; the returned stance already folded any modifiers into its intensity.
    const s = stance(template, targetId, ctx.model, this.world, ctx.services.campaign);
    // Feature 3 — a LEADER may proactively DISCIPLINE the player. Corporal discipline (a genuinely
    // cruel, grievance-fed leader) is chosen first; anything short of it falls through to the ordinary
    // social press below.
    let action: AgendaAction | null = null;
    if (this.canLeadNow(ctx, npcId)) {
      const grievance = decayedGrievance(autonomyOf(ctx.model)[npcId], nowOf(ctx));
      action = chooseLeaderDiscipline(template, s, grievance, ctx.model, this.world);
    }
    action ??= chooseAgendaAction(template, s, ctx.model, this.world);
    if (!action) return null;
    if (action.kind === "demand" || action.kind === "pressure") {
      if (this.pendingAgendaPressures.has(action.targetId)) return null;
      // Pressure pacing (mirrors the proposal cooldown): within PRESSURE_COOLDOWN_BEATS of the
      // last armed demand/pressure this NPC gets no new one — its beat stays plain dialogue.
      // Default-open: `lastPressedAt` absent ⇒ 0 ⇒ the first press always fires.
      const heartbeatMs = template.autonomy.heartbeatSeconds * 1000;
      const lastPressedAt = autonomyOf(ctx.model)[npcId]?.lastPressedAt ?? 0;
      if (nowOf(ctx) - lastPressedAt < PRESSURE_COOLDOWN_BEATS * heartbeatMs) return null;
    }
    const pcId = playerEntity(ctx.model)?.id;
    const discreet =
      pcId !== undefined &&
      action.targetId === pcId &&
      (s.disposition === "exploitative" || whisperSteerOf(ctx.model.modules, npcId) !== undefined);
    return { action, discreet, modifiers: s.socialContext?.modifiers };
  }

  private emitAgendaAction(
    ctx: TickContext,
    npcId: string,
    intentText: string,
    action: AgendaAction,
    discreet: boolean,
    modifiers?: SocialModifier[],
  ): void {
    // Workstream F: when the chosen agenda move rode a stance with a non-empty appearance/identity
    // read, surface the one-line summary two ways. Both are derived, never world state, never a delta.
    if (modifiers && modifiers.length > 0) {
      const summary = summarizeModifiers(modifiers);
      // (a) The per-turn scratch → the Observatory Turns trace (best-effort, wrapped so it never throws).
      try {
        const store = turnContext.getStore();
        if (store) {
          (store.socialModifiers ??= []).push({ actorId: npcId, targetId: action.targetId, summary });
        }
      } catch {
        // telemetry is best-effort; never break the tick
      }
      // (b) The tick's `ctx.data` → the GM's last-word brief as a TONE-ONLY cue (Workstream F follow-up).
      // Only the narration module reads it, so it colors the GM's prose without reaching NPC decide
      // briefs; omitted from the brief when empty, so a no-read turn stays byte-identical.
      recordSocialRead(ctx.data, {
        actor: this.nameOf(ctx, npcId),
        target: this.nameOf(ctx, action.targetId),
        summary,
      });
    }
    // Verbatim-repeat guard (W6): dedup only the WORDS. The agenda MECHANICS (pressure, resist
    // rolls, help/manipulate command) always fire below regardless — the channel/rules never
    // change; a repeated line just falls silent so the NPC doesn't loop the same demand aloud.
    const repeat = isRecentDuplicate(ctx.model.modules, npcId, intentText);
    if (repeat) {
      this.emitSaysNothing(ctx, npcId);
    } else {
      // A DISCREET line is a private aside to its target — it still emits its own verbatim whisper
      // bubble (unheard by others). A
      // PUBLIC agenda move no longer emits a bubble: the DM delivers its words as staged prose from
      // the weave block. Either way the mechanics it parks (pressure, resist rolls) fire below.
      if (discreet) {
        ctx.emit({
          kind: "dialogue",
          actorId: npcId,
          text: intentText,
          toId: action.targetId,
          channel: "private" as const,
        });
      }
      this.recordUtterance(ctx, npcId, intentText);
      if (!discreet) {
        recordNpcBeat(ctx.data, {
          actorId: npcId,
          name: this.nameOf(ctx, npcId),
          dialogue: intentText,
          action: action.summary,
        });
      }
    }
    if (action.kind === "help" || action.kind === "manipulate") {
      ctx.enqueue(action.command);
      return;
    }

    this.pendingAgendaPressures.set(action.targetId, {
      npcId,
      targetId: action.targetId,
      actionKind: action.kind,
      summary: action.summary,
      directive: action.directive,
      consequence: action.consequence,
      resist: action.resist,
    });

    // Stamp the pressure-cooldown clock where the pressure is ARMED (same modulePatch idiom as
    // releaseLock/emitProposal, so replayed saves fold to the identical runtime).
    const a = autonomyOf(ctx.model)[npcId] ?? { talking: false, replyDepth: 0, lastActedAt: 0 };
    ctx.applySilent({
      type: "modulePatch",
      module: "autonomy",
      patch: { [npcId]: { ...a, lastPressedAt: nowOf(ctx) } },
    });
  }

  /** A leader's party-level proposal: a first-class event + a pending action on tacit consent. */
  private emitProposal(
    ctx: TickContext,
    npcId: string,
    ground: GroundingResult,
    spokenText: string,
    template: { autonomy: { heartbeatSeconds: number } } | undefined,
  ): void {
    // The intent was already grounded by the caller (one grounding call per realize) into the action
    // this proposal would take, so tacit consent can execute it. If it didn't ground to a concrete
    // world move, the proposal is a pure suggestion (no commands). Every PLAYER-FACING surface — the
    // proposal event and the stored text the accept narration echoes — carries only the CLEAN spoken
    // line the caller passed (re-run through spokenLineOf defensively): a proposal is dialogue, not
    // stage direction, and never the keyword-rich grounding string.
    const commands: Command[] = ground.action.kind === "command" ? [ground.action.command] : [];
    const line = spokenLineOf(spokenText);
    // Tacit consent must outlast the player READING the proposal and typing an answer. One heartbeat
    // (40s) was shorter than a single narrated turn on a reasoning model, so "Meeting no objection,
    // Oda follows through" landed while the 2026-07-24 playtester was still composing a reply. The
    // composing hold below stops the clock entirely while they type; this widens the window for the
    // ordinary case of simply thinking about it.
    const expiresInMs = (template?.autonomy.heartbeatSeconds ?? 40) * 1000 * PROPOSAL_CONSENT_BEATS;

    ctx.emit({
      kind: "npcProposal",
      actorId: npcId,
      proposal: line,
      options: ["accept", "override", "ignore"],
      expiresInMs,
    });

    const a = autonomyOf(ctx.model)[npcId] ?? { talking: false, replyDepth: 0, lastActedAt: 0 };
    ctx.applySilent({
      type: "modulePatch",
      module: "autonomy",
      patch: {
        [npcId]: {
          ...a,
          // The cooldown stamp (see realize) rides the same modulePatch as the proposal itself,
          // so replayed saves fold to the identical runtime (snapshot == fold(deltas)).
          lastProposedAt: nowOf(ctx),
          lastProposedClock: ctx.model.clock,
          // Origin stamp: the commands bake absolute destinations grounded against THIS location;
          // the accept/consent paths refuse the plan once the party has moved on (see types.ts).
          pendingProposal: {
            commands,
            expiresAt: nowOf(ctx) + expiresInMs,
            text: line,
            originLocationId: partyLocationOf(ctx.model) ?? undefined,
          },
        },
      },
    });
    ctx.data.persist = true;
  }

  /**
   * Resolve a grounded pick/force attempt (Stage 2b) — the marquee NPC mechanic. The ability score
   * comes off the NPC's TEMPLATE stat block (never the live EntityStats; a statless NPC is a flat
   * 10, exactly the player path's sheet-less default). The roll is the seeded `this.rng` so autonomy
   * tests are reproducible. On SUCCESS the way opens ("open" for a pick, "broken" for a force — a
   * forced barrier is permanently, audibly open) via a single `setExitState`; on FAILURE nothing
   * changes and the beat narrates the attempt that didn't land. Mirrors the player's
   * `resolveBarrierCheck` with actor = the NPC, but never touches the PC-coupled engine resolvers.
   */
  private emitBarrierAttempt(
    ctx: TickContext,
    npcId: string,
    action: Extract<GroundedAction, { kind: "barrierAttempt" }>,
    spoken: string,
    facts: string[] | undefined,
  ): void {
    const entity = ctx.model.entities.get(npcId);
    const template = this.world.npcs.find((n) => n.id === (entity?.templateId ?? npcId));
    const abilityScore = template?.stats?.abilities[action.ability] ?? 10;
    const outcome = resolveBarrierAttempt(action, abilityScore, this.rng);
    const name = this.nameOf(ctx, npcId);

    // A trace roll (never a player prompt — the NPC just acts). Same shape the engine emits for the
    // player's barrier check, so the Observatory shows the NPC's attempt identically.
    ctx.emit({
      kind: "diceRolled",
      actorId: npcId,
      notation: "1d20",
      rolls: outcome.result.rolls,
      total: outcome.result.total,
      purpose: `${action.verb === "pick" ? "Pick" : "Force"}: ${action.barrierDesc} (${action.destName}) (DC ${action.dc})`,
      success: outcome.success,
    });

    // The clean spoken words that motivated the attempt, deduped against the verbatim-repeat guard.
    const line = spoken;
    const repeat = line.trim().length > 0 && isRecentDuplicate(ctx.model.modules, npcId, line);
    if (line.trim() && !repeat) this.recordUtterance(ctx, npcId, line);

    if (outcome.success) {
      ctx.enqueue({ type: "setExitState", locationId: action.locationId, to: action.to, state: outcome.state });
      ctx.emit({
        kind: "stateChanged",
        summary:
          action.verb === "pick"
            ? `${name} unlocks the way to ${action.destName}.`
            : `${name} breaks open the way to ${action.destName}.`,
        changes: { locationId: action.locationId, to: action.to, exitState: outcome.state },
      });
      recordNpcBeat(ctx.data, {
        actorId: npcId,
        name,
        ...(!repeat && line.trim() ? { dialogue: line } : {}),
        action:
          action.verb === "pick"
            ? `picks the lock on ${action.barrierDesc} — the way to ${action.destName} opens`
            : `forces ${action.barrierDesc} — the way to ${action.destName} breaks open`,
        accepted: true,
        ...(facts ? { factsAsserted: facts } : {}),
      });
      // Stamp persistence on the successful world change (realize also stamps it below; explicit here
      // to keep the success path self-evidently durable).
      ctx.data.persist = true;
    } else {
      // Failure: no world change. The attempt still HAPPENED — a completed beat that just fell short.
      recordNpcBeat(ctx.data, {
        actorId: npcId,
        name,
        ...(!repeat && line.trim() ? { dialogue: line } : {}),
        action:
          action.verb === "pick"
            ? `works at ${action.barrierDesc}, but the lock holds`
            : `throws a shoulder against ${action.barrierDesc}, but it holds fast`,
        accepted: true,
      });
    }
    if (facts) ctx.services.disclosure?.record(npcId, facts);
  }

  /**
   * Feature 1d — resolve an NPC's use of a consumable it owns (grounding classified `consumeItem`).
   * Mirrors the PC path (`resolveItemAction` "use", engine.ts) for the NPC actor with the seeded
   * `this.rng`, but stays in the autonomy layer — the PC-coupled engine resolver is untouched:
   *   - `properties.heal` (dice string) → seeded roll → `adjustHp` + consume one stack (`transferItem` to null).
   *   - else positive-int `properties.energy` (food/drink) → `adjustEnergy` + consume.
   *   - else no coded effect → a plain "uses it" beat, no mutation.
   * The reducer applies the enqueued commands at commit (one writer); the consume is enqueued after
   * the effect so the same tick sees both.
   */
  private emitItemUse(
    ctx: TickContext,
    npcId: string,
    itemId: string,
    spoken: string,
    facts: string[] | undefined,
  ): void {
    const entity = ctx.model.entities.get(npcId);
    const item = resolveItem(this.world, itemId);
    const name = this.nameOf(ctx, npcId);
    const line = spoken;
    const repeat = line.trim().length > 0 && isRecentDuplicate(ctx.model.modules, npcId, line);
    if (line.trim() && !repeat) this.recordUtterance(ctx, npcId, line);

    // Legality re-check: the item must still be owned (grounding read a snapshot). Missing content or
    // a dropped item degrades to a plain beat, never a crash (the PC path's heal-dice precedent).
    let actionText = `uses the ${item?.name ?? "item"}`;
    if (item && entity?.stats?.inventory.includes(itemId)) {
      const healNotation = typeof item.properties.heal === "string" ? item.properties.heal : null;
      const energyProp = item.properties.energy;
      const energyGain =
        typeof energyProp === "number" && Number.isInteger(energyProp) && energyProp > 0 ? energyProp : null;
      if (healNotation) {
        let healRoll: RollResult | null = null;
        try {
          healRoll = roll(healNotation, this.rng);
        } catch {
          healRoll = null; // malformed authored dice — narrate, no numbers
        }
        if (healRoll) {
          ctx.enqueue({ type: "adjustHp", entityId: npcId, by: healRoll.total });
          ctx.enqueue({ type: "transferItem", itemId, from: npcId, to: null });
          ctx.emit({
            kind: "diceRolled",
            actorId: npcId,
            notation: healNotation,
            rolls: healRoll.rolls,
            total: healRoll.total,
            purpose: `${item.name} — healing`,
          });
          actionText = `drinks the ${item.name}, mending ${healRoll.total} points of hurt`;
        }
      } else if (energyGain !== null) {
        ctx.enqueue({ type: "adjustEnergy", entityId: npcId, by: energyGain });
        ctx.enqueue({ type: "transferItem", itemId, from: npcId, to: null });
        actionText = `consumes the ${item.name} and takes back some strength`;
      }
    }

    recordNpcBeat(ctx.data, {
      actorId: npcId,
      name,
      ...(!repeat && line.trim() ? { dialogue: line } : {}),
      action: actionText,
      accepted: true,
      ...(facts ? { factsAsserted: facts } : {}),
    });
    if (facts) ctx.services.disclosure?.record(npcId, facts);
    ctx.data.persist = true;
  }

  // --- gates + bookkeeping ---------------------------------------------------

  /** Idle/anti-spam guard shared by B and C: not already talking, and not within the dedup window. */
  private eligible(ctx: TickContext, npcId: string): boolean {
    const entity = ctx.model.entities.get(npcId);
    if (!entity?.partyMember) return false;
    // A downed (0-HP / `unconscious`) companion is out of the scene — never let it self-initiate a
    // beat, or the DM narrates the felled ally speaking/acting right after the party was overcome.
    if (!isConscious(entity)) return false;
    // Defense-in-depth (audit #6): a party member must be CO-LOCATED with the party to self-initiate.
    // A companion left behind — a "go alone" solo-split, or any residual desync — must not have its
    // beat woven into the player's scene where it is not actually standing (a phantom).
    if (entity.locationId !== partyLocationOf(ctx.model)) return false;
    if (isPartyHostile(ctx.model, npcId)) return false;
    const a = autonomyOf(ctx.model)[npcId];
    if (a?.talking) return false;
    if (a && nowOf(ctx) - a.lastActedAt < MIN_DEDUP_MS) return false;
    return true;
  }

  /**
   * Stage 3 anti-spam guard for a PRESENT NON-PARTY world NPC — like `eligible` but WITHOUT the party
   * requirement (the candidate scan already excluded party members / hostiles / non-initiative
   * levels). Gated on the shared `autonomyOf` runtime slice (keyed by npcId, so a world NPC and a
   * companion never collide): not already holding the talk-lock, and past the calmer WORLD cooldown.
   */
  private eligibleWorld(ctx: TickContext, npcId: string): boolean {
    if (!isConscious(ctx.model.entities.get(npcId))) return false;
    const a = autonomyOf(ctx.model)[npcId];
    if (a?.talking) return false;
    if (a && nowOf(ctx) - a.lastActedAt < WORLD_NPC_DEDUP_MS) return false;
    return true;
  }

  /**
   * Stage 3: resolve the deciding agent for a queued item. A companion always wins (`this.npcs`); a
   * present non-party world NPC is built once via `agentFactory` and cached module-side so it isn't
   * rebuilt every tick. Undefined ⇒ no agent (no factory, or no world template) ⇒ realize no-ops.
   */
  private agentFor(npcId: string): NpcAgent | undefined {
    const companion = this.npcs.get(npcId);
    if (companion) return companion;
    const cached = this.worldAgents.get(npcId);
    if (cached) return cached;
    const agent = this.agentFactory?.(npcId);
    if (agent) this.worldAgents.set(npcId, agent);
    return agent;
  }

  /** Acquire the talk-lock (silent write) before the async decide() so overlapping ticks bail. */
  private acquireLock(ctx: TickContext, npcId: string): void {
    const a = autonomyOf(ctx.model)[npcId] ?? { talking: false, replyDepth: 0, lastActedAt: 0 };
    ctx.applySilent({ type: "modulePatch", module: "autonomy", patch: { [npcId]: { ...a, talking: true } } });
  }

  /** Release the talk-lock, bump reply-chain depth, and stamp the dedup clock. */
  private releaseLock(ctx: TickContext, npcId: string): void {
    const a = autonomyOf(ctx.model)[npcId] ?? { talking: false, replyDepth: 0, lastActedAt: 0 };
    ctx.applySilent({
      type: "modulePatch",
      module: "autonomy",
      patch: { [npcId]: { ...a, talking: false, replyDepth: a.replyDepth + 1, lastActedAt: nowOf(ctx) } },
    });
  }

  /**
   * Workstream C (slim) telemetry: when a grounded NPC action fell back to plain speech, record the
   * drop on the per-turn scratch so the Turns inspector shows *why* an attempted move never
   * happened — the fallback was previously silent. The
   * drop-or-not decision + reason is the pure `groundingFallbackReason`; here we only push it,
   * best-effort and wrapped so telemetry never breaks a tick (never a delta).
   *
   * The NAMED act rides along (verb + the id the model copied): an `illegal` drop with no act on it
   * says only "something didn't happen", which is exactly as far as the r15 sweep's
   * `grounding-fallback::illegal` finding could be read. The values are model strings — telemetry
   * only, never trusted, and clipped so a runaway target can't bloat a trace.
   */
  private recordGroundingFallback(actorId: string, ground: GroundingResult, act?: NpcAct): void {
    const drop = groundingFallbackReason(ground);
    if (!drop) return;
    try {
      const store = turnContext.getStore();
      const target = act?.target?.trim().slice(0, 80);
      if (store) {
        (store.groundingFallbacks ??= []).push({
          actorId,
          ...drop,
          ...(act?.do ? { act: act.do } : {}),
          ...(target ? { target } : {}),
        });
      }
    } catch {
      // telemetry is best-effort; never break the tick
    }
  }

  /**
   * Consent-gate telemetry (playtest r9 F-1, spec item (d)): an NPC act that WOULD have fired
   * unasked and is being held for the player's word instead. The r9 report's acceptance criterion
   * is a count — "heartbeat-origin entityMoved(pc.*) must be 0" — and a suppression that leaves no
   * trace can only be measured by its absence, which is indistinguishable from an idle Director.
   * Same best-effort scratch channel as the grounding fallbacks; never a delta, never throws.
   */
  private recordConsentBlock(actorId: string, block: ConsentBlock, path: ConsentPath): void {
    try {
      const store = turnContext.getStore();
      if (store) (store.consentBlocks ??= []).push({ actorId, command: block.command, reason: block.reason, path });
    } catch {
      // telemetry is best-effort; never break the tick
    }
  }

  // --- helpers ---------------------------------------------------------------

  /** The narrator brief this NPC decides from — same WorldModel-sourced grounding the GM gets. */
  private briefFor(ctx: TickContext, npcId: string): string {
    const state = ctx.state();
    const locationName = (id: string): string =>
      this.world.locations.find((l) => l.id === id)?.name ?? id;
    // Stage 1 self-perception: the deciding NPC's own body/inventory/energy/
    // goal/party status + a peek through its own exits, pre-extracted here from the WorldModel
    // registry so `context.ts` stays a pure formatter. A statless entity (no `stats`) yields
    // `self: undefined`, so `buildNarrationContext` renders neither the `# YOU` block nor the
    // `Adjacent:` peek — this stays a strictly additive state summary for stat-bearing deciders only, and
    // the GM/player brief (which never passes `self`) is unaffected either way.
    const entity = ctx.model.entities.get(npcId);
    const stats = entity?.stats;
    const self: SelfInfo | undefined = stats
      ? {
          currentHp: stats.currentHp,
          maxHp: stats.maxHp,
          energy: energyOf(stats),
          maxEnergy: maxEnergyOf(stats),
          exhaustion: stats.exhaustion,
          conditions: stats.conditions,
          inventory: stats.inventory,
          coins: stats.coins,
          equipped: stats.equipped ? Object.values(stats.equipped).filter((id): id is string => !!id) : undefined,
          aim: this.world.npcs.find((n) => n.id === (entity?.templateId ?? npcId))?.goals[0],
          party: !entity?.partyMember ? "none" : partyLeaderOf(ctx.model.modules) === npcId ? "leader" : "member",
          adjacent:
            entity && entity.locationId !== null
              ? exitsFrom(ctx.model.map, entity.locationId)
                  .filter((e) => !e.hidden)
                  .map((e) => ({ name: e.name, direction: e.direction, destination: locationName(e.to) }))
              : undefined,
        }
      : undefined;
    // Build presence + exits from the deciding NPC's OWN location, not the party's default snapshot —
    // so its decide brief always describes the scene it is actually in (defense-in-depth for audit #6;
    // byte-identical for a co-located decider, which the `eligible`/present gates already guarantee).
    const ownScene =
      entity && entity.locationId !== null
        ? { locationId: entity.locationId, entities: entitiesAt(ctx.model, entity.locationId) }
        : undefined;
    return buildNarrationContext({
      world: this.world,
      campaign: ctx.services.campaign,
      state,
      recentEvents: ctx.recent,
      trigger: `${this.nameOf(ctx, npcId)} considers what to do.`,
      // Observer-safe projection (Phase 2): a decide brief is FOR this character — the same
      // narrowing as its reply brief, so knowledge cannot differ between speaking and acting
      // (epistemic hard invariant 9).
      audience: { kind: "npc", npcId, templateId: entity?.templateId ?? npcId },
      // Private-thread visibility (Phase 6): this NPC's decide brief keeps only the private lines
      // it is itself a party to; asides between the PC and OTHER NPCs are structurally excluded.
      privateFor: npcId,
      present: modelPresence(ctx.model, this.world, ownScene),
      exits: modelExits(ctx.model, locationName, ownScene, frontierExpansionEnabled(this.world)),
      // Claims THIS NPC previously voiced — speaker continuity only, never authoritative world truth.
      // Omit-when-empty ⇒ byte-identical for an NPC with no prior claims.
      established: ctx.services.disclosure?.get(npcId),
      self,
    }).contextText;
  }

  private relationshipLineFor(ctx: TickContext, npcId: string): string | undefined {
    const pcId = playerEntity(ctx.model)?.id;
    if (!pcId) return undefined;
    return renderRelationshipProfile(relationshipProfileFromState(ctx.state(), npcId, pcId));
  }

  /**
   * A short spontaneous stimulus rooted in where the NPC is and who is around. Stage 4 (goal-
   * directed decision framing): phrased as an ACTIVE prompt toward purpose rather than a passive
   * "is there something you want to do?" — it names the widened grounder's action space (speak,
   * move, gear, barriers, rest, "your aims") so a proactive companion reaches for a concrete world
   * move instead of banter, WITHOUT re-quoting `template.goals` verbatim (already private in the
   * system prompt + surfaced as the Stage-1 `Your aim:` brief line — a past playtest saw a bare
   * goal recital leak into dialogue when the stimulus repeated it). `situationHint` appends 0-2
   * terse, code-derived live facts (never rng, never a write) so the nudge stays grounded in what
   * is actually true this tick.
   */
  private idleStimulus(ctx: TickContext, npcId: string): string {
    const loc = partyLocationOf(ctx.model);
    const here = loc
      ? entitiesAt(ctx.model, loc)
          .filter((e: Entity) => e.id !== npcId)
          .map((e) => this.nameOf(ctx, e.id))
      : [];
    const company = here.length ? ` with ${here.join(", ")}` : " alone";
    const base =
      `The party is idle${company}. Act on what matters to you: you might speak, move somewhere you can ` +
      `reach, ready or hand over your gear, work a locked way open, rest if you're worn, or press on ` +
      `toward your aims. What do you do?`;
    // Goal-directed decision framing: a leader gets the party-direction nudge (its C beat becomes an
    // executable NpcProposal); a plain proactive follower gets the SELF-scoped `goalHint` instead, so
    // it too reaches for a concrete step toward its own aim rather than generic banter (F3).
    const goal = this.canLeadNow(ctx, npcId) ? leaderGoalHint(ctx, npcId) : goalHint(ctx, npcId);
    return base + situationHint(ctx, npcId) + goal;
  }

  /**
   * Stage 3 stimulus for a PRESENT NON-PARTY world NPC — like `idleStimulus`, but framed for someone
   * going about their own life while the player (and whoever else) happens to be here, rather than a
   * companion idling with the party. Stage 4: reframed active/purposeful the same way, plus the same
   * `situationHint` live-fact nudge.
   */
  private worldStimulus(ctx: TickContext, npcId: string): string {
    const loc = partyLocationOf(ctx.model);
    const locName = (loc ? this.world.locations.find((l) => l.id === loc)?.name : undefined) ?? "here";
    const others = loc
      ? entitiesAt(ctx.model, loc)
          .filter((e: Entity) => e.id !== npcId)
          .map((e) => this.nameOf(ctx, e.id))
      : [];
    const company = others.length
      ? `${others.join(", ")} ${others.length === 1 ? "is" : "are"} here with you`
      : "you are alone for the moment";
    const base =
      `You are going about your business at ${locName}; ${company}. Go after what you want right now — ` +
      `speak, move on, ready your gear, force or pick a barred way, rest, or turn to what's around you. ` +
      `What do you do?`;
    // A present world NPC is never a party leader, so it gets the SELF-scoped goal nudge (F3).
    return base + situationHint(ctx, npcId) + goalHint(ctx, npcId);
  }

  /** Display name for an entity id, via WorldView (PC sheet → world NPC → id). */
  private nameOf(ctx: TickContext, id: string): string {
    return new WorldView(this.world, ctx.services.campaign, ctx.state()).name(id);
  }

  /**
   * Verbatim-repeat guard fallout (W6): a suppressed line reads as the NPC choosing silence, the
   * same neutral beat the dialogue module emits when a reply comes back empty. No retry, no
   * regeneration — the point is to break the loop, not to force a fresh line.
   *
   * The silence is now INTERNAL. It used to ride the player-facing `system` channel as a bulleted
   * meta line — the same treatment as "Combat begins" and error banners
   * — so "Oda the Wayfarer says nothing." read to the 2026-07-24 playtester as an error, and the
   * client's system handler also discarded the live streaming buffers on the way. A suppression is a
   * decision the engine made about its own output, not an event in the world; the GM's prose already
   * shows the scene without it.
   */
  private emitSaysNothing(ctx: TickContext, npcId: string): void {
    void ctx;
    void npcId;
  }

  /**
   * Record a line this NPC actually said into its bounded utterance history (W6), via the generic
   * `modulePatch` command and a silent apply — the one-writer/replay-safe idiom (mirrors the
   * autonomy talk-lock / pressure-cooldown patches). Blank lines record nothing (see `pushUtterance`).
   */
  private recordUtterance(ctx: TickContext, npcId: string, line: string): void {
    ctx.applySilent({
      type: "modulePatch",
      module: UTTERANCES_MODULE,
      patch: { [npcId]: pushUtterance(ctx.model.modules, npcId, line) },
    });
  }

  /**
   * Mystery wave — an NPC just VOICED a case fact on-screen (the Director share). Mint the code-owned
   * consequences: `revealCaseFact` enters the fact into the player's knowledge AND has every OTHER
   * present NPC witness it (limited perception — they learn by hearing it), and `markCaseFactShared`
   * records that this NPC told the party (share-dedup) + stamps its share cooldown. Both ride the
   * commit queue so they apply at the one writer, replay-safe. The model phrased the line; CODE owns
   * which fact reached the ledger.
   */
  private enqueueCaseShare(ctx: TickContext, npcId: string, share: CaseShare): void {
    const loc = ctx.model.entities.get(npcId)?.locationId ?? partyLocationOf(ctx.model);
    const witnesses = loc
      ? entitiesAt(ctx.model, loc)
          .filter((e) => e.kind === "npc" && e.id !== npcId)
          .map((e) => e.id)
      : [];
    ctx.enqueue({
      type: "revealCaseFact",
      caseId: share.caseId,
      factId: share.factId,
      factText: share.factText,
      witnesses,
    });
    ctx.enqueue({ type: "markCaseFactShared", caseId: share.caseId, npcId, factId: share.factId });
  }
}

/** The outcome of a resolved NPC barrier attempt (Stage 2b) — pure, so it is unit-testable. */
export interface BarrierAttemptOutcome {
  result: CheckResult;
  success: boolean;
  /** The exit state a SUCCESS sets: "open" for a picked lock, "broken" for a forced barrier. */
  state: ExitRuntimeState;
}

/**
 * Resolve an NPC pick/force attempt against its DC with a seeded RNG (Stage 2b). PURE — the roll is
 * code, never the model: pick = dex vs `barrier.dc` → the way OPENS; force = str vs `barrier.breakDc`
 * → it BREAKS (permanently, audibly open). `abilityScore` is the raw NPC ability (resolveCheck folds
 * in the 5e modifier); a statless NPC passes 10 (modifier +0). Exposed so autonomy tests can seed
 * the RNG and assert success/failure deterministically without driving the whole Director tick.
 */
export function resolveBarrierAttempt(
  action: Extract<GroundedAction, { kind: "barrierAttempt" }>,
  abilityScore: number,
  rng: Rng,
): BarrierAttemptOutcome {
  const result = resolveCheck({ abilityScore, dc: action.dc }, rng);
  return { result, success: result.success, state: action.verb === "force" ? "broken" : "open" };
}

/** Below this energy fraction of max, `situationHint` calls the NPC "worn down" (meaningfully low, not a sliver). */
const DEPLETED_ENERGY_RATIO = 0.6;
/**
 * Feature 2 — a single member this far below its (exhaustion-adjusted) energy cap is worn enough to
 * pull the whole party toward a rest on its own, even if the rest of the party is fresh. Above it, a
 * rest is called only when the party's MEAN energy is depleted (several mildly-tired members).
 */
const CRITICAL_ENERGY_RATIO = 0.35;

/**
 * Stage 4 — a short, code-derived nudge appended to both `idleStimulus` and `worldStimulus`
 * surfacing 0-2 ACTIONABLE live facts already true in state, re-stated as prompts so the model
 * reaches for the matching widened grounder verb instead of generic banter. PURE/deterministic:
 * no rng, no state write, just reads already-resolved WorldModel facts. Omit-when-empty — a
 * fully-fine NPC with no barred exit and no fallen holder nearby gets "" back, so the stimulus is
 * byte-identical to the base reframing. Exported (mirrors `resolveBarrierAttempt`) so tests can
 * assert on it directly without driving a whole Director tick.
 *  - depleted: energy below {@link DEPLETED_ENERGY_RATIO} of max ⇒ "You're worn down." (nudges REST).
 *  - barred way: a non-hidden barred exit out of the NPC's location ⇒ names the destination + the
 *    obstacle (nudges PICK/FORCE).
 *  - fallen holder: a present, non-self entity that is defeated (hp ≤ 0 or `unconscious`) and
 *    carries at least one item ⇒ names them (nudges LOOT). Mirrors grounding.ts's own `isDefeated`
 *    lootability rule (duplicated here, not imported — this module never touches grounding.ts).
 */
export function situationHint(ctx: TickContext, npcId: string): string {
  const entity = ctx.model.entities.get(npcId);
  if (!entity) return "";
  const fragments: string[] = [];

  const stats = entity.stats;
  if (stats) {
    const max = maxEnergyOf(stats);
    if (max > 0 && energyOf(stats) < max * DEPLETED_ENERGY_RATIO) fragments.push("You're worn down.");
  }

  const loc = entity.locationId;
  if (loc !== null) {
    const barred = barredExitsAt(ctx.model, loc).find((v) => !v.exit.hidden);
    if (barred) {
      const destName = ctx.services.world.locations.find((l) => l.id === barred.exit.to)?.name ?? barred.exit.to;
      const label = barred.exit.name ?? destName;
      const desc = barrierDescription(barred.exit.barrier);
      fragments.push(`The way to ${label} is barred (${desc}).`);
    }

    const fallen = entitiesAt(ctx.model, loc).find((e) => e.id !== npcId && isFallenHolder(e));
    if (fallen) fragments.push(`${displayName(fallen)} lies fallen nearby.`);

  }

  // Mystery wave — proactive collaboration: this NPC holds a case fact the party hasn't heard and its
  // share cooldown has cleared ⇒ nudge it to VOLUNTEER that EXACT fact. The realize path mints the
  // matching `revealCaseFact`/`markCaseFactShared` when the NPC actually speaks (both read the same
  // pure `planCaseShare` off unchanged state within the tick, so prose + ledger name the same fact).
  // Omit-when-empty — no shareable fact ⇒ byte-identical stimulus.
  const share = planCaseShare(ctx.services.campaign, ctx.state(), npcId, ctx.model.clock);
  if (share) {
    fragments.push(`You know something the others still haven't heard — bring it up now: "${share.factText}"`);
  }

  return fragments.length > 0 ? ` ${fragments.join(" ")}` : "";
}

/**
 * Stage 5 (goal-directed leadership) — a short, code-derived nudge appended to `idleStimulus` ONLY
 * for a companion that can currently lead the party (an authored `canLead` leader or the appointed
 * slice leader — `idleStimulus` gates the call on `canLeadNow`). A leader's spontaneous (C) beat is
 * grounded into an executable NpcProposal the table can accept/override/ignore ({@link emitProposal}),
 * so this steers that proposal toward PURPOSE — pursue the live objective, take up an offered
 * job, push into the unexplored — instead of the generic banter that used to trip the proposal net.
 *
 * PURE/deterministic like {@link situationHint}: reads already-resolved campaign + WorldModel facts,
 * no rng, no state write. The quest text is AUTHORED, player-facing copy echoed verbatim (an active
 * quest's objectives and an offered quest's name both already surface to the player) — the model only
 * phrases the pursuit; the OBJECTIVE stays code-owned truth, never model-invented, never GM-secret
 * (hidden/failed/complete quests are excluded). Omit-when-empty ⇒ byte-identical for a quest-clear
 * world with no frontier ahead, so a leader in a fully-mapped, done world proposes exactly as before.
 * Surfaces at most two facts (a quest direction + the unexplored way), the same 0-2 discipline
 * `situationHint` keeps. Exported so tests assert on it without driving a whole Director tick.
 *  - party fatigue: the party (members OTHER than the leader) worn per {@link partyFatigued} — any one
 *    member critically spent OR the party's mean energy depleted, both against the exhaustion-adjusted
 *    cap ⇒ "The party is worn — you could call a rest…" (nudges the leader to call a group rest; the
 *    leader's OWN fatigue stays `situationHint`'s personal "You're worn down").
 *  - active objective: the first incomplete objective of an `active` quest ⇒ "The party still has
 *    to: <objective>." (nudges pursuing the current goal); an objective-less active quest falls back
 *    to its name.
 *  - offered job: else, the name of a quest visibly ON OFFER but not yet taken ⇒ "There's a job no
 *    one has taken up yet: <name>." (nudges opting in — the player still decides).
 *  - PERSONAL agenda: else (no quest calls the party at all) a leader that HAS an authored goal is
 *    told the course is ITS to set — steer the party toward what it came to do. The aim itself is
 *    NOT re-quoted (it already rides the leader's `# YOU`/`Your aim:` brief + system prompt; a
 *    verbatim goal recital once leaked into spoken dialogue — the Stage-4 note), so this is a
 *    DIRECTIVE to lead toward that private motive, letting the model turn it into a concrete move
 *    (this is how a leaderful party keeps moving with no quest on the table — the requested feature).
 *    A goal-less leader gets nothing here, preserving omit-when-empty.
 *  - unexplored way: a non-hidden FRONTIER exit out of the party's location ⇒ "No one has explored
 *    <way> yet." (nudges a MOVE into worldgen-as-explore).
 */
export function leaderGoalHint(ctx: TickContext, npcId: string): string {
  const fragments: string[] = [];
  const model = ctx.model;
  const campaign = ctx.services.campaign;
  const world = ctx.services.world;
  const loc = partyLocationOf(model);

  // Party fatigue first — a worn party should be rested before it is pushed anywhere. Scoped to
  // members OTHER than the leader (the leader's own low energy is situationHint's personal line).
  if (loc && partyFatigued(model, npcId, loc)) {
    fragments.push("The party is worn — you could call a rest before pressing on.");
  }

  // Direction: pursue the live objective of an ACTIVE quest → else take up an OFFERED job → else,
  // with no quest calling the party, it falls to the leader to set the course toward its OWN aim.
  // Quest states echoed here are already player-visible, so nothing GM-secret leaks.
  const active = campaign.quests.find((q) => model.quests.get(q.id) === "active");
  const offered = active ? undefined : campaign.quests.find((q) => model.quests.get(q.id) === "offered");
  if (active) {
    // LIVE done-ness, not the authored default (playtest r9 F-3): `o.done` is static content and
    // stays false forever — the leader's brief kept saying "the party still has to: recover the
    // guild-bond" on the same page that listed that objective `· done`. The reducer records
    // completion in the `objectives` module slice; read it PURELY (moduleSlice creates-on-touch,
    // which would dirty a snapshot from a read path — the combatSlice() trap).
    const doneOf =
      (model.modules["objectives"] as Record<string, Record<string, boolean>> | undefined)?.[active.id] ?? {};
    const objective = active.objectives.find((o) => !(doneOf[o.id] ?? o.done));
    fragments.push(
      objective ? `The party still has to: ${objective.description}.` : `You're still seeing ${active.name} through.`,
    );
  } else if (offered) {
    fragments.push(`There's a job no one has taken up yet: ${offered.name}.`);
  } else {
    const templateId = model.entities.get(npcId)?.templateId ?? npcId;
    const template = world.npcs.find((n) => n.id === templateId);
    if (template && template.goals.length > 0) {
      fragments.push(
        "No quest calls the party right now — the course is yours to set. Turn what you came here to do into where the party goes and what it does next.",
      );
    }
  }

  // Mystery wave — an ACTIVE, open case still missing core facts ⇒ steer the leader to drive the
  // JOINT investigation (press the others for what they know, chase the next lead). The case's own
  // quest already surfaces above as the active-quest objective; this adds the collaborative "ask
  // around" pull that pairs with each NPC's proactive share. Truthful + player-visible (case name),
  // omit-when-empty; ranked below rest + quest direction (the slice(0,2) keeps the stronger pulls).
  for (const c of campaign.cases) {
    if (model.quests.get(c.questId) !== "active") continue;
    const runtime = caseRuntimeOf(model.modules, c.id);
    if (runtime.status !== "open") continue;
    const known = new Set(runtime.playerKnown);
    if (c.facts.some((f) => f.core && !known.has(f.id))) {
      fragments.push(`The ${c.name} is still unsolved — press the others for what they know and run the leads down.`);
      break;
    }
  }

  // Unexplored way: a non-hidden frontier exit out of where the party stands (worldgen-as-explore) —
  // the leader can propose the MOVE that grows the map, executed on tacit consent if grounding lands.
  // Suppressed when frontier expansion is disabled for the world: the edge is latent, so never nudge
  // toward a crossing the engine will refuse.
  if (loc && frontierExpansionEnabled(world)) {
    const frontier = exitsFrom(model.map, loc).find((e) => !e.hidden && isFrontierId(e.to));
    if (frontier) {
      const label = frontier.name ?? frontier.direction ?? FRONTIER_FALLBACK_NAME;
      fragments.push(`No one has explored ${label} yet.`);
    }
  }

  // Terse like situationHint — surface at most the two strongest pulls (rest > direction > explore).
  return fragments.length > 0 ? ` ${fragments.slice(0, 2).join(" ")}` : "";
}

/**
 * F3 — the SELF-scoped counterpart to {@link leaderGoalHint}, appended to `idleStimulus` (for a
 * proactive NON-leader companion) and `worldStimulus` (a present non-party NPC). A leader is steered
 * to move the PARTY toward the objective; a follower/world NPC can only move ITSELF, so this steers it
 * to take one concrete step (move/give/ready/speak) toward its OWN aim instead of idle banter — the
 * missing link that let a goal actually shape a non-leader's autonomous beat (before this, only
 * leaders' goals reached action framing; `chooseAgendaAction` is stance-only).
 *
 * PURE/deterministic like {@link situationHint}: reads the already-resolved NPC template, no rng, no
 * write. The goal is NEVER re-quoted — it already rides the NPC's system prompt + `Your aim:` self
 * line, and a verbatim recital once leaked into spoken dialogue (the Stage-4 note) — so this is a
 * DIRECTIVE to act on the private motive, not a recital of it. Omit-when-empty: a goal-less NPC gets
 * "" back, so its stimulus stays byte-identical to the base reframing. Exported so tests assert on it.
 */
export function goalHint(ctx: TickContext, npcId: string): string {
  const templateId = ctx.model.entities.get(npcId)?.templateId ?? npcId;
  const template = ctx.services.world.npcs.find((n) => n.id === templateId);
  if (!template || template.goals.length === 0) return "";
  return " Don't just pass the time — take one concrete step toward what you're really after right now.";
}

/**
 * Feature 2 — whether the party (its co-located members OTHER than the leader) is worn enough that a
 * leader should propose a group rest. WEIGHTED across every member rather than tripping on the first
 * sub-threshold one: a rest is called when EITHER any single member is CRITICALLY spent
 * (`< CRITICAL_ENERGY_RATIO` of its cap) OR the party's MEAN energy ratio is depleted
 * (`< DEPLETED_ENERGY_RATIO`) — so one slightly-tired member no longer forces a rest, but two mildly
 * tired ones (or one genuinely spent one) do. Each ratio folds in EXHAUSTION: the member's energy is
 * first capped at its exhaustion-reduced working ceiling (`workingCap`, the same ceiling the engine's
 * rest loops refill to), then read against its NOMINAL max — so an exhausted member reads as tired
 * even near nominal-full energy (its energy can't count above the lowered cap). The leader's own
 * fatigue stays `situationHint`'s personal line. The PC carries `partyMember`, so this covers player +
 * companions; a statless member (no energy) never counts.
 */
function partyFatigued(model: WorldModel, leaderId: string, loc: string): boolean {
  let sum = 0;
  let n = 0;
  for (const e of entitiesAt(model, loc)) {
    if (e.id === leaderId || !e.partyMember) continue;
    const s = e.stats;
    if (!s) continue;
    const max = maxEnergyOf(s);
    if (max <= 0) continue;
    // Exhaustion caps how rested a member can read: effective energy can't exceed the working ceiling.
    const effective = Math.min(energyOf(s), workingCap(exhaustionOf(s), max));
    const ratio = effective / max;
    if (ratio < CRITICAL_ENERGY_RATIO) return true; // one spent member pulls the whole party
    sum += ratio;
    n += 1;
  }
  return n > 0 && sum / n < DEPLETED_ENERGY_RATIO;
}

/** A defeated (hp ≤ 0 or `unconscious`) present entity carrying at least one item — lootable. */
function isFallenHolder(entity: Entity): boolean {
  const s = entity.stats;
  return s !== undefined && (s.currentHp <= 0 || s.conditions.includes("unconscious")) && s.inventory.length > 0;
}

/**
 * A one-line GM-facing summary of a grounded command for the weave block (no raw mechanics).
 * Phrased as an ATTEMPT, not a completed fact: the command is only ENQUEUED here and the reducer
 * applies it at commit — AFTER the GM has already woven this line — and may still reject it (e.g.
 * a transfer to a statless holder). An attempt-phrasing stays true whether or not commit succeeds,
 * so the authoritative brief never canonizes a move that never happened. Item ids resolve to
 * display names (never the raw internal id) like every other player-facing surface.
 */
export function summarizeCommand(cmd: Command, ctx: TickContext, world: World): string {
  switch (cmd.type) {
    case "moveEntity":
      return `moves to head toward ${world.locations.find((l) => l.id === cmd.to)?.name ?? cmd.to}`;
    case "transferItem": {
      const itemName = resolveItem(world, cmd.itemId)?.name ?? cmd.itemId;
      return `offers ${itemName}${cmd.to ? ` to ${ctx.model.entities.get(cmd.to)?.name ?? cmd.to}` : ""}`;
    }
    case "adjustRelationship":
      return cmd.by >= 0 ? "makes a warm gesture" : "makes a cold gesture";
    default:
      return `moves to act (${cmd.type})`;
  }
}

/** A copy of the runtime with any pending proposal removed. */
function stripProposal(a: AutonomyRuntime): AutonomyRuntime {
  const { pendingProposal: _drop, ...rest } = a;
  return rest;
}

export type { AutonomyDialogueItem };
