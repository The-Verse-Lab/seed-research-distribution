/** Shared, provider-neutral machinery for one-shot research HTTP adapters. */
import {
  ResearchProviderAttemptV1Schema,
  ResearchProviderRequestV1Schema,
  parseResearchDecision,
  type ResearchDecision,
  type ResearchProviderErrorClassV1,
  type ResearchProviderAttemptV1,
  type ResearchProviderRequestV1,
} from "../contracts.ts";

export interface ResearchHttpProviderOptions {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
}

export type ResearchUsageV1 = NonNullable<ResearchProviderAttemptV1["usage"]>;

/**
 * All three strict-output APIs accept a root object with a nested union. OpenAI specifically
 * rejects a union at the schema root, so the public decision union is wrapped consistently for
 * every provider and unwrapped before `parseResearchDecision`. The discriminators use `enum`
 * instead of JSON Schema `const`, and the schema omits string `minLength`, because Gemini's
 * documented structured-output subset does not include those keywords. The exact Zod domain
 * contract remains authoritative after decoding.
 */
export const WRAPPED_RESEARCH_DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      anyOf: [
        {
          type: "object",
          properties: {
            choice: { type: "string", enum: ["abstain"] },
          },
          required: ["choice"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            choice: { type: "string", enum: ["intervene"] },
            candidateId: { type: "string" },
          },
          required: ["choice", "candidateId"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["decision"],
  additionalProperties: false,
} as const;

export interface SingleHttpResponse {
  kind: "response";
  response: Response;
  bodyText: string;
  latencyMs: number;
}

export interface SingleHttpFailure {
  kind: "timeout" | "network-error";
  latencyMs: number;
  errorClass: ResearchProviderErrorClassV1;
}

export type SingleHttpResult = SingleHttpResponse | SingleHttpFailure;

export function assertProviderOptions(options: ResearchHttpProviderOptions): void {
  if (!options.apiKey) throw new Error("Research provider API key is required");
  if (typeof options.fetch !== "function") throw new Error("Research provider fetch implementation is required");
}

export function parseProviderRequest(value: ResearchProviderRequestV1): ResearchProviderRequestV1 {
  return ResearchProviderRequestV1Schema.parse(value);
}

/** Performs exactly one fetch invocation. No retry, fallback, redirect following, or SDK is used. */
export async function fetchExactlyOnce(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
  now: () => number,
): Promise<SingleHttpResult> {
  const controller = new AbortController();
  let timedOut = false;
  const startedAt = now();
  let rejectDeadline: (reason: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(new DOMException("Research provider request timed out", "AbortError"));
  }, timeoutMs);

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      }),
      deadline,
    ]);
    const bodyText = await Promise.race([response.text(), deadline]);
    return {
      kind: "response",
      response,
      bodyText,
      latencyMs: elapsedMs(startedAt, now()),
    };
  } catch {
    return {
      kind: timedOut || controller.signal.aborted ? "timeout" : "network-error",
      latencyMs: elapsedMs(startedAt, now()),
      errorClass: timedOut || controller.signal.aborted ? "timeout" : "network-error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function integerField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function normalizedHttpErrorClass(status: number): ResearchProviderErrorClassV1 {
  switch (status) {
    case 400:
    case 422:
      return "invalid-request";
    case 401:
      return "authentication-error";
    case 403:
      return "permission-error";
    case 404:
      return "not-found";
    case 408:
    case 504:
      return "provider-timeout";
    case 409:
      return "conflict";
    case 413:
      return "request-too-large";
    case 429:
      return "rate-limit";
    case 500:
      return "provider-internal";
    case 502:
    case 503:
      return "provider-unavailable";
    default:
      return "http-error";
  }
}

export function makeUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cachedInputTokens?: number,
): ResearchUsageV1 | undefined {
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

export interface VisibleDecisionResult {
  status: "valid" | "invalid-json" | "invalid-schema";
  parsedDecision?: ResearchDecision;
  errorClass?: ResearchProviderErrorClassV1;
}

export function parseVisibleResearchDecision(
  visibleOutput: string,
  candidateIds: ReadonlySet<string>,
): VisibleDecisionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(visibleOutput);
  } catch {
    return { status: "invalid-json", errorClass: "invalid-json" };
  }

  const wrapper = asRecord(parsed);
  if (!wrapper || Object.keys(wrapper).length !== 1 || !("decision" in wrapper)) {
    return { status: "invalid-schema", errorClass: "schema-validation-error" };
  }

  try {
    return {
      status: "valid",
      parsedDecision: parseResearchDecision(wrapper.decision, candidateIds),
    };
  } catch (error) {
    const grounding = error instanceof Error && error.message.startsWith("Unknown candidateId:");
    return {
      status: "invalid-schema",
      errorClass: grounding ? "grounding-error" : "schema-validation-error",
    };
  }
}

export function candidateIdSet(request: ResearchProviderRequestV1): ReadonlySet<string> {
  return new Set(request.packet.candidates.map((candidate) => candidate.candidateId));
}

export function finalizeAttempt(value: ResearchProviderAttemptV1): ResearchProviderAttemptV1 {
  return ResearchProviderAttemptV1Schema.parse(value);
}

function elapsedMs(startedAt: number, endedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, Math.round(endedAt - startedAt));
}
