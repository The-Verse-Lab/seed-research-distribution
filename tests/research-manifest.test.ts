import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { assertSafeStoredValue } from "../src/research/live/artifact-store.ts";
import {
  ResearchModelManifestV1Schema,
  ResearchRunManifestV1Schema,
  assertResearchApiKeyEnvironment,
  buildResearchRunManifestV1,
  parseResearchModelManifestV1,
  type BuildResearchRunManifestV1Options,
} from "../src/research/live/manifest.ts";
import {
  ANTHROPIC_RESEARCH_ENDPOINT,
  ANTHROPIC_RESEARCH_MODEL,
  GOOGLE_RESEARCH_ENDPOINT,
  GOOGLE_RESEARCH_MODEL,
  OPENAI_RESEARCH_ENDPOINT,
  OPENAI_RESEARCH_MODEL,
  RESEARCH_MAX_OUTPUT_TOKENS,
} from "../src/research/providers/index.ts";

const EXAMPLE = fileURLToPath(new URL("../research-models.example.json", import.meta.url));

async function exampleManifest(): Promise<unknown> {
  return JSON.parse(await readFile(EXAMPLE, "utf8")) as unknown;
}

function buildOptions(localManifest: unknown): BuildResearchRunManifestV1Options {
  return {
    localManifest,
    runId: "wakeward-pilot-20260816",
    generatedAt: "2026-08-16T12:34:56.000Z",
    schedulerSeed: 0x51ee_d123,
    bootstrapSeed: 0xb005_7a9,
    timeoutMs: 30_000,
    suiteHash: "a".repeat(64),
    qualificationHash: "b".repeat(64),
    git: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
    runtime: { bun: "1.3.14", node: "v22.18.0" },
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value as Record<string, unknown>)) expectDeeplyFrozen(child);
}

describe("research model and run manifests", () => {
  test("example references exactly the three fixed models and API-key environment names", async () => {
    const parsed = parseResearchModelManifestV1(await exampleManifest());

    expect(parsed.providers).toEqual([
      { provider: "google", model: GOOGLE_RESEARCH_MODEL, apiKeyEnv: "GOOGLE_API_KEY" },
      { provider: "anthropic", model: ANTHROPIC_RESEARCH_MODEL, apiKeyEnv: "ANTHROPIC_API_KEY" },
      { provider: "openai", model: OPENAI_RESEARCH_MODEL, apiKeyEnv: "OPENAI_API_KEY" },
    ]);
    expect(parsed.providers.map((provider) => provider.apiKeyEnv)).toEqual([
      "GOOGLE_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]);

    const wrongModel = structuredClone(parsed) as Record<string, unknown>;
    (wrongModel.providers as Array<Record<string, unknown>>)[0]!.model = "gemini-latest";
    expect(() => ResearchModelManifestV1Schema.parse(wrongModel)).toThrow();
    const wrongReference = structuredClone(parsed) as Record<string, unknown>;
    (wrongReference.providers as Array<Record<string, unknown>>)[2]!.apiKeyEnv = "CUSTOM_OPENAI_KEY";
    expect(() => ResearchModelManifestV1Schema.parse(wrongReference)).toThrow();
  });

  test("environment validation reports only missing references and never secret values", async () => {
    const parsed = parseResearchModelManifestV1(await exampleManifest());
    const secrets = {
      GOOGLE_API_KEY: "GOOGLE_SECRET_VALUE",
      ANTHROPIC_API_KEY: "ANTHROPIC_SECRET_VALUE",
      OPENAI_API_KEY: "OPENAI_SECRET_VALUE",
    };
    expect(() => assertResearchApiKeyEnvironment(parsed, secrets)).not.toThrow();
    expect(JSON.stringify(parsed)).not.toContain("SECRET_VALUE");

    let message = "";
    try {
      assertResearchApiKeyEnvironment(parsed, {
        GOOGLE_API_KEY: secrets.GOOGLE_API_KEY,
        ANTHROPIC_API_KEY: "",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).not.toContain(secrets.GOOGLE_API_KEY);
    expect(message).not.toContain("SECRET_VALUE");
  });

  test("builds deterministic deeply frozen redacted provenance with fixed protocol settings", async () => {
    const localManifest = await exampleManifest();
    const first = buildResearchRunManifestV1(buildOptions(localManifest));
    const second = buildResearchRunManifestV1(buildOptions(localManifest));

    expect(first).toEqual(second);
    expectDeeplyFrozen(first);
    expect(() => assertSafeStoredValue(first)).not.toThrow();
    expect(first.design).toEqual({
      schedulerSeed: 0x51ee_d123,
      bootstrapSeed: 0xb005_7a9,
      bootstrapResamples: 10_000,
      cellCount: 144,
      providerCount: 3,
      replicatesPerCell: 5,
      totalCallCount: 2_160,
      maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
      inputOverheadTokenBound: 12_000,
      timeoutMs: 30_000,
      maxInFlightPerProvider: 1,
    });
    expect(first.budget).toEqual({ currency: "USD", hardCapUsd: "100", priorCommittedUsd: "0" });
    expect(first.source).toEqual({
      suiteHash: "a".repeat(64),
      qualificationHash: "b".repeat(64),
      git: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
      runtime: { bun: "1.3.14", node: "v22.18.0" },
    });
    expect(first.providers.map((provider) => ({
      provider: provider.provider,
      configuredModel: provider.configuredModel,
      apiKeyEnv: provider.apiKeyEnv,
      endpoint: provider.endpoint,
      protocol: provider.protocol,
      reasoningConfig: provider.reasoningConfig,
    }))).toEqual([
      {
        provider: "google",
        configuredModel: GOOGLE_RESEARCH_MODEL,
        apiKeyEnv: "GOOGLE_API_KEY",
        endpoint: GOOGLE_RESEARCH_ENDPOINT,
        protocol: "google.generateContent.v1beta",
        reasoningConfig: { thinkingLevel: "minimal", includeThoughts: false },
      },
      {
        provider: "anthropic",
        configuredModel: ANTHROPIC_RESEARCH_MODEL,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        endpoint: ANTHROPIC_RESEARCH_ENDPOINT,
        protocol: "anthropic.messages.2023-06-01",
        reasoningConfig: { effort: "low", thinkingMode: "disabled" },
      },
      {
        provider: "openai",
        configuredModel: OPENAI_RESEARCH_MODEL,
        apiKeyEnv: "OPENAI_API_KEY",
        endpoint: OPENAI_RESEARCH_ENDPOINT,
        protocol: "openai.responses.v1",
        reasoningConfig: { effort: "none", store: false },
      },
    ]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toMatch(/GOOGLE_SECRET_VALUE|ANTHROPIC_SECRET_VALUE|OPENAI_SECRET_VALUE/);
    expect(first.providers.every((provider) => provider.pricing.retrievedDate === "2026-08-21")).toBe(true);
  });

  test("accepts exact smoke identities and rejects any returned-model drift", async () => {
    const localManifest = await exampleManifest();
    const options = buildOptions(localManifest);
    const verified = buildResearchRunManifestV1({
      ...options,
      smokeReturnedModels: {
        google: GOOGLE_RESEARCH_MODEL,
        anthropic: ANTHROPIC_RESEARCH_MODEL,
        openai: OPENAI_RESEARCH_MODEL,
      },
    });
    expect(verified.providers.map((provider) => provider.smokeReturnedModel)).toEqual([
      GOOGLE_RESEARCH_MODEL,
      ANTHROPIC_RESEARCH_MODEL,
      OPENAI_RESEARCH_MODEL,
    ]);

    expect(() => buildResearchRunManifestV1({
      ...options,
      smokeReturnedModels: { openai: "gpt-5.6-sol-unexpected-snapshot" },
    })).toThrow(/Smoke returned model drift for openai/);

    const drifted = structuredClone(verified) as Record<string, unknown>;
    (drifted.providers as Array<Record<string, unknown>>)[1]!.configuredModel = "claude-sonnet-latest";
    expect(() => ResearchRunManifestV1Schema.parse(drifted)).toThrow();
  });

  test("fails closed on dirty or unidentified executable provenance", async () => {
    const localManifest = await exampleManifest();
    expect(() => buildResearchRunManifestV1({
      ...buildOptions(localManifest),
      git: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: true },
    } as unknown as BuildResearchRunManifestV1Options)).toThrow();
    expect(() => buildResearchRunManifestV1({
      ...buildOptions(localManifest),
      git: { commit: null, dirty: null },
    } as unknown as BuildResearchRunManifestV1Options)).toThrow();
  });
});
