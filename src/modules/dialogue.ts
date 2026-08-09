/**
 * Dialogue module — reactive companion replies, extracted onto the tick's `narrate` phase.
 *
 * Reads the dialogue intent the resolve phase parked on `ctx.data.dialogue` (the addressed
 * companion + the player's line), asks that NPC's agent for one in-character reply, and emits
 * it. Records the NPC's last autonomous action through the reducer (silent bookkeeping). Pure
 * relocation of the engine's old `companionReply()`.
 *
 * @author Runkai Zhang
 */
import type { AutonomyRuntime } from "../state/types.ts";
import { scrubSelfNarration, type NpcAgent, type NpcTurnIntent } from "../agents/npc.ts";
import { MINOR_SAFETY_REFUSAL } from "../llm/safety.ts";
import { scrubProseArtifacts } from "../llm/prose-scrub.ts";
import { buildNarrationContext, recordNpcBeat } from "../agents/context.ts";
import { frontierExpansionEnabled } from "../world/expansion.ts";
import { modelExits, modelPresence, WorldView } from "../world/queries.ts";
import { nowOf, type TickContext, type TickModule } from "../engine/tick.ts";
import type { TurnPlan } from "../engine/turn-plan.ts";
import { LoreRetriever } from "../memory/retriever.ts";
import { knowledgeDocs } from "../memory/ingest.ts";
import { renderRecallForQuery } from "./npc-memory/state.ts";
import { offersPatch } from "../rules/pending-offers.ts";
import { isRecentDuplicate, pushUtterance, UTTERANCES_MODULE } from "../rules/utterances.ts";
import { entitiesAt, partyLocationOf } from "../world/model.ts";
import type { Command } from "../world/commands.ts";
import { applyCommand } from "../world/reducer.ts";
import { extractGist, renderHistoryBlock } from "../memory/npc-history.ts";
import {
  CHAT_FRIENDSHIP_CAP,
  clampConvoNudge,
  readRelationshipMeta,
  relationshipProfileFromState,
  renderRelationshipProfile,
} from "../rules/relationships.ts";
import { dayOf, effectiveScheduleOf, readRoutinesSlice } from "../rules/routine.ts";
import { nameMentioned, replierKnowsTarget, whereaboutsLines } from "../rules/sightings.ts";
import { caseBriefForNpc } from "../rules/cases.ts";
import { knowledgeStatements } from "../knowledge/facts.ts";
import { composeEpistemicPacket } from "../knowledge/packet.ts";
import { groundUsedFactIds, renderEpistemicBlocks } from "../knowledge/render.ts";
import { readLearnedFacts } from "../rules/npc-knowledge.ts";
import { exitsFrom } from "../world/map.ts";

/** Which companion replies, to what line. The resolve phase sets `ctx.data.dialogue` to this. */
export interface DialogueIntent {
  npcId: string;
  playerLine: string;
  /**
   * Optional mechanics-chosen outcome the reply must voice (e.g. an invite the code already
   * accepted). Threaded to the agent as a directive — the DECISION is code's, only the phrasing
   * is the model's. Absent for ordinary replies (byte-identical prompts).
   */
  steer?: string;
  /**
   * Private-thread marker (Phase 6, click-to-chat). `"private"` ⇒ the player's line was an aside
   * to this NPC alone: the reply is emitted with `channel:"private"` (an NPC replying IN a
   * private thread stays private), its brief includes the thread's own prior private lines
   * (`privateFor`), and bystander modules (autonomy priority-B, other NPCs' memory) treat the
   * exchange as inaudible. Absent ⇒ today's public behavior, byte-identical.
   */
  channel?: "private";
  /**
   * Code-gated `# WORK ON OFFER` facts (numbers-free) for a `workInquiry` routed to this NPC: the
   * authoritative job the live board carries here, so the replier POINTS the asker at real work in
   * their own voice instead of a disembodied menu. The DECISION (which job, whether any) is code's —
   * see the engine's `workInquiry` branch — and the wage/DC/Take affordance stays in the WorkCard;
   * the model only phrases the pointer. Absent for ordinary dialogue (byte-identical prompt).
   */
  workLead?: string[];
  /**
   * Code-gated `# ERRAND ON OFFER` terms for an errand QUOTE routed to this NPC (r5): where, how
   * long, and what it costs — every number computed from real roads and real stance, so the
   * runner states the deal in their own voice instead of the world printing a form. The DECISION
   * (willing at all, the route, the fee) is code's; the model only phrases it. Absent for ordinary
   * dialogue (byte-identical prompt).
   */
  errandQuote?: string[];
}

/**
 * An NPC reply the module chose NOT to deliver — an empty completion, a verbatim repeat, or a
 * Judge-confirmed violation. This is INTERNAL: it used to emit `"<name> says nothing."` on the
 * player-facing `system` channel, which clients render as a meta line beside
 * "Combat begins" and error banners, so the 2026-07-24 playtester read it as an error — and the
 * client's system handler discards the live streaming buffers on the way through. A suppression is
 * a decision the engine made about its own output, not an event in the world. The GM's weave already
 * shows the scene without it, so the right amount of player-facing noise is none.
 */
function suppressLine(): void {}

export class DialogueModule implements TickModule {
  readonly id = "dialogue";
  readonly phases: TickModule["phases"];
  /**
   * Read-only retrievers over each companion's own `knowledge[]`, built lazily on first reply and
   * cached by NPC id. Separate from the shared world-lore retriever (`ctx.services.lore`); a reply
   * draws on BOTH so an NPC speaks from what it personally knows and the world's public canon.
   */
  private readonly knowledge = new Map<string, LoreRetriever>();

  constructor(
    private readonly npcs: Map<string, NpcAgent>,
    /**
     * Fallback agent lookup for NPCs without a standing companion agent (Phase 6): a private
     * thread may address any present location NPC, so the engine supplies ephemeral reply agents
     * for them. Companions in `npcs` always win; absent resolver ⇒ companion-only (the pre-Phase-6
     * behavior, byte-identical).
     */
    private readonly resolveAgent?: (npcId: string) => NpcAgent | undefined,
  ) {
    this.phases = { narrate: (ctx) => this.onNarrate(ctx) };
  }

  private async onNarrate(ctx: TickContext): Promise<void> {
    const intent = ctx.data.dialogue as DialogueIntent | undefined;
    if (!intent) return;
    const agent = this.npcs.get(intent.npcId) ?? this.resolveAgent?.(intent.npcId);
    if (!agent) return;

    const state = ctx.state();
    const view = new WorldView(ctx.services.world, ctx.services.campaign, state);
    const player = state.party[0] ?? "pc.you";
    const locationName = (id: string): string =>
      ctx.services.world.locations.find((l) => l.id === id)?.name ?? id;
    const replierTemplateId = ctx.model.entities.get(intent.npcId)?.templateId ?? intent.npcId;
    const nctx = buildNarrationContext({
      world: ctx.services.world,
      campaign: ctx.services.campaign,
      state,
      recentEvents: ctx.recent,
      trigger: `${view.name(player)} speaks to you.`,
      // Observer-safe projection (Phase 2): this brief is FOR the replying character — no other-NPC
      // motive summaries, no pack/purse contents, no player-only case evidence, participation-
      // filtered record. The GM's own weave brief keeps full authority.
      audience: { kind: "npc", npcId: intent.npcId, templateId: replierTemplateId },
      // Same WorldModel-sourced grounding the narrator gets — EXCEPT private asides: this NPC's
      // own `# RECENT` keeps the lines it is a party to, while everyone else's brief drops them.
      privateFor: intent.npcId,
      present: modelPresence(ctx.model, ctx.services.world),
      exits: modelExits(ctx.model, locationName, undefined, frontierExpansionEnabled(ctx.services.world)),
      // What THIS NPC previously claimed — speaker continuity only, never authoritative world truth.
      // Omit-when-empty ⇒ byte-identical for an NPC with no prior claims.
      established: ctx.services.disclosure?.get(intent.npcId),
    });

    // Read-only retrieval (M4 Part A): ground the reply in the NPC's own knowledge + PUBLIC world
    // lore, queried by the player's line. Best-effort — empty on any failure, never throws/stalls.
    const lore = await this.retrieveForNpc(ctx, intent.npcId, intent.playerLine);
    // Recalled memory (M4 Part B + epistemic plan §12.1): the journal beats most RELEVANT to the
    // player's actual line — an old betrayal outranks recent small talk when trust is the question.
    // A line touching nothing stored degrades to plain recency (today's behavior). Empty ⇒
    // npc.ts omits the `# YOU REMEMBER` block (byte-identical prompt for a memory-less NPC).
    const memory = renderRecallForQuery(ctx.model, intent.npcId, intent.playerLine, undefined, ctx.services.world);

    // Ask-around (routine learnability): when the player's line names another SCHEDULED NPC this
    // replier would plausibly know, inject that NPC's true routine as `# KNOWN WHEREABOUTS` facts —
    // code decides who knows what; the model only phrases it. Absent otherwise (byte-identical).
    const whereabouts = whereaboutsFor(ctx, intent.npcId, intent.playerLine, locationName);

    // Code-owned case knowledge (mystery wave): this NPC's known facts + (possibly-false) beliefs,
    // rendered as `# THE CASE AS YOU KNOW IT`. Empty for an NPC with no stake ⇒ byte-identical prompt.
    const caseFile = caseBriefForNpc(ctx.services.campaign, state, intent.npcId);

    // Epistemic packet (NPC-EPISTEMIC-CONTEXT-PLAN, first slice): code selects the current/
    // historical facts and guarded secrets this NPC may speak to THIS line, at THIS relationship.
    // The classifier's knowledgeAsk frame steers timeframe; absent ⇒ safe default (history still
    // never renders as current). Empty packet ⇒ both blocks omitted ⇒ byte-identical prompts for
    // every world with no facts, no guilds, and no structured knowledge.
    const partyLoc = partyLocationOf(ctx.model);
    const packet = composeEpistemicPacket({
      world: ctx.services.world,
      npcTemplateId: replierTemplateId,
      npcName: view.name(intent.npcId),
      playerLine: intent.playerLine,
      ask: (ctx.data.plan as TurnPlan | undefined)?.knowledgeAsk ?? undefined,
      friendship: state.relationships[intent.npcId]?.[player],
      locationId: partyLoc,
      adjacentLocationIds: partyLoc
        ? exitsFrom(ctx.model.map, partyLoc)
            .filter((e) => !e.hidden)
            .map((e) => e.to)
        : [],
      // Facts this NPC LEARNED during play (reducer-owned slice, replay-safe): a witnessed
      // reveal or another speaker's voiced fact counts as an explicit grant here.
      learned: readLearnedFacts(ctx.model.modules, intent.npcId),
    });
    const epistemic = renderEpistemicBlocks(packet);

    const isPrivate = intent.channel === "private";
    const replyCtx = {
      contextText: nctx.contextText,
      playerLine: intent.playerLine,
      fromName: view.name(player),
      toward: state.relationships[intent.npcId]?.[player],
      relationship: renderRelationshipProfile(relationshipProfileFromState(state, intent.npcId, player)),
      lore,
      memory,
      history: renderHistoryBlock(ctx.services.npcHistory?.get(intent.npcId)),
      directive: intent.steer,
      ...(whereabouts ? { whereabouts } : {}),
      ...(caseFile.length > 0 ? { caseFile } : {}),
      // Epistemic blocks (omit-when-empty ⇒ byte-identical prompts without them): the code-chosen
      // answer facts for this line, and the concealment cues for relevant-but-withheld secrets.
      ...(epistemic.answerFacts.length > 0 ? { answerFacts: epistemic.answerFacts } : {}),
      ...(epistemic.disclosure.length > 0 ? { disclosure: epistemic.disclosure } : {}),
      // Code-gated job pointer (workInquiry routed to this NPC): authoritative, numbers-free.
      // Omit-when-empty ⇒ byte-identical for any reply that is not a work pointer.
      ...(intent.workLead && intent.workLead.length > 0 ? { workLead: intent.workLead } : {}),
      // Same discipline for an errand quote: computed terms, stated in character, never altered.
      ...(intent.errandQuote && intent.errandQuote.length > 0 ? { errandQuote: intent.errandQuote } : {}),
    };
    // PRIVATE whisper stays verbatim first-person via reply() — zero enrichment, never touches
    // replyTurn (the escape hatch where an NPC speaks freely). A PUBLIC address emits a structured
    // NpcTurnIntent (words + staging + facts) the GM renders into staged prose. Neither streams to the
    // player here — the reply is collected then emitted / woven.
    let line = "";
    let blocked = false;
    let turnIntent: NpcTurnIntent | undefined;
    try {
      if (isPrivate) {
        const r = await agent.reply(state, replyCtx, { onReasoning: ctx.services.client?.onReasoningToken });
        // A whisper is spoken first-person verbatim — scrub any third-person self-narration the
        // model bled into it (same seatbelt replyTurn's parse applies; live D2, 07-17), plus the
        // mechanical artifact scrub (leaked headers / glitch glyph runs — r3 P4). A blocked
        // reply is the OOC refusal and must pass through untouched.
        line = r.blocked ? r.text : scrubProseArtifacts(scrubSelfNarration(r.text, view.name(intent.npcId)));
        blocked = r.blocked ?? false;
      } else {
        turnIntent = await agent.replyTurn(state, replyCtx, { onReasoning: ctx.services.client?.onReasoningToken });
        line = turnIntent.blocked ? turnIntent.visibleSpeech : scrubProseArtifacts(turnIntent.visibleSpeech);
        blocked = turnIntent.blocked ?? false;
      }
    } catch {
      ctx.emit({
        kind: "system",
        level: "warn",
        message: `${view.name(intent.npcId)} gives no reply (narrator unavailable).`,
      });
      return;
    }
    // The one hard line: a minor-safety block surfaces the firm OOC refusal and stops — no reply.
    if (blocked) {
      ctx.emit({ kind: "system", level: "warn", message: MINOR_SAFETY_REFUSAL });
      return;
    }
    if (!line.trim()) {
      suppressLine(); // internal — a suppressed reply is not a world event (see the helper)
      return;
    }
    // Verbatim-repeat guard (W6): if this NPC just said these exact words (normalized), suppress the
    // line and emit a "says nothing" beat instead of looping it — no retry/regeneration. Private
    // replies dedupe off the SAME slice. A STEERED reply is exempt: it voices a mechanics-chosen
    // outcome (a distinct beat), and deduping it would drop the scripted line and poison the history.
    if (!intent.steer && isRecentDuplicate(ctx.model.modules, intent.npcId, line)) {
      suppressLine(); // internal — a suppressed reply is not a world event (see the helper)
      return;
    }
    // Continuity Judge (whisper path): a PRIVATE whisper is the NPC's own first-person voice and
    // bypasses the GM weave (and thus `narrateGuarded`'s Judge), so it is screened here. The whisper
    // bundle carries only what applies — the NPC's prior claims + this turn's authorized commands
    // — so the Judge runs the state-assertion + established-contradiction checks and skips the cast/
    // verbatim/mechanics checks. On a CONFIRMED violation the line is SUPPRESSED (the NPC says nothing).
    // A verifier OUTAGE must NOT mute the NPC: `adjudicate` degrades to the deterministic Tier-1 floor
    // (`semanticVerified:false`), and silence-on-outage is worse weirdness than an unverified-but-
    // grounded whisper — so we suppress ONLY on real `violations`, and `force:false` lets a clean
    // whisper (no established facts / no floor flag) skip the model round-trip entirely.
    if (isPrivate && ctx.services.judge) {
      try {
        const applied = (ctx.data.turnCommands as Command[] | undefined) ?? [];
        // Sequential fold on one clone (see narrate.ts): the pending queue commits in order, so a later
        // command must be dry-run against the effect of the earlier ones, not the pre-queue model —
        // else a doomed command could still launder a whisper's authorization (audit #6).
        const work = structuredClone(ctx.model);
        const legalQueue = ctx.queue.filter((c) => !applyCommand(work, c).rejected);
        const verdict = await ctx.services.judge.adjudicate(
          {
            prose: line,
            mode: "whisper",
            established: ctx.services.disclosure?.get(intent.npcId) ?? [],
            // The world's own ledger — a whisper that denies a job the player took is a
            // `ledgerContradiction` and gets suppressed like any other confirmed violation.
            ledger: nctx.ledger,
            authorizedCommands: [...applied, ...legalQueue],
          },
          { force: false },
        );
        if (verdict.violations.length > 0) {
          suppressLine(); // internal — a suppressed reply is not a world event (see the helper)
          return;
        }
      } catch {
        // Judge threw unexpectedly (adjudicate swallows model outages itself, so this is a real
        // internal error). Deliver the line — the Tier-1 floor is the guardrail, not this best-effort
        // semantic pass; muting the NPC on an engine hiccup is the exact weirdness we are removing.
      }
    }
    // Public NPC speech is now DELIVERED BY THE DM as staged prose — the enriched beat below carries
    // the words into the GM's weave block. Only a PRIVATE whisper still emits its own verbatim bubble
    // (the escape hatch, unheard by others), keeping today's private-thread behavior byte-identical.
    if (isPrivate) {
      ctx.emit({ kind: "dialogue", actorId: intent.npcId, text: line, toId: player, channel: "private" as const });
    }
    // Accrue a semantic gist of this exchange into the NPC's history day-buffer (statefulness #2) —
    // fire-and-forget on the cheap utility role, off the turn's critical path (best-effort, never throws).
    const npcHistory = ctx.services.npcHistory;
    if (npcHistory) {
      // Capture the store epoch NOW: if a rewind clears the store before this async gist resolves, the
      // guarded `recordGist` drops it rather than re-seeding a discarded timeline's memory.
      const epoch = npcHistory.currentEpoch();
      void extractGist(ctx.services.gateway, {
        npcName: view.name(intent.npcId),
        playerLine: intent.playerLine,
        npcReply: line,
      })
        .then((g) => {
          if (g) npcHistory.recordGist(intent.npcId, g, epoch);
        })
        .catch(() => {});
    }
    // Record the spoken line into the bounded utterance history for the verbatim-repeat guard
    // (steered lines exempt — a one-off scripted beat must never shadow ordinary conversation).
    if (!intent.steer) {
      ctx.applySilent({
        type: "modulePatch",
        module: UTTERANCES_MODULE,
        patch: { [intent.npcId]: pushUtterance(ctx.model.modules, intent.npcId, line) },
      });
    }
    // PROSE-TO-CODE §2.1 — the words just PRICED something. Bind the offer as scene-scoped stock the
    // counter will honour, so "this lantern's five gold" survives into the trade resolver instead of
    // dying with the scrollback. Self-reported by the NPC agent (never read out of its prose), and
    // written through the reducer like every other slice.
    if (turnIntent?.offers && turnIntent.offers.length > 0 && partyLoc) {
      ctx.applySilent({
        type: "modulePatch",
        ...offersPatch(ctx.model.modules, intent.npcId, turnIntent.offers, partyLoc, ctx.model.clock),
      });
    }
    // Record the EXECUTED public reply for the GM's weave block (Workstream C slim), ENRICHED with the
    // exact spoken words and claim history. A reactive reply enqueues no command, so free-form model
    // staging is deliberately omitted: without a grounded Command it is a proposal, not something
    // that happened. Private asides stay structurally invisible.
    if (!isPrivate) {
      recordNpcBeat(ctx.data, {
        actorId: intent.npcId,
        name: view.name(intent.npcId),
        dialogue: line,
        ...(turnIntent?.lines && turnIntent.lines.length > 0 ? { lines: turnIntent.lines } : {}),
        accepted: true,
        ...(turnIntent?.factsAsserted && turnIntent.factsAsserted.length > 0
          ? { factsAsserted: turnIntent.factsAsserted }
          : {}),
      });
      if (turnIntent?.factsAsserted && turnIntent.factsAsserted.length > 0) {
        ctx.services.disclosure?.record(intent.npcId, turnIntent.factsAsserted);
      }
      // Witnessed testimony teaches (epistemic plan §12.3): when the reply VOICED canonical facts
      // (closed [F#] handles grounded against the packet — never free prose), every OTHER NPC in
      // the room learns them as told/confident through the reducer. Private whispers never reach
      // this branch, so an aside teaches nobody; an absent NPC is simply not in `entitiesAt`.
      const usedFactIds = groundUsedFactIds(turnIntent?.factIdsUsed, epistemic, packet.factIds);
      if (usedFactIds.length > 0 && partyLoc) {
        for (const listener of entitiesAt(ctx.model, partyLoc)) {
          if (listener.kind !== "npc" || listener.id === intent.npcId) continue;
          for (const factId of usedFactIds) {
            ctx.enqueue({
              type: "learnFact",
              npcId: listener.id,
              factId,
              certainty: "confident",
              sourceKind: "told",
              sourceId: intent.npcId,
            });
          }
        }
      }
      // Living relationships: the NPC's agent may nudge its regard for the PC after a genuine
      // exchange. Bounded ±2, and cumulative chat-earned friendship is capped; cooling is uncapped.
      if (turnIntent?.relationshipNudge !== undefined) {
        this.applyConversationNudge(ctx, intent.npcId, player, turnIntent.relationshipNudge);
      }
    }

    // Record this NPC's last autonomous action through the reducer (silent bookkeeping).
    const autonomy = (ctx.model.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};
    const a = autonomy[intent.npcId];
    if (a) {
      ctx.applySilent({
        type: "modulePatch",
        module: "autonomy",
        patch: { [intent.npcId]: { ...a, lastActedAt: nowOf(ctx) } },
      });
    }
  }

  /**
   * Apply an NPC-proposed conversation nudge to its regard for the PC, code-bounded: magnitude is
   * clamped to ±2 and cumulative POSITIVE friendship earned through talk alone is capped at
   * `CHAT_FRIENDSHIP_CAP` (cooling is never capped). The nudge is enqueued as an `adjustRelationship`
   * command applied at commit — it moves the Friendship gauge `stance()` reads directly. (It is NOT
   * recorded as an npc-memory beat: that module scans the command queue in the earlier `react` phase,
   * before this `narrate`-phase enqueue.) The running totals + interaction day persist to the
   * `relationshipMeta` slice (the decay module's exemption + the cap source).
   */
  private applyConversationNudge(ctx: TickContext, npcId: string, pcId: string, raw: number): void {
    let n = clampConvoNudge(raw);
    if (n === 0) return;
    const meta = readRelationshipMeta(ctx.model.modules);
    const earned = meta.chatEarned[npcId]?.[pcId] ?? 0;
    if (n > 0) {
      if (earned >= CHAT_FRIENDSHIP_CAP) return; // ceiling hit — talk alone can go no warmer
      n = Math.min(n, CHAT_FRIENDSHIP_CAP - earned);
    }
    ctx.enqueue({ type: "adjustRelationship", actorId: npcId, targetId: pcId, by: n });
    (meta.chatEarned[npcId] ??= {})[pcId] = earned + Math.max(0, n);
    (meta.lastInteractDay[npcId] ??= {})[pcId] = dayOf(ctx.model.clock);
    ctx.applySilent({ type: "modulePatch", module: "relationshipMeta", patch: { ...meta } });
    ctx.data.persist = true;
  }

  /**
   * Gather relevant lore for an NPC's reply: PUBLIC world lore (the shared `ctx.services.lore`) plus
   * the NPC's own `knowledge[]` (a lazily-built per-NPC index), both queried by the player's line.
   * Pure read: builds nothing in world state, returns rendered bullets. Best-effort — any failure
   * yields fewer/zero snippets, never an error. World lore comes first so canon precedes the NPC's
   * personal notes; duplicates (defensive) are removed.
   */
  private async retrieveForNpc(ctx: TickContext, npcId: string, query: string): Promise<string[]> {
    const opts = ctx.services.loreOptions;
    const out: string[] = [];

    if (ctx.services.lore) {
      out.push(...(await ctx.services.lore.retrieve(query, opts)).public);
    }

    let kn = this.knowledge.get(npcId);
    if (!kn) {
      const template = ctx.services.world.npcs.find((n) => n.id === npcId);
      // Structured entries fold to their statement text — same retrieval surface as legacy strings.
      // Disclosure-guarded secrets live in `privateKnowledge` and are deliberately NOT indexed here:
      // retrieval must never surface a withheld statement (the packet composer owns that gate).
      kn = new LoreRetriever(knowledgeDocs(`knowledge:${npcId}`, knowledgeStatements(template?.knowledge)));
      void kn.build(ctx.services.gateway); // warm best-effort; retrieve self-builds if needed
      this.knowledge.set(npcId, kn);
    }
    out.push(...(await kn.retrieve(query, opts)).public);

    return [...new Set(out)];
  }
}

/**
 * The `# KNOWN WHEREABOUTS` facts for a reply, or undefined: the first SCHEDULED world NPC the
 * player's line names (whole-word, skipping the replier) whose routine this replier would
 * plausibly know (same home region / same faction / any standing relationship). Pure read —
 * code decides who knows what; the model only phrases the injected facts.
 *
 * THE ONE `player-query` CALLER (r8). A name whose every token is ordinary English is otherwise
 * unreachable in lower case — "where can i find dray" found nobody, because "dray" is also a cart
 * and the binder cannot tell the readings apart from the text (`src/rules/name-match.ts`). The
 * evidence lives here: `dialogueAsk` is the classifier's own read of the SAME line it already
 * classifies this turn (no extra call, no added latency), and only its `whereabouts` answer opens
 * the binder's whole-name-uncapitalized handle. So:
 *   "where can i find dray?"              ⇒ dialogueAsk=whereabouts ⇒ the quartermaster's routine.
 *   "we should hitch the dray before dark" ⇒ dialogueAsk=other       ⇒ nobody, as today.
 * No plan at all — a private whisper (which never reaches the classifier), a scripted stub, a
 * classifier outage — degrades to `uncased`, which is exactly today's behaviour: the player has to
 * capitalize. That is the safe direction; the block is prose-only either way (it injects facts into
 * ONE reply brief and writes no state), and the two structural gates below still apply.
 */
function whereaboutsFor(
  ctx: TickContext,
  replierId: string,
  playerLine: string,
  locName: (id: string) => string,
): string[] | undefined {
  const world = ctx.services.world;
  const asksWhereabouts = (ctx.data.plan as TurnPlan | undefined)?.dialogueAsk === "whereabouts";
  const surface = asksWhereabouts ? "player-query" : "uncased";
  const replierTplId = ctx.model.entities.get(replierId)?.templateId ?? replierId;
  const replier = world.npcs.find((n) => n.id === replierTplId);
  const homeLocOf = (npcId: string): string | undefined =>
    world.locations.find((l) => l.npcs.includes(npcId))?.id;
  const regionOf = (locId: string | undefined): string | undefined =>
    locId === undefined ? undefined : world.locations.find((l) => l.id === locId)?.region;
  for (const target of world.npcs) {
    if (target.id === replierTplId) continue;
    // Authored or (world opt-in) derived — the same schedule the routines module walks.
    const schedule = effectiveScheduleOf(target, world);
    if (!schedule) continue;
    if (!nameMentioned(playerLine, target.name, surface)) continue;
    const relationship = ctx.model.relationships.get(replierTplId)?.get(target.id);
    if (!replierKnowsTarget(replier, target, regionOf, homeLocOf, relationship)) continue;
    const override = readRoutinesSlice(ctx.model.modules).overrides[target.id];
    const lines = whereaboutsLines({ name: target.name, schedule }, override, locName);
    return lines.length > 0 ? lines : undefined;
  }
  return undefined;
}
