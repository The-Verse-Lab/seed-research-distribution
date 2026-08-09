/**
 * RescueGateway tests — retry-once + uncensored-reroute control flow, with scripted mock
 * gateways (no network, no real model). Asserts: clean completions/streams pass through
 * byte-identical; a transient EMPTY is healed by a single base retry; a persistent
 * empty/refusal reroutes to the rescue provider (when configured) and its text is returned;
 * the stream HOLD-BACK never lets a refusal reach the consumer; non-rescued roles and
 * guard-block sentinels are untouched; and every rescue-path failure degrades to the base
 * result instead of throwing.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { RescueGateway } from "../src/llm/rescue.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../src/llm/types.ts";

const CLEAN =
  "The blade tears through the bandit and blood sprays across the cobblestones of the old market square.";
const REFUSAL =
  "I'm sorry, but I can't continue with this scene. It goes against my guidelines.";
const RESCUE_TEXT = "The narrator leans in and the scene continues, unflinching and vivid.";

const req: CompletionRequest = {
  messages: [
    { role: "system", content: "You are the Game Master." },
    { role: "user", content: "swing the axe" },
  ],
};

/** Split text into small word-ish deltas, ending with a terminal done chunk. */
function chunksOf(text: string, size = 12): CompletionChunk[] {
  const out: CompletionChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({ delta: text.slice(i, i + size), done: false });
  }
  out.push({ delta: "", done: true });
  return out;
}

/** A base gateway scripted per call: the Nth complete/stream serves the Nth script entry. */
class ScriptedBase implements LlmGateway {
  completeCalls = 0;
  streamCalls = 0;
  /** Streams whose generator was closed before yielding every scripted chunk. */
  streamsAbandoned = 0;
  constructor(
    private readonly completions: Partial<CompletionResult>[] = [],
    private readonly streams: CompletionChunk[][] = [],
  ) {}
  complete(_role: LlmRole, _req: CompletionRequest): Promise<CompletionResult> {
    const i = Math.min(this.completeCalls, this.completions.length - 1);
    this.completeCalls += 1;
    const scripted = this.completions[i] ?? {};
    return Promise.resolve({ text: "", model: "base", ...scripted });
  }
  async *stream(_role: LlmRole, _req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const i = Math.min(this.streamCalls, this.streams.length - 1);
    this.streamCalls += 1;
    const script = this.streams[i] ?? [];
    let yielded = 0;
    try {
      for (const chunk of script) {
        yield chunk;
        yielded += 1;
      }
    } finally {
      if (yielded < script.length) this.streamsAbandoned += 1;
    }
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => [0]), model: "base" });
  }
}

/** A rescue endpoint that always answers with fixed text (or is scripted to fail/blank). */
class FakeRescue implements LlmGateway {
  completeCalls = 0;
  streamCalls = 0;
  constructor(
    private readonly text: string = RESCUE_TEXT,
    private readonly failing = false,
  ) {}
  complete(_role: LlmRole, _req: CompletionRequest): Promise<CompletionResult> {
    this.completeCalls += 1;
    if (this.failing) return Promise.reject(new Error("rescue endpoint down"));
    return Promise.resolve({ text: this.text, model: "rescue" });
  }
  async *stream(_role: LlmRole, _req: CompletionRequest): AsyncIterable<CompletionChunk> {
    this.streamCalls += 1;
    if (this.failing) throw new Error("rescue endpoint down");
    yield* chunksOf(this.text);
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => [0]), model: "rescue" });
  }
}

async function collect(
  stream: AsyncIterable<CompletionChunk>,
): Promise<{ text: string; chunks: CompletionChunk[] }> {
  const chunks: CompletionChunk[] = [];
  let text = "";
  for await (const c of stream) {
    chunks.push(c);
    if (c.delta) text += c.delta;
  }
  return { text, chunks };
}

describe("RescueGateway — complete", () => {
  test("a clean completion passes through byte-identical on one base call", async () => {
    const base = new ScriptedBase([{ text: CLEAN, usage: { promptTokens: 3, completionTokens: 7 } }]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue, model: "rescue-9b" });
    const res = await gw.complete("narrator", req);
    expect(res.text).toBe(CLEAN);
    expect(res.model).toBe("base");
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 7 });
    expect(base.completeCalls).toBe(1);
    expect(rescue.completeCalls).toBe(0);
  });

  test("a transient EMPTY is healed by a single base retry (no rescue call)", async () => {
    const base = new ScriptedBase([{ text: "  " }, { text: CLEAN }]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const res = await gw.complete("narrator", req);
    expect(res.text).toBe(CLEAN);
    expect(base.completeCalls).toBe(2);
    expect(rescue.completeCalls).toBe(0);
  });

  test("a persistent refusal reroutes to the rescue provider", async () => {
    const base = new ScriptedBase([{ text: REFUSAL }, { text: REFUSAL }]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue, model: "rescue-9b" });
    const res = await gw.complete("narrator", req);
    expect(res.text).toBe(RESCUE_TEXT);
    expect(res.model).toBe("rescue");
    expect(base.completeCalls).toBe(2);
    expect(rescue.completeCalls).toBe(1);
  });

  test("no rescue configured ⇒ retry a persistent empty EMPTY_RETRIES times; the base result stands", async () => {
    const base = new ScriptedBase([{ text: "" }, { text: "" }, { text: "" }]);
    const gw = new RescueGateway(base);
    const res = await gw.complete("narrator", req);
    expect(res.text).toBe("");
    expect(base.completeCalls).toBe(3); // primary + 2 empty retries (finding #6 reliability bump)
  });

  test("a non-rescued role is untouched: no retry, no rescue, even when empty", async () => {
    const base = new ScriptedBase([{ text: "" }]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const res = await gw.complete("utility", req);
    expect(res.text).toBe("");
    expect(base.completeCalls).toBe(1);
    expect(rescue.completeCalls).toBe(0);
  });

  test("a failing rescue endpoint degrades to the base result — never throws", async () => {
    const base = new ScriptedBase([{ text: REFUSAL }, { text: REFUSAL }]);
    const rescue = new FakeRescue(RESCUE_TEXT, true);
    const gw = new RescueGateway(base, { provider: rescue });
    const res = await gw.complete("narrator", req);
    expect(res.text).toBe(REFUSAL);
    expect(rescue.completeCalls).toBe(1);
  });

  test("an empty rescue answer falls back to the base result", async () => {
    const base = new ScriptedBase([{ text: REFUSAL }, { text: REFUSAL }]);
    const rescue = new FakeRescue("   ");
    const gw = new RescueGateway(base, { provider: rescue });
    const res = await gw.complete("narrator", req);
    expect(res.text).toBe(REFUSAL);
  });

  test("a guard-block sentinel passes through untouched (never rerouted)", async () => {
    const base = new ScriptedBase([{ text: "", model: "guard-blocked", blocked: true }]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const res = await gw.complete("narrator", req);
    expect(res.blocked).toBe(true);
    expect(base.completeCalls).toBe(1);
    expect(rescue.completeCalls).toBe(0);
  });
});

describe("RescueGateway — stream hold-back", () => {
  test("a clean short stream yields the identical chunk sequence", async () => {
    const script = [...chunksOf(CLEAN)];
    script.splice(script.length - 1, 0, {
      delta: "",
      usage: { promptTokens: 3, completionTokens: 7 },
      done: false,
    });
    const base = new ScriptedBase([], [script]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const { text, chunks } = await collect(gw.stream("narrator", req));
    expect(text).toBe(CLEAN);
    expect(chunks).toEqual(script);
    expect(base.streamCalls).toBe(1);
    expect(rescue.streamCalls).toBe(0);
  });

  test("a clean long stream (past the hold-back window) yields an identical concatenation", async () => {
    const long = `${CLEAN} ${CLEAN} ${CLEAN} ${CLEAN}`; // > 300 visible chars
    const base = new ScriptedBase([], [chunksOf(long)]);
    const gw = new RescueGateway(base, { provider: new FakeRescue() });
    const { text } = await collect(gw.stream("narrator", req));
    expect(long.length).toBeGreaterThan(300);
    expect(text).toBe(long);
    expect(base.streamCalls).toBe(1);
  });

  test("a refusal stream never yields the refusal text — the rescue streams instead", async () => {
    const base = new ScriptedBase([], [chunksOf(REFUSAL)]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue, model: "rescue-9b" });
    const { text } = await collect(gw.stream("narrator", req));
    expect(text).toBe(RESCUE_TEXT);
    expect(text).not.toContain("can't continue");
    expect(base.streamCalls).toBe(1); // refusals go straight to the rescue — no base retry
    expect(rescue.streamCalls).toBe(1);
  });

  test("a mid-stream refusal verdict abandons the base stream (stops consuming)", async () => {
    // Pad the refusal past the 300-char window so the verdict fires MID-stream, with chunks left.
    const padded = `${REFUSAL} ${CLEAN} ${CLEAN} ${CLEAN} and the refusal rambles on far beyond the window.`;
    const base = new ScriptedBase([], [chunksOf(padded, 8)]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const { text } = await collect(gw.stream("narrator", req));
    expect(text).toBe(RESCUE_TEXT);
    expect(base.streamsAbandoned).toBe(1);
  });

  test("a transient EMPTY stream is healed by a single base retry", async () => {
    const base = new ScriptedBase([], [[{ delta: "", done: true }], chunksOf(CLEAN)]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const { text } = await collect(gw.stream("narrator", req));
    expect(text).toBe(CLEAN);
    expect(base.streamCalls).toBe(2);
    expect(rescue.streamCalls).toBe(0);
  });

  test("a persistently EMPTY stream reroutes to the rescue after EMPTY_RETRIES retries", async () => {
    const empty: CompletionChunk[] = [{ delta: "", done: true }];
    const base = new ScriptedBase([], [empty, empty, empty]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const { text } = await collect(gw.stream("narrator", req));
    expect(text).toBe(RESCUE_TEXT);
    expect(base.streamCalls).toBe(3); // primary + 2 empty retries (finding #6)
    expect(rescue.streamCalls).toBe(1);
  });

  test("EMPTY stream with no rescue configured ⇒ retry EMPTY_RETRIES times, then the base chunks surface", async () => {
    const empty: CompletionChunk[] = [
      { delta: "", usage: { promptTokens: 3, completionTokens: 0 }, done: false },
      { delta: "", done: true },
    ];
    const base = new ScriptedBase([], [empty, empty, empty]);
    const gw = new RescueGateway(base);
    const { text, chunks } = await collect(gw.stream("narrator", req));
    expect(text).toBe("");
    expect(base.streamCalls).toBe(3); // primary + 2 empty retries
    expect(chunks).toEqual(empty); // the last retried base result is surfaced as-is
  });

  test("reasoning chunks pass through immediately, even when the prose is later rescued", async () => {
    const script: CompletionChunk[] = [
      { delta: "", reasoning: "let me think about whether to comply…", done: false },
      ...chunksOf(REFUSAL),
    ];
    const base = new ScriptedBase([], [script]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const { text, chunks } = await collect(gw.stream("narrator", req));
    expect(chunks[0]?.reasoning).toBe("let me think about whether to comply…");
    expect(text).toBe(RESCUE_TEXT);
  });

  test("a non-rescued role's stream passes through untouched", async () => {
    const empty: CompletionChunk[] = [{ delta: "", done: true }];
    const base = new ScriptedBase([], [empty]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const { chunks } = await collect(gw.stream("utility", req));
    expect(chunks).toEqual(empty);
    expect(base.streamCalls).toBe(1);
    expect(rescue.streamCalls).toBe(0);
  });

  test("a failing rescue stream degrades to the base result — never throws", async () => {
    const empty: CompletionChunk[] = [{ delta: "", done: true }];
    const base = new ScriptedBase([], [empty, empty]);
    const rescue = new FakeRescue(RESCUE_TEXT, true);
    const gw = new RescueGateway(base, { provider: rescue });
    const { text, chunks } = await collect(gw.stream("narrator", req));
    expect(text).toBe("");
    expect(chunks).toEqual(empty);
    expect(rescue.streamCalls).toBe(1);
  });

  test("a guard-blocked chunk passes through untouched (never rerouted)", async () => {
    const blockedStream: CompletionChunk[] = [{ delta: "", done: true, blocked: true }];
    const base = new ScriptedBase([], [blockedStream]);
    const rescue = new FakeRescue();
    const gw = new RescueGateway(base, { provider: rescue });
    const { chunks } = await collect(gw.stream("narrator", req));
    expect(chunks).toEqual(blockedStream);
    expect(base.streamCalls).toBe(1);
    expect(rescue.streamCalls).toBe(0);
  });
});
