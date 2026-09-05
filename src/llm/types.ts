/** Minimal type-only surface required by the retained minor-safety model judge. */

export type LlmRole = "utility";
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
}

export interface CompletionChunk {
  delta: string;
  done: boolean;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
}
