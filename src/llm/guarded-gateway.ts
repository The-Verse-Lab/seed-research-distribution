/**
 * GuardedGateway — the single enforcement point for the minor-safety guard.
 *
 * Composed as `LoggingGateway( GuardedGateway( base ) )` so the generative roles flow through it
 * and nothing bypasses it. The SCREENED ROLES are exactly {`narrator`, `creative`} — the two
 * generative prose paths (play: GM narration + NPC dialogue + autonomous beats; authoring:
 * worldsmith elaboration, builders, NPC-background enrichment). `utility` and `embedding` pass
 * straight through — importantly, the model judge calls `complete("utility")` on the BASE
 * gateway, so screening only the prose roles keeps the judge from recursing back through the
 * guard.
 *
 * INVARIANT: the safety boundary IS the screened-role set {`narrator`, `creative`}. Any path that
 * produces player-visible prose MUST request one of them (never `utility`/`embedding`), or it
 * bypasses this guard entirely. `utility` is reserved for non-visible work (intent
 * classification, the safety judge) and is intentionally unscreened. The visible-prose agents are
 * pinned to screened roles, and `tests/visible-prose-role.test.ts` locks that so a future
 * refactor can't silently move a visible generation onto an unguarded role.
 *
 * For a screened-role `complete`/`stream` the pipeline is:
 *   1. INPUT screen — if the request's current action would produce minor-sexual content, block
 *      immediately and call no model at all (return the block sentinel).
 *   2. PRIMARY — run the base gateway (streaming is BUFFERED internally: raw tokens are not
 *      surfaced, which also closes the player-voice streaming hole; raw reasoning/CoT is withheld
 *      and replaced by a single content-free "thinking" signal so the UX indicator still fires).
 *   3. OUTPUT screen — the deterministic detector + optional model judge on the buffered text; if
 *      it sexualizes a minor, block (discard the text).
 *   4. Else re-emit the approved text as word chunks.
 *
 * The minor-safety guard is ALWAYS ON and reads no env flag, prefix, or world data — there is no
 * toggle that disables it. (Retry/reroute behavior lives in a separate `RescueGateway`, composed
 * OUTSIDE this guard in `src/config/env.ts` so rerouted output is screened too; this file is guard-only.)
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
import {
  applyJudge,
  screenInput,
  screenOutput,
  type SafetyContext,
  type SafetyJudge,
} from "./safety.ts";
import { ACTION_MARKERS } from "../util/markers.ts";
import { chunkWords } from "../util/text.ts";

const BLOCKED_MODEL = "guard-blocked";

/**
 * The trailing window (chars) held back from live release while streaming, so a partial — and
 * possibly sexual — token is never surfaced before the deterministic screen has seen it whole.
 * Comfortably exceeds the longest safety token/phrase, so any sexual signal is fully buffered (and
 * therefore detected → the release freezes) before its start position could ever be released.
 */
const RELEASE_HOLDBACK_CHARS = 64;

/**
 * Index just past the last whitespace at or before `limit`, but never before `from`; returns `from`
 * when the span holds no whole word yet. Releasing only up to a word boundary keeps spacing
 * byte-exact once the streamed slices are concatenated back into the full text.
 */
function wordBoundaryBefore(text: string, from: number, limit: number): number {
  if (limit <= from) return from;
  for (let i = limit - 1; i >= from; i--) {
    if (/\s/.test(text[i]!)) return i + 1;
  }
  return from;
}

/** The guard's screened-role set: every generative-prose role. Extending it only ever ADDS screening. */
const SCREENED_ROLES: ReadonlySet<LlmRole> = new Set(["narrator", "creative"]);

/**
 * True when the minor-safety guard screens this role. Exported so the invariant tests can lock
 * the set itself, not just the behavior on one role.
 */
export function isScreenedRole(role: LlmRole): boolean {
  return SCREENED_ROLES.has(role);
}

export interface GuardedGatewayOptions {
  /** Model judge for the output screen (additive; only ever adds a block). Null/omitted = off. */
  judge?: SafetyJudge | null;
  /** Supplies the present characters' known ages each screen (declared-minor protection). */
  getContext?: () => SafetyContext | undefined;
}

export class GuardedGateway implements LlmGateway {
  private readonly judge: SafetyJudge | null;
  private getContext: () => SafetyContext | undefined;

  constructor(
    private readonly inner: LlmGateway,
    opts: GuardedGatewayOptions = {},
  ) {
    this.judge = opts.judge ?? null;
    this.getContext = opts.getContext ?? (() => undefined);
  }

  /** Wire the live present-character context (declared ages) after the engine exists. */
  setContextProvider(fn: () => SafetyContext | undefined): void {
    this.getContext = fn;
  }

  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return this.inner.embed(role, texts);
  }

  async complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    if (!isScreenedRole(role)) return this.inner.complete(role, req);

    const blocked = this.inputBlock(req);
    if (blocked) return blocked;

    const primary = await this.inner.complete(role, req);
    return this.finish({
      text: primary.text,
      usage: primary.usage,
      model: primary.model,
      providerFinishReason: primary.providerFinishReason,
    });
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (!isScreenedRole(role)) {
      yield* this.inner.stream(role, req);
      return;
    }

    if (this.inputBlock(req)) {
      yield { delta: "", done: true, blocked: true };
      return;
    }

    // PROGRESSIVE RELEASE with a safety freeze. The player sees the beat's prose token-by-token
    // instead of a dead-air wall — BUT only its deterministically-safe, NON-SEXUAL lead-in is
    // released live. The instant the deterministic screen sees a SEXUAL signal in the buffer we
    // FREEZE the release point: everything from there is held and goes through the full output
    // screen + optional model judge at stream end (released in one burst only if it clears). A hard
    // deterministic block anywhere stops immediately, emitting nothing more. Because EVERY
    // minor-safety block requires a sexual signal, the released prefix is always non-sexual and thus
    // never the flagged content — no token of a blocked or explicit passage ever streams, preserving
    // the deterministic guarantee verbatim while only the fuzzy judge becomes a retract-at-end.
    // Raw reasoning/CoT is still withheld (it can restate blocked content) — a single content-free
    // "thinking" signal fires the UX indicator.
    const ctx = this.getContext();
    let text = "";
    let released = 0;
    let frozen = false;
    let usage: CompletionResult["usage"];
    let providerFinishReason: string | undefined;
    let thinkingSignaled = false;
    for await (const chunk of this.inner.stream(role, req)) {
      if (chunk.reasoning && !thinkingSignaled) {
        thinkingSignaled = true;
        yield { delta: "", reasoning: "…", done: false };
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.providerFinishReason) providerFinishReason = chunk.providerFinishReason;
      if (!chunk.delta) continue;
      text += chunk.delta;
      if (frozen) continue;

      const verdict = screenOutput(text, ctx);
      if (!verdict.allowed) {
        // Deterministic minor-safety block. Nothing flagged has been released — the freeze below
        // stops the instant any sexual signal appears, so the block is reached before it could.
        yield { delta: "", done: true, blocked: true };
        return;
      }
      if (verdict.sexual) {
        // Sexual content is present: from here the beat can only become minor-sexual through the
        // fuzzy judge, which needs the whole text. Stop live release; hold the rest for finish().
        frozen = true;
        continue;
      }
      // Release the confirmed-safe, non-sexual prefix up to a whole-word boundary, holding back the
      // trailing window so no partial (possibly-sexual) token escapes before it is fully screened.
      const cut = wordBoundaryBefore(text, released, text.length - RELEASE_HOLDBACK_CHARS);
      if (cut > released) {
        for (const word of chunkWords(text.slice(released, cut))) yield { delta: word, done: false };
        released = cut;
      }
    }

    // Stream ended: the full output screen + optional judge on the COMPLETE text (unchanged policy).
    const result = await this.finish({ text, usage, model: "", providerFinishReason });
    if (result.blocked) {
      yield { delta: "", done: true, blocked: true };
      return;
    }
    // Flush whatever is still unreleased — the held-back tail plus any frozen explicit portion the
    // judge just cleared — preserving spacing, then a terminal usage frame.
    for (const word of chunkWords(result.text.slice(released))) yield { delta: word, done: false };
    yield { delta: "", usage: result.usage, providerFinishReason: result.providerFinishReason, done: true };
  }

  // --- pipeline internals --------------------------------------------------

  /**
   * Isolate the player's current-action text from the (possibly long, context-laden) brief by
   * screening everything from the EARLIEST action marker onward. The player's input only ever
   * lands after the engine's first `# NOW`, so this both excludes the recent transcript/lore
   * (no over-block) AND captures the whole action even if the player injects a later fake `# NOW`
   * (no under-block) — the malicious text still falls inside the screened span.
   */
  private inputScreenText(messages: CompletionRequest["messages"]): string {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const content = last?.content ?? messages.map((m) => m.content).join("\n\n");
    let cut = -1;
    for (const marker of ACTION_MARKERS) {
      const i = content.indexOf(marker);
      if (i >= 0 && (cut < 0 || i < cut)) cut = i;
    }
    return cut >= 0 ? content.slice(cut) : content;
  }

  /** Step 1: deterministic input screen. Returns a block sentinel result, or null to proceed. */
  private inputBlock(req: CompletionRequest): CompletionResult | null {
    // Declared-minor participants (ctx) are screened regardless of distance; the text screen
    // targets the current action only, so recent transcript / world lore can't over-block.
    const action = this.inputScreenText(req.messages);
    const verdict = screenInput([{ role: "user", content: action }], this.getContext());
    return verdict.allowed ? null : this.blockResult();
  }

  /** Step 3: the output screen (deterministic + optional model judge) on the buffered text. */
  private async finish(primary: {
    text: string;
    usage: CompletionResult["usage"];
    model: string;
    providerFinishReason?: string;
  }): Promise<CompletionResult> {
    const ctx = this.getContext();
    const det = screenOutput(primary.text, ctx);
    const verdict = await applyJudge(det, primary.text, this.judge, ctx);
    if (!verdict.allowed) return this.blockResult();
    return {
      text: primary.text,
      usage: primary.usage,
      model: primary.model,
      providerFinishReason: primary.providerFinishReason,
    };
  }

  private blockResult(): CompletionResult {
    return { text: "", model: BLOCKED_MODEL, blocked: true };
  }
}
