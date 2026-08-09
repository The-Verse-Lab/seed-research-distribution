/**
 * NpcMemoryModule (M4 Part B) — records salient, DETERMINISTIC beats into each NPC's journal.
 *
 * The stateful half of the memory rebuild. It observes the tick and ENQUEUES `recordNpcMemory`
 * commands for a small, deterministic beat set; the reducer is the only writer of the slice (the
 * one-writer rule), and the recall side (Phase 3, npc.ts `# YOU REMEMBER`) reads it back. Every
 * recorded summary is an engine-templated string (never LLM prose, never raw player text) and
 * `entry.at = model.clock`, so recorded state is fully deterministic and `snapshot == fold(deltas)`
 * holds. Registered UNCONDITIONALLY — it's benign and inert when no beat fires (no journal, so the
 * recall block is omitted and prompts are byte-identical).
 *
 * Beats (start here; the kind tag makes the set extensible):
 *  - "addressed": the player directly speaks to a companion (observed via `ctx.data.dialogue`, which
 *    the engine's resolve phase sets only for an addressed companion). Recorded in `react`, so it
 *    lands at commit AFTER this turn's reply is generated — you remember PRIOR beats, not the line
 *    you're currently answering (recall reflects it next turn).
 *  - "questResolved": a quest transitions to `complete` this tick. Detected deterministically by
 *    scanning the not-yet-committed `ctx.queue` (this module runs `after: ["events", "core"]`, so the
 *    events module's `setQuestState` is already queued) for a quest whose CURRENT model state is not
 *    yet `complete`. Recorded for the present party-member companions (a simple, deterministic
 *    "involved" rule: the companions who were there when it resolved).
 *  - "relationship": an NPC's regard/stat for someone shifted this tick. Detected by scanning `ctx.queue`
 *    for `adjustRelationship` whose `actorId` is an NPC and whose `by !== 0` — both the events module
 *    (scripted effects) and the autonomy module (NPC gestures) enqueue these in `react` BEFORE us
 *    (both registered earlier and share our `after`), so they're already queued. Recorded on the
 *    actor NPC: "warmed" / "cooled" by the sign of `by`.
 *  - "traveled": the party changed location this tick. The player's `moveParty` is applied directly
 *    in the engine's RESOLVE phase (it never enters `ctx.queue`), so unlike the other beats this one
 *    is detected from MODEL STATE: a `perceive`-phase handler stashes the party location before the
 *    move, and `react` compares it to the post-move location. Recorded for the companions who
 *    traveled along (present at the new location — the reducer moves all party members together). A
 *    no-op or failed move leaves the location unchanged, so nothing is recorded.
 *  - "attireObserved": the PC's attire reads bare/disheveled this tick and differs from last tick's
 *    state — detected the same MODEL-STATE way as "traveled" (a typed clothing change, like
 *    `moveParty`, is applied directly in RESOLVE, never queued): `perceive` stashes the PC's
 *    pre-tick attire `VisibleFact` (`visibleStateOf`, the same derivation the brief's Attire line
 *    uses) and `react` compares its coarse state to the post-tick fact. Firing only on a REAL
 *    transition (not a repeat "already bare" tick) is the spam guard — lingering in one state for many
 *    turns writes exactly one beat, not one per turn. Recorded for EVERY co-located NPC (bystanders
 *    included, not just party companions) — unlike "traveled"/"questResolved", anyone physically
 *    present witnesses it, not just the PC's own travelling companions.
 *
 * @author Runkai Zhang
 */
import type { Campaign, World } from "../../content/schema.ts";
import type { Command } from "../../world/commands.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { WorldView } from "../../world/queries.ts";
import type { NpcMemoryEntry } from "../../rules/npc-memory.ts";
import { ATTIRE_FACT_ID, visibleStateOf, type VisibleFact } from "../../rules/visible-state.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";

/** The dialogue intent the engine parks when the player addresses a companion (read-only here). */
interface DialogueIntentLike {
  npcId: string;
  playerLine: string;
  /** Private-thread marker (Phase 6): the address was an aside to this NPC alone. */
  channel?: "private";
}

export class NpcMemoryModule implements TickModule {
  readonly id = "npc-memory";
  /**
   * Run AFTER the modules whose enqueued commands we inspect/follow: events (queues setQuestState),
   * core (owns resolve → `ctx.data.dialogue`), and dialogue (so the addressing record is logically
   * paired with the reply it follows). We only enqueue more commands for the same commit, so order
   * within the queue stays deterministic.
   */
  readonly after = ["core", "events", "dialogue"];
  readonly phases: TickModule["phases"];

  /** Scratch key for the party location captured in `perceive`, used by the movement beat in `react`. */
  private static readonly PRE_MOVE_LOC = "npcMemory.preMoveLoc";
  /** Scratch key for the PC's attire fact captured in `perceive`, used by the attire beat in `react`. */
  private static readonly PRE_ATTIRE = "npcMemory.preAttire";

  constructor(
    private readonly world: World,
    private readonly campaign: Campaign,
  ) {
    this.phases = {
      perceive: (ctx) => this.onPerceive(ctx),
      react: (ctx) => this.onReact(ctx),
    };
  }

  /**
   * Snapshot the party location BEFORE the engine's resolve phase moves it, so the movement beat can
   * detect a real relocation by comparing against the post-move location in `react`. Cheap and inert
   * on non-player ticks (the move path is player-only).
   */
  private onPerceive(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return;
    ctx.data[NpcMemoryModule.PRE_MOVE_LOC] = partyLocationOf(ctx.model);
    ctx.data[NpcMemoryModule.PRE_ATTIRE] = this.pcAttireFact(ctx.model);
  }

  private onReact(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return; // beats are consequences of a player turn
    this.recordAddress(ctx);
    this.recordQuestResolutions(ctx);
    this.recordRelationshipShifts(ctx);
    this.recordMovement(ctx);
    this.recordAttireObservation(ctx);
  }

  /**
   * "addressed": the player directly spoke to a companion this turn. Recorded ONLY on the
   * addressed NPC — this is also the structural privacy guarantee for private threads (Phase 6):
   * no other NPC's journal can ever carry a beat for an aside it never heard. A private address
   * is remembered AS private (still an engine-templated summary, never the player's raw text).
   */
  private recordAddress(ctx: TickContext): void {
    const dialogue = ctx.data.dialogue as DialogueIntentLike | undefined;
    if (!dialogue) return;
    const playerName = this.view(ctx).name(playerEntity(ctx.model)?.id ?? "pc.you");
    const summary =
      dialogue.channel === "private" ? `Spoke privately with ${playerName}.` : `Spoke with ${playerName}.`;
    ctx.enqueue({
      type: "recordNpcMemory",
      npcId: dialogue.npcId,
      entry: this.entry(ctx, "addressed", summary),
    });
  }

  /**
   * "questResolved": for each queued setQuestState→complete whose quest is NOT yet complete in the
   * live model (a real transition this tick), record the beat for the present party companions.
   */
  private recordQuestResolutions(ctx: TickContext): void {
    const model = ctx.model;
    const completing = new Set<string>();
    for (const cmd of ctx.queue) {
      if (cmd.type === "setQuestState" && cmd.state === "complete" && model.quests.get(cmd.questId) !== "complete") {
        completing.add(cmd.questId);
      }
    }
    if (completing.size === 0) return;

    const companions = this.presentCompanions(model);
    if (companions.length === 0) return;

    for (const questId of completing) {
      const name = this.campaign.quests.find((q) => q.id === questId)?.name ?? questId;
      const summary = `Quest "${name}" was resolved.`;
      for (const npcId of companions) {
        ctx.enqueue({ type: "recordNpcMemory", npcId, entry: this.entry(ctx, "questResolved", summary) });
      }
    }
  }

  /**
   * "relationship": for each queued relationship command whose actor is an NPC and whose `by` is
   * non-zero (skip no-op nudges — no noise), record a beat on the actor NPC. Both the events module
   * and the autonomy module enqueue these earlier in `react`, so they're already in `ctx.queue`.
   */
  private recordRelationshipShifts(ctx: TickContext): void {
    const model = ctx.model;
    const view = this.view(ctx);
    for (const cmd of ctx.queue) {
      if (cmd.type !== "adjustRelationship" || cmd.by === 0) continue;
      if (model.entities.get(cmd.actorId)?.kind !== "npc") continue;
      const targetName = view.name(cmd.targetId);
      const summary = `My regard for ${targetName} ${cmd.by >= 0 ? "warmed" : "cooled"}.`;
      ctx.enqueue({ type: "recordNpcMemory", npcId: cmd.actorId, entry: this.entry(ctx, "relationship", summary) });
    }
  }

  /**
   * "traveled": the party relocated this tick. Detected from model state (the player's `moveParty` is
   * applied in resolve, never queued): compare the `perceive`-captured location to the current one.
   * On a real move, record a beat for each companion who travelled along (present at the destination).
   */
  private recordMovement(ctx: TickContext): void {
    const model = ctx.model;
    const before = ctx.data[NpcMemoryModule.PRE_MOVE_LOC] as string | null | undefined;
    const after = partyLocationOf(model);
    if (!after || after === before) return; // no-op / failed move ⇒ nothing to record
    const companions = this.presentCompanions(model);
    if (companions.length === 0) return;
    const summary = `Traveled to ${this.view(ctx).locationName(after)}.`;
    for (const npcId of companions) {
      ctx.enqueue({ type: "recordNpcMemory", npcId, entry: this.entry(ctx, "traveled", summary) });
    }
  }

  /**
   * "attireObserved": the PC's attire read (bare/disheveled) differs from last tick's — a real
   * transition, not a lingering state — so it is recorded once per change, never once per turn the
   * PC merely stays in the same state. Recorded for every co-located NPC (bystanders too, not just
   * companions): unlike a shared journey or a shared quest, anyone present witnesses this.
   */
  private recordAttireObservation(ctx: TickContext): void {
    const before = ctx.data[NpcMemoryModule.PRE_ATTIRE] as VisibleFact | undefined;
    const after = this.pcAttireFact(ctx.model);
    if (!after?.memory) return; // currently fully dressed ⇒ nothing to witness
    if (before?.brief === after.brief) return; // unchanged since last tick

    const witnesses = this.presentNpcs(ctx.model);
    if (witnesses.length === 0) return;

    const loc = partyLocationOf(ctx.model);
    const view = this.view(ctx);
    const pcName = view.name(playerEntity(ctx.model)?.id ?? "pc.you");
    const locName = loc ? view.locationName(loc) : "an unknown place";
    const summary = `${pcName} ${after.memory.summary} at ${locName}.`;
    for (const npcId of witnesses) {
      ctx.enqueue({ type: "recordNpcMemory", npcId, entry: this.entry(ctx, after.memory.kind, summary) });
    }
  }

  /** Party-member NPCs co-located with the party — the deterministic "involved" set for a quest beat. */
  private presentCompanions(model: WorldModel): string[] {
    const loc = partyLocationOf(model);
    if (!loc) return [];
    return entitiesAt(model, loc)
      .filter((e) => e.kind === "npc" && e.partyMember)
      .map((e) => e.id);
  }

  /**
   * ALL co-located NPCs — companions and bystanders alike. Unlike {@link presentCompanions}, NOT
   * restricted to party members: a perception beat like exposure is witnessed by anyone physically
   * present, not just the PC's own travelling companions.
   */
  private presentNpcs(model: WorldModel): string[] {
    const loc = partyLocationOf(model);
    if (!loc) return [];
    return entitiesAt(model, loc)
      .filter((e) => e.kind === "npc")
      .map((e) => e.id);
  }

  /**
   * The PC's current attire fact (undefined when fully dressed) — reuses `visibleStateOf`, the same
   * derivation the narrator brief's Attire line reads, so "what counts as bare/disheveled" lives in
   * exactly one place.
   */
  private pcAttireFact(model: WorldModel): VisibleFact | undefined {
    const pcId = playerEntity(model)?.id;
    if (!pcId) return undefined;
    const character = this.campaign.characters.find((c) => c.id === pcId);
    return visibleStateOf(model, pcId, character).find((f) => f.id === ATTIRE_FACT_ID);
  }

  /** Build a journal entry stamped with the world clock (deterministic; never Date.now()). */
  private entry(ctx: TickContext, kind: string, summary: string): NpcMemoryEntry {
    return { at: ctx.model.clock, kind, summary };
  }

  private view(ctx: TickContext): WorldView {
    return new WorldView(this.world, this.campaign, ctx.state());
  }
}
