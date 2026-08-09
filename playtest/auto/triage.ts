/**
 * Automated playtest loop — the triage stage (sweep → **triage** → fix → sweep).
 *
 *   bun playtest/auto/triage.ts                          # fold the latest sweep into the ledger
 *   bun playtest/auto/triage.ts --round 2026-08-01T22-54-44
 *   bun playtest/auto/triage.ts --record-fix <sha> [--note "..."]   # after the fixer commits
 *   bun playtest/auto/triage.ts --mute "wakeward-cold-passage::state-inert::inert-stretch" --note "accepted noise"
 *   bun playtest/auto/triage.ts --status                 # standing ledger, no round folded
 *
 * Reads the per-scenario report JSON a sweep left in `reports/` (grouped by its shared timestamp —
 * that stamp IS the round id), folds them into `ledger.json`, and writes `<round>-triage.md`: the
 * work order the fix agent is handed, with each finding's history attached. Nothing here calls a
 * model or an engine — triage is arithmetic over recorded data, and stays cheap enough to re-run.
 *
 * @author Runkai Zhang
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  foldRound,
  ledgerDiff,
  loadLedger,
  measurementHashOf,
  mute,
  recheckLedger,
  recordFix,
  saveLedger,
  COVERAGE_FLOOR,
  MEASUREMENT_FILES,
  type Ledger,
  type RoundRecord,
  type TriageItem,
  type TriageResult,
} from "./ledger.ts";
import { labelOf } from "./fingerprint.ts";
import { routeFixTier } from "./routing.ts";
import type { RecordedRun, RubricReport } from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPORTS_DIR = join(HERE, "reports");

/** The stamp prefix every sweep writes its per-scenario reports under, e.g. `2026-08-01T22-54-44`. */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.json$/;

interface RoundFiles {
  round: string;
  files: Array<{ scenarioId: string; path: string }>;
}

/** Every round present in reports/, oldest first. */
export function roundsOnDisk(dir = REPORTS_DIR): RoundFiles[] {
  const byRound = new Map<string, RoundFiles>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names.sort()) {
    const m = STAMP_RE.exec(name);
    if (!m) continue;
    const [, round, scenarioId] = m as unknown as [string, string, string];
    if (scenarioId === "triage") continue;
    const rec = byRound.get(round) ?? { round, files: [] };
    rec.files.push({ scenarioId, path: join(dir, name) });
    byRound.set(round, rec);
  }
  return [...byRound.values()].sort((a, b) => a.round.localeCompare(b.round));
}

function measurementHash(): string {
  return measurementHashOf(MEASUREMENT_FILES.map((f) => readFileSync(join(HERE, f), "utf8")));
}

async function headSha(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: HERE, stdout: "pipe", stderr: "ignore" });
    return (await new Response(proc.stdout).text()).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Load one round's reports off disk. */
export function loadRound(rf: RoundFiles): Array<{ report: RubricReport; turns: number; maxTurns: number; stopped: string }> {
  const out = [];
  for (const f of rf.files) {
    try {
      const parsed = JSON.parse(readFileSync(f.path, "utf8")) as { run: RecordedRun; report: RubricReport };
      if (!parsed.report) continue;
      out.push({
        report: parsed.report,
        turns: parsed.run?.turns?.length ?? parsed.report.stats.turns,
        maxTurns: parsed.run?.scenario?.maxTurns ?? 0,
        stopped: parsed.run?.stopped ?? "unknown",
      });
    } catch {
      console.warn(`⚠ unreadable report ${f.path} — skipped`);
    }
  }
  return out;
}

function bucket(items: TriageItem[], verdict: TriageItem["verdict"]): TriageItem[] {
  return items.filter((i) => i.verdict === verdict);
}

function historyLine(i: TriageItem): string {
  const e = i.entry;
  const bits = [`first seen ${e.firstRound}`, `${e.seenRounds} round(s) seen`, `${e.clearedRounds} clear`];
  if (e.regressions > 0) bits.push(`**${e.regressions} regression(s)**`);
  if (e.oscillations > 0) bits.push(`${e.oscillations} oscillation(s)`);
  if (e.fixAttempts.length > 0) {
    bits.push(
      `prior fix attempts: ${e.fixAttempts.map((a) => `${a.commit}${a.note ? ` (“${a.note}”)` : ""}`).join(", ")}`,
    );
  }
  return bits.join(" · ");
}

function renderItem(i: TriageItem): string[] {
  const e = i.entry;
  const turns = e.exampleTurns.slice(0, 6).map((t) => `t${t}`).join(", ");
  const headline = i.coverage
    ? `- **UNMEASURED** · ${e.confidence} · run stopped at ${i.coverage.turns}/${i.coverage.maxTurns} turns, ` +
      `needed ${i.coverage.needed} (last seen at ${turns})`
    : `- **${i.verdict.toUpperCase()}** · ${e.confidence} · ${i.count}× this round (${turns})`;
  const lines = [`#### \`${e.fp}\``, "", headline, `- ${e.exampleSummary}`];
  if (e.exampleEvidence) lines.push(`- evidence: “${e.exampleEvidence}”`);
  lines.push(`- history: ${historyLine(i)}`);
  if (e.note) lines.push(`- note: ${e.note}`);
  lines.push("");
  return lines;
}

/** The work order the fix agent reads. Every actionable finding carries its own history. */
export function renderTriageMarkdown(result: TriageResult, roundFiles: RoundFiles): string {
  const L: string[] = [
    `# Playtest triage — round ${result.round}`,
    "",
    `Scenarios: ${result.scenarioStats.map((s) => s.scenarioId).join(", ")}`,
    `Reports: ${roundFiles.files.map((f) => f.path.replace(/^.*\/reports\//, "reports/")).join(", ")}`,
    "",
  ];

  if (result.measurementChanged) {
    L.push(
      "> ⚠ **MEASUREMENT SURFACE CHANGED** since the previous round (rubric/scenarios/types/judge/fingerprint).",
      "> Every FIXED verdict below is **unverified** — a finding can vanish because the bug went away",
      "> or because the scorer stopped looking. Confirm the scorer still fires on the old evidence before",
      "> believing any of them.",
      "",
    );
  }

  L.push("## Run health", "");
  const prev = result.previousRound;
  L.push("| scenario | turns | stopped | findings | fallbacks | mean turn | judge |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of result.scenarioStats) {
    const before = prev?.scenarios.find((p) => p.scenarioId === s.scenarioId);
    const delta = (now: number, then?: number) => (then === undefined ? "" : ` (${now - then >= 0 ? "+" : ""}${now - then})`);
    const judge = s.judge
      ? Object.entries(s.judge)
          .map(([k, v]) => `${k[0]}${v}`)
          .join(" ")
      : "—";
    // A run that stopped under the floor cannot clear anything — say so where the numbers are read.
    const shallow = s.turns < Math.ceil(COVERAGE_FLOOR * s.maxTurns) ? " ⚠" : "";
    L.push(
      `| ${s.scenarioId} | ${s.turns}/${s.maxTurns}${shallow} | ${s.stopped} | ${s.findings}${delta(s.findings, before?.findings)} | ` +
        `${s.fallbackTurns}${delta(s.fallbackTurns, before?.fallbackTurns)} | ${(s.wallMsMean / 1000).toFixed(1)}s | ${judge} |`,
    );
  }
  const shallowRuns = result.scenarioStats.filter((s) => s.turns < Math.ceil(COVERAGE_FLOOR * s.maxTurns));
  if (shallowRuns.length > 0) {
    L.push(
      "",
      `> ⚠ ${shallowRuns.map((s) => `**${s.scenarioId}** (${s.turns}/${s.maxTurns})`).join(", ")} stopped under half the turn cap.`,
      "> Findings absent from a run that short are reported UNMEASURED, not cleared.",
    );
  }
  L.push("");

  const sections: Array<[TriageItem["verdict"], string, string]> = [
    ["regressed", "Regressed", "Was clear at the end of an earlier round and is back. Something undid the fix — read the prior attempt before touching anything."],
    ["new", "New", "Not seen in any previous round."],
    ["recurring", "Recurring", "Still open, and the last round saw it too. If a fix was aimed at it, that diagnosis was wrong — re-derive from the trace, do not re-apply."],
    ["fixed", "Cleared this round", "Open last round, absent now. Provisional: one live run is one sample against a nondeterministic model."],
    ["flaky", "Flaky (not actionable)", "Has oscillated clear/present 3+ times. Treat as model variance, not a code defect, until a deterministic repro exists."],
    ["unmeasured", "Unmeasured (coverage short)", "The scenario ran, but stopped before this finding's own evidence depth — usually the driver declaring the goal met early. Silence proves nothing here: still open, NOT cleared, and not handed to the fixer. If a fingerprint lives here for several rounds, the scenario is too shallow to test it."],
  ];
  for (const [verdict, title, blurb] of sections) {
    const items = bucket(result.items, verdict);
    L.push(`## ${title} (${items.length})`, "", `_${blurb}_`, "");
    if (items.length === 0) L.push("_none_", "");
    else for (const i of items) L.push(...renderItem(i));
  }

  const muted = Object.values(result.ledger.entries).filter((e) => e.status === "muted");
  if (muted.length > 0) {
    L.push(`## Muted (${muted.length})`, "");
    for (const e of muted) L.push(`- \`${e.fp}\` — ${e.note ?? "no reason recorded"}`);
    L.push("");
  }

  L.push("## Work order", "");
  if (result.actionable.length === 0) {
    L.push("_Nothing actionable — the sweep came back clean of anything the ledger has not already parked._");
  } else {
    result.actionable.forEach((i, n) => {
      L.push(`${n + 1}. \`${labelOf(i.entry.fp)}\` in **${i.entry.scenarioId}** — ${i.verdict}, ${i.entry.confidence}`);
    });
    const tier = routeFixTier(result.actionable);
    L.push(
      "",
      `Fix stage routed to **${tier.model}** at effort **${tier.effort}**${tier.ultracode ? " with **ultracode**" : ""} — ${tier.reason}.`,
    );
  }
  L.push("");
  return L.join("\n");
}

function renderStatus(ledger: Ledger): string {
  const rows = Object.values(ledger.entries).sort((a, b) => a.fp.localeCompare(b.fp));
  const L = [`# Findings ledger — ${rows.length} entries over ${ledger.rounds.length} rounds`, ""];
  for (const e of rows) {
    L.push(
      `- [${e.status}] \`${e.fp}\` — seen ${e.seenRounds}, clear ${e.clearedRounds}, regressions ${e.regressions}, ` +
        `attempts ${e.fixAttempts.length}${e.note ? ` — ${e.note}` : ""}`,
    );
  }
  return L.join("\n");
}

interface Args {
  round?: string;
  recordFix?: string;
  mute?: string;
  note?: string;
  status: boolean;
  recheck?: boolean;
  force?: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { status: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === "--round") a.round = argv[++i];
    else if (f === "--record-fix") a.recordFix = argv[++i];
    else if (f === "--mute") a.mute = argv[++i];
    else if (f === "--note") a.note = argv[++i];
    else if (f === "--status") a.status = true;
    else if (f === "--recheck") a.recheck = true;
    else if (f === "--force") a.force = true;
    else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ledger = loadLedger();

  if (args.status) {
    console.log(renderStatus(ledger));
    return;
  }

  if (args.mute) {
    if (!args.note) throw new Error("--mute requires --note (a muted finding without a reason is a lost finding)");
    saveLedger(mute(ledger, args.mute, args.note));
    console.log(`muted ${args.mute}`);
    return;
  }

  const rounds = roundsOnDisk();
  if (rounds.length === 0) throw new Error(`no sweep reports in ${REPORTS_DIR} — run playtest/auto/run.ts first`);

  if (args.recheck) {
    const inputs = rounds
      .map((rf) => {
        const prior = ledger.rounds.find((r) => r.round === rf.round);
        return {
          round: rf.round,
          commit: prior?.commit ?? "unknown",
          measurementHash: prior?.measurementHash ?? measurementHash(),
          reports: loadRound(rf),
        };
      })
      .filter((i) => i.reports.length > 0);
    // A rebuild can only see rounds whose reports still exist. If the ledger remembers a round the
    // reports directory no longer holds, rebuilding would silently drop every finding whose only
    // evidence lived there — the loop's memory, deleted by a cleanup. Refuse instead.
    const haveRounds = new Set(inputs.map((i) => i.round));
    const orphaned = ledger.rounds.filter((r) => !haveRounds.has(r.round)).map((r) => r.round);
    if (orphaned.length > 0 && !args.force) {
      throw new Error(
        `refusing to recheck: the ledger records ${orphaned.length} round(s) with no reports on disk ` +
          `(${orphaned.join(", ")}). Rebuilding would drop their findings. Restore the reports, or ` +
          `pass --force to rebuild from the ${inputs.length} round(s) that remain and accept the loss.`,
      );
    }
    const rebuilt = recheckLedger(ledger, inputs);
    const changes = ledgerDiff(ledger, rebuilt);
    saveLedger(rebuilt);
    console.log(`rechecked ${inputs.length} round(s) under the current fold rules`);
    if (orphaned.length > 0) console.log(`⚠ dropped ${orphaned.length} round(s) with no reports on disk: ${orphaned.join(", ")}`);
    if (changes.length === 0) console.log("no status changed — the ledger already agreed with the rules");
    else for (const c of changes) console.log(`  ${c.fp}: ${c.from} → ${c.to}`);
    return;
  }

  if (args.recordFix) {
    const round = args.round ?? ledger.rounds[ledger.rounds.length - 1]?.round;
    if (!round) throw new Error("no folded round to attach a fix to");
    saveLedger(recordFix(ledger, round, args.recordFix, args.note));
    console.log(`recorded fix ${args.recordFix} against round ${round}`);
    return;
  }

  const target = args.round ? rounds.find((r) => r.round === args.round) : rounds[rounds.length - 1];
  if (!target) throw new Error(`round ${args.round} not found in ${REPORTS_DIR}`);
  if (ledger.rounds.some((r: RoundRecord) => r.round === target.round)) {
    console.log(`round ${target.round} is already folded into the ledger — nothing to do`);
    // Re-emit the machine-readable tail from the round's saved triage so a re-run of the loop
    // after an interruption routes the fix stage the same way the first pass would have.
    let saved: { tier?: { model: string; effort: string; ultracode: boolean }; items?: TriageItem[] } = {};
    try {
      saved = JSON.parse(readFileSync(join(REPORTS_DIR, `${target.round}-triage.json`), "utf8"));
    } catch {
      // no saved triage — fall through to the neutral defaults below
    }
    console.log(`ROUND=${target.round}`);
    console.log(`ACTIONABLE=${ledger.rounds.find((r) => r.round === target.round)?.actionable.length ?? 0}`);
    console.log(`UNMEASURED=${saved.items?.filter((i) => i.verdict === "unmeasured").length ?? 0}`);
    console.log(`FIXMODEL=${saved.tier?.model ?? "claude-opus-5"}`);
    console.log(`FIXEFFORT=${saved.tier?.effort ?? "high"}`);
    console.log(`ULTRACODE=${saved.tier?.ultracode ? 1 : 0}`);
    return;
  }

  const reports = loadRound(target);
  if (reports.length === 0) throw new Error(`round ${target.round} has no readable reports`);

  const result = foldRound(ledger, {
    round: target.round,
    commit: await headSha(),
    measurementHash: measurementHash(),
    reports,
  });
  saveLedger(result.ledger);

  const tier = routeFixTier(result.actionable);
  const mdPath = join(REPORTS_DIR, `${target.round}-triage.md`);
  writeFileSync(mdPath, renderTriageMarkdown(result, target));
  writeFileSync(
    join(REPORTS_DIR, `${target.round}-triage.json`),
    `${JSON.stringify({ round: result.round, measurementChanged: result.measurementChanged, tier, items: result.items, actionable: result.actionable.map((i) => i.entry.fp) }, null, 2)}\n`,
  );

  const counts = (v: TriageItem["verdict"]) => bucket(result.items, v).length;
  console.log(
    `round ${result.round}: new ${counts("new")} · recurring ${counts("recurring")} · regressed ${counts("regressed")} · cleared ${counts("fixed")} · flaky ${counts("flaky")} · unmeasured ${counts("unmeasured")}`,
  );
  if (result.measurementChanged) console.log("⚠ measurement surface changed — FIXED verdicts unverified");
  if (counts("unmeasured") > 0) {
    console.log(`⚠ ${counts("unmeasured")} finding(s) unmeasured — a scenario stopped short of its own evidence depth`);
  }
  if (result.actionable.length > 0) console.log(`fix tier: ${tier.model} @ ${tier.effort}${tier.ultracode ? " +ultracode" : ""} — ${tier.reason}`);
  console.log(`triage: ${mdPath}`);
  // Machine-readable tail — loop.sh greps these lines.
  console.log(`ROUND=${result.round}`);
  console.log(`ACTIONABLE=${result.actionable.length}`);
  console.log(`UNMEASURED=${counts("unmeasured")}`);
  console.log(`FIXMODEL=${tier.model}`);
  console.log(`FIXEFFORT=${tier.effort}`);
  console.log(`ULTRACODE=${tier.ultracode ? 1 : 0}`);
}

if (import.meta.main) await main();
