/**
 * Engine-level safety integration — the player-visible outcomes the guard produces.
 *
 *  1. A blocked generation (gateway returns the block sentinel) ⇒ the engine emits its firm
 *     out-of-character refusal, narrates NOTHING, and does NOT fall through to offline narration.
 *  2. Normal play is NOT over-blocked: a real GuardedGateway wrapping clean prose still yields a
 *     single narration and the turn proceeds normally.
 *
 * Deterministic: mock gateways + seeded rng, no network, no real model. (The uncensored-reroute
 * feature is deferred, so there is no reroute test here.)
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { byKind, kinds, makeEngine } from "./support/harness.ts";
import { GuardedGateway } from "../src/llm/guarded-gateway.ts";
import { MINOR_SAFETY_REFUSAL } from "../src/llm/safety.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../src/llm/types.ts";

const FREEFORM = "I admire the firelight and the worn floorboards.";

/** A gateway that always returns the minor-safety block sentinel. */
class BlockGateway implements LlmGateway {
  complete(_role: LlmRole, _req: CompletionRequest): Promise<CompletionResult> {
    return Promise.resolve({ text: "", model: "guard-blocked", blocked: true });
  }
  async *stream(_role: LlmRole, _req: CompletionRequest): AsyncIterable<CompletionChunk> {
    yield { delta: "", done: true, blocked: true };
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => [0]), model: "block" });
  }
}

const CLEAN_PROSE = "The hearth pops; shadows lean long across the worn floorboards as you settle in.";

/** A base gateway that streams clean narration for every narrator call. */
class CleanGateway implements LlmGateway {
  complete(_role: LlmRole, _req: CompletionRequest): Promise<CompletionResult> {
    return Promise.resolve({ text: CLEAN_PROSE, model: "base" });
  }
  async *stream(_role: LlmRole, _req: CompletionRequest): AsyncIterable<CompletionChunk> {
    yield { delta: CLEAN_PROSE, done: false };
    yield { delta: "", done: true };
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => [0]), model: "base" });
  }
}

describe("engine — minor-safety block", () => {
  test("emits the firm OOC refusal, narrates nothing, and does NOT fall back to offline", async () => {
    const { engine, events } = await makeEngine({ gateway: new BlockGateway() });
    events.length = 0;

    await engine.submitPlayerInput(FREEFORM);

    const sys = byKind(events, "system");
    expect(sys.some((e) => e.message === MINOR_SAFETY_REFUSAL)).toBe(true);
    // No narration at all, and no offline-narrator fallthrough.
    expect(kinds(events)).not.toContain("narration");
    expect(events.every((e) => !("text" in e && String(e.text).includes("Offline narrator")))).toBe(true);
  });
});

describe("engine — normal play is not over-blocked", () => {
  test("a real GuardedGateway over clean prose still narrates the turn", async () => {
    const guard = new GuardedGateway(new CleanGateway(), { judge: null });
    const { engine, events } = await makeEngine({ gateway: guard });
    events.length = 0;

    await engine.submitPlayerInput(FREEFORM);

    const narration = byKind(events, "narration");
    expect(narration.length).toBe(1);
    expect(narration[0]?.text).toBe(CLEAN_PROSE);
    // No safety refusal surfaced.
    expect(byKind(events, "system").some((e) => e.message === MINOR_SAFETY_REFUSAL)).toBe(false);
  });
});
