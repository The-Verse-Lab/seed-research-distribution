/** Versioned redacted local configuration and frozen live-run manifest. */
import { z } from "zod";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_RESEARCH_ENDPOINT,
  ANTHROPIC_RESEARCH_MODEL,
  GOOGLE_RESEARCH_ENDPOINT,
  GOOGLE_RESEARCH_MODEL,
  OPENAI_RESEARCH_ENDPOINT,
  OPENAI_RESEARCH_MODEL,
} from "../providers/index.ts";
import { DEFAULT_RESEARCH_BUDGET_USD, normalizeUsd } from "./budget.ts";
import {
  AnthropicPricingEntrySchema,
  GooglePricingEntrySchema,
  OpenAIPricingEntrySchema,
  RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND,
  RESEARCH_MAX_OUTPUT_TOKENS,
  RESEARCH_PILOT_CALL_COUNT,
  RESEARCH_PILOT_CELL_COUNT,
  RESEARCH_PILOT_PROVIDER_COUNT,
  RESEARCH_PILOT_REPLICATES,
  RESEARCH_PRICING_SNAPSHOT_V1,
} from "./pricing.ts";

export const RESEARCH_BOOTSTRAP_RESAMPLES = 10_000;
export const RESEARCH_MAX_IN_FLIGHT_PER_PROVIDER = 1;

const GoogleLocalProviderSchema = z.object({
  provider: z.literal("google"),
  model: z.literal(GOOGLE_RESEARCH_MODEL),
  apiKeyEnv: z.literal("GOOGLE_API_KEY"),
}).strict();

const AnthropicLocalProviderSchema = z.object({
  provider: z.literal("anthropic"),
  model: z.literal(ANTHROPIC_RESEARCH_MODEL),
  apiKeyEnv: z.literal("ANTHROPIC_API_KEY"),
}).strict();

const OpenAILocalProviderSchema = z.object({
  provider: z.literal("openai"),
  model: z.literal(OPENAI_RESEARCH_MODEL),
  apiKeyEnv: z.literal("OPENAI_API_KEY"),
}).strict();

/** Local configuration contains references to environment variables, never their values. */
export const ResearchModelManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  artifactKind: z.literal("seed.research.local-model-manifest"),
  providers: z.tuple([
    GoogleLocalProviderSchema,
    AnthropicLocalProviderSchema,
    OpenAILocalProviderSchema,
  ]),
}).strict();

export type ResearchModelManifestV1 = z.infer<typeof ResearchModelManifestV1Schema>;

const GoogleRunProviderSchema = z.object({
  provider: z.literal("google"),
  configuredModel: z.literal(GOOGLE_RESEARCH_MODEL),
  apiKeyEnv: z.literal("GOOGLE_API_KEY"),
  endpoint: z.literal(GOOGLE_RESEARCH_ENDPOINT),
  protocol: z.literal("google.generateContent.v1beta"),
  reasoningConfig: z.object({
    thinkingLevel: z.literal("minimal"),
    includeThoughts: z.literal(false),
  }).strict(),
  pricing: GooglePricingEntrySchema,
  smokeReturnedModel: z.literal(GOOGLE_RESEARCH_MODEL).optional(),
}).strict();

const AnthropicRunProviderSchema = z.object({
  provider: z.literal("anthropic"),
  configuredModel: z.literal(ANTHROPIC_RESEARCH_MODEL),
  apiKeyEnv: z.literal("ANTHROPIC_API_KEY"),
  endpoint: z.literal(ANTHROPIC_RESEARCH_ENDPOINT),
  protocol: z.literal(`anthropic.messages.${ANTHROPIC_API_VERSION}`),
  reasoningConfig: z.object({
    effort: z.literal("low"),
    thinkingMode: z.literal("disabled"),
  }).strict(),
  pricing: AnthropicPricingEntrySchema,
  smokeReturnedModel: z.literal(ANTHROPIC_RESEARCH_MODEL).optional(),
}).strict();

const OpenAIRunProviderSchema = z.object({
  provider: z.literal("openai"),
  configuredModel: z.literal(OPENAI_RESEARCH_MODEL),
  apiKeyEnv: z.literal("OPENAI_API_KEY"),
  endpoint: z.literal(OPENAI_RESEARCH_ENDPOINT),
  protocol: z.literal("openai.responses.v1"),
  reasoningConfig: z.object({
    effort: z.literal("none"),
    store: z.literal(false),
  }).strict(),
  pricing: OpenAIPricingEntrySchema,
  smokeReturnedModel: z.literal(OPENAI_RESEARCH_MODEL).optional(),
}).strict();

const UnsignedSeedSchema = z.number().int().min(0).max(0xffff_ffff);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const CanonicalUsdSchema = z.string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/)
  .refine((value) => normalizeUsd(value) === value, "USD amount must be canonical");

export const ResearchRunManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  artifactKind: z.literal("seed.research.live-manifest"),
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  providers: z.tuple([
    GoogleRunProviderSchema,
    AnthropicRunProviderSchema,
    OpenAIRunProviderSchema,
  ]),
  design: z.object({
    schedulerSeed: UnsignedSeedSchema,
    bootstrapSeed: UnsignedSeedSchema,
    bootstrapResamples: z.literal(RESEARCH_BOOTSTRAP_RESAMPLES),
    cellCount: z.literal(RESEARCH_PILOT_CELL_COUNT),
    providerCount: z.literal(RESEARCH_PILOT_PROVIDER_COUNT),
    replicatesPerCell: z.literal(RESEARCH_PILOT_REPLICATES),
    totalCallCount: z.literal(RESEARCH_PILOT_CALL_COUNT),
    maxOutputTokens: z.literal(RESEARCH_MAX_OUTPUT_TOKENS),
    inputOverheadTokenBound: z.literal(RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND),
    timeoutMs: z.number().int().positive(),
    maxInFlightPerProvider: z.literal(RESEARCH_MAX_IN_FLIGHT_PER_PROVIDER),
  }).strict(),
  budget: z.object({
    currency: z.literal("USD"),
    hardCapUsd: z.literal(DEFAULT_RESEARCH_BUDGET_USD),
    priorCommittedUsd: CanonicalUsdSchema,
  }).strict(),
  source: z.object({
    suiteHash: Sha256Schema,
    qualificationHash: Sha256Schema,
    git: z.object({
      commit: GitCommitSchema,
      dirty: z.literal(false),
    }).strict(),
    runtime: z.object({
      bun: z.string().min(1).nullable(),
      node: z.string().min(1),
    }).strict(),
  }).strict(),
}).strict();

export type ResearchRunManifestV1 = z.infer<typeof ResearchRunManifestV1Schema>;

const BuildResearchRunManifestOptionsSchema = z.object({
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  schedulerSeed: UnsignedSeedSchema,
  bootstrapSeed: UnsignedSeedSchema,
  timeoutMs: z.number().int().positive(),
  priorCommittedUsd: CanonicalUsdSchema.optional(),
  suiteHash: Sha256Schema,
  qualificationHash: Sha256Schema,
  git: z.object({
    commit: GitCommitSchema,
    dirty: z.literal(false),
  }).strict(),
  runtime: z.object({
    bun: z.string().min(1).nullable(),
    node: z.string().min(1),
  }).strict(),
  smokeReturnedModels: z.object({
    google: z.string().min(1).optional(),
    anthropic: z.string().min(1).optional(),
    openai: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export interface BuildResearchRunManifestV1Options {
  localManifest: unknown;
  runId: string;
  generatedAt: string;
  schedulerSeed: number;
  bootstrapSeed: number;
  timeoutMs: number;
  /** Spend already committed by the separately verified smoke package. */
  priorCommittedUsd?: string;
  suiteHash: string;
  qualificationHash: string;
  git: { commit: string; dirty: false };
  runtime: { bun: string | null; node: string };
  smokeReturnedModels?: Partial<Record<"google" | "anthropic" | "openai", string>>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseResearchModelManifestV1(value: unknown): ResearchModelManifestV1 {
  return ResearchModelManifestV1Schema.parse(value);
}

/** Validate presence only; no API key value is returned, logged, serialized, or included in errors. */
export function assertResearchApiKeyEnvironment(
  manifestValue: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const manifest = parseResearchModelManifestV1(manifestValue);
  const missing = manifest.providers
    .map((provider) => provider.apiKeyEnv)
    .filter((name) => {
      const value = environment[name];
      return typeof value !== "string" || value.trim().length === 0;
    });
  if (missing.length > 0) {
    throw new Error(`Missing required research API environment variables: ${missing.join(", ")}`);
  }
}

/** Build a deterministic, deeply frozen, credential-free manifest for one live run. */
export function buildResearchRunManifestV1(
  optionsValue: BuildResearchRunManifestV1Options,
): Readonly<ResearchRunManifestV1> {
  const localManifest = parseResearchModelManifestV1(optionsValue.localManifest);
  const { localManifest: _localManifest, ...metadataValue } = optionsValue;
  const options = BuildResearchRunManifestOptionsSchema.parse(metadataValue);
  const expectedModels = {
    google: GOOGLE_RESEARCH_MODEL,
    anthropic: ANTHROPIC_RESEARCH_MODEL,
    openai: OPENAI_RESEARCH_MODEL,
  } as const;
  for (const provider of localManifest.providers) {
    const returnedModel = options.smokeReturnedModels?.[provider.provider];
    if (returnedModel !== undefined && returnedModel !== expectedModels[provider.provider]) {
      throw new Error(
        `Smoke returned model drift for ${provider.provider}: expected ${expectedModels[provider.provider]}, received ${returnedModel}`,
      );
    }
  }

  const pricing = RESEARCH_PRICING_SNAPSHOT_V1.providers;
  const manifest = ResearchRunManifestV1Schema.parse({
    schemaVersion: 1,
    artifactKind: "seed.research.live-manifest",
    runId: options.runId,
    generatedAt: options.generatedAt,
    providers: [
      {
        provider: "google",
        configuredModel: localManifest.providers[0].model,
        apiKeyEnv: localManifest.providers[0].apiKeyEnv,
        endpoint: GOOGLE_RESEARCH_ENDPOINT,
        protocol: "google.generateContent.v1beta",
        reasoningConfig: { thinkingLevel: "minimal", includeThoughts: false },
        pricing: pricing[0],
        ...(options.smokeReturnedModels?.google
          ? { smokeReturnedModel: options.smokeReturnedModels.google }
          : {}),
      },
      {
        provider: "anthropic",
        configuredModel: localManifest.providers[1].model,
        apiKeyEnv: localManifest.providers[1].apiKeyEnv,
        endpoint: ANTHROPIC_RESEARCH_ENDPOINT,
        protocol: `anthropic.messages.${ANTHROPIC_API_VERSION}`,
        reasoningConfig: { effort: "low", thinkingMode: "disabled" },
        pricing: pricing[1],
        ...(options.smokeReturnedModels?.anthropic
          ? { smokeReturnedModel: options.smokeReturnedModels.anthropic }
          : {}),
      },
      {
        provider: "openai",
        configuredModel: localManifest.providers[2].model,
        apiKeyEnv: localManifest.providers[2].apiKeyEnv,
        endpoint: OPENAI_RESEARCH_ENDPOINT,
        protocol: "openai.responses.v1",
        reasoningConfig: { effort: "none", store: false },
        pricing: pricing[2],
        ...(options.smokeReturnedModels?.openai
          ? { smokeReturnedModel: options.smokeReturnedModels.openai }
          : {}),
      },
    ],
    design: {
      schedulerSeed: options.schedulerSeed,
      bootstrapSeed: options.bootstrapSeed,
      bootstrapResamples: RESEARCH_BOOTSTRAP_RESAMPLES,
      cellCount: RESEARCH_PILOT_CELL_COUNT,
      providerCount: RESEARCH_PILOT_PROVIDER_COUNT,
      replicatesPerCell: RESEARCH_PILOT_REPLICATES,
      totalCallCount: RESEARCH_PILOT_CALL_COUNT,
      maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
      inputOverheadTokenBound: RESEARCH_INPUT_OVERHEAD_TOKEN_BOUND,
      timeoutMs: options.timeoutMs,
      maxInFlightPerProvider: RESEARCH_MAX_IN_FLIGHT_PER_PROVIDER,
    },
    budget: {
      currency: "USD",
      hardCapUsd: DEFAULT_RESEARCH_BUDGET_USD,
      priorCommittedUsd: normalizeUsd(options.priorCommittedUsd ?? "0"),
    },
    source: {
      suiteHash: options.suiteHash,
      qualificationHash: options.qualificationHash,
      git: options.git,
      runtime: options.runtime,
    },
  });
  return deepFreeze(manifest);
}
