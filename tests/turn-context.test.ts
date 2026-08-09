/**
 * Per-turn trace context (Workstream D, slim) — the `AsyncLocalStorage` seam.
 *
 * Two things ride the per-turn scratch across a tick's awaits: the `LoggingGateway` stamps each
 * call with the turn's seq (so the Observatory groups a turn's calls), and the classifier's
 * `onFallback` reports the freeform-fallback reason back into the turn (Workstream G leftover).
 * Outside a scope both degrade silently — telemetry never affects play.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { LoggingGateway } from "../src/logging/logging-gateway.ts";
import { turnContext, type TurnScratch } from "../src/logging/turn-context.ts";
import { makeLlmClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext } from "../src/engine/turn-plan.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type {
  CompletionChunk,
  CompletionResult,
  EmbeddingResult,
} from "../src/llm/types.ts";
import type { LlmCallRecord, LogSink } from "../src/logging/types.ts";

const okInner: LlmGateway = {
  complete: async (): Promise<CompletionResult> => ({ text: "ok", model: "m" }),
  async *stream(): AsyncIterable<CompletionChunk> {
    yield { delta: "ok", done: true };
  },
  embed: async (): Promise<EmbeddingResult> => ({ vectors: [], model: "m" }),
};

const minimalCtx: ClassifierContext = {
  playerActorId: "pc",
  locationId: "loc",
  locationName: "Nowhere",
  exits: [],
  presentEntities: [],
  companionIds: [],
};

describe("turn context (Workstream D)", () => {
  test("the LoggingGateway stamps a call with the turn's seq inside a scope, undefined outside", async () => {
    const captured: LlmCallRecord[] = [];
    const sink: LogSink = { recordLlmCall: (r) => captured.push(r) };
    const logged = new LoggingGateway(okInner, sink, "c1");

    await turnContext.run({ turnSeq: 7 }, () => logged.complete("utility", { messages: [] }));
    expect(captured.at(-1)?.turnSeq).toBe(7);

    await logged.complete("utility", { messages: [] });
    expect(captured.at(-1)?.turnSeq).toBeUndefined();
  });

  test("the classifier's freeform-fallback reason lands on the turn scratch", async () => {
    const failing: LlmGateway = {
      complete: async (): Promise<CompletionResult> => {
        throw new Error("boom");
      },
      async *stream(): AsyncIterable<CompletionChunk> {},
      embed: async (): Promise<EmbeddingResult> => ({ vectors: [], model: "m" }),
    };
    const classifier = makeLlmClassifier(failing, (reason) => {
      const scratch = turnContext.getStore();
      if (scratch) scratch.fallback = reason;
    });

    const scratch: TurnScratch = { turnSeq: 3 };
    const plan = await turnContext.run(scratch, () => classifier.classify("hello", minimalCtx));
    // The safe floor: never a regex guess.
    expect(plan.kind).toBe("freeformNarrative");
    // The reason was carried out of the classifier and onto the turn.
    expect(scratch.fallback).toBe("boom");
  });
});
