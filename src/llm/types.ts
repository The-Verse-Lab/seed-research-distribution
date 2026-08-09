/**
 * LLM gateway types — provider-agnostic, role-based.
 *
 * Four roles are routed independently so you can mix models: a NARRATOR for play-time
 * prose, a CREATIVE writing model for the character builder/NPC-background enrichment, a
 * cheap UTILITY model for intent/state work, and an EMBEDDING model for memory/RAG.
 * There is deliberately no moderation type anywhere in this layer.
 *
 * @author Runkai Zhang
 */

/** The four independently-configurable model roles. */
export type LlmRole = "narrator" | "creative" | "utility" | "embedding";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** 0..2; higher is more random. Provider default if omitted. */
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Ask for strict JSON output where the backend supports it. */
  json?: boolean;
  /**
   * Disable model reasoning/thinking for THIS request (sent as DeepSeek-style
   * `thinking: { type: "disabled" }`), independent of the role's global `ProviderConfig.thinking`.
   * For structured-verdict calls (the Continuity Judge, cast verification) whose tiny JSON output
   * gains nothing from chain-of-thought but would otherwise burn hundreds of tokens on a hybrid
   * reasoning model. Endpoints that don't know the field ignore it. Effective if EITHER this or the
   * role config is "off".
   */
  thinking?: "off";
  /**
   * Serve THIS request with a different model id on the role's endpoint (playtest r9 F-10
   * follow-up): the Continuity Judge shares the `utility` role with the intent classifier, and
   * pointing the whole role at a stronger, slower model to catch drift would tax every
   * classification. A per-request override lets `SEED_JUDGE_MODEL` upgrade only the judge's
   * verdicts. Omitted ⇒ the role's configured model, byte-identical behavior.
   */
  model?: string;
}

export interface CompletionResult {
  text: string;
  /** Best-effort token accounting if the backend reports it. */
  usage?: { promptTokens?: number; completionTokens?: number };
  model: string;
  /**
   * Set by the GuardedGateway when a generation was refused by the minor-safety guard (the one
   * hard line). The text is empty; callers surface a firm OOC refusal and never fall back to
   * other prose. Unset on every normal completion.
   */
  blocked?: boolean;
  /**
   * The raw `finish_reason` the provider reported ("stop", "length", "content_filter", ...), if
   * any. Diagnostic only — nothing in the engine branches on it. Lets a short/truncated
   * completion be told apart post-hoc from a provider-side content filter vs. a plain
   * length/network cutoff, instead of all three looking identical in the logs.
   */
  providerFinishReason?: string;
}

/** A streamed completion delta. */
export interface CompletionChunk {
  /** Incremental visible text since the previous chunk. */
  delta: string;
  /** Incremental reasoning/thinking text (reasoning models), if the backend separates it. */
  reasoning?: string;
  /** Final token usage, if reported (streaming requires stream_options.include_usage). */
  usage?: { promptTokens?: number; completionTokens?: number };
  done: boolean;
  /** Set on the terminal chunk when the minor-safety guard refused the generation. */
  blocked?: boolean;
  /** The raw provider `finish_reason`, if reported — see {@link CompletionResult.providerFinishReason}. */
  providerFinishReason?: string;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
}

/** Per-role endpoint configuration (one entry per role in gateway config). */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Per-request timeout (ms). While streaming, this is an inactivity timeout. */
  timeoutMs?: number;
  /**
   * Ask the endpoint to disable model reasoning/thinking for this role (`SEED_<ROLE>_THINKING=off`).
   * Sent as DeepSeek-style `thinking: { type: "disabled" }`; endpoints that don't know the field
   * ignore it or reject it loudly — the knob is opt-in per rig, absent by default (byte-identical
   * requests). Useful for hybrid reasoning models (deepseek-v4-*) whose thinking otherwise burns
   * hundreds of tokens of budget/latency on small utility calls.
   */
  thinking?: "off";
}
