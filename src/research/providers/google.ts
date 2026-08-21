/** Raw-HTTP Gemini adapter for the controlled research benchmark. */
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

export const GOOGLE_RESEARCH_MODEL = "gemini-3.5-flash-lite";
export const GOOGLE_RESEARCH_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_RESEARCH_MODEL}:generateContent`;

const GOOGLE_REFUSAL_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

export class GoogleResearchProvider implements ResearchProvider {
  readonly providerId = "google" as const;
  readonly model = GOOGLE_RESEARCH_MODEL;

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
      GOOGLE_RESEARCH_ENDPOINT,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: {
            maxOutputTokens: 256,
            thinkingConfig: {
              thinkingLevel: "minimal",
              includeThoughts: false,
            },
            responseFormat: {
              text: {
                mimeType: "application/json",
                schema: WRAPPED_RESEARCH_DECISION_JSON_SCHEMA,
              },
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
    if (!result.response.ok) {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: result.response.status === 429 ? "rate-limit" : "provider-error",
        latencyMs: result.latencyMs,
        errorClass: normalizedHttpErrorClass(result.response.status),
      });
    }
    if (!envelope) {
      return this.providerFailure(request, result.latencyMs, "invalid-provider-envelope");
    }

    const candidate = asRecord(asArray(envelope.candidates)[0]);
    const promptFeedback = asRecord(envelope.promptFeedback);
    const usageMetadata = asRecord(envelope.usageMetadata);
    const returnedModel = stringField(envelope, "modelVersion");
    const responseId = stringField(envelope, "responseId");
    const finishReason = stringField(candidate, "finishReason");
    const promptBlockReason = stringField(promptFeedback, "blockReason");
    const stopReason = promptBlockReason ?? finishReason;
    const visibleOutput = googleVisibleOutput(candidate);
    const usage = googleUsage(usageMetadata);
    const metadata = {
      ...(returnedModel ? { returnedModel } : {}),
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

    const promptWasBlocked = promptBlockReason !== undefined;
    if (promptWasBlocked || (finishReason !== undefined && GOOGLE_REFUSAL_REASONS.has(finishReason))) {
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

    if (finishReason !== "STOP") {
      return finalizeAttempt({
        schemaVersion: 1,
        attemptId: request.attemptId,
        provider: this.providerId,
        configuredModel: this.model,
        status: "provider-error",
        latencyMs: result.latencyMs,
        errorClass: finishReason ? "incomplete-response" : "missing-finish-reason",
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
  ): ResearchProviderAttemptV1 {
    return finalizeAttempt({
      schemaVersion: 1,
      attemptId: request.attemptId,
      provider: this.providerId,
      configuredModel: this.model,
      status: "provider-error",
      latencyMs,
      errorClass,
    });
  }
}

function googleVisibleOutput(candidate: Record<string, unknown> | undefined): string | undefined {
  const content = asRecord(candidate?.content);
  const visible = asArray(content?.parts)
    .map(asRecord)
    .filter((part) => part?.thought === undefined || part.thought === false)
    .map((part) => stringField(part, "text"))
    .filter((text): text is string => text !== undefined);
  return visible.length > 0 ? visible.join("") : undefined;
}

function googleUsage(usage: Record<string, unknown> | undefined) {
  const candidates = integerField(usage, "candidatesTokenCount");
  const thoughts = integerField(usage, "thoughtsTokenCount") ?? 0;
  return makeUsage(
    integerField(usage, "promptTokenCount"),
    candidates === undefined ? undefined : candidates + thoughts,
    integerField(usage, "cachedContentTokenCount"),
  );
}
