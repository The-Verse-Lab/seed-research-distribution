/** Vendor-verified pricing and conservative exact cost projections for live research. */
import { z } from "zod";
import { ResearchUsageV1Schema } from "../contracts.ts";
import {
  ANTHROPIC_RESEARCH_MODEL,
  GOOGLE_RESEARCH_MODEL,
  OPENAI_RESEARCH_MODEL,
} from "../providers/index.ts";
import {
  DEFAULT_RESEARCH_BUDGET_USD,
  ResearchBudget,
  type UsdInput,
  normalizeUsd,
} from "./budget.ts";

export const RESEARCH_PRICING_RETRIEVED_DATE = "2026-08-21";
export const RESEARCH_MAX_OUTPUT_TOKENS = 256;
/**
 * Per-call allowance for schema compilation and provider-injected structured-output instructions.
 * Anthropic documents that its injected JSON-output prompt is billable; this deliberately large
 * allowance keeps the pre-dispatch reservation conservative without relying on hidden tokenizers.
 */
export const RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND = 12_000;
export const RESEARCH_PILOT_CELL_COUNT = 144;
export const RESEARCH_PILOT_REPLICATES = 5;
export const RESEARCH_PILOT_PROVIDER_COUNT = 3;
export const RESEARCH_PILOT_CALL_COUNT = 2_160;

export const ResearchPricingProviderSchema = z.enum(["google", "anthropic", "openai"]);
export type ResearchPricingProvider = z.infer<typeof ResearchPricingProviderSchema>;

const PricingEntryBaseSchema = z.object({
  pricingBasis: z.literal("standard-uncached-text"),
  inputUsdPerMillionTokens: z.string().regex(/^\d+(?:\.\d+)?$/),
  outputUsdPerMillionTokens: z.string().regex(/^\d+(?:\.\d+)?$/),
  sourceUrl: z.string().url(),
  retrievedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const GooglePricingEntrySchema = PricingEntryBaseSchema.extend({
  provider: z.literal("google"),
  model: z.literal(GOOGLE_RESEARCH_MODEL),
  inputUsdPerMillionTokens: z.literal("0.30"),
  outputUsdPerMillionTokens: z.literal("2.50"),
  sourceUrl: z.literal("https://ai.google.dev/gemini-api/docs/pricing"),
  retrievedDate: z.literal(RESEARCH_PRICING_RETRIEVED_DATE),
}).strict();

export const AnthropicPricingEntrySchema = PricingEntryBaseSchema.extend({
  provider: z.literal("anthropic"),
  model: z.literal(ANTHROPIC_RESEARCH_MODEL),
  inputUsdPerMillionTokens: z.literal("2.00"),
  outputUsdPerMillionTokens: z.literal("10.00"),
  sourceUrl: z.literal("https://platform.claude.com/docs/en/about-claude/pricing"),
  retrievedDate: z.literal(RESEARCH_PRICING_RETRIEVED_DATE),
}).strict();

export const OpenAIPricingEntrySchema = PricingEntryBaseSchema.extend({
  provider: z.literal("openai"),
  model: z.literal(OPENAI_RESEARCH_MODEL),
  inputUsdPerMillionTokens: z.literal("5.00"),
  outputUsdPerMillionTokens: z.literal("30.00"),
  sourceUrl: z.literal("https://developers.openai.com/api/docs/models/gpt-5.6-sol"),
  retrievedDate: z.literal(RESEARCH_PRICING_RETRIEVED_DATE),
}).strict();

export const ResearchPricingSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  artifactKind: z.literal("seed.research.pricing-snapshot"),
  currency: z.literal("USD"),
  unit: z.literal("per-million-tokens"),
  providers: z.tuple([
    GooglePricingEntrySchema,
    AnthropicPricingEntrySchema,
    OpenAIPricingEntrySchema,
  ]),
}).strict();

export type ResearchPricingSnapshotV1 = z.infer<typeof ResearchPricingSnapshotV1Schema>;
export type ResearchPricingEntryV1 = ResearchPricingSnapshotV1["providers"][number];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const RESEARCH_PRICING_SNAPSHOT_V1: Readonly<ResearchPricingSnapshotV1> = deepFreeze(
  ResearchPricingSnapshotV1Schema.parse({
    schemaVersion: 1,
    artifactKind: "seed.research.pricing-snapshot",
    currency: "USD",
    unit: "per-million-tokens",
    providers: [
      {
        provider: "google",
        model: GOOGLE_RESEARCH_MODEL,
        pricingBasis: "standard-uncached-text",
        inputUsdPerMillionTokens: "0.30",
        outputUsdPerMillionTokens: "2.50",
        sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
        retrievedDate: RESEARCH_PRICING_RETRIEVED_DATE,
      },
      {
        provider: "anthropic",
        model: ANTHROPIC_RESEARCH_MODEL,
        pricingBasis: "standard-uncached-text",
        inputUsdPerMillionTokens: "2.00",
        outputUsdPerMillionTokens: "10.00",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        retrievedDate: RESEARCH_PRICING_RETRIEVED_DATE,
      },
      {
        provider: "openai",
        model: OPENAI_RESEARCH_MODEL,
        pricingBasis: "standard-uncached-text",
        inputUsdPerMillionTokens: "5.00",
        outputUsdPerMillionTokens: "30.00",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
        retrievedDate: RESEARCH_PRICING_RETRIEVED_DATE,
      },
    ],
  }),
);

export interface ResearchTokenCostV1 {
  schemaVersion: 1;
  currency: "USD";
  provider: ResearchPricingProvider;
  model: string;
  basis: "actual-safe-usage-at-full-rates" | "prompt-bytes-plus-fixed-overhead-bound";
  inputTokens: number;
  outputTokens: number;
  inputCostNanoUsd: string;
  outputCostNanoUsd: string;
  totalCostNanoUsd: string;
  totalCostUsd: string;
}

export interface ProjectedResearchCallCostV1 extends ResearchTokenCostV1 {
  basis: "prompt-bytes-plus-fixed-overhead-bound";
  promptUtf8Bytes: number;
  inputOverheadTokenBound: typeof RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND;
  maxOutputTokens: typeof RESEARCH_MAX_OUTPUT_TOKENS;
}

export interface ActualResearchCallCostV1 extends ResearchTokenCostV1 {
  basis: "actual-safe-usage-at-full-rates";
}

export interface ResearchPilotProviderProjectionV1 {
  provider: ResearchPricingProvider;
  model: string;
  callCount: number;
  inputTokenUpperBound: number;
  outputTokenUpperBound: number;
  totalCostNanoUsd: string;
  totalCostUsd: string;
}

export interface ResearchPilotCostProjectionV1 {
  schemaVersion: 1;
  currency: "USD";
  hardCapUsd: string;
  cellCount: typeof RESEARCH_PILOT_CELL_COUNT;
  providerCount: typeof RESEARCH_PILOT_PROVIDER_COUNT;
  replicatesPerCell: typeof RESEARCH_PILOT_REPLICATES;
  callCount: typeof RESEARCH_PILOT_CALL_COUNT;
  maxOutputTokens: typeof RESEARCH_MAX_OUTPUT_TOKENS;
  inputOverheadTokenBound: typeof RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND;
  promptUtf8BytesPerReplicate: number;
  byProvider: Record<ResearchPricingProvider, ResearchPilotProviderProjectionV1>;
  totalCostNanoUsd: string;
  totalCostUsd: string;
}

function pricingFor(provider: ResearchPricingProvider): ResearchPricingEntryV1 {
  const entry = RESEARCH_PRICING_SNAPSHOT_V1.providers.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`Missing frozen pricing for research provider: ${provider}`);
  return entry;
}

/** Convert an exact decimal USD/MTok rate to integer nano-USD/token. */
function nanoUsdPerToken(pricePerMillion: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(pricePerMillion);
  if (!match?.[1]) throw new Error(`Unsupported pricing precision: ${pricePerMillion}`);
  const thousandths = (match[2] ?? "").padEnd(3, "0");
  return BigInt(match[1]) * 1_000n + BigInt(thousandths || "0");
}

function assertTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function usdFromNano(nanoUsd: bigint): string {
  const whole = nanoUsd / 1_000_000_000n;
  const fraction = (nanoUsd % 1_000_000_000n).toString().padStart(9, "0");
  return normalizeUsd(`${whole}.${fraction}`);
}

function tokenCost(
  provider: ResearchPricingProvider,
  inputTokens: number,
  outputTokens: number,
  basis: ResearchTokenCostV1["basis"],
): ResearchTokenCostV1 {
  assertTokenCount(inputTokens, "Input token count");
  assertTokenCount(outputTokens, "Output token count");
  const pricing = pricingFor(provider);
  const inputNano = BigInt(inputTokens) * nanoUsdPerToken(pricing.inputUsdPerMillionTokens);
  const outputNano = BigInt(outputTokens) * nanoUsdPerToken(pricing.outputUsdPerMillionTokens);
  const totalNano = inputNano + outputNano;
  return {
    schemaVersion: 1,
    currency: "USD",
    provider,
    model: pricing.model,
    basis,
    inputTokens,
    outputTokens,
    inputCostNanoUsd: inputNano.toString(),
    outputCostNanoUsd: outputNano.toString(),
    totalCostNanoUsd: totalNano.toString(),
    totalCostUsd: usdFromNano(totalNano),
  };
}

/** Bill every observed input token at the uncached rate, even when cache usage is reported. */
export function calculateActualResearchCost(
  providerValue: ResearchPricingProvider,
  usageValue: unknown,
): ActualResearchCallCostV1 {
  const provider = ResearchPricingProviderSchema.parse(providerValue);
  const usage = ResearchUsageV1Schema.parse(usageValue);
  assertTokenCount(usage.inputTokens, "Safe usage inputTokens");
  assertTokenCount(usage.outputTokens, "Safe usage outputTokens");
  if (usage.cachedInputTokens !== undefined) {
    assertTokenCount(usage.cachedInputTokens, "Safe usage cachedInputTokens");
    if (usage.cachedInputTokens > usage.inputTokens) {
      throw new RangeError("Safe usage cachedInputTokens cannot exceed inputTokens");
    }
  }
  return {
    ...tokenCost(provider, usage.inputTokens, usage.outputTokens, "actual-safe-usage-at-full-rates"),
    basis: "actual-safe-usage-at-full-rates",
  };
}

/**
 * UTF-8 bytes bound the public prompt's tokens; the fixed overhead allowance covers the native
 * request schema and provider-injected structured-output instructions that may also be billed.
 */
export function projectResearchCallCost(
  providerValue: ResearchPricingProvider,
  prompt: string,
): ProjectedResearchCallCostV1 {
  const provider = ResearchPricingProviderSchema.parse(providerValue);
  if (typeof prompt !== "string") throw new TypeError("Research prompt must be a string");
  const promptUtf8Bytes = new TextEncoder().encode(prompt).byteLength;
  const cost = tokenCost(
    provider,
    promptUtf8Bytes + RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND,
    RESEARCH_MAX_OUTPUT_TOKENS,
    "prompt-bytes-plus-fixed-overhead-bound",
  );
  return {
    ...cost,
    basis: "prompt-bytes-plus-fixed-overhead-bound",
    promptUtf8Bytes,
    inputOverheadTokenBound: RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND,
    maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
  };
}

/**
 * Project all 144 cells × five replicates × three providers and reserve the total
 * against the hard cap before any dispatch is authorized.
 */
export function projectResearchPilotCost(
  prompts: readonly string[],
  hardCapUsd: UsdInput = DEFAULT_RESEARCH_BUDGET_USD,
  priorCommittedUsd: UsdInput = "0",
): ResearchPilotCostProjectionV1 {
  if (prompts.length !== RESEARCH_PILOT_CELL_COUNT) {
    throw new Error(`Research pilot projection requires exactly ${RESEARCH_PILOT_CELL_COUNT} cell prompts`);
  }
  let promptUtf8BytesPerReplicate = 0;
  for (const prompt of prompts) {
    if (typeof prompt !== "string") throw new TypeError("Every research pilot prompt must be a string");
    promptUtf8BytesPerReplicate += new TextEncoder().encode(prompt).byteLength;
  }
  assertTokenCount(promptUtf8BytesPerReplicate, "Pilot prompt UTF-8 byte total");

  const byProvider = {} as Record<ResearchPricingProvider, ResearchPilotProviderProjectionV1>;
  let totalNano = 0n;
  for (const provider of ResearchPricingProviderSchema.options) {
    const callCount = RESEARCH_PILOT_CELL_COUNT * RESEARCH_PILOT_REPLICATES;
    const inputTokenUpperBound = promptUtf8BytesPerReplicate * RESEARCH_PILOT_REPLICATES +
      callCount * RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND;
    const outputTokenUpperBound = callCount * RESEARCH_MAX_OUTPUT_TOKENS;
    const cost = tokenCost(
      provider,
      inputTokenUpperBound,
      outputTokenUpperBound,
      "prompt-bytes-plus-fixed-overhead-bound",
    );
    totalNano += BigInt(cost.totalCostNanoUsd);
    byProvider[provider] = {
      provider,
      model: cost.model,
      callCount,
      inputTokenUpperBound,
      outputTokenUpperBound,
      totalCostNanoUsd: cost.totalCostNanoUsd,
      totalCostUsd: cost.totalCostUsd,
    };
  }

  const totalCostUsd = usdFromNano(totalNano);
  const budget = new ResearchBudget({ capUsd: hardCapUsd, committedUsd: priorCommittedUsd });
  budget.reserve("full-2160-call-pilot", totalCostUsd);
  return {
    schemaVersion: 1,
    currency: "USD",
    hardCapUsd: budget.snapshot().capUsd,
    cellCount: RESEARCH_PILOT_CELL_COUNT,
    providerCount: RESEARCH_PILOT_PROVIDER_COUNT,
    replicatesPerCell: RESEARCH_PILOT_REPLICATES,
    callCount: RESEARCH_PILOT_CALL_COUNT,
    maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
    inputOverheadTokenBound: RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND,
    promptUtf8BytesPerReplicate,
    byProvider,
    totalCostNanoUsd: totalNano.toString(),
    totalCostUsd,
  };
}
