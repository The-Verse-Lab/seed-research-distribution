import { describe, expect, test } from "bun:test";
import type {
  ResearchDecisionPacketV1,
  ResearchProviderRequestV1,
} from "../src/research/contracts.ts";
import { renderResearchPrompt, researchPacketId } from "../src/research/prompt.ts";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_RESEARCH_ENDPOINT,
  ANTHROPIC_RESEARCH_MODEL,
  AnthropicResearchProvider,
  GOOGLE_RESEARCH_ENDPOINT,
  GOOGLE_RESEARCH_MODEL,
  GoogleResearchProvider,
  OPENAI_RESEARCH_ENDPOINT,
  OPENAI_RESEARCH_MODEL,
  OpenAIResearchProvider,
  WRAPPED_RESEARCH_DECISION_JSON_SCHEMA,
} from "../src/research/providers/index.ts";

interface CapturedCall {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
}

type FetchResponder = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

function capturingFetch(calls: CapturedCall[], responder: FetchResponder): typeof fetch {
  return (async (input, init) => {
    calls.push({ input, init });
    return responder(input, init);
  }) as typeof fetch;
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestBody(call: CapturedCall): unknown {
  expect(typeof call.init?.body).toBe("string");
  return JSON.parse(call.init?.body as string);
}

function requestHeaders(call: CapturedCall): Headers {
  return new Headers(call.init?.headers);
}

function expectOnePost(call: CapturedCall, endpoint: string): void {
  expect(String(call.input)).toBe(endpoint);
  expect(call.init?.method).toBe("POST");
  expect(call.init?.redirect).toBe("error");
  expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  expect(requestHeaders(call).get("content-type")).toBe("application/json");
}

function expectNoSamplingFields(value: unknown): void {
  const forbidden = new Set(["temperature", "top_p", "top_k", "seed"]);
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      expect(forbidden.has(key)).toBe(false);
      visit(child);
    }
  };
  visit(value);
}

function researchRequest(timeoutMs = 1_000): ResearchProviderRequestV1 {
  const core: Omit<ResearchDecisionPacketV1, "packetId"> = {
    schemaVersion: 1,
    actor: {
      id: "companion-1",
      name: "Aster",
      persona: "A careful cartographer who states only observed facts.",
    },
    controlledGoals: ["Reach the archive without abandoning the player."],
    visibleState: {
      location: "Flooded Causeway",
      clock: "04:30",
      playerInventory: ["brass key"],
      companionInventory: ["dry rope"],
      exits: [{ destination: "North Archive", state: "locked" }],
      task: {
        title: "Open the archive",
        objective: "Reach the catalog room",
        status: "active",
      },
    },
    companionKnownFacts: [{ id: "fact-1", text: "The west stair is flooded." }],
    playerKnownFacts: [{ id: "fact-2", text: "The brass key opens blue doors." }],
    candidates: [{
      candidateId: "candidate-1",
      modality: "inform",
      description: "Tell the player the west stair is flooded.",
    }],
  };
  const packet: ResearchDecisionPacketV1 = {
    ...core,
    packetId: researchPacketId(core),
  };
  return {
    attemptId: "attempt-1",
    prompt: renderResearchPrompt(packet),
    packet,
    timeoutMs,
  };
}

function googleEnvelope(visibleOutput: string, returnedModel = GOOGLE_RESEARCH_MODEL): unknown {
  return {
    responseId: "google-response-1",
    modelVersion: returnedModel,
    candidates: [{
      finishReason: "STOP",
      content: {
        role: "model",
        parts: [
          { thought: true, text: "GOOGLE_PRIVATE_THOUGHT", thoughtSignature: "PRIVATE_SIGNATURE" },
          { text: visibleOutput },
        ],
      },
    }],
    usageMetadata: {
      promptTokenCount: 31,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 3,
    },
    providerEnvelopeSecret: "GOOGLE_ENVELOPE_SECRET",
  };
}

function anthropicEnvelope(visibleOutput: string): unknown {
  return {
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: ANTHROPIC_RESEARCH_MODEL,
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "ANTHROPIC_PRIVATE_THOUGHT", signature: "PRIVATE_SIGNATURE" },
      { type: "text", text: visibleOutput },
    ],
    usage: {
      input_tokens: 41,
      output_tokens: 6,
      cache_read_input_tokens: 4,
    },
    providerEnvelopeSecret: "ANTHROPIC_ENVELOPE_SECRET",
  };
}

function openAIEnvelope(visibleOutput: string, returnedModel = OPENAI_RESEARCH_MODEL): unknown {
  return {
    id: "resp_123",
    object: "response",
    status: "completed",
    model: returnedModel,
    output: [
      {
        id: "rs_123",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "OPENAI_PRIVATE_REASONING" }],
        encrypted_content: "PRIVATE_ENCRYPTED_REASONING",
      },
      {
        id: "msg_456",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: visibleOutput, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 51,
      input_tokens_details: { cached_tokens: 7 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 0 },
    },
    providerEnvelopeSecret: "OPENAI_ENVELOPE_SECRET",
  };
}

describe("research provider raw HTTP request shapes", () => {
  test("Google sends one native structured-output request and retains only safe fields", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = capturingFetch(calls, () => jsonResponse(
      googleEnvelope('{"decision":{"choice":"intervene","candidateId":"candidate-1"}}'),
    ));
    const provider = new GoogleResearchProvider({ apiKey: "google-key", fetch: fetchImpl, now: () => 10 });
    const request = researchRequest();

    const attempt = await provider.decide(request);

    expect(calls).toHaveLength(1);
    expectOnePost(calls[0]!, GOOGLE_RESEARCH_ENDPOINT);
    expect(requestHeaders(calls[0]!).get("x-goog-api-key")).toBe("google-key");
    const body = requestBody(calls[0]!);
    expect(body).toEqual({
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        maxOutputTokens: 256,
        thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false },
        responseFormat: {
          text: {
            mimeType: "application/json",
            schema: WRAPPED_RESEARCH_DECISION_JSON_SCHEMA,
          },
        },
      },
    });
    expect(JSON.stringify(WRAPPED_RESEARCH_DECISION_JSON_SCHEMA)).not.toContain('"const"');
    expect(JSON.stringify(WRAPPED_RESEARCH_DECISION_JSON_SCHEMA)).not.toContain('"minLength"');
    expect(JSON.stringify(WRAPPED_RESEARCH_DECISION_JSON_SCHEMA)).toContain('"enum"');
    expectNoSamplingFields(body);
    expect(attempt).toEqual({
      schemaVersion: 1,
      attemptId: "attempt-1",
      provider: "google",
      configuredModel: GOOGLE_RESEARCH_MODEL,
      returnedModel: GOOGLE_RESEARCH_MODEL,
      status: "valid",
      latencyMs: 0,
      responseId: "google-response-1",
      visibleOutput: '{"decision":{"choice":"intervene","candidateId":"candidate-1"}}',
      parsedDecision: { choice: "intervene", candidateId: "candidate-1" },
      usage: { inputTokens: 31, outputTokens: 7, cachedInputTokens: 3 },
      stopReason: "STOP",
    });
    expect(JSON.stringify(attempt)).not.toContain("PRIVATE");
    expect(JSON.stringify(attempt)).not.toContain("ENVELOPE_SECRET");
  });

  test("Anthropic sends one low-effort, thinking-disabled JSON-schema request", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = capturingFetch(calls, () => jsonResponse(
      anthropicEnvelope('{"decision":{"choice":"abstain"}}'),
      200,
      { "request-id": "anthropic-request-1" },
    ));
    const provider = new AnthropicResearchProvider({ apiKey: "anthropic-key", fetch: fetchImpl, now: () => 20 });
    const request = researchRequest();

    const attempt = await provider.decide(request);

    expect(calls).toHaveLength(1);
    expectOnePost(calls[0]!, ANTHROPIC_RESEARCH_ENDPOINT);
    const headers = requestHeaders(calls[0]!);
    expect(headers.get("x-api-key")).toBe("anthropic-key");
    expect(headers.get("anthropic-version")).toBe(ANTHROPIC_API_VERSION);
    const body = requestBody(calls[0]!);
    expect(body).toEqual({
      model: ANTHROPIC_RESEARCH_MODEL,
      max_tokens: 256,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: request.prompt }],
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: WRAPPED_RESEARCH_DECISION_JSON_SCHEMA,
        },
      },
    });
    expectNoSamplingFields(body);
    expect(attempt).toEqual({
      schemaVersion: 1,
      attemptId: "attempt-1",
      provider: "anthropic",
      configuredModel: ANTHROPIC_RESEARCH_MODEL,
      returnedModel: ANTHROPIC_RESEARCH_MODEL,
      status: "valid",
      latencyMs: 0,
      requestId: "anthropic-request-1",
      responseId: "msg_123",
      visibleOutput: '{"decision":{"choice":"abstain"}}',
      parsedDecision: { choice: "abstain" },
      usage: { inputTokens: 41, outputTokens: 6, cachedInputTokens: 4 },
      stopReason: "end_turn",
    });
    expect(JSON.stringify(attempt)).not.toContain("PRIVATE");
    expect(JSON.stringify(attempt)).not.toContain("ENVELOPE_SECRET");
  });

  test("OpenAI sends one stateless strict Responses request with reasoning disabled", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = capturingFetch(calls, () => jsonResponse(
      openAIEnvelope('{"decision":{"choice":"intervene","candidateId":"candidate-1"}}'),
      200,
      { "x-request-id": "openai-request-1" },
    ));
    const provider = new OpenAIResearchProvider({ apiKey: "openai-key", fetch: fetchImpl, now: () => 30 });
    const request = researchRequest();

    const attempt = await provider.decide(request);

    expect(calls).toHaveLength(1);
    expectOnePost(calls[0]!, OPENAI_RESEARCH_ENDPOINT);
    const headers = requestHeaders(calls[0]!);
    expect(headers.get("authorization")).toBe("Bearer openai-key");
    const body = requestBody(calls[0]!);
    expect(body).toEqual({
      model: OPENAI_RESEARCH_MODEL,
      input: request.prompt,
      max_output_tokens: 256,
      reasoning: { effort: "none" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "research_decision",
          strict: true,
          schema: WRAPPED_RESEARCH_DECISION_JSON_SCHEMA,
        },
      },
    });
    expectNoSamplingFields(body);
    expect(attempt).toEqual({
      schemaVersion: 1,
      attemptId: "attempt-1",
      provider: "openai",
      configuredModel: OPENAI_RESEARCH_MODEL,
      returnedModel: OPENAI_RESEARCH_MODEL,
      status: "valid",
      latencyMs: 0,
      requestId: "openai-request-1",
      responseId: "resp_123",
      visibleOutput: '{"decision":{"choice":"intervene","candidateId":"candidate-1"}}',
      parsedDecision: { choice: "intervene", candidateId: "candidate-1" },
      usage: { inputTokens: 51, outputTokens: 8, cachedInputTokens: 7 },
      stopReason: "completed",
    });
    expect(JSON.stringify(attempt)).not.toContain("PRIVATE");
    expect(JSON.stringify(attempt)).not.toContain("ENVELOPE_SECRET");
  });
});

describe("research provider status normalization", () => {
  test("malformed visible JSON is invalid-json after exactly one call", async () => {
    const calls: CapturedCall[] = [];
    const provider = new GoogleResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => jsonResponse(googleEnvelope("not-json"))),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("invalid-json");
    expect(attempt.errorClass).toBe("invalid-json");
    expect(attempt.parsedDecision).toBeUndefined();
  });

  test("near-miss decisions are invalid-schema rather than being coerced", async () => {
    const malformedDecisions = [
      '{"decision":{"choice":"abstain","candidateId":"candidate-1"}}',
      '{"decision":{"choice":"intervene"}}',
    ];

    for (const visibleOutput of malformedDecisions) {
      const calls: CapturedCall[] = [];
      const provider = new OpenAIResearchProvider({
        apiKey: "key",
        fetch: capturingFetch(calls, () => jsonResponse(openAIEnvelope(visibleOutput))),
      });

      const attempt = await provider.decide(researchRequest());

      expect(calls).toHaveLength(1);
      expect(attempt.status).toBe("invalid-schema");
      expect(attempt.errorClass).toBe("schema-validation-error");
      expect(attempt.parsedDecision).toBeUndefined();
    }
  });

  test("a native Anthropic refusal is normalized without retaining refusal or thinking text", async () => {
    const calls: CapturedCall[] = [];
    const provider = new AnthropicResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => jsonResponse({
        id: "msg_refusal",
        model: ANTHROPIC_RESEARCH_MODEL,
        stop_reason: "refusal",
        content: [
          { type: "thinking", thinking: "REFUSAL_PRIVATE_THOUGHT" },
          { type: "text", text: "REFUSAL_EXPLANATION_MUST_NOT_BE_RETAINED" },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      })),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("refusal");
    expect(attempt.visibleOutput).toBeUndefined();
    expect(attempt.errorClass).toBe("refusal");
    expect(JSON.stringify(attempt)).not.toContain("REFUSAL_");
  });

  test("AbortController timeout is normalized after one fetch invocation", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = capturingFetch(calls, () => new Promise<Response>(() => undefined));
    const provider = new OpenAIResearchProvider({ apiKey: "key", fetch: fetchImpl });

    const attempt = await provider.decide(researchRequest(5));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
    expect(attempt.status).toBe("timeout");
    expect(attempt.errorClass).toBe("timeout");
  });

  test("the same deadline covers a response body that stalls after headers", async () => {
    const calls: CapturedCall[] = [];
    const stalledBody = new ReadableStream<Uint8Array>({ start: () => undefined });
    const provider = new GoogleResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => new Response(stalledBody, { status: 200 })),
    });

    const attempt = await provider.decide(researchRequest(5));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
    expect(attempt.status).toBe("timeout");
    expect(attempt.errorClass).toBe("timeout");
  });

  test("every present Google prompt block reason is a refusal without blocked content", async () => {
    for (const blockReason of ["OTHER", "BLOCK_REASON_UNSPECIFIED"]) {
      const calls: CapturedCall[] = [];
      const provider = new GoogleResearchProvider({
        apiKey: "key",
        fetch: capturingFetch(calls, () => jsonResponse({
          responseId: "blocked-response",
          modelVersion: GOOGLE_RESEARCH_MODEL,
          promptFeedback: { blockReason, blockReasonMessage: "BLOCK_PRIVATE_DETAIL" },
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0 },
        })),
      });

      const attempt = await provider.decide(researchRequest());

      expect(calls).toHaveLength(1);
      expect(attempt.status).toBe("refusal");
      expect(attempt.stopReason).toBe(blockReason);
      expect(attempt.visibleOutput).toBeUndefined();
      expect(JSON.stringify(attempt)).not.toContain("BLOCK_PRIVATE_DETAIL");
    }
  });

  test("HTTP 429 is rate-limit and does not persist the provider error envelope", async () => {
    const calls: CapturedCall[] = [];
    const provider = new GoogleResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => jsonResponse({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "GOOGLE_RATE_LIMIT_SECRET",
          details: [{ private: "GOOGLE_ERROR_DETAIL" }],
        },
      }, 429)),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("rate-limit");
    expect(attempt.errorClass).toBe("rate-limit");
    expect(JSON.stringify(attempt)).not.toContain("SECRET");
    expect(JSON.stringify(attempt)).not.toContain("ERROR_DETAIL");
  });

  test("HTTP 500 is provider-error with only the whitelisted safe error class", async () => {
    const calls: CapturedCall[] = [];
    const provider = new AnthropicResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => jsonResponse({
        type: "error",
        error: { type: "api_error", message: "ANTHROPIC_SERVER_SECRET" },
      }, 500, { "request-id": "request-error-1" })),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("provider-error");
    expect(attempt.errorClass).toBe("provider-internal");
    expect(attempt.requestId).toBe("request-error-1");
    expect(JSON.stringify(attempt)).not.toContain("SERVER_SECRET");
  });

  test("provider-controlled error prose cannot enter errorClass", async () => {
    const calls: CapturedCall[] = [];
    const provider = new OpenAIResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => jsonResponse({
        error: { type: "PRIVATE ERROR TEXT WITH SPACES", message: "SECOND_PRIVATE_DETAIL" },
      }, 500)),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("provider-error");
    expect(attempt.errorClass).toBe("provider-internal");
    expect(JSON.stringify(attempt)).not.toContain("PRIVATE");
  });

  test("a thrown fetch error name cannot enter the normalized attempt", async () => {
    const calls: CapturedCall[] = [];
    const providerError = new Error("PRIVATE_NETWORK_MESSAGE");
    providerError.name = "PRIVATE_NETWORK_ERROR_NAME";
    const provider = new AnthropicResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => {
        throw providerError;
      }),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("provider-error");
    expect(attempt.errorClass).toBe("network-error");
    expect(JSON.stringify(attempt)).not.toContain("PRIVATE");
  });

  test("an exact returned-model mismatch is model-drift", async () => {
    const calls: CapturedCall[] = [];
    const provider = new OpenAIResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => jsonResponse(
        openAIEnvelope('{"decision":{"choice":"abstain"}}', "gpt-5.6-sol-2026-08-01"),
      )),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("model-drift");
    expect(attempt.configuredModel).toBe(OPENAI_RESEARCH_MODEL);
    expect(attempt.returnedModel).toBe("gpt-5.6-sol-2026-08-01");
    expect(attempt.errorClass).toBe("returned-model-mismatch");
    expect(JSON.stringify(attempt)).not.toContain("PRIVATE");
  });

  test("a structurally valid but unlisted candidate is a grounding invalid-schema", async () => {
    const calls: CapturedCall[] = [];
    const provider = new GoogleResearchProvider({
      apiKey: "key",
      fetch: capturingFetch(calls, () => jsonResponse(
        googleEnvelope('{"decision":{"choice":"intervene","candidateId":"candidate-999"}}'),
      )),
    });

    const attempt = await provider.decide(researchRequest());

    expect(calls).toHaveLength(1);
    expect(attempt.status).toBe("invalid-schema");
    expect(attempt.errorClass).toBe("grounding-error");
    expect(attempt.parsedDecision).toBeUndefined();
  });
});
