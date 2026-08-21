/** Distribution firewall for the research-only experiment appliance. */
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  expandResearchBenchmarkCells,
  loadResearchBenchmarkV2FromDir,
} from "../src/research/benchmark.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function filesBelow(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [path];
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function repositoryPaths(paths: readonly string[]): string[] {
  return paths.map((path) => relative(ROOT, path).replaceAll("\\", "/")).sort();
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: ROOT, encoding: "utf8" }).trim();
}

const EXPECTED_SOURCE_FILES = [
  "src/llm/gateway.ts",
  "src/llm/normalize.ts",
  "src/llm/safety.ts",
  "src/llm/types.ts",
  "src/research/analysis.ts",
  "src/research/analyze.ts",
  "src/research/benchmark.ts",
  "src/research/cli-support.ts",
  "src/research/contracts.ts",
  "src/research/index.ts",
  "src/research/live.ts",
  "src/research/live/artifact-store.ts",
  "src/research/live/budget.ts",
  "src/research/live/finalize.ts",
  "src/research/live/gates.ts",
  "src/research/live/integrity.ts",
  "src/research/live/manifest.ts",
  "src/research/live/pricing.ts",
  "src/research/live/records.ts",
  "src/research/live/run.ts",
  "src/research/live/scheduler.ts",
  "src/research/live/trial.ts",
  "src/research/preparation.ts",
  "src/research/prepare.ts",
  "src/research/prompt.ts",
  "src/research/providers/anthropic.ts",
  "src/research/providers/google.ts",
  "src/research/providers/index.ts",
  "src/research/providers/openai.ts",
  "src/research/providers/shared.ts",
  "src/research/qualification.ts",
  "src/research/qualify.ts",
  "src/research/report.ts",
  "src/research/smoke.ts",
  "src/research/statistics.ts",
  "src/research/world/commands.ts",
  "src/research/world/deltas.ts",
  "src/research/world/events.ts",
  "src/research/world/executor.ts",
  "src/research/world/index.ts",
  "src/research/world/reducer.ts",
  "src/research/world/replay.ts",
  "src/research/world/schema.ts",
  "src/research/world/state.ts",
  "src/safety/minor.ts",
].sort();

const EXPECTED_TEST_FILES = [
  "tests/normalize.test.ts",
  "tests/research-analysis.test.ts",
  "tests/research-artifact-store-v1.test.ts",
  "tests/research-benchmark.test.ts",
  "tests/research-budget.test.ts",
  "tests/research-cli.test.ts",
  "tests/research-contracts.test.ts",
  "tests/research-firewall.test.ts",
  "tests/research-gates-report.test.ts",
  "tests/research-live-finalize.test.ts",
  "tests/research-live-records.test.ts",
  "tests/research-live-run.test.ts",
  "tests/research-live-trial.test.ts",
  "tests/research-manifest.test.ts",
  "tests/research-preparation-v2.test.ts",
  "tests/research-pricing.test.ts",
  "tests/research-providers.test.ts",
  "tests/research-qualification.test.ts",
  "tests/research-scheduler.test.ts",
  "tests/research-statistics.test.ts",
  "tests/research-world-executor.test.ts",
  "tests/safety.test.ts",
].sort();

describe("research-only distribution firewall", () => {
  test("allows only the research appliance and the unchanged safety island", async () => {
    expect(repositoryPaths(await filesBelow(resolve(ROOT, "src")))).toEqual(EXPECTED_SOURCE_FILES);
    expect(repositoryPaths(await filesBelow(resolve(ROOT, "tests")))).toEqual(EXPECTED_TEST_FILES);
    for (const removed of ["characters", "playtest", "src/engine", "src/modules", "src/viewer", "tests/fixtures", "tests/support"]) {
      expect(await stat(resolve(ROOT, removed)).catch(() => null)).toBeNull();
    }
  });

  test("keeps every research import inside the appliance, node built-ins, or zod", async () => {
    const failures: string[] = [];
    for (const file of await filesBelow(resolve(ROOT, "src/research"))) {
      if (extname(file) !== ".ts") continue;
      const text = await readFile(file, "utf8");
      const imports = [...text.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        if (specifier === "zod" || specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".")) {
          failures.push(`${relative(ROOT, file)}: external import ${specifier}`);
          continue;
        }
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(resolve(ROOT, "src/research") + "/")) {
          failures.push(`${relative(ROOT, file)}: escapes research root via ${specifier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("exposes only setup, checks, and the five research workflow commands", async () => {
    const packageJson = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    expect(packageJson.name).toBe("seed-research-appliance");
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.scripts).toEqual({
      setup: "bun install --frozen-lockfile",
      check: "tsc --noEmit && bun test",
      test: "bun test",
      "research:prepare": "bun run src/research/prepare.ts",
      "research:qualify": "bun run src/research/qualify.ts",
      "research:run": "bun run src/research/qualify.ts",
      "research:smoke": "bun run src/research/smoke.ts",
      "research:live": "bun run src/research/live.ts",
      "research:analyze": "bun run src/research/analyze.ts",
    });
  });

  test("ships one canonical 24-scenario, 144-cell benchmark with no campaign file", async () => {
    expect((await readdir(resolve(ROOT, "worlds"))).sort()).toEqual(["README.md", "wakeward-isles"]);
    expect((await readdir(resolve(ROOT, "worlds/wakeward-isles"))).sort()).toEqual([
      "README.md",
      "research.json",
      "world.json",
    ]);
    const loaded = await loadResearchBenchmarkV2FromDir(resolve(ROOT, "worlds/wakeward-isles"));
    expect(loaded.manifest.scenarios).toHaveLength(24);
    expect(new Set(loaded.manifest.scenarios.map((row) => row.family)).size).toBe(6);
    expect(expandResearchBenchmarkCells(loaded)).toHaveLength(144);
  });

  test("ignores credentials, local manifests, generated packages, and Graphify output", () => {
    for (const path of [
      ".env",
      ".env.local",
      "research-models.local.json",
      "research-artifacts/firewall-probe",
      "graphify-out/graph.json",
    ]) {
      expect(() => execFileSync("git", ["check-ignore", "--quiet", path], { cwd: ROOT })).not.toThrow();
    }
    expect(git(["ls-files", "graphify-out"])).toBe("");
  });

  test("contains no credential values or machine-local absolute paths in distributed surfaces", async () => {
    const roots = [
      ".env.example",
      "research-models.example.json",
      "package.json",
      "README.md",
      "RESEARCH.md",
      "CLAUDE.md",
      "NOTICE",
      "CITATION.cff",
      "docs",
      "src",
      "worlds",
    ];
    const failures: string[] = [];
    const credential = /\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{20,}|AIza[a-z0-9_-]{20,})\b/i;
    for (const root of roots) {
      for (const file of await filesBelow(resolve(ROOT, root))) {
        const text = await readFile(file, "utf8");
        if (credential.test(text) || /\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
          failures.push(relative(ROOT, file));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("keeps relative Markdown links resolvable", async () => {
    const markdown = [
      resolve(ROOT, "README.md"),
      resolve(ROOT, "RESEARCH.md"),
      resolve(ROOT, "CLAUDE.md"),
      ...await filesBelow(resolve(ROOT, "docs")),
      ...await filesBelow(resolve(ROOT, "worlds")),
    ].filter((path) => extname(path) === ".md");
    const broken: string[] = [];
    for (const file of markdown) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1]!.trim();
        if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
        const path = resolve(dirname(file), target.split("#")[0]!);
        if (!(await stat(path).catch(() => null))) broken.push(`${relative(ROOT, file)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("license and notice agree after all SRD-derived files are removed", async () => {
    const [notice, packageText, license] = await Promise.all([
      readFile(resolve(ROOT, "NOTICE"), "utf8"),
      readFile(resolve(ROOT, "package.json"), "utf8"),
      readFile(resolve(ROOT, "LICENSE"), "utf8"),
    ]);
    expect(JSON.parse(packageText).license).toBe("Apache-2.0");
    expect(license).toContain("Apache License");
    expect(notice).toContain("Apache License, Version 2.0");
    expect(notice).not.toMatch(/SRD|Open Game License|Creative Commons|Wizards of the Coast/i);
    expect(await stat(resolve(ROOT, "src/rules/srd")).catch(() => null)).toBeNull();
  });
});
