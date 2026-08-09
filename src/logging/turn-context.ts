/**
 * Per-turn trace context (Workstream D, slim).
 *
 * A tick runs through several `await`s (classify, narrate, dialogue) and heartbeat ticks can
 * interleave with a player tick, so a single shared mutable "current turn" holder would clobber
 * under concurrency. `AsyncLocalStorage` scopes a per-turn scratch correctly across a tick's
 * awaits: the engine opens a scope around the tick body, and code with no `ctx` access — the
 * `LoggingGateway` (to stamp `turnSeq` on each call) and the bootstrap `onFallback` closure (to
 * report the freeform-fallback reason back to the engine) — reads/writes the same scratch.
 *
 * Best-effort: outside a scope `getStore()` is `undefined`, so telemetry simply degrades (no
 * turnSeq / no fallback capture) and never affects play.
 *
 * @author Runkai Zhang
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The mutable scratch shared for the duration of one tick. */
export interface TurnScratch {
  /** The event seq assigned at the tick's start — the trace correlation key. */
  turnSeq: number;
  /** Set by the classifier's `onFallback` when the model path fails twice this turn. */
  fallback?: string;
  /**
   * Workstream F — appearance/identity social reads that colored a chosen NPC agenda move this
   * turn. Best-effort telemetry pushed by the autonomy module; read at tick end into the TurnTrace.
   */
  socialModifiers?: Array<{ actorId: string; targetId: string; summary: string }>;
  /**
   * Workstream C (slim) — grounded NPC actions that fell back to plain speech this turn because the
   * directive was too weak (`low-confidence`) or would have been illegal (`illegal`). Best-effort
   * telemetry pushed by the autonomy module; read at tick end into the TurnTrace so the Turns
   * inspector shows *why* an attempted move never happened. Pure-conversation lines (no directive
   * at all) are NOT recorded here — only a real candidate that was dropped.
   *
   * `act`/`target` name WHICH act was dropped. Without them an `illegal` drop is undiagnosable —
   * the r15 sweep reported "npc.oda action dropped (illegal, confidence 1.00)" and no reader,
   * human or automated, could tell whether the NPC named an unoffered verb or a stale id.
   */
  groundingFallbacks?: Array<{
    actorId: string;
    confidence: number;
    reason: "low-confidence" | "illegal";
    act?: string;
    target?: string;
  }>;
  /**
   * Playtest r9 F-1 — grounded NPC commands HELD for the player's word this turn instead of firing
   * unasked (`src/modules/autonomy/consent.ts`). Best-effort telemetry pushed by the autonomy
   * module; read at tick end into the TurnTrace so "the Director wanted to move the party and
   * didn't" is a countable event rather than an absence.
   */
  consentBlocks?: Array<{ actorId: string; command: string; reason: string; path: "tacit" | "direct" }>;
}

export const turnContext = new AsyncLocalStorage<TurnScratch>();
