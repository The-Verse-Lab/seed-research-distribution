/**
 * Logging types — structured records of every LLM interaction.
 *
 * These give full transparency into model behavior (prompts, raw responses, reasoning,
 * tokens, latency) for debugging the engine and for model work. A LogSink persists them;
 * the LoggingGateway produces them by wrapping any LlmGateway.
 *
 * @author Runkai Zhang
 */
import type { LlmRole } from "../llm/types.ts";

export interface LlmCallRecord {
  campaignId: string;
  /** Epoch ms when the call finished. */
  at: number;
  role: LlmRole;
  model: string;
  kind: "complete" | "stream" | "embed";
  /** The slimmed request: messages + sampling params (not the API key). */
  request: unknown;
  /** Final visible content (reasoning already separated out). */
  responseText: string;
  /** Captured reasoning/thinking, if the model exposed any. */
  reasoningText: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  finish: "ok" | "empty" | "error";
  /**
   * The provider's own raw `finish_reason` ("stop", "length", "content_filter", ...), if it
   * reported one. Separate from `finish` on purpose: `finish` is Seed's own coarse ok/empty/error
   * bucket, this is the unmodified upstream signal — lets a short completion be diagnosed as a
   * provider-side content filter vs. a length cap vs. a plain stop, instead of a shrug.
   */
  providerFinish?: string;
  error?: string;
  /**
   * The turn that spawned this call (Workstream D): the event seq at the tick's start, so the
   * Observatory can group a turn's calls together. Best-effort — set from the per-turn
   * `AsyncLocalStorage` context; absent (older rows, or calls made outside a tick) ⇒ ungrouped.
   */
  turnSeq?: number;
}

/** A persisted call with its row id (for incremental reads / live tailing). */
export type StoredLlmCall = LlmCallRecord & { id: number };

/** A destination for LLM call records. Implemented by the SQLite store. */
export interface LogSink {
  recordLlmCall(record: LlmCallRecord): void;
}

export interface LlmCallQuery {
  /** Only calls with id strictly greater than this (for tailing). */
  sinceId?: number;
  limit?: number;
}

/**
 * One tick-module handler invocation (Workstream D, attribution pass) — which module ran in which
 * phase, how long it cost, and what it did to the world.
 *
 * The rest of {@link TurnTrace} records WHAT a turn decided; this records WHO decided it. Derived
 * purely by OBSERVATION in `TickRunner` (the command queue's tail, the tick's applied-command
 * ledger, and the bus seq are diffed around each handler), so no module has to know it is being
 * watched and nothing here can influence a turn. Telemetry only — never a command, never a delta,
 * never in a brief.
 *
 * `phase` is the `TickPhase` string ("perceive" | "resolve" | "react" | "narrate" | "commit" |
 * "persist"); it is typed loosely here so this logging leaf keeps no dependency on the engine.
 */
export interface ModulePhaseTrace {
  moduleId: string;
  phase: string;
  /** Wall-clock cost of the handler, ms (rounded). */
  ms: number;
  /** Command types this handler enqueued for the commit transaction (`ctx.enqueue`). */
  enqueued?: string[];
  /** Command types this handler applied immediately (`ctx.apply` / `ctx.applySilent`). */
  applied?: string[];
  /** Events the bus stamped during this handler. */
  emitted?: number;
  /** Set when the handler threw. The tick still fails — this records which module failed it. */
  error?: string;
}

/**
 * Per-turn agent trace (Workstream D, slim) — the decision skeleton of one tick, durable beside
 * `llm_calls`. It is TELEMETRY, not world state: never a reducer command / delta, never in the
 * narrator brief. Deliberately slim and public-safe — no chain-of-thought, no system prompts, no
 * hidden lore; the `npcBeats` are the already-emitted PUBLIC beats (`turnOutcome.npc`, which
 * excludes private/discreet lines). The full prompts + reasoning live in `llm_calls`.
 */
export interface TurnTrace {
  campaignId: string;
  characterId: string;
  /** The correlation key: the event seq assigned at the tick's start. */
  turnSeq: number;
  /** The seq range this turn produced (`seqEnd` = the last seq assigned, or `seqStart - 1` if none). */
  seqStart: number;
  seqEnd: number;
  /** Epoch ms bracketing the tick. */
  atStart: number;
  atEnd: number;
  trigger: "player" | "heartbeat";
  /** The player's line (player trigger) / the acting NPC (heartbeat trigger). */
  input?: string;
  npcId?: string;
  /** The reconciled classifier decision (player turns only). */
  classifierKind?: string;
  classifierTargetId?: string | null;
  classifierConfidence?: number;
  classifierCheck?: { ability: string | null; skill?: string | null; dc: number | null } | null;
  /** The reconciled trade payload verbatim (r10) — the r10 report misdiagnosed F-3's mechanism
   *  because the trace recorded the KIND but not what the classifier actually asked the resolver
   *  to move. Absent on non-trade turns. */
  classifierTrade?: {
    direction: "buy" | "sell";
    itemId: string | null;
    vendorId: string | null;
    quantity?: number;
    inquiry?: boolean;
    itemWords?: string;
    vendorWords?: string;
  };
  /**
   * The reconciled settle-then-move destination (r11 §2.4), when the player's line carried one —
   * "I sign the salvage claim … then head west on the Ashwild road". Without it the trace records a
   * `questAction`/`trade` kind on a turn that legitimately relocated the party, and nothing
   * downstream can tell that from a relocation the player never asked for. Absent ⇒ the line carried
   * no second half.
   */
  classifierSecondaryMove?: { destinationLocationId: string | null; destinationName: string | null };
  /** The freeform-fallback reason, if the classifier failed twice (Workstream G leftover). */
  fallback?: string;
  /**
   * Public NPC beats this turn (the DM delivers these as staged prose; no raw bubble). Public-safe by
   * construction — private/discreet lines never enter `turnOutcome`, and `emitTurnTrace` maps to these
   * explicit fields, so privateIntent/confidence never ride the trace. `accepted:false` marks a
   * grounded action the reducer would reject; `factsAsserted` are attributed claims remembered by the disclosure ledger.
   */
  npcBeats?: {
    actorId: string;
    name: string;
    dialogue?: string;
    /** Mood-tagged spoken lines (the structured form of `dialogue`) — feeds the client's speech tinting. */
    lines?: { text: string; mood: string }[];
    action?: string;
    accepted?: boolean;
    rejectedReason?: string;
    factsAsserted?: string[];
  }[];
  /** Environmental beats already narrated this turn (prebaked events). */
  eventBeats?: string[];
  /**
   * Appearance/identity social reads (Workstream F) that shifted an NPC's stance toward the move it
   * chose this turn. Telemetry only — a one-line summary per read (`summarizeModifiers`); absent when
   * no perceived signals moved anyone.
   */
  socialModifiers?: Array<{ actorId: string; targetId: string; summary: string }>;
  /**
   * Grounded NPC actions dropped to plain speech this turn (Workstream C slim): an attempted
   * move/give/gesture whose directive was too weak (`low-confidence`) or would have been illegal
   * (`illegal`), so it never mutated the world. Telemetry only — the previously-silent fallback
   * made inspectable. Absent when every NPC action grounded cleanly (or nobody attempted one).
   *
   * `act`/`target` are the verb and id the NPC actually named (omitted on an older exported trace).
   * A drop without them cannot be diagnosed — "an unoffered verb" and "a stale/invented id" read
   * identically in the report, which is what stalled the r15 `grounding-fallback::illegal` finding.
   */
  groundingFallbacks?: Array<{
    actorId: string;
    confidence: number;
    reason: "low-confidence" | "illegal";
    act?: string;
    target?: string;
  }>;
  /**
   * Consent-gate hits (playtest r9 F-1): grounded NPC commands that would have executed with nobody
   * having said yes, and were held as a spoken nudge instead — `path: "tacit"` for an expired
   * proposal consumed on silence, `"direct"` for an unasked act taken while the proposal path was
   * closed. `reason` is the {@link consentBlockFor} class (movement/commitment/custody/
   * unclassified). Telemetry only; absent when the Director asked for nothing it wasn't owed.
   */
  consentBlocks?: Array<{ actorId: string; command: string; reason: string; path: "tacit" | "direct" }>;
  /**
   * Turn-auditor findings (best-effort telemetry): the deterministic Tier-1 continuity screen run on
   * every EMITTED narration — even when the Judge is disabled or didn't escalate — so honesty
   * violations are machine-recorded instead of eyeball-only. A non-empty list means the final prose
   * still matched a violation pattern (with a Judge configured this is rare — the residue the regen
   * loop shipped anyway); scripted live runs export these for an automatic violations report.
   * Absent ⇒ every emitted narration screened clean (or the turn had no narration).
   */
  audit?: Array<{ kind: string; detail: string }>;
  /**
   * Per-module attribution for this tick (see {@link ModulePhaseTrace}) — the handlers that DID
   * something: mutated the world, emitted an event, threw, or cost real time. A tick invokes ~40
   * handlers across 24 modules and most are no-ops on any given turn, so the quiet ones are counted
   * rather than listed (`modulesQuiet`) — never silently dropped. Absent ⇒ no trace sink was
   * attached when the tick ran (the runner then takes its original, uninstrumented path).
   */
  modules?: ModulePhaseTrace[];
  /** How many invoked handlers were no-ops this turn (the complement of `modules`). */
  modulesQuiet?: number;
}

/** A persisted trace with its row id (for incremental reads / live tailing). */
export type StoredTurnTrace = TurnTrace & { id: number };

/** A destination for turn traces. Implemented by the SQLite store (optional on other stores). */
export interface TraceSink {
  recordTurnTrace(trace: TurnTrace): void;
}

export interface TurnTraceQuery {
  /** Only traces whose `turnSeq` is >= this (for tailing). */
  sinceSeq?: number;
  limit?: number;
}
