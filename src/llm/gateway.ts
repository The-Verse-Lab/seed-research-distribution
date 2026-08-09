/**
 * LlmGateway — the single point through which all model access flows.
 *
 * It routes the three roles (narrator / utility / embedding) to independently-configured
 * providers. Prompts and completions otherwise pass through unchanged; the minor-safety guard is
 * composed separately at the application boundary.
 *
 * @author Runkai Zhang
 */
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "./types.ts";

/** A concrete backend bound to a single model (e.g. one OpenAI-compatible endpoint). */
export interface LlmProvider {
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  embed(texts: string[]): Promise<EmbeddingResult>;
}

/** Role-routed access to language and embedding models. */
export interface LlmGateway {
  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult>;
  stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk>;
  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult>;
}

/** Default gateway: a thin role → provider router. No filtering by design. */
export class Gateway implements LlmGateway {
  constructor(private readonly providers: Record<LlmRole, LlmProvider>) {}

  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    return this.providers[role].complete(req);
  }

  stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    return this.providers[role].stream(req);
  }

  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return this.providers[role].embed(texts);
  }
}
