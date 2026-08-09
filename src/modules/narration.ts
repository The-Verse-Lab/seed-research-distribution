/**
 * Narration module — the GM's prose, extracted from the engine onto the tick's `narrate` phase.
 *
 * Reads the narration intent the resolve phase parked on `ctx.data.narration`, builds the
 * narrator brief, calls the configured DM, and degrades to deterministic offline narration on
 * any failure or empty output. Pure relocation of the engine's old `narrate()` — same brief,
 * same fallbacks, same emitted `narration` event.
 *
 * @author Runkai Zhang
 */
import type { World } from "../content/schema.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import { DungeonMaster } from "../agents/dm.ts";
import type { ResolvedMechanics } from "../agents/dm.ts";
import { buildNarrationContext, type SocialRead, type TurnOutcome } from "../agents/context.ts";
import { frontierExpansionEnabled } from "../world/expansion.ts";
import type { RetrievedLore } from "../memory/retriever.ts";
import {
  establishedFactsAt,
  modelExits,
  modelLocationSnapshot,
  modelPresence,
} from "../world/queries.ts";
import { applyCommand } from "../world/reducer.ts";
import { toGameState } from "../world/model.ts";
import type { TickContext, TickModule } from "../engine/tick.ts";
import { AUTONOMOUS_BEAT_SEED, authorizedCommandsOf, beatEcho, looksLikeRefusal, narrateGuarded } from "./narrate.ts";
import { turnFactLines } from "../rules/turn-facts.ts";

/** What to narrate this tick. The resolve phase sets `ctx.data.narration` to this. */
export interface NarrationIntent {
  trigger: string;
  resolved?: ResolvedMechanics;
  /** The trigger is already complete player-facing prose and must not be rewritten by a model. */
  deterministic?: boolean;
  /**
   * Player-safe line to emit if the narrator comes back blank (after the RescueGateway's
   * retry/reroute). Set ONLY where the trigger IS the raw player input (a freeform/default turn):
   * without it, `triggerEcho` would parrot the player's own words back as narration (T7).
   * Engine-authored triggers stay unset — their stripped prose is already a good echo.
   */
  echoFallback?: string;
}

export class NarrationModule implements TickModule {
  readonly id = "narration";
  /**
   * The GM speaks LAST (Workstream C slim): dialogue replies, event beats, and autonomy moves
   * all land first, accumulate on `ctx.data.turnOutcome`, and the brief weaves them as
   * authoritative fact — the GM can no longer contradict an NPC line it never saw.
   */
  readonly after = ["dialogue", "events", "autonomy"];
  readonly phases: TickModule["phases"];
  private readonly dm: DungeonMaster;
  /** Lazily-built deterministic narrator used when the configured one fails mid-tick. */

  constructor(
    private readonly world: World,
    gateway: LlmGateway,
    private readonly systemPrefix?: string,
  ) {
    this.dm = new DungeonMaster(gateway, world, systemPrefix);
    this.phases = { narrate: (ctx) => this.onNarrate(ctx) };
  }

  private async onNarrate(ctx: TickContext): Promise<void> {
    const intent = ctx.data.narration as NarrationIntent | undefined;
    // The DM now OWNS all public NPC communication: fire it when a public NPC beat exists even if no
    // narration intent was parked (an autonomous NPC beat on a heartbeat) — it renders those beats as
    // staged prose. A public reactive address parks an intent (engine dialogueToNpc), so it fires with
    // a proper seed. Absent BOTH ⇒ nothing to narrate (a private-only whisper turn stays a no-op).
    const outcome = ctx.data.turnOutcome as TurnOutcome | undefined;
    const hasPublicBeat = (outcome?.npc?.length ?? 0) > 0;
    if (!intent && !hasPublicBeat) return;
    // Synthesized seed when only NPC beats drive the turn (the beats themselves are in the brief's
    // authoritative weave block, so this is just a prompt seed, not the content).
    const trigger = intent?.trigger ?? AUTONOMOUS_BEAT_SEED;

    // Hard mechanical refusals must remain true even when the narrator is blank, confused, or
    // eager to continue the previous action. The resolver marks only already-player-facing lines;
    // emit them verbatim and skip the model entirely (N7: rest-in-combat became a club swing).
    //
    // Skipping the model also skips the BRIEF that would have woven this tick's public NPC beats —
    // and a public beat has NO other renderer (dialogue.ts emits a bubble only for a PRIVATE line;
    // autonomy's own comment is "No raw bubble — the DM delivers this NPC's words as staged prose").
    // So returning bare here drops an NPC's words outright, and for a grounded beat leaves its
    // committed command unnarrated — the player sees only `Present:` change next turn. Append the
    // beats verbatim instead: the mechanical line stays byte-true (nothing re-established, no model
    // round-trip) and the NPC is still heard. Zero beats ⇒ byte-identical to the old emit.
    if (intent?.deterministic) {
      const spoken = beatEcho(outcome?.npc);
      const text = spoken ? `${trigger} ${spoken}` : trigger;
      ctx.data.lastNarration = text;
      ctx.emit({ kind: "narration", text });
      return;
    }

    // The GM narrates the RESULT of this tick, but react-phase modules (autonomy/routines moves, a
    // barrier opened, an NPC departure) ENQUEUE their commands — the reducer applies them at COMMIT,
    // AFTER this narrate phase. Grounding on the live pre-commit model would therefore list a departed
    // NPC as still present or render a just-opened barrier as shut. Mirror combat's preview: ground on
    // a throwaway clone with the queue applied. Best-effort — a preview fault must never break narrate,
    // so it falls back to the live model (worst case: the pre-existing pre-commit behavior).
    //
    // ONE exception: an NPC who took a PUBLIC BEAT this tick stays where they were. Their line is in
    // the brief's authoritative weave block and the narrator is required to deliver it verbatim, so
    // previewing their queued departure hands the model a flat contradiction — "say this, from
    // someone who is not here" — and puts them on the `Not present` line the cast checks read. r13
    // fixture-work t10: Lys the Quiet spoke a case fact while autonomy queued her exit in the same narrate
    // phase; the brief listed her absent, the narrator burned 140 s and returned nothing, and the
    // engine's own beat echo was then audited as a castPresence violation. They were here when they
    // spoke; the queued exit still commits, and next turn's brief shows them gone.
    const spokeThisTick = new Set((outcome?.npc ?? []).map((b) => b.actorId));
    let groundModel = ctx.model;
    if (ctx.queue.length > 0) {
      try {
        const preview = structuredClone(ctx.model);
        for (const command of ctx.queue) {
          if (command.type === "moveEntity" && spokeThisTick.has(command.entityId)) continue;
          applyCommand(preview, command);
        }
        groundModel = preview;
      } catch {
        groundModel = ctx.model;
      }
    }
    const state = groundModel === ctx.model ? ctx.state() : toGameState(groundModel);
    const locationName = (id: string): string =>
      this.world.locations.find((l) => l.id === id)?.name ?? id;

    // Resolve location/presence once for all three neighboring grounding blocks. This keeps the
    // disclosure ledger, presence list, and exits on one snapshot and avoids repeated registry scans.
    const location = modelLocationSnapshot(groundModel);
    const established = establishedFactsAt(groundModel, ctx.services.disclosure, location);

    // Read-only lore retrieval (M4): find authored canon relevant to what's being narrated and inject
    // it as grounding. Best-effort by contract — the retriever returns empty buckets on any failure
    // and never throws, so a retrieval problem cannot stall or break the narrate phase.
    //   - `public` → the shared brief's `# RELEVANT LORE` (seen by the DM AND NPCs).
    //   - `secret` → the DM-ONLY `gmLore` channel (never enters `contextText`, never an NPC prompt).
    // Prefer the promise the resolve phase prefetched (its embedding round-trip overlapped the
    // react-phase NPC calls instead of blocking the narrator). Fall back to a fresh retrieve when
    // there is no prefetch or its trigger differs (heartbeat / beats-only turns). Best-effort by
    // contract — the retriever returns empty buckets on any failure and never throws.
    const prefetched =
      ctx.data.lorePrefetchTrigger === trigger
        ? (ctx.data.lorePrefetch as Promise<RetrievedLore> | undefined)
        : undefined;
    const retrieved = prefetched
      ? await prefetched
      : ctx.services.lore
        ? await ctx.services.lore.retrieve(trigger, ctx.services.loreOptions)
        : { public: [], secret: [] };

    const nctx = buildNarrationContext({
      world: this.world,
      campaign: ctx.services.campaign,
      state,
      recentEvents: ctx.recent,
      trigger,
      resolved: intent?.resolved,
      // Consequences the engine bound this turn (Phase 3): authoritative outcome lines, each backed by
      // a ledgered command so the Judge converges. Omit-when-empty ⇒ byte-identical on a plain turn.
      consequences: ctx.data.consequences as string[] | undefined,
      // TURN FACTS: the player-salient changes from the SAME authorized ledger the Judge verifies
      // against — the narrator sees what actually happened (names off the pre-commit model, matching
      // the Judge's own name resolution). Empty ⇒ omitted, byte-identical.
      turnFacts: turnFactLines(this.world, ctx.model, authorizedCommandsOf(ctx)),
      // Facts present NPCs have established this campaign (disclosure ledger) — the DM must not
      // contradict them. Omit-when-empty ⇒ byte-identical when nothing has been established.
      established,
      // Presence + exits come from the post-queue WorldModel so the narrator sees the tick's RESULT
      // (registry presence, hidden exits filtered) — a departed NPC is gone, an opened barrier is open.
      present: modelPresence(groundModel, this.world, location),
      exits: modelExits(groundModel, locationName, location, frontierExpansionEnabled(this.world)),
      // Executed NPC beats this tick (dialogue reply, autonomy moves) — the GM runs after those
      // modules and weaves what ALREADY happened; empty ⇒ the block is omitted, byte-identical.
      turnOutcome: (ctx.data.turnOutcome as TurnOutcome | undefined)?.npc,
      // Environmental event beats already shown this tick — the GM stays consistent, never
      // restating them; empty ⇒ omitted, byte-identical.
      turnEvents: (ctx.data.turnOutcome as TurnOutcome | undefined)?.events,
      // An offstage rumor that reached this room (r11 F-12). It is NOT already on screen — the
      // deterministic overhear line is gone — so the GM is the only voice that will carry it.
      overheard: ctx.data.overheard as { place: string; text: string } | undefined,
      // Appearance/identity social reads that colored an NPC's move this tick (Workstream F
      // follow-up): a GM-only tone cue. Only the GM's brief carries it; empty ⇒ omitted, byte-identical.
      socialReads: ctx.data.socialReads as SocialRead[] | undefined,
      lore: retrieved.public,
      // GM-only secret lore — DM's private narrate message only (set on the context, NOT contextText).
      gmLore: retrieved.secret,
      // The campaign rolling-summary (M4 follow-up): a best-effort derived cache the engine loads and
      // regenerates off the critical path; rendered as `# STORY SO FAR` (omitted when empty). Carries
      // no state — pure prompt grounding.
      storySoFar: ctx.services.storySoFar,
    });
    // A raw-player-input trigger carries a neutral blank-narrator echo (T7) — thread it onto the
    // narration context as the player-safe fallback for this beat.
    if (intent?.echoFallback) nctx.echoFallback = intent.echoFallback;

    // Pass the OOC-refusal detector so a base model that declines ordinary prose (no rescue route set,
    // or rescue also refuses) degrades to the deterministic trigger echo instead of emitting the model
    // breaking character on screen — the same backstop combat already uses (audit). Minor-safety
    // `blocked` is unaffected (it never falls through to any prose).
    await narrateGuarded(ctx, state, this.dm, nctx, looksLikeRefusal);
  }
}
