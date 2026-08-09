/**
 * RescueGateway — retry-once plus optional rerouting for the generative prose roles.
 *
 * Two provider failure modes ruin a live turn without ever throwing (reproduced on DeepSeek):
 *   1. EMPTY — an HTTP-200 completion whose text is empty/whitespace (often reasoning-only),
 *      which silently degrades the turn to the offline template mid-session.
 *   2. REFUSAL — an HTTP-200 out-of-character content refusal returned as prose ("I'm sorry,
 *      I can't continue this scene"), which breaks immersion.
 *
 * For the RESCUED ROLES (default {narrator, creative} — the player-visible prose paths; utility
 * has the deterministic heuristic floor and embedding can't refuse) this wrapper:
 *   - retries the base ONCE on an empty/refused completion (covers transient empties), then
 *   - reroutes the same request to an optional RESCUE endpoint (for example, a local
 *     LM Studio model) and returns its answer if non-empty, else the base result.
 *
 * Streaming uses a HOLD-BACK buffer: visible deltas are withheld until ~300 chars (or stream
 * end), the verdict runs on what accumulated, and only a clean head is released — so a refusal
 * NEVER reaches the player's screen; the perceived cost is a sub-second first-token delay.
 * Reasoning chunks always pass through immediately (they are never rendered as prose).
 *
 * COMPOSITION ORDER (wired in src/config/env.ts): base → RescueGateway → GuardedGateway. The
 * minor-safety guard sits OUTSIDE this wrapper, so rescued output is screened exactly like
 * primary output — the one hard line holds on every route. Because the guard is outside, this
 * class never sees guard blocks; if a `blocked` sentinel ever does flow through, it is passed
 * on untouched — only model-authored refusals/empties are rerouted.
 *
 * Fail-safe by construction: every rescue-path error is swallowed in favor of the base result —
 * this wrapper never throws where the base wouldn't.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "./gateway.ts";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "./types.ts";
import { looksLikeRefusal } from "./refusal.ts";

/** Prose roles rescued by default. Utility/embedding are deliberately excluded. */
const DEFAULT_RESCUED_ROLES: readonly LlmRole[] = ["narrator", "creative"];

/** Visible chars accumulated before a stream's head is released (refusals sit at the head). */
const HOLDBACK_CHARS = 300;

/**
 * How many times the base is retried on a non-clean completion (finding #6: deepseek-v4-flash blanks
 * ~1 prose turn in 4, degrading the turn to the deterministic echo). A REFUSAL retries once — a second
 * identical prompt rarely un-refuses, so the reroute is its fix — but a persistent EMPTY retries the
 * full budget, since a blank has nothing for the reroute to improve on a bare model. 2 retries drop the
 * blank rate to ~p^3. The REAL cure is a non-empty-prone rescue endpoint (SEED_RESCUE_*, see .env.example).
 */
const EMPTY_RETRIES = 2;

/** An optional second endpoint (already role-routed) that answers when the base won't. */
export interface RescueRoute {
  provider: LlmGateway;
  /** Model name, for telemetry only. */
  model?: string;
}

type Verdict = "clean" | "empty" | "refusal";

function verdictOf(text: string): Verdict {
  if (!text.trim()) return "empty";
  return looksLikeRefusal(text) ? "refusal" : "clean";
}

/** What holdBack() hands back when it did NOT release the stream (empty/refusal head). */
interface HeldStream {
  verdict: Verdict;
  /** The withheld chunks — the base result, re-emittable when no rescue can do better. */
  buffered: CompletionChunk[];
}

export class RescueGateway implements LlmGateway {
  private readonly roles: ReadonlySet<LlmRole>;

  constructor(
    private readonly base: LlmGateway,
    private readonly rescue?: RescueRoute,
    opts: { roles?: LlmRole[] } = {},
  ) {
    this.roles = new Set(opts.roles ?? DEFAULT_RESCUED_ROLES);
  }

  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return this.base.embed(role, texts);
  }

  async complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    const primary = await this.base.complete(role, req);
    if (!this.roles.has(role)) return primary;
    // A guard-block sentinel is not model prose — never reroute it (defense in depth; the guard
    // normally sits outside us and we never see one).
    if (primary.blocked) return primary;
    if (verdictOf(primary.text) === "clean") return primary;

    // Retry the base — once for a refusal, up to EMPTY_RETRIES times for a persistent empty.
    let best = primary;
    for (let attemptN = 1; attemptN <= EMPTY_RETRIES; attemptN++) {
      try {
        const retry = await this.base.complete(role, req);
        if (retry.blocked) return retry;
        if (verdictOf(retry.text) === "clean") return retry;
        // Prefer the retry when it at least said something (a refusal beats a blank for fallback).
        if (retry.text.trim()) best = retry;
      } catch {
        // The retry failed where the first call didn't — keep the best-so-far.
        break;
      }
      // A refusal (or any non-empty) won't improve on more identical retries — reroute is its fix.
      if (verdictOf(best.text) !== "empty") break;
    }

    const reason = verdictOf(best.text) === "empty" ? "empty" : "refusal";
    if (!this.rescue) return best;
    try {
      const rescued = await this.rescue.provider.complete(role, req);
      if (rescued.text.trim() && !rescued.blocked) {
        this.logRescue(role, reason);
        return rescued;
      }
    } catch {
      // Rescue endpoint down/misconfigured — degrade to the base result, never throw.
    }
    return best;
  }

  stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (!this.roles.has(role)) return this.base.stream(role, req);
    return this.rescuedStream(role, req);
  }

  private async *rescuedStream(
    role: LlmRole,
    req: CompletionRequest,
  ): AsyncGenerator<CompletionChunk> {
    let attempt = yield* this.holdBack(this.base.stream(role, req));
    if (attempt === null) return; // clean — holdBack released the whole stream

    // Retry the base on a persistent EMPTY up to EMPTY_RETRIES times (the same hold-back applies each
    // time). A refusal is NOT retried here — it goes straight to the reroute below (finding #6).
    for (let attemptN = 1; attemptN <= EMPTY_RETRIES && attempt.verdict === "empty"; attemptN++) {
      try {
        const retry = yield* this.holdBack(this.base.stream(role, req));
        if (retry === null) return; // clean — holdBack released the whole stream
        attempt = retry;
      } catch {
        // The retry failed where the first stream didn't — fall through with the best-so-far.
        break;
      }
    }

    // Still empty/refused — reroute to the rescue endpoint when configured. The base stream was
    // already abandoned inside holdBack (its iterator is closed; the refusal was never yielded).
    if (this.rescue) {
      this.logRescue(role, attempt.verdict === "empty" ? "empty" : "refusal");
      let visible = "";
      try {
        for await (const chunk of this.rescue.provider.stream(role, req)) {
          visible += chunk.delta;
          yield chunk;
        }
      } catch {
        // Rescue endpoint failed — fall back to the base result below unless prose got out.
      }
      if (visible.trim()) return;
    }

    // No rescue (or it produced nothing visible): surface the withheld base result as-is.
    for (const chunk of attempt.buffered) yield chunk;
  }

  /**
   * Consume `stream` while withholding visible deltas. Reasoning-only chunks pass through
   * immediately. Once HOLDBACK_CHARS visible chars accumulate (or the stream ends), run the
   * verdict: CLEAN ⇒ release the buffer, pass the rest through live, and return null;
   * EMPTY/REFUSAL ⇒ stop consuming (the iterator is closed) and return the held chunks so the
   * caller can retry/rescue — the suspect text is never yielded.
   */
  private async *holdBack(
    stream: AsyncIterable<CompletionChunk>,
  ): AsyncGenerator<CompletionChunk, HeldStream | null> {
    const buffered: CompletionChunk[] = [];
    let visible = "";
    const it = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await it.next();
        if (step.done) break;
        const chunk = step.value;
        // A guard-block sentinel: not model prose — release everything untouched (see class doc).
        if (chunk.blocked) {
          yield* buffered;
          yield chunk;
          yield* this.drain(it);
          return null;
        }
        // Reasoning is never rendered as prose — always safe to surface immediately.
        if (chunk.reasoning && !chunk.delta) {
          yield chunk;
          continue;
        }
        buffered.push(chunk);
        visible += chunk.delta;
        if (visible.length >= HOLDBACK_CHARS) {
          if (looksLikeRefusal(visible)) return { verdict: "refusal", buffered };
          yield* buffered;
          yield* this.drain(it);
          return null;
        }
      }
      // Stream ended under the hold-back threshold: the verdict runs on the whole text.
      const verdict = verdictOf(visible);
      if (verdict !== "clean") return { verdict, buffered };
      yield* buffered;
      return null;
    } finally {
      // Close the underlying stream on every exit (abandon, throw, or normal end — harmless then).
      void it.return?.(undefined)?.catch?.(() => {});
    }
  }

  /** Pass the remainder of an iterator through live. */
  private async *drain(it: AsyncIterator<CompletionChunk>): AsyncGenerator<CompletionChunk> {
    for (;;) {
      const step = await it.next();
      if (step.done) return;
      yield step.value;
    }
  }

  /** Telemetry only — must never throw or slow a turn. */
  private logRescue(role: LlmRole, reason: "empty" | "refusal"): void {
    try {
      const model = this.rescue?.model ?? "rescue model";
      console.warn(`[rescue] ${role} rerouted to ${model} (${reason})`);
    } catch {
      // Best-effort by contract.
    }
  }
}
