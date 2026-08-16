#!/usr/bin/env bun
/**
 * Prepare a checksummed research-plan package without running a model or an episode.
 *
 * @author Runkai Zhang
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  buildResearchPreparation,
  researchSourceFile,
  writeResearchPreparationArtifacts,
} from "./artifacts.ts";
import { loadResearchSuiteFromDir } from "./scenario.ts";

interface Args {
  worldDir: string;
  outputDir?: string;
  runId?: string;
  help: boolean;
}

const USAGE = `Usage: bun run research:prepare [world-dir] [--out <directory>] [--run-id <id>]

Builds a model-free, checksummed experiment preparation package. It does not run episodes,
call an LLM, score outcomes, or claim a research result.

Defaults:
  world-dir  worlds/wakeward-isles
  --out      research-artifacts/<generated-run-id>
`;

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseResearchPreparationArgs(argv: string[]): Args {
  const args: Args = { worldDir: "worlds/wakeward-isles", help: false };
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--out") {
      args.outputDir = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--out=")) args.outputDir = arg.slice("--out=".length);
    else if (arg === "--run-id") {
      args.runId = valueAfter(argv, index, arg);
      index++;
    } else if (arg.startsWith("--run-id=")) args.runId = arg.slice("--run-id=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`);
    else if (!positional) {
      args.worldDir = arg;
      positional = true;
    } else throw new Error(`unexpected positional argument ${arg}`);
  }
  if (args.outputDir === "") throw new Error("--out requires a value");
  if (args.runId === "") throw new Error("--run-id requires a value");
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

async function main(): Promise<void> {
  const args = parseResearchPreparationArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const generatedAt = new Date().toISOString();
  const runId = args.runId ?? `prep-${generatedAt.replace(/[:.]/g, "-")}`;
  const worldDir = resolve(args.worldDir);
  const outputDir = resolve(args.outputDir ?? "research-artifacts", args.outputDir ? "" : runId);
  const loaded = await loadResearchSuiteFromDir(worldDir);
  const sourceFiles = await Promise.all(
    ["world.json", "campaign.json", "research.json"].map(async (name) => {
      const path = resolve(worldDir, name);
      return researchSourceFile(portablePath(path), await readFile(path));
    }),
  );
  const commit = gitText(["rev-parse", "HEAD"]);
  const status = gitText(["status", "--porcelain", "--untracked-files=normal"]);
  const artifact = buildResearchPreparation(loaded, {
    runId,
    generatedAt,
    worldDir: portablePath(worldDir),
    sourceFiles,
    repository: { commit, dirty: status === null ? null : status.length > 0 },
    runtime: { bun: process.versions.bun ?? null, node: process.version },
  });
  const paths = await writeResearchPreparationArtifacts(outputDir, artifact);

  console.log(`Prepared ${artifact.planId}`);
  console.log(`Status: NOT RUN (0 model calls, 0 outcomes)`);
  console.log(
    `Design: ${artifact.design.conditionCellCount} condition cells · ${artifact.design.plannedEpisodeCount} planned episodes`,
  );
  console.log(`Artifacts: ${paths.directory}`);
}

if (import.meta.main) {
  await main();
}
