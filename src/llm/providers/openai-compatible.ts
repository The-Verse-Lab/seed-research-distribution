/**
 * OpenAI-compatible provider — one adapter for most of the ecosystem.
 *
 * Works as-is against Ollama, vLLM, LocalAI, LM Studio, OpenRouter, OpenAI, and remote
 * gateways, because they all speak the `/chat/completions` + `/embeddings` shape. This is
 * what makes the LLM in Seed pluggable: swap the base URL/model in `.env` and nothing else
 * changes. Every request carries a timeout (an inactivity timeout while streaming) so a
 * slow or half-open remote degrades to a thrown error rather than hanging a turn forever.
 *
 * @author Runkai Zhang
 */
import type { LlmProvider } from "../gateway.ts";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  ProviderConfig,
} from "../types.ts";
import { ThinkingFilter, stripThinking } from "../thinking.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Floor for the enlarged budget of the empty-at-length retry (see `complete`). A hybrid reasoning
 * model (deepseek-v4-flash) spends ~400–900 tokens thinking before its first content token, so the
 * retry must clear that band with room for the answer regardless of how small the original cap was.
 */
const EMPTY_LENGTH_RETRY_MIN_TOKENS = 2048;

/** Collapse + cap a server error body so a verbose page can't flood an exception. */
function truncateBody(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly model: string;

  /**
   * Sticky memo: once this model has burned an entire capped budget on reasoning (empty text at
   * finish=length), every later small-capped `complete()` starts at the enlarged budget directly.
   * The doomed small first call is near-deterministic on such models (measured 5/5), so skipping
   * it removes a full round-trip from every small-budget call (summary, npc-history, …).
   * max_tokens is a ceiling, not a target — flooring costs nothing on well-behaved calls.
   * Streams share the memo both ways: a small-capped `stream()` starts at the enlarged budget
   * once it is set, and a stream that ends with zero visible content at finish=length sets it —
   * so the RescueGateway's re-issue of a burned narrator stream runs floored instead of
   * repeating the identical doomed call.
   */
  private reasoningBurns = false;

  constructor(private readonly config: ProviderConfig) {
    this.model = config.model;
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private body(req: CompletionRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model ?? this.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stop: req.stop,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...(req.thinking === "off" || this.config.thinking === "off"
        ? { thinking: { type: "disabled" } }
        : {}),
    });
  }

  /**
   * A hybrid reasoning model can spend the ENTIRE token budget thinking and emit zero content:
   * the completion arrives HTTP-200 with empty text and `finish_reason: "length"` (measured 5/5
   * on deepseek-v4-flash for a 400-token judge call — near-deterministic, not variance). That
   * silent empty poisons whoever asked (the Continuity Judge fails closed and eats good narrator
   * prose; the archivist loses a summary). The signature is precise — a non-reasoning model that
   * hits the length cap has non-empty text — so retry ONCE with an enlarged budget that clears
   * the thinking band. Only fires when the caller set a cap; an uncapped request already ran at
   * the provider default.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.reasoningBurns && req.maxTokens !== undefined && req.maxTokens < EMPTY_LENGTH_RETRY_MIN_TOKENS) {
      req = { ...req, maxTokens: EMPTY_LENGTH_RETRY_MIN_TOKENS };
    }
    const first = await this.completeOnce(req);
    const burned =
      first.text.trim() === "" && first.providerFinishReason === "length" && req.maxTokens !== undefined;
    if (!burned) return first;
    this.reasoningBurns = true;
    const retryBudget = Math.max(EMPTY_LENGTH_RETRY_MIN_TOKENS, (req.maxTokens as number) * 4);
    console.warn(
      `[llm] ${this.model}: empty completion at max_tokens=${req.maxTokens} (finish=length — reasoning burned the budget); retrying at ${retryBudget}`,
    );
    try {
      return await this.completeOnce({ ...req, maxTokens: retryBudget });
    } catch {
      // The retry failed where the first call didn't — surface the original result, never throw anew.
      return first;
    }
  }

  private async completeOnce(req: CompletionRequest): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: this.body(req, false),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`LLM completion failed (${res.status}): ${truncateBody(await res.text())}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const raw = data.choices?.[0]?.message?.content ?? "";
      return {
        // Drop any inline <think>/<thinking> reasoning that some models emit in content.
        text: stripThinking(raw).content,
        model: data.model ?? this.model,
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
        },
        providerFinishReason: data.choices?.[0]?.finish_reason ?? undefined,
      };
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`LLM completion timed out after ${this.timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse one SSE `data:` payload into the chunks to yield (content + reasoning). */
  private *frameChunks(payload: string, filter: ThinkingFilter): Generator<CompletionChunk> {
    try {
      const chunk = JSON.parse(payload) as ChatCompletionChunk;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        // Strip inline <think>/<thinking> tags; route the thinking to `reasoning`.
        const out = filter.push(delta.content);
        if (out.reasoning) yield { delta: "", reasoning: out.reasoning, done: false };
        if (out.content) yield { delta: out.content, done: false };
      }
      // Independent channel: some models stream reasoning in its own frames.
      if (delta?.reasoning_content) yield { delta: "", reasoning: delta.reasoning_content, done: false };
      // The provider's own finish_reason, if this frame carries one (diagnostic passthrough only).
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason) yield { delta: "", providerFinishReason: finishReason, done: false };
      // Final usage frame (stream_options.include_usage); carries no choices.
      if (chunk.usage) {
        yield {
          delta: "",
          usage: { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens },
          done: false,
        };
      }
    } catch {
      // Tolerate keep-alive comments / partial frames.
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    // Same sticky floor as complete(): once a reasoning burn is known, don't run a doomed
    // small-capped stream just to watch the whole budget go to thinking.
    if (this.reasoningBurns && req.maxTokens !== undefined && req.maxTokens < EMPTY_LENGTH_RETRY_MIN_TOKENS) {
      req = { ...req, maxTokens: EMPTY_LENGTH_RETRY_MIN_TOKENS };
    }
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(req, true),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new Error(`LLM stream failed (${res.status}): ${truncateBody(await res.text())}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const filter = new ThinkingFilter();
    let buffer = "";
    // The most recent provider finish_reason seen across frames — carried onto the terminal
    // chunk so a consumer can tell "the model stopped" from "length cap" from "content filter"
    // instead of every short completion looking the same.
    let providerFinishReason: string | undefined;
    // Whether ANY non-whitespace visible content was yielded — the stream-side half of the
    // reasoning-burn signature (mirrors complete()'s `text.trim() === ""`). `see` runs before
    // every visible-delta yield so a new yield path can't silently miss the flag.
    let sawVisible = false;
    const see = (s: string | undefined) => {
      if (s && /\S/.test(s)) sawVisible = true;
    };
    const noteBurn = () => {
      if (!sawVisible && providerFinishReason === "length" && req.maxTokens !== undefined) {
        this.reasoningBurns = true;
      }
    };

    try {
      for (;;) {
        const chunk = await reader.read().catch((err: unknown): never => {
          if (controller.signal.aborted) throw new Error(`LLM stream stalled (no data for ${this.timeoutMs}ms)`);
          throw err;
        });
        if (chunk.done) break;

        // Reset the inactivity timer on every received chunk.
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), this.timeoutMs);

        buffer += decoder.decode(chunk.value, { stream: true });

        // Server-Sent Events: parse complete `data: ...` lines out of the buffer.
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            const tail = filter.flush();
            if (tail.reasoning) yield { delta: "", reasoning: tail.reasoning, done: false };
            if (tail.content) {
              see(tail.content);
              yield { delta: tail.content, done: false };
            }
            noteBurn();
            yield { delta: "", providerFinishReason, done: true };
            return;
          }
          for (const c of this.frameChunks(payload, filter)) {
            if (c.providerFinishReason) providerFinishReason = c.providerFinishReason;
            see(c.delta);
            yield c;
          }
        }
      }

      // Drain the decoder + any final frame that lacked a trailing newline.
      buffer += decoder.decode();
      const last = buffer.trim();
      if (last.startsWith("data:")) {
        const payload = last.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          for (const c of this.frameChunks(payload, filter)) {
            if (c.providerFinishReason) providerFinishReason = c.providerFinishReason;
            see(c.delta);
            yield c;
          }
        }
      }
      const tail = filter.flush();
      if (tail.reasoning) yield { delta: "", reasoning: tail.reasoning, done: false };
      if (tail.content) {
        see(tail.content);
        yield { delta: tail.content, done: false };
      }
      noteBurn();
      yield { delta: "", providerFinishReason, done: true };
    } finally {
      clearTimeout(timer);
      // Tear down the connection on every exit path (normal end, [DONE], throw, early stop).
      void reader.cancel().catch(() => {});
    }
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Embedding failed (${res.status}): ${truncateBody(await res.text())}`);
      }
      const data = (await res.json()) as EmbeddingResponse;
      return {
        vectors: data.data.map((d) => d.embedding),
        model: data.model ?? this.model,
      };
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Embedding timed out after ${this.timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Minimal response shapes (only the fields we read) ---------------------

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface EmbeddingResponse {
  model?: string;
  data: { embedding: number[] }[];
}
