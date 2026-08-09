/**
 * Reasoning-burn defenses at the provider layer (live finding #6, r2 playtests).
 *
 * A hybrid reasoning model (deepseek-v4-flash) can spend an entire small max_tokens budget
 * "thinking" and return an HTTP-200 completion with EMPTY content and finish_reason="length"
 * (measured 5/5 on a 400-token continuity-judge call). Downstream that empty poisons the turn:
 * the Judge fails closed and replaces good narrator prose with the trigger echo.
 *
 * Defenses under test:
 *   1. `OpenAICompatibleProvider.complete` retries ONCE with an enlarged budget on exactly the
 *      empty+length signature — and only then.
 *   2. `ProviderConfig.thinking: "off"` sends DeepSeek-style `thinking:{type:"disabled"}`.
 *   3. `loadConfig` parses the per-role SEED_<ROLE>_THINKING knobs (absent by default).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { OpenAICompatibleProvider } from "../src/llm/providers/openai-compatible.ts";
import { loadConfig } from "../src/config/env.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function completionResponse(content: string, finishReason: string): Response {
  return new Response(
    JSON.stringify({
      model: "test-model",
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Install a scripted fetch; returns the captured request bodies (parsed JSON). */
function scriptFetch(responses: Response[]): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return res;
  }) as typeof fetch;
  return bodies;
}

const provider = (thinking?: "off") =>
  new OpenAICompatibleProvider({
    baseUrl: "http://test.local/v1",
    apiKey: "k",
    model: "test-model",
    ...(thinking ? { thinking } : {}),
  });

const REQ = { messages: [{ role: "user" as const, content: "verdict?" }], maxTokens: 400 };

describe("empty-at-length retry (reasoning burned the budget)", () => {
  test("empty content + finish=length ⇒ ONE retry with an enlarged max_tokens", async () => {
    const bodies = scriptFetch([
      completionResponse("", "length"),
      completionResponse('{"violations":[]}', "stop"),
    ]);
    const res = await provider().complete(REQ);
    expect(res.text).toBe('{"violations":[]}');
    expect(bodies.length).toBe(2);
    expect(bodies[0]?.max_tokens).toBe(400);
    // 4× the original, floored at 2048 — clears the measured 400–900-token thinking band.
    expect(bodies[1]?.max_tokens).toBe(2048);
    // Everything else about the request is preserved verbatim.
    expect(bodies[1]?.messages).toEqual(bodies[0]?.messages as unknown[]);
  });

  test("large original budgets scale 4× rather than shrinking to the floor", async () => {
    const bodies = scriptFetch([completionResponse("", "length"), completionResponse("ok", "stop")]);
    await provider().complete({ ...REQ, maxTokens: 1024 });
    expect(bodies[1]?.max_tokens).toBe(4096);
  });

  test("whitespace-only content at finish=length also triggers the retry", async () => {
    const bodies = scriptFetch([completionResponse("  \n ", "length"), completionResponse("ok", "stop")]);
    const res = await provider().complete(REQ);
    expect(res.text).toBe("ok");
    expect(bodies.length).toBe(2);
  });

  test("a <think>-only completion truncated mid-block strips to empty and retries", async () => {
    // Inline-thinking family: the whole budget went inside an unterminated <think> block.
    const bodies = scriptFetch([
      completionResponse("<think>hmm, the cast is Oda and", "length"),
      completionResponse("clean", "stop"),
    ]);
    const res = await provider().complete(REQ);
    expect(res.text).toBe("clean");
    expect(bodies.length).toBe(2);
  });

  test("empty at finish=stop does NOT retry (a genuine no-content answer is the caller's problem)", async () => {
    const bodies = scriptFetch([completionResponse("", "stop")]);
    const res = await provider().complete(REQ);
    expect(res.text).toBe("");
    expect(bodies.length).toBe(1);
  });

  test("non-empty at finish=length does NOT retry (real truncation, not reasoning burn)", async () => {
    const bodies = scriptFetch([completionResponse("The wolf lunges and", "length")]);
    const res = await provider().complete(REQ);
    expect(res.text).toBe("The wolf lunges and");
    expect(bodies.length).toBe(1);
  });

  test("no caller cap ⇒ no retry (the provider default budget was already in effect)", async () => {
    const bodies = scriptFetch([completionResponse("", "length")]);
    const res = await provider().complete({ messages: REQ.messages });
    expect(res.text).toBe("");
    expect(bodies.length).toBe(1);
  });

  test("retry still empty ⇒ returned as-is with only the two calls (no loop)", async () => {
    const bodies = scriptFetch([completionResponse("", "length"), completionResponse("", "length")]);
    const res = await provider().complete(REQ);
    expect(res.text).toBe("");
    expect(res.providerFinishReason).toBe("length");
    expect(bodies.length).toBe(2);
  });

  test("a retry transport failure degrades to the first result instead of throwing", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return completionResponse("", "length");
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const res = await provider().complete(REQ);
    expect(res.text).toBe("");
    expect(res.providerFinishReason).toBe("length");
    expect(calls).toBe(2);
  });
});

describe("sticky burn memo (a model that burned once skips the doomed small call)", () => {
  test("after one burn, the next small-capped call starts at the enlarged budget in ONE round-trip", async () => {
    const p = provider();
    scriptFetch([completionResponse("", "length"), completionResponse("ok", "stop")]);
    await p.complete(REQ); // burn observed → memo set
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    const res = await p.complete({ ...REQ, maxTokens: 60 });
    expect(res.text).toBe("ok");
    expect(bodies.length).toBe(1);
    expect(bodies[0]?.max_tokens).toBe(2048);
  });

  test("caps at or above the floor pass through untouched", async () => {
    const p = provider();
    scriptFetch([completionResponse("", "length"), completionResponse("ok", "stop")]);
    await p.complete(REQ);
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await p.complete({ ...REQ, maxTokens: 3000 });
    expect(bodies[0]?.max_tokens).toBe(3000);
  });

  test("uncapped requests stay uncapped after a burn", async () => {
    const p = provider();
    scriptFetch([completionResponse("", "length"), completionResponse("ok", "stop")]);
    await p.complete(REQ);
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await p.complete({ messages: REQ.messages });
    expect("max_tokens" in (bodies[0] ?? {})).toBe(false);
  });

  test("a provider instance that never burned keeps original caps (memo is per-instance)", async () => {
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await provider().complete({ ...REQ, maxTokens: 60 });
    expect(bodies[0]?.max_tokens).toBe(60);
  });

  test("a floored call that still burns retries once at 4× the floor", async () => {
    const p = provider();
    scriptFetch([completionResponse("", "length"), completionResponse("ok", "stop")]);
    await p.complete(REQ); // memo set
    const bodies = scriptFetch([completionResponse("", "length"), completionResponse("deep", "stop")]);
    const res = await p.complete({ ...REQ, maxTokens: 400 });
    expect(res.text).toBe("deep");
    expect(bodies[0]?.max_tokens).toBe(2048);
    expect(bodies[1]?.max_tokens).toBe(8192);
  });
});

// --- Stream-side memo (the narrator path) -----------------------------------

/** One SSE data frame carrying a delta and (optionally) a finish_reason. */
const sseFrame = (
  delta: { content?: string; reasoning_content?: string },
  finish?: string,
): string => `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;

function sseResponse(frames: string[]): Response {
  return new Response([...frames, "data: [DONE]\n\n"].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drainStream(p: OpenAICompatibleProvider, req: Parameters<OpenAICompatibleProvider["complete"]>[0]): Promise<string> {
  let text = "";
  for await (const c of p.stream(req)) text += c.delta;
  return text;
}

describe("sticky burn memo — stream path", () => {
  test("a reasoning-only stream ending finish=length sets the memo (next small complete() is floored)", async () => {
    const p = provider();
    scriptFetch([sseResponse([sseFrame({ reasoning_content: "hmm…" }), sseFrame({}, "length")])]);
    const text = await drainStream(p, REQ);
    expect(text).toBe("");
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await p.complete({ ...REQ, maxTokens: 60 });
    expect(bodies[0]?.max_tokens).toBe(2048);
  });

  test("after a burn, a small-capped stream request carries the enlarged budget", async () => {
    const p = provider();
    scriptFetch([completionResponse("", "length"), completionResponse("ok", "stop")]);
    await p.complete(REQ); // memo set via complete()
    const bodies = scriptFetch([sseResponse([sseFrame({ content: "prose" }), sseFrame({}, "stop")])]);
    const text = await drainStream(p, { ...REQ, maxTokens: 1024 });
    expect(text).toBe("prose");
    expect(bodies[0]?.max_tokens).toBe(2048);
  });

  test("a stream that produced visible content at finish=length does NOT set the memo (real truncation)", async () => {
    const p = provider();
    scriptFetch([sseResponse([sseFrame({ content: "The wolf lunges and" }), sseFrame({}, "length")])]);
    const text = await drainStream(p, REQ);
    expect(text).toBe("The wolf lunges and");
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await p.complete({ ...REQ, maxTokens: 60 });
    expect(bodies[0]?.max_tokens).toBe(60);
  });

  test("an empty UNCAPPED stream at finish=length does not set the memo", async () => {
    const p = provider();
    scriptFetch([sseResponse([sseFrame({ reasoning_content: "hmm" }), sseFrame({}, "length")])]);
    await drainStream(p, { messages: REQ.messages });
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await p.complete({ ...REQ, maxTokens: 60 });
    expect(bodies[0]?.max_tokens).toBe(60);
  });

  test("post-burn stream caps at/above the floor and uncapped streams pass through untouched", async () => {
    const p = provider();
    scriptFetch([completionResponse("", "length"), completionResponse("ok", "stop")]);
    await p.complete(REQ); // memo set
    let bodies = scriptFetch([sseResponse([sseFrame({ content: "x" }), sseFrame({}, "stop")])]);
    await drainStream(p, { ...REQ, maxTokens: 3000 });
    expect(bodies[0]?.max_tokens).toBe(3000);
    bodies = scriptFetch([sseResponse([sseFrame({ content: "x" }), sseFrame({}, "stop")])]);
    await drainStream(p, { messages: REQ.messages });
    expect("max_tokens" in (bodies[0] ?? {})).toBe(false);
  });

  test("a <think>-only stream truncated mid-block (no visible content) sets the memo", async () => {
    const p = provider();
    scriptFetch([sseResponse([sseFrame({ content: "<think>the cast is Oda and" }), sseFrame({}, "length")])]);
    const text = await drainStream(p, REQ);
    expect(text).toBe("");
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await p.complete({ ...REQ, maxTokens: 60 });
    expect(bodies[0]?.max_tokens).toBe(2048);
  });
});

describe('ProviderConfig.thinking: "off"', () => {
  test("sends DeepSeek-style thinking:{type:'disabled'} on completions", async () => {
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await provider("off").complete(REQ);
    expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
  });

  test("absent by default — the request body carries no thinking field", async () => {
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await provider().complete(REQ);
    expect("thinking" in (bodies[0] ?? {})).toBe(false);
  });
});

describe("SEED_<ROLE>_THINKING env knobs", () => {
  test("absent ⇒ no thinking override on any role", () => {
    const cfg = loadConfig({});
    expect(cfg.gateway.narrator.thinking).toBeUndefined();
    expect(cfg.gateway.creative.thinking).toBeUndefined();
    expect(cfg.gateway.utility.thinking).toBeUndefined();
  });

  test("SEED_UTILITY_THINKING=off disables thinking for the utility role only", () => {
    const cfg = loadConfig({ SEED_UTILITY_THINKING: "off" });
    expect(cfg.gateway.utility.thinking).toBe("off");
    expect(cfg.gateway.narrator.thinking).toBeUndefined();
    expect(cfg.gateway.creative.thinking).toBeUndefined();
  });

  test("off-tokens are case-insensitive and cover 0/false/no/disabled", () => {
    for (const v of ["off", "OFF", "0", "false", "No", "disabled"]) {
      expect(loadConfig({ SEED_NARRATOR_THINKING: v }).gateway.narrator.thinking).toBe("off");
    }
    // Anything else (including "on") leaves the request untouched.
    expect(loadConfig({ SEED_NARRATOR_THINKING: "on" }).gateway.narrator.thinking).toBeUndefined();
  });

  test("the rescue route accepts its own knob", () => {
    const cfg = loadConfig({ SEED_RESCUE_BASE_URL: "http://r.local/v1", SEED_RESCUE_THINKING: "off" });
    expect(cfg.rescue?.thinking).toBe("off");
    const bare = loadConfig({ SEED_RESCUE_BASE_URL: "http://r.local/v1" });
    expect(bare.rescue?.thinking).toBeUndefined();
  });

  test("thinking is per-role, NOT inherited through the narrator fallback chain", () => {
    const cfg = loadConfig({ SEED_NARRATOR_THINKING: "off" });
    expect(cfg.gateway.narrator.thinking).toBe("off");
    // Utility/creative inherit the narrator ENDPOINT, never its thinking behavior.
    expect(cfg.gateway.utility.thinking).toBeUndefined();
    expect(cfg.gateway.creative.thinking).toBeUndefined();
  });
});

describe("per-request model override (r9 F-10 follow-up — SEED_JUDGE_MODEL)", () => {
  test("a request-level model id replaces the role's configured model in the wire body", async () => {
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await provider().complete({ ...REQ, model: "deepseek-v4-pro" });
    expect(bodies[0]?.model).toBe("deepseek-v4-pro");
  });

  test("omitted ⇒ the configured model, byte-identical", async () => {
    const bodies = scriptFetch([completionResponse("ok", "stop")]);
    await provider().complete(REQ);
    expect(bodies[0]?.model).toBe("test-model");
  });

  test("SEED_JUDGE_MODEL lands on config.judgeModel; unset stays absent", () => {
    expect(loadConfig({ SEED_JUDGE_MODEL: "deepseek-v4-pro" }).judgeModel).toBe("deepseek-v4-pro");
    expect(loadConfig({}).judgeModel).toBeUndefined();
  });
});
