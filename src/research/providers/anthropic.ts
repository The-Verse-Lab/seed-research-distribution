/** Raw-HTTP Claude adapter for the controlled research benchmark. */
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
  RESEARCH_MAX_OUTPUT_TOKENS,
  type ResearchHttpProviderOptions,
} from "./shared.ts";

export const ANTHROPIC_RESEARCH_MODEL = "claude-sonnet-5";
export const ANTHROPIC_RESEARCH_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";

export class AnthropicResearchProvider implements ResearchProvider {
  readonly providerId = "anthropic" as const;
  readonly model = ANTHROPIC_RESEARCH_MODEL;

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
      ANTHROPIC_RESEARCH_ENDPOINT,
      {
        method: "POST",
        headers: {
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: RESEARCH_MAX_OUTPUT_TOKENS,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: request.prompt }],
          output_config: {
            effort: "low",
            format: {
              type: "json_schema",
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
    const requestId = result.response.headers.get("request-id") || undefined;
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
    const stopReason = stringField(envelope, "stop_reason");
    const visibleOutput = anthropicVisibleOutput(envelope);
    const usage = anthropicUsage(asRecord(envelope.usage));
    const metadata = {
      ...(returnedModel ? { returnedModel } : {}),
      ...(requestId ? { requestId } : {}),
      ...(responseId ? { responseId } : {}),
      ...(visibleOutput === undefined ? {} : { visibleOutput }),
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

    if (stopReason === "refusal") {
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

    if (stopReason !== "end_turn") {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: "provider-error",
        latencyMs: result.latencyMs,
        errorClass: stopReason === "max_tokens"
          ? "output-truncated"
          : stopReason ? "incomplete-response" : "missing-stop-reason",
        ...metadata,
      });
    }
    if (visibleOutput === undefined) {
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

    const parsed = parseVisibleResearchDecision(visibleOutput, candidateIdSet(request));
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

function anthropicVisibleOutput(envelope: Record<string, unknown>): string | undefined {
  const visible = asArray(envelope.content)
    .map(asRecord)
    .filter((block) => stringField(block, "type") === "text")
    .map((block) => stringField(block, "text"))
    .filter((text): text is string => text !== undefined);
  return visible.length > 0 ? visible.join("") : undefined;
}

function anthropicUsage(usage: Record<string, unknown> | undefined) {
  return makeUsage(
    integerField(usage, "input_tokens"),
    integerField(usage, "output_tokens"),
    integerField(usage, "cache_read_input_tokens"),
  );
}
