#!/usr/bin/env bun
/** Execute a prepared research plan with the bounded model-free scripted runner. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  buildResearchPreparation,
  canonicalJson,
  researchSourceFile,
  type ResearchPreparationArtifact,
} from "./artifacts.ts";
import { writeResearchResultsArtifacts } from "./results.ts";
import { executeResearchPlan } from "./runner.ts";
import { loadResearchSuiteFromDir } from "./scenario.ts";

interface Args {
  worldDir: string;
  planPath?: string;
  outputDir?: string;
  runId?: string;
  scenarioIds: string[];
  help: boolean;
}

const USAGE = `Usage: bun run research:run -- --plan <experiment-plan.json> [options]

Executes matched intervention/silence suffixes with the deterministic scripted-waypoint policy.
No external model or network endpoint is contacted. Results measure the substrate and authored
oracle interventions, not live-agent decision quality.

Options:
  --plan <file>       required preparation artifact
  --out <directory>  default research-artifacts/<generated-run-id>
  --run-id <id>       portable result identifier
  --scenario <id>     repeat to execute a subset
  --world <directory> default worlds/wakeward-isles
`;

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseResearchRunArgs(argv: string[]): Args {
  const args: Args = { worldDir: "worlds/wakeward-isles", scenarioIds: [], help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--plan") {
      args.planPath = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--plan=")) args.planPath = arg.slice("--plan=".length);
    else if (arg === "--out") {
      args.outputDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--out=")) args.outputDir = arg.slice("--out=".length);
    else if (arg === "--run-id") {
      args.runId = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--run-id=")) args.runId = arg.slice("--run-id=".length);
    else if (arg === "--scenario") {
      args.scenarioIds.push(valueAfter(argv, index, arg));
      index++;
    } else if (arg.startsWith("--scenario=")) args.scenarioIds.push(arg.slice("--scenario=".length));
    else if (arg === "--world") {
      args.worldDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--world=")) args.worldDir = arg.slice("--world=".length);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!args.help && !args.planPath) throw new Error("--plan is required");
  if (args.planPath === "") throw new Error("--plan requires a value");
  if (args.outputDir === "") throw new Error("--out requires a value");
  if (args.runId === "") throw new Error("--run-id requires a value");
  if (args.scenarioIds.some((row) => row === "")) throw new Error("--scenario requires a value");
  return args;
}

function gitText(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function portablePath(path: string): string {
  const repoRelative = relative(process.cwd(), path).replaceAll("\\", "/");
  return repoRelative.startsWith("../") || isAbsolute(repoRelative) ? basename(path) : repoRelative;
}

function parsedPlan(value: unknown): ResearchPreparationArtifact {
  if (!value || typeof value !== "object") throw new Error("Research plan is not a JSON object");
  const plan = value as Partial<ResearchPreparationArtifact>;
  if (plan.artifactKind !== "seed.research.preparation" || plan.schemaVersion !== 1) {
    throw new Error("Research plan has an unsupported artifact kind or schema version");
  }
  if (!plan.planId || !plan.planHash || !plan.source || !Array.isArray(plan.cells)) {
    throw new Error("Research plan is missing identity, source, or cell fields");
  }
  return plan as ResearchPreparationArtifact;
}

async function main(): Promise<void> {
  const args = parseResearchRunArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const generatedAt = new Date().toISOString();
  const runId = args.runId ?? `results-${generatedAt.replace(/[:.]/g, "-")}`;
  const outputDir = resolve(args.outputDir ?? "research-artifacts", args.outputDir ? "" : runId);
  const worldDir = resolve(args.worldDir);
  const planPath = resolve(args.planPath!);
  const plan = parsedPlan(JSON.parse(await readFile(planPath, "utf8")) as unknown);
  const loaded = await loadResearchSuiteFromDir(worldDir);
  const sourceFiles = await Promise.all(
    ["world.json", "campaign.json", "research.json"].map(async (name) => {
      const path = resolve(worldDir, name);
      return researchSourceFile(portablePath(path), await readFile(path));
    }),
  );
  const current = buildResearchPreparation(loaded, {
    runId: plan.runId,
    generatedAt: plan.generatedAt,
    worldDir: portablePath(worldDir),
    sourceFiles,
    repository: {
      commit: gitText(["rev-parse", "HEAD"]),
      dirty: (gitText(["status", "--porcelain", "--untracked-files=normal"]) ?? "").length > 0,
    },
    runtime: { bun: process.versions.bun ?? null, node: process.version },
  });
  if (current.planHash !== plan.planHash || canonicalJson(current.cells) !== canonicalJson(plan.cells)) {
    throw new Error("Research plan does not match the current validated source suite");
  }

  const results = await executeResearchPlan(loaded, plan, {
    runId,
    generatedAt,
    ...(args.scenarioIds.length > 0 ? { scenarioIds: args.scenarioIds } : {}),
  });
  const paths = await writeResearchResultsArtifacts(outputDir, results);
  console.log(`Executed ${results.scope.executedEpisodes} episodes from ${results.plan.planId}`);
  console.log(`Runner: ${results.runner.id} · external model calls: 0`);
  console.log(
    `Pairs: ${results.summary.resolvedPairCount} resolved · ${results.summary.censoredPairCount} censored; ${results.summary.positivePairs} positive · ${results.summary.neutralPairs} neutral · ${results.summary.negativePairs} negative`,
  );
  console.log(`Results: ${paths.directory}`);
}

if (import.meta.main) await main();
