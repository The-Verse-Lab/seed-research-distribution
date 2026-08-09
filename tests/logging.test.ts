/**
 * Logging tests — the gateway decorator and the store's call log.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoggingGateway } from "../src/logging/logging-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionChunk } from "../src/llm/types.ts";
import type { LlmCallRecord, LogSink } from "../src/logging/types.ts";
import { BunSqliteGameStateStore } from "../src/state/sqlite-store.ts";

class CapturingSink implements LogSink {
  records: LlmCallRecord[] = [];
  recordLlmCall(r: LlmCallRecord): void {
    this.records.push(r);
  }
}

/** Fake gateway: a complete() with usage, and a stream() emitting reasoning then content. */
class FakeGateway implements LlmGateway {
  complete() {
    return Promise.resolve({ text: "hello", model: "fake-m", usage: { promptTokens: 5, completionTokens: 2 } });
  }
  async *stream(): AsyncGenerator<CompletionChunk> {
    yield { delta: "", reasoning: "thinking…", done: false };
    yield { delta: "narration ", done: false };
    yield { delta: "here.", done: false };
    yield { delta: "", done: true };
  }
  embed() {
    return Promise.resolve({ vectors: [[0]], model: "fake-e" });
  }
}

describe("LoggingGateway", () => {
  test("records a complete() call with usage and finish", async () => {
    const sink = new CapturingSink();
    const g = new LoggingGateway(new FakeGateway(), sink, "c1", () => "cfg-model");
    const res = await g.complete("utility", { messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("hello");
    expect(sink.records.length).toBe(1);
    const r = sink.records[0]!;
    expect(r.kind).toBe("complete");
    expect(r.responseText).toBe("hello");
    expect(r.completionTokens).toBe(2);
    expect(r.finish).toBe("ok");
    expect(r.campaignId).toBe("c1");
  });

  test("records the `creative` role string verbatim (the Observatory sees who authored what)", async () => {
    const sink = new CapturingSink();
    const g = new LoggingGateway(new FakeGateway(), sink, "c1", () => "cfg-model");
    await g.complete("creative", { messages: [{ role: "user", content: "write a world" }] });
    expect(sink.records.length).toBe(1);
    expect(sink.records[0]!.role).toBe("creative");
    expect(sink.records[0]!.finish).toBe("ok");
  });

  test("records a stream() call, accumulating content and reasoning", async () => {
    const sink = new CapturingSink();
    const g = new LoggingGateway(new FakeGateway(), sink, "c1", () => "cfg-model");
    let out = "";
    for await (const c of g.stream("narrator", { messages: [] })) {
      if (c.delta) out += c.delta;
    }
    expect(out).toBe("narration here.");
    const r = sink.records[0]!;
    expect(r.kind).toBe("stream");
    expect(r.responseText).toBe("narration here.");
    expect(r.reasoningText).toBe("thinking…");
    expect(r.model).toBe("cfg-model");
    expect(r.finish).toBe("ok");
  });
});

describe("store call log", () => {
  const DB = join(tmpdir(), "seed-log-test.db");
  const clean = (): void => {
    for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
  };

  test("records, reads back, and lists campaigns + playset", () => {
    clean();
    const store = new BunSqliteGameStateStore(DB);
    store.recordLlmCall({
      campaignId: "c1",
      at: 1,
      role: "narrator",
      model: "m",
      kind: "stream",
      request: { messages: [] },
      responseText: "hi",
      reasoningText: "think",
      latencyMs: 10,
      finish: "ok",
    });
    const calls = store.readLlmCalls("c1");
    expect(calls.length).toBe(1);
    expect(calls[0]!.responseText).toBe("hi");
    expect(calls[0]!.reasoningText).toBe("think");
    expect(typeof calls[0]!.id).toBe("number");

    store.savePlayset("c1", { world: { name: "W" } });
    expect((store.loadPlayset("c1") as { world: { name: string } }).world.name).toBe("W");
    expect(store.listCampaigns().some((c) => c.campaignId === "c1")).toBe(true);

    store.close();
    clean();
  });
});
