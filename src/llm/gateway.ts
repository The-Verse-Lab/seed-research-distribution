/** Minimal model-judge boundary retained solely by the non-bypassable minor-safety guard. */
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "./types.ts";

/** Optional judge access. The research provider runtime does not use or compose this interface. */
export interface LlmGateway {
  complete(role: LlmRole, request: CompletionRequest): Promise<CompletionResult>;
  stream(role: LlmRole, request: CompletionRequest): AsyncIterable<CompletionChunk>;
  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult>;
}
