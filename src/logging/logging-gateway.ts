/**
 * LoggingGateway — a transparent decorator over any LlmGateway that records every call.
 *
 * It captures the full request, the response, and (for streaming) the accumulated content
 * and reasoning, with latency and token usage, into a LogSink. Recording is best-effort:
 * a logging failure never affects the call. This is the seam that gives the Observatory
 * its view into model behavior.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../llm/gateway.ts";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../llm/types.ts";
import type { LlmCallRecord, LogSink } from "./types.ts";
import { turnContext } from "./turn-context.ts";

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class LoggingGateway implements LlmGateway {
  constructor(
    private readonly inner: LlmGateway,
    private readonly sink: LogSink,
    private readonly campaignId: string,
    /** Resolves the configured model name per role (for logging stream calls). */
    private readonly modelFor: (role: LlmRole) => string = () => "",
  ) {}

  private slim(req: CompletionRequest): unknown {
    return { messages: req.messages, temperature: req.temperature, maxTokens: req.maxTokens, json: req.json ?? false };
  }

  private record(rec: Omit<LlmCallRecord, "campaignId" | "at">): void {
    try {
      // Correlate the call to its turn (Workstream D): the per-turn scratch carries the seq the
      // tick opened with. Absent outside a tick scope ⇒ the call is simply left ungrouped.
      const turnSeq = turnContext.getStore()?.turnSeq;
      this.sink.recordLlmCall({ campaignId: this.campaignId, at: Date.now(), turnSeq, ...rec });
    } catch {
      // Logging must never break a call.
    }
  }

  async complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now();
    try {
      const res = await this.inner.complete(role, req);
      this.record({
        role,
        model: res.model || this.modelFor(role),
        kind: "complete",
        request: this.slim(req),
        responseText: res.text,
        reasoningText: "",
        promptTokens: res.usage?.promptTokens,
        completionTokens: res.usage?.completionTokens,
        latencyMs: Date.now() - start,
        finish: res.text ? "ok" : "empty",
        providerFinish: res.providerFinishReason,
      });
      return res;
    } catch (err) {
      this.record({
        role,
        model: this.modelFor(role),
        kind: "complete",
        request: this.slim(req),
        responseText: "",
        reasoningText: "",
        latencyMs: Date.now() - start,
        finish: "error",
        error: msg(err),
      });
      throw err;
    }
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const start = Date.now();
    let content = "";
    let reasoning = "";
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    let finish: LlmCallRecord["finish"] = "ok";
    let providerFinish: string | undefined;
    let error: string | undefined;
    try {
      for await (const chunk of this.inner.stream(role, req)) {
        if (chunk.delta) content += chunk.delta;
        if (chunk.reasoning) reasoning += chunk.reasoning;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.providerFinishReason) providerFinish = chunk.providerFinishReason;
        yield chunk;
      }
      finish = content ? "ok" : "empty";
    } catch (err) {
      finish = "error";
      error = msg(err);
      throw err;
    } finally {
      // Records on every exit: normal completion, error, or early consumer close.
      this.record({
        role,
        model: this.modelFor(role),
        kind: "stream",
        request: this.slim(req),
        responseText: content,
        reasoningText: reasoning,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        latencyMs: Date.now() - start,
        finish,
        providerFinish,
        error,
      });
    }
  }

  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    const start = Date.now();
    return this.inner.embed(role, texts).then(
      (res) => {
        this.record({
          role,
          model: res.model || this.modelFor(role),
          kind: "embed",
          request: { inputs: texts.length },
          responseText: `${res.vectors.length} vector(s)`,
          reasoningText: "",
          latencyMs: Date.now() - start,
          finish: "ok",
        });
        return res;
      },
      (err: unknown) => {
        this.record({
          role,
          model: this.modelFor(role),
          kind: "embed",
          request: { inputs: texts.length },
          responseText: "",
          reasoningText: "",
          latencyMs: Date.now() - start,
          finish: "error",
          error: msg(err),
        });
        throw err;
      },
    );
  }
}
