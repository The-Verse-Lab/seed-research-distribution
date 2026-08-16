import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { parseResearchAnalyzeArgs } from "../src/research/analyze.ts";
import { loadResearchBenchmarkV2FromDir } from "../src/research/benchmark.ts";
import {
  parseResearchLiveArgs,
  runResearchLiveCli,
  verifyResearchSmokePackage,
} from "../src/research/live.ts";
import { parseResearchPreparationArgs } from "../src/research/prepare.ts";
import {
  ANTHROPIC_RESEARCH_MODEL,
  GOOGLE_RESEARCH_MODEL,
  OPENAI_RESEARCH_MODEL,
} from "../src/research/providers/index.ts";
import { qualifyResearchBenchmarkV2 } from "../src/research/qualification.ts";
import { parseResearchQualificationArgs } from "../src/research/qualify.ts";
import { writeResearchQualificationPackage } from "../src/research/qualify.ts";
import { parseResearchSmokeArgs, runResearchSmokeCli } from "../src/research/smoke.ts";

const WORLD_DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));

function fakeProviderFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  const visible = JSON.stringify({ decision: { choice: "abstain" } });
  if (url.includes("generativelanguage.googleapis.com")) {
    return Promise.resolve(new Response(JSON.stringify({
      modelVersion: GOOGLE_RESEARCH_MODEL,
      responseId: "google-response-id",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: visible }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 },
    }), { status: 200 }));
  }
  if (url.includes("api.anthropic.com")) {
    return Promise.resolve(new Response(JSON.stringify({
      model: ANTHROPIC_RESEARCH_MODEL,
      id: "anthropic-response-id",
      stop_reason: "end_turn",
      content: [{ type: "text", text: visible }],
      usage: { input_tokens: 100, output_tokens: 5 },
    }), { status: 200, headers: { "request-id": "anthropic-request-id" } }));
  }
  return Promise.resolve(new Response(JSON.stringify({
    model: OPENAI_RESEARCH_MODEL,
    id: "openai-response-id",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: visible }] }],
    usage: { input_tokens: 100, output_tokens: 5 },
  }), { status: 200, headers: { "x-request-id": "openai-request-id" } }));
}

describe("research-only CLI contracts", () => {
  test("parses preparation and qualification paths without gameplay arguments", () => {
    expect(parseResearchPreparationArgs([
      "--world", "worlds/custom", "--out=out/prep", "--run-id", "prep-1",
    ])).toEqual({
      worldDir: "worlds/custom",
      outputDir: "out/prep",
      runId: "prep-1",
      help: false,
    });
    expect(parseResearchQualificationArgs(["--out", "out/qualification"])).toEqual({
      worldDir: "worlds/wakeward-isles",
      outputDir: "out/qualification",
      help: false,
    });
    expect(() => parseResearchPreparationArgs(["play"])).toThrow(/Unknown research:prepare argument/);
    expect(() => parseResearchQualificationArgs(["--scenario", "x"])).toThrow(/Unknown research:qualify argument/);
  });

  test("requires an explicit analysis package and validates a zero-trial phase", () => {
    expect(parseResearchAnalyzeArgs(["--package", "results/run", "--phase=pilot"])).toEqual({
      packageDir: "results/run",
      phase: "pilot",
      help: false,
    });
    expect(() => parseResearchAnalyzeArgs([])).toThrow(/--package is required/);
    expect(() => parseResearchAnalyzeArgs(["--package=x", "--phase=game"])).toThrow(/smoke or pilot/);
  });

  test("parses strict smoke and pilot gates without accepting implicit live execution", () => {
    expect(parseResearchSmokeArgs([
      "--qualification", "results/qualification",
      "--models=research-models.local.json",
      "--out", "results/smoke",
      "--run-id", "smoke-1",
      "--scheduler-seed=0x51eed123",
      "--bootstrap-seed", "184571817",
      "--timeout-ms=45000",
    ])).toEqual({
      worldDir: "worlds/wakeward-isles",
      qualificationPath: "results/qualification",
      modelManifestPath: "research-models.local.json",
      outputDir: "results/smoke",
      runId: "smoke-1",
      schedulerSeed: 0x51ee_d123,
      bootstrapSeed: 184_571_817,
      timeoutMs: 45_000,
      help: false,
    });
    expect(parseResearchLiveArgs([
      "--smoke=results/smoke",
      "--world", "worlds/custom",
      "--out=results/pilot",
    ])).toEqual({
      smokePackageDir: "results/smoke",
      worldDir: "worlds/custom",
      modelManifestPath: "research-models.local.json",
      outputDir: "results/pilot",
      help: false,
    });
    expect(() => parseResearchSmokeArgs([])).toThrow(/--qualification is required/);
    expect(() => parseResearchLiveArgs([])).toThrow(/--smoke is required/);
    expect(() => parseResearchLiveArgs(["--smoke=x", "--qualification=y"]))
      .toThrow(/Unknown research:live argument/);
    expect(() => parseResearchSmokeArgs(["--qualification=x", "--run-id=../escape"]))
      .toThrow(/portable identifier/);
  });

  test("finalizes a safe smoke package and refuses a tampered smoke before pilot dispatch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-research-cli-"));
    const environmentNames = ["GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
    const priorEnvironment = environmentNames.map((name) => process.env[name]);
    try {
      const loaded = await loadResearchBenchmarkV2FromDir(WORLD_DIR);
      const qualification = qualifyResearchBenchmarkV2(loaded, "2026-08-16T00:00:00.000Z");
      const qualificationDir = join(scratch, "qualification");
      await writeResearchQualificationPackage(qualificationDir, qualification);
      const modelManifestPath = join(scratch, "research-models.local.json");
      await writeFile(modelManifestPath, JSON.stringify({
        schemaVersion: 1,
        artifactKind: "seed.research.local-model-manifest",
        providers: [
          { provider: "google", model: GOOGLE_RESEARCH_MODEL, apiKeyEnv: "GOOGLE_API_KEY" },
          { provider: "anthropic", model: ANTHROPIC_RESEARCH_MODEL, apiKeyEnv: "ANTHROPIC_API_KEY" },
          { provider: "openai", model: OPENAI_RESEARCH_MODEL, apiKeyEnv: "OPENAI_API_KEY" },
        ],
      }));
      for (const name of environmentNames) process.env[name] = "test-only-placeholder";

      const smokeDirectory = join(scratch, "smoke");
      const result = await runResearchSmokeCli([
        "--qualification", qualificationDir,
        "--models", modelManifestPath,
        "--out", smokeDirectory,
        "--run-id", "smoke-cli-test",
      ], "2026-08-16T12:34:56.000Z", fakeProviderFetch as typeof globalThis.fetch);
      expect(result?.run.completedTrialCount).toBe(9);
      expect(result?.finalized.gate).toEqual({ passed: true, failures: [] });
      const verified = await verifyResearchSmokePackage(smokeDirectory, loaded);
      expect(verified.authorization.returnedModels).toEqual({
        google: GOOGLE_RESEARCH_MODEL,
        anthropic: ANTHROPIC_RESEARCH_MODEL,
        openai: OPENAI_RESEARCH_MODEL,
      });

      await appendFile(join(smokeDirectory, "REPORT.md"), "\ntampered\n");
      let pilotDispatches = 0;
      await expect(runResearchLiveCli([
        "--smoke", smokeDirectory,
        "--models", modelManifestPath,
        "--out", join(scratch, "pilot"),
      ], "2026-08-16T13:34:56.000Z", ((...args) => {
        pilotDispatches++;
        return fakeProviderFetch(args[0]);
      }) as typeof globalThis.fetch)).rejects.toThrow(/Checksum mismatch/);
      expect(pilotDispatches).toBe(0);
    } finally {
      environmentNames.forEach((name, index) => {
        const value = priorEnvironment[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
