import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { loadResearchBenchmarkV2FromDir } from "../src/research/benchmark.ts";
import { ResearchArtifactStoreV1 } from "../src/research/live/artifact-store.ts";
import { finalizeResearchLivePackage } from "../src/research/live/finalize.ts";
import { buildResearchRunManifestV1 } from "../src/research/live/manifest.ts";
import { researchQualificationHash } from "../src/research/live/run.ts";
import {
  ANTHROPIC_RESEARCH_MODEL,
  GOOGLE_RESEARCH_MODEL,
  OPENAI_RESEARCH_MODEL,
} from "../src/research/providers/index.ts";
import { qualifyResearchBenchmarkV2 } from "../src/research/qualification.ts";

const WORLD_DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));

describe("live package finalization", () => {
  test("checksums and reports a pilot that fails before its first provider call", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "seed-live-finalize-"));
    try {
      const loaded = await loadResearchBenchmarkV2FromDir(WORLD_DIR);
      const qualification = qualifyResearchBenchmarkV2(loaded, "2026-08-16T00:00:00.000Z");
      const manifest = buildResearchRunManifestV1({
        localManifest: {
          schemaVersion: 1,
          artifactKind: "seed.research.local-model-manifest",
          providers: [
            { provider: "google", model: GOOGLE_RESEARCH_MODEL, apiKeyEnv: "GOOGLE_API_KEY" },
            { provider: "anthropic", model: ANTHROPIC_RESEARCH_MODEL, apiKeyEnv: "ANTHROPIC_API_KEY" },
            { provider: "openai", model: OPENAI_RESEARCH_MODEL, apiKeyEnv: "OPENAI_API_KEY" },
          ],
        },
        runId: "zero-call-failed-pilot",
        generatedAt: "2026-08-16T12:00:00.000Z",
        schedulerSeed: 1,
        bootstrapSeed: 2,
        timeoutMs: 30_000,
        suiteHash: loaded.suiteHash,
        qualificationHash: researchQualificationHash(qualification),
        git: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
        runtime: { bun: process.versions.bun ?? null, node: process.version },
      });
      const store = await ResearchArtifactStoreV1.open(join(scratch, "package"));
      await store.writeManifest(manifest);
      await store.writeOracleQualification(qualification);

      const finalized = await finalizeResearchLivePackage({
        store,
        loaded,
        manifest,
        qualification,
        phase: "pilot",
      });

      expect(finalized.analysis.coverage.totalTrials).toBe(0);
      expect(finalized.gate.passed).toBe(false);
      expect(finalized.gate.failures.join(" ")).toContain("pilot requires 2160 calls");
      expect(await store.verifyFinalized()).toEqual(finalized.package.entries);
      expect(await readFile(join(store.directory, "REPORT.md"), "utf8"))
        .toMatch(/First-attempt trials: 0[\s\S]*Pilot gate: \*\*FAILED\*\*/);
      expect((await readFile(join(store.directory, "SHA256SUMS"), "utf8")))
        .toContain("  analysis.json\n");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
