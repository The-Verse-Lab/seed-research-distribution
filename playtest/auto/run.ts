/**
 * Automated playtest harness — CLI entry (Concordia transfer #5).
 *
 *   bun playtest/auto/run.ts                       # every standing scenario, live model
 *   bun playtest/auto/run.ts wakeward-cold-passage wakeward-clear-glass    # a subset
 *   bun playtest/auto/run.ts --turns 30            # raise the cap
 *   bun playtest/auto/run.ts --judge               # add the prose-quality judge pass
 *   bun playtest/auto/run.ts --script lines.txt wakeward-shared-stores   # scripted driver (no LLM player)
 *
 * Uses the .env endpoints via the same probed/guarded gateway stack as `bun run dev` — costs real
 * tokens. Reports land in playtest/auto/reports/ as JSON (full recorded run) + Markdown (the
 * human-report shape). The rubric reads traces + deltas; see rubric.ts for the failure classes.
 *
 * @author Runkai Zhang
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../../src/content/loader.ts";
import { createProbedGateway, loadConfig } from "../../src/config/env.ts";
import { LlmDriver, ScriptDriver, type Driver } from "./driver.ts";
import { runScenario } from "./harness.ts";
import { coverageTargetFor, loadLedger } from "./ledger.ts";
import { judgeRun } from "./judge.ts";
import { renderReportMarkdown, scoreRun } from "./rubric.ts";
import { SCENARIOS, scenarioById } from "./scenarios.ts";
import type { Scenario } from "./types.ts";

const REPORTS_DIR = fileURLToPath(new URL("reports", import.meta.url));

interface Args {
  ids: string[];
  turns?: number;
  judge: boolean;
  script?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ids: [], judge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--turns") args.turns = Number(argv[++i]);
    else if (a === "--judge") args.judge = true;
    else if (a === "--script") args.script = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else args.ids.push(a);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const picked: Scenario[] =
    args.ids.length === 0
      ? SCENARIOS
      : args.ids.map((id) => {
          const s = scenarioById(id);
          if (!s) throw new Error(`unknown scenario "${id}" (have: ${SCENARIOS.map((x) => x.id).join(", ")})`);
          return s;
        });

  const config = loadConfig();
  let gateway;
  try {
    gateway = await createProbedGateway(config);
  } catch (err) {
    console.error(`\n✖ endpoint unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (!process.env.SEED_RESCUE_BASE_URL) {
    // r10 F-6: five consecutive empty-narrator turns in one sweep, all avoidable with a rescue
    // route. Warn loudly, don't block — a sweep without one is still a sweep.
    console.warn(
      "⚠ SEED_RESCUE_* is not configured — empty narrator completions will degrade to the fallback line instead of rerouting (r10 F-6). Set SEED_RESCUE_BASE_URL/MODEL for clean sweeps.",
    );
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Read-only: how deep each scenario must run for its silence to clear what the ledger holds
  // against it. The sweep never writes the ledger — triage.ts owns that.
  const ledger = loadLedger();

  for (const base of picked) {
    const scenario: Scenario = args.turns ? { ...base, maxTurns: args.turns } : base;
    const coverageTarget = coverageTargetFor(ledger, scenario.id, scenario.maxTurns);
    console.log(`\n=== ${scenario.id} — up to ${scenario.maxTurns} turns ===`);
    console.log(`goal: ${scenario.goal}`);
    console.log(`coverage: play past the goal to t${coverageTarget} (deepest open evidence in the ledger)`);
    const playset = await loadPlaySetFromDir(scenario.worldDir);
    const driver: Driver = args.script
      ? new ScriptDriver(
          readFileSync(args.script, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith("#")),
        )
      : new LlmDriver(gateway, scenario);

    const run = await runScenario(scenario, driver, {
      playset,
      gateway,
      systemPrefix: config.systemPrefix,
      coverageTarget,
      onTurn: (turn, input, ms) => console.log(`  t${turn} (${(ms / 1000).toFixed(1)}s) > ${input}`),
    });
    if (run.error) console.error(`  ✖ run errored: ${run.error}`);

    const report = scoreRun(run);
    if (args.judge) {
      const judged = await judgeRun(gateway, run);
      if (judged) report.judge = judged;
    }

    const jsonPath = join(REPORTS_DIR, `${stamp}-${scenario.id}.json`);
    const mdPath = join(REPORTS_DIR, `${stamp}-${scenario.id}.md`);
    writeFileSync(jsonPath, JSON.stringify({ run, report }, null, 2));
    writeFileSync(mdPath, renderReportMarkdown(run, report));

    console.log(`  stopped: ${run.stopped}${run.driverNote ? ` — "${run.driverNote}"` : ""}`);
    console.log(
      `  findings: ${report.findings.length} (${Object.entries(report.stats.findingsByClass)
        .map(([k, n]) => `${k}:${n}`)
        .join(", ") || "clean"})`,
    );
    console.log(`  fallbacks: ${report.stats.fallbackTurns}/${report.stats.turns} · mean turn ${(report.stats.wallMsMean / 1000).toFixed(1)}s`);
    console.log(`  report: ${mdPath}`);
  }
}

await main();
