/** Raw-HTTP Responses API adapter for the controlled research benchmark. */
import type {
  ResearchProvider,
  ResearchProviderAttemptV1,
  ResearchProviderRequestV1,
  ResearchProviderErrorClassV1,
} from "../contracts.ts";
import {
  WRAPPED_RESEARCH_DECISION_JSON_SCHEMA,
  asArray,
  asRecord,
  assertProviderOptions,
  candidateIdSet,
  fetchExactlyOnce,
  finalizeAttempt,
  integerField,
  makeUsage,
  normalizedHttpErrorClass,
  parseJsonRecord,
  parseProviderRequest,
  parseVisibleResearchDecision,
  stringField,
  type ResearchHttpProviderOptions,
} from "./shared.ts";

export const OPENAI_RESEARCH_MODEL = "gpt-5.6-sol";
export const OPENAI_RESEARCH_ENDPOINT = "https://api.openai.com/v1/responses";

export class OpenAIResearchProvider implements ResearchProvider {
  readonly providerId = "openai" as const;
  readonly model = OPENAI_RESEARCH_MODEL;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: ResearchHttpProviderOptions) {
    assertProviderOptions(options);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
  }

  async decide(requestValue: ResearchProviderRequestV1): Promise<ResearchProviderAttemptV1> {
    const request = parseProviderRequest(requestValue);
    const result = await fetchExactlyOnce(
      this.fetchImpl,
      OPENAI_RESEARCH_ENDPOINT,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
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
        }),
      },
      request.timeoutMs,
      this.now,
    );

    if (result.kind !== "response") {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: result.kind === "timeout" ? "timeout" : "provider-error",
        latencyMs: result.latencyMs,
        errorClass: result.kind === "timeout" ? "timeout" : result.errorClass,
      });
    }

    const envelope = parseJsonRecord(result.bodyText);
    const requestId = result.response.headers.get("x-request-id") || undefined;
    if (!result.response.ok) {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: result.response.status === 429 ? "rate-limit" : "provider-error",
        latencyMs: result.latencyMs,
        ...(requestId ? { requestId } : {}),
        errorClass: normalizedHttpErrorClass(result.response.status),
      });
    }
    if (!envelope) {
      return this.providerFailure(request, result.latencyMs, "invalid-provider-envelope", requestId);
    }

    const returnedModel = stringField(envelope, "model");
    const responseId = stringField(envelope, "id");
    const responseStatus = stringField(envelope, "status");
    const visible = openAIVisibleOutput(envelope);
    const usage = openAIUsage(asRecord(envelope.usage));
    const incompleteReason = stringField(asRecord(envelope.incomplete_details), "reason");
    const stopReason = responseStatus === "completed"
      ? "completed"
      : incompleteReason ?? responseStatus;
    const metadata = {
      ...(returnedModel ? { returnedModel } : {}),
      ...(requestId ? { requestId } : {}),
      ...(responseId ? { responseId } : {}),
      ...(visible.text === undefined ? {} : { visibleOutput: visible.text }),
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stopReason } : {}),
    };

    if (returnedModel !== this.model) {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: "model-drift",
        latencyMs: result.latencyMs,
        errorClass: returnedModel ? "returned-model-mismatch" : "missing-returned-model",
        ...metadata,
      });
    }

    if (visible.refused) {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: "refusal",
        latencyMs: result.latencyMs,
        errorClass: "refusal",
        ...metadata,
        visibleOutput: undefined,
      });
    }

    if (responseStatus !== "completed") {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: "provider-error",
        latencyMs: result.latencyMs,
        errorClass: responseStatus ? "incomplete-response" : "missing-response-status",
        ...metadata,
      });
    }
    if (visible.text === undefined) {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: "provider-error",
        latencyMs: result.latencyMs,
        errorClass: "missing-visible-output",
        ...metadata,
      });
    }

    const parsed = parseVisibleResearchDecision(visible.text, candidateIdSet(request));
    return finalizeAttempt({
      schemaVersion: 1,
      attemptId: request.attemptId,
      provider: this.providerId,
      configuredModel: this.model,
      status: parsed.status,
      latencyMs: result.latencyMs,
      ...metadata,
      ...(parsed.parsedDecision ? { parsedDecision: parsed.parsedDecision } : {}),
      ...(parsed.errorClass ? { errorClass: parsed.errorClass } : {}),
    });
  }

  private providerFailure(
    request: ResearchProviderRequestV1,
    latencyMs: number,
    errorClass: ResearchProviderErrorClassV1,
    requestId?: string,
  ): ResearchProviderAttemptV1 {
    return finalizeAttempt({
      schemaVersion: 1,
      attemptId: request.attemptId,
      provider: this.providerId,
      configuredModel: this.model,
      status: "provider-error",
      latencyMs,
      ...(requestId ? { requestId } : {}),
      errorClass,
    });
  }
}

interface OpenAIVisibleOutput {
  text?: string;
  refused: boolean;
}

function openAIVisibleOutput(envelope: Record<string, unknown>): OpenAIVisibleOutput {
  const text: string[] = [];
  let refused = false;

  for (const itemValue of asArray(envelope.output)) {
    const item = asRecord(itemValue);
    if (stringField(item, "type") !== "message") continue;
    for (const blockValue of asArray(item?.content)) {
      const block = asRecord(blockValue);
      const type = stringField(block, "type");
      if (type === "output_text") {
        const value = stringField(block, "text");
        if (value !== undefined) text.push(value);
      } else if (type === "refusal") {
        refused = true;
      }
    }
  }

  return {
    ...(text.length > 0 ? { text: text.join("") } : {}),
    refused,
  };
}

function openAIUsage(usage: Record<string, unknown> | undefined) {
  const inputDetails = asRecord(usage?.input_tokens_details);
  return makeUsage(
    integerField(usage, "input_tokens"),
    integerField(usage, "output_tokens"),
    integerField(inputDetails, "cached_tokens"),
  );
}
