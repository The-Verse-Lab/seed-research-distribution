/**
 * Auto-playtest loop — fingerprint identity and the standing ledger's round arithmetic.
 *
 * The loop's whole value is the verdict it puts on a finding: NEW, RECURRING (the fix missed),
 * REGRESSED (something undid it), FIXED, FLAKY (the live model, not the code). Those verdicts come
 * out of `foldRound`, which is pure over recorded reports — so every transition is pinned here
 * without a model, a gateway, or a live sweep.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, groupByFingerprint, normalizeKey } from "../playtest/auto/fingerprint.ts";
import {
  coverageNeededFor,
  coverageTargetFor,
  emptyLedger,
  foldRound,
  ledgerDiff,
  measurementHashOf,
  mute,
  recheckLedger,
  recordFix,
  COVERAGE_FLOOR,
  MEASUREMENT_FILES,
  type EntryStatus,
  type Ledger,
  type LedgerEntry,
  type TriageItem,
} from "../playtest/auto/ledger.ts";
import { pinModel, routeFixTier } from "../playtest/auto/routing.ts";
import type { Finding, RubricReport } from "../playtest/auto/types.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return { class: "audit-violation", turn: 3, summary: "turn auditor: verbatimDropped", key: "verbatimDropped", confidence: "confirmed", ...over };
}

function report(scenarioId: string, findings: Finding[]): RubricReport {
  return {
    scenarioId,
    findings,
    stats: {
      turns: 20,
      wallMsTotal: 0,
      wallMsMean: 0,
      wallMsP90: 0,
      classifierKinds: {},
      fallbackTurns: 0,
      moduleCostMs: {},
      consentBlocks: {},
      findingsByClass: {},
    },
  };
}

function fold(prior: Ledger, round: string, reports: RubricReport[], hash = "h1") {
  return foldRound(prior, {
    round,
    commit: "abc1234",
    measurementHash: hash,
    reports: reports.map((r) => ({ report: r, turns: 20, maxTurns: 20, stopped: "maxTurns" })),
  });
}

/** Same fold, but the run stopped early — the driver declared the goal met at `turns`. */
function foldShort(prior: Ledger, round: string, reports: RubricReport[], turns: number, maxTurns = 20) {
  return foldRound(prior, {
    round,
    commit: "abc1234",
    measurementHash: "h1",
    reports: reports.map((r) => ({ report: r, turns, maxTurns, stopped: "driverDone" })),
  });
}

describe("fingerprint", () => {
  test("is stable when the turn, the location and the model's words all move", () => {
    const a = finding({
      class: "involuntary-relocation",
      key: "dialogueToNpc",
      turn: 4,
      summary: 'party moved loc.a → loc.b on a "dialogueToNpc" turn ("ask Oda about the road")',
    });
    const b = { ...a, turn: 17, summary: 'party moved loc.q → loc.z on a "dialogueToNpc" turn ("what do you know")' };
    expect(fingerprint("fixture-travel", a)).toBe(fingerprint("fixture-travel", b));
  });

  test("separates scenarios — the same class in two scenarios is usually two code paths", () => {
    expect(fingerprint("fixture-trade", finding())).not.toBe(fingerprint("fixture-combat", finding()));
  });

  test("separates within-class keys", () => {
    expect(fingerprint("fixture-trade", finding({ key: "verbatimDropped" }))).not.toBe(
      fingerprint("fixture-trade", finding({ key: "castPresence" })),
    );
  });

  test("falls back to a normalized summary for reports recorded before keys existed", () => {
    const legacy = { class: "state-inert", turn: 6, summary: "4 consecutive turns (t6–t9) emitted no state change at all", confidence: "review" } as Finding;
    const later = { ...legacy, turn: 15, summary: "5 consecutive turns (t15–t19) emitted no state change at all" };
    expect(fingerprint("fixture-trade", legacy)).toBe(fingerprint("fixture-trade", later));
  });

  test("normalizeKey collapses quotes, ids and digits", () => {
    expect(normalizeKey('moved loc.a → loc.b on 3 turns ("go north")')).toBe("moved § → § on # turns (§)");
  });

  test("grouping counts occurrences and prefers a confirmed exemplar", () => {
    const g = groupByFingerprint("fixture-trade", [
      finding({ turn: 2, confidence: "review", summary: "weak" }),
      finding({ turn: 9, confidence: "confirmed", summary: "strong" }),
    ]);
    const only = [...g.values()][0]!;
    expect(only.count).toBe(2);
    expect(only.turns).toEqual([2, 9]);
    expect(only.exemplar.summary).toBe("strong");
  });
});

describe("ledger round arithmetic", () => {
  test("a first sighting is NEW and becomes an open entry", () => {
    const r = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    expect(r.items.map((i) => i.verdict)).toEqual(["new"]);
    expect(r.actionable).toHaveLength(1);
    const entry = r.ledger.entries[fingerprint("fixture-trade", finding())]!;
    expect(entry.status).toBe("open");
    expect(entry.firstRound).toBe("r1");
    expect(entry.seenRounds).toBe(1);
  });

  test("seen again next round is RECURRING, not new", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const r2 = fold(r1.ledger, "r2", [report("fixture-trade", [finding({ turn: 11 })])]);
    expect(r2.items.map((i) => i.verdict)).toEqual(["recurring"]);
    expect(r2.ledger.entries[fingerprint("fixture-trade", finding())]!.seenRounds).toBe(2);
  });

  test("absent while its scenario ran is FIXED — and coming back after that is REGRESSED", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const r2 = fold(r1.ledger, "r2", [report("fixture-trade", [])]);
    expect(r2.items.map((i) => i.verdict)).toEqual(["fixed"]);
    expect(r2.actionable).toHaveLength(0);

    const r3 = fold(r2.ledger, "r3", [report("fixture-trade", [finding()])]);
    expect(r3.items.map((i) => i.verdict)).toEqual(["regressed"]);
    const entry = r3.ledger.entries[fingerprint("fixture-trade", finding())]!;
    expect(entry.regressions).toBe(1);
    expect(r3.actionable[0]!.verdict).toBe("regressed");
  });

  test("a scenario that did not run this round yields no verdict either way", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const r2 = fold(r1.ledger, "r2", [report("fixture-combat", [])]);
    expect(r2.items).toHaveLength(0);
    expect(r2.ledger.entries[fingerprint("fixture-trade", finding())]!.status).toBe("open");
  });

  test("a run that stopped under the coverage floor clears NOTHING — it is UNMEASURED", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-work", [finding({ turn: 2 })])]);
    // The 2026-08-02 shape: the driver really finished the goal at turn 2 of 20. Real completion,
    // but 2 turns is not a sample — the old rule credited it as a clear and marked the entry fixed.
    const r2 = foldShort(r1.ledger, "r2", [report("fixture-work", [])], 2);

    expect(r2.items.map((i) => i.verdict)).toEqual(["unmeasured"]);
    expect(r2.items[0]!.coverage).toEqual({ turns: 2, maxTurns: 20, needed: 10 });
    const entry = r2.ledger.entries[fingerprint("fixture-work", finding())]!;
    expect(entry.status).toBe("open");
    expect(entry.clearedRounds).toBe(0);
    expect(entry.lastClearRound).toBeUndefined();
  });

  test("past the floor but short of the finding's own evidence depth is still UNMEASURED", () => {
    // Fires at t13. A run that stopped at t11 cleared the floor (10) but never reached the evidence.
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding({ turn: 13 })])]);
    const r2 = foldShort(r1.ledger, "r2", [report("fixture-trade", [])], 11);
    expect(r2.items[0]!.verdict).toBe("unmeasured");
    expect(r2.items[0]!.coverage!.needed).toBe(13);

    // Reaching t13 makes the silence mean something.
    const r3 = foldShort(r2.ledger, "r3", [report("fixture-trade", [])], 13);
    expect(r3.items[0]!.verdict).toBe("fixed");
  });

  test("an unmeasured round is never handed to the fixer and never counts an oscillation", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-work", [finding({ turn: 2 })])]);
    let led = r1.ledger;
    // Four shallow rounds in a row must not drift the entry toward FLAKY by fake clear/present flips.
    for (const n of [2, 3, 4, 5]) led = foldShort(led, `r${n}`, [report("fixture-work", [])], 2).ledger;
    const entry = led.entries[fingerprint("fixture-work", finding())]!;
    expect(entry.oscillations).toBe(0);
    expect(entry.seenRounds).toBe(1);

    const last = foldShort(led, "r6", [report("fixture-work", [])], 2);
    expect(last.actionable).toHaveLength(0);
    expect(last.items[0]!.verdict).toBe("unmeasured");
  });

  test("a shallow run does not strengthen an already-fixed entry's clear record either", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-work", [finding({ turn: 2 })])]);
    const r2 = fold(r1.ledger, "r2", [report("fixture-work", [])]); // deep run, honestly fixed
    expect(r2.ledger.entries[fingerprint("fixture-work", finding())]!.clearedRounds).toBe(1);

    const r3 = foldShort(r2.ledger, "r3", [report("fixture-work", [])], 2);
    expect(r3.ledger.entries[fingerprint("fixture-work", finding())]!.clearedRounds).toBe(1);
    expect(r3.items[0]!.verdict).toBe("unmeasured");
  });

  test("coverageNeededFor takes the deeper of the floor and the finding's own evidence", () => {
    const shallowEvidence = { exampleTurns: [2, 4] } as never;
    expect(coverageNeededFor(shallowEvidence, 20)).toBe(10); // floor wins
    const deepEvidence = { exampleTurns: [10, 18] } as never;
    expect(coverageNeededFor(deepEvidence, 20)).toBe(18); // evidence wins
    expect(COVERAGE_FLOOR).toBeGreaterThan(0);
  });

  // The fold demands `coverageNeededFor`, but the harness used to push the driver only to the blunt
  // COVERAGE_FLOOR — so a finding whose evidence sat deeper than half the cap could never be
  // cleared however well the engine behaved (2026-08-04: fixture-combat stopped 11/20 needing 12/16/20,
  // fixture-social 12/20 needing 16, four findings unmeasured two rounds running). This is the query the
  // sweep asks so the two agree.
  /** Only the three fields `coverageTargetFor` reads; the rest of the entry is irrelevant here. */
  const depthEntry = (scenarioId: string, status: EntryStatus, exampleTurns: number[]): LedgerEntry =>
    ({ scenarioId, status, exampleTurns }) as unknown as LedgerEntry;

  test("coverageTargetFor is the deepest live entry the scenario must outrun", () => {
    const led = emptyLedger();
    led.entries["fixture-combat::a"] = depthEntry("fixture-combat", "fixed", [12]);
    led.entries["fixture-combat::b"] = depthEntry("fixture-combat", "open", [16, 4]);
    led.entries["fixture-social::c"] = depthEntry("fixture-social", "open", [19]);

    expect(coverageTargetFor(led, "fixture-combat", 20)).toBe(16); // deepest of ITS OWN entries, not fixture-social's
    expect(coverageTargetFor(led, "fixture-social", 20)).toBe(19);
  });

  test("coverageTargetFor floors at COVERAGE_FLOOR, clamps to the cap, and ignores muted entries", () => {
    const led = emptyLedger();
    led.entries["fixture-work::shallow"] = depthEntry("fixture-work", "open", [2]);
    expect(coverageTargetFor(led, "fixture-work", 20)).toBe(10); // floor wins over shallow evidence
    expect(coverageTargetFor(led, "fixture-unknown", 16)).toBe(8); // no entries at all ⇒ the floor

    // Evidence deeper than the cap cannot demand turns the scenario does not have.
    led.entries["fixture-work::beyond"] = depthEntry("fixture-work", "open", [40]);
    expect(coverageTargetFor(led, "fixture-work", 20)).toBe(20);

    // A muted finding is nobody's verdict to wait on, so it must not buy turns.
    led.entries["fixture-work::beyond"] = depthEntry("fixture-work", "muted", [40]);
    expect(coverageTargetFor(led, "fixture-work", 20)).toBe(10);
  });

  test("a finding that oscillates three times is FLAKY and never handed to the fixer", () => {
    let led = emptyLedger();
    // present / clear / present / clear — the live model as the variable, not the code.
    [true, false, true, false].forEach((present, n) => {
      led = fold(led, `r${n}`, [report("fixture-trade", present ? [finding()] : [])]).ledger;
    });
    const last = fold(led, "rN", [report("fixture-trade", [finding()])]);
    expect(last.items[0]!.verdict).toBe("flaky");
    expect(last.actionable).toHaveLength(0);
  });

  test("regressions rank above new, and confirmed above review", () => {
    const base = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const cleared = fold(base.ledger, "r2", [report("fixture-trade", [])]);
    const r3 = fold(cleared.ledger, "r3", [
      report("fixture-trade", [
        finding({ key: "brandNew", class: "grounding-fallback", confidence: "review", summary: "fresh review smell" }),
        finding({ key: "alsoNew", class: "classifier-fallback", confidence: "confirmed", summary: "fresh confirmed" }),
        finding(),
      ]),
    ]);
    expect(r3.actionable.map((i) => i.verdict)).toEqual(["regressed", "new", "new"]);
    expect(r3.actionable[1]!.entry.confidence).toBe("confirmed");
  });

  test("a muted finding stays out of the work order even while it keeps firing", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const muted = mute(r1.ledger, fingerprint("fixture-trade", finding()), "accepted noise");
    const r2 = fold(muted, "r2", [report("fixture-trade", [finding()])]);
    expect(r2.actionable).toHaveLength(0);
    expect(r2.ledger.entries[fingerprint("fixture-trade", finding())]!.status).toBe("muted");
  });

  test("a moved measurement surface flags the round's verdicts as unverified", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])], "h1");
    const r2 = fold(r1.ledger, "r2", [report("fixture-trade", [])], "h2");
    expect(r2.measurementChanged).toBe(true);
    const r3 = fold(r2.ledger, "r3", [report("fixture-trade", [])], "h2");
    expect(r3.measurementChanged).toBe(false);
  });

  test("measurementHashOf moves with the scoring files' content", () => {
    expect(measurementHashOf(["a", "b"])).toBe(measurementHashOf(["a", "b"]));
    expect(measurementHashOf(["a", "b"])).not.toBe(measurementHashOf(["a", "c"]));
  });

  test("recordFix attaches the attempt to what the round actually handed the fixer", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const after = recordFix(r1.ledger, "r1", "deadbee", "narrowed the receipt path");
    const entry = after.entries[fingerprint("fixture-trade", finding())]!;
    expect(entry.fixAttempts).toEqual([{ round: "r1", commit: "deadbee", note: "narrowed the receipt path" }]);
    expect(after.rounds[0]!.fixCommit).toBe("deadbee");
    // A recurrence next round can now say "you already tried this, at that sha".
    const r2 = fold(after, "r2", [report("fixture-trade", [finding()])]);
    expect(r2.items[0]!.verdict).toBe("recurring");
    expect(r2.items[0]!.entry.fixAttempts).toHaveLength(1);
  });

  test("folding never mutates the ledger it was handed", () => {
    const before = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]).ledger;
    const snapshot = JSON.stringify(before);
    fold(before, "r2", [report("fixture-trade", [finding()])]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("the round record carries per-scenario health, judge scores included", () => {
    const rep = report("fixture-trade", []);
    rep.judge = { scores: { grounded: 2, agency: 1 }, notes: [] };
    const r = fold(emptyLedger(), "r1", [rep]);
    expect(r.scenarioStats[0]).toMatchObject({ scenarioId: "fixture-trade", turns: 20, findings: 0, judge: { grounded: 2 } });
    expect(r.ledger.rounds[0]!.scenarios).toHaveLength(1);
  });
});

describe("recheckLedger", () => {
  const roundInput = (round: string, reports: RubricReport[], turns: number, maxTurns = 20) => ({
    round,
    commit: "abc1234",
    measurementHash: "h1",
    reports: reports.map((r) => ({ report: r, turns, maxTurns, stopped: "driverDone" })),
  });

  test("re-folding under the coverage rule takes back a FIXED verdict a shallow run never earned", () => {
    // Exactly the 2026-08-02 shape, built with the OLD rule by hand: fixed on a 2-turn run.
    const stale = fold(emptyLedger(), "r1", [report("fixture-work", [finding({ turn: 2 })])]).ledger;
    const wronglyFixed: Ledger = {
      ...stale,
      entries: {
        ...stale.entries,
        [fingerprint("fixture-work", finding())]: {
          ...stale.entries[fingerprint("fixture-work", finding())]!,
          status: "fixed",
          clearedRounds: 1,
        },
      },
    };
    const rebuilt = recheckLedger(wronglyFixed, [
      roundInput("r1", [report("fixture-work", [finding({ turn: 2 })])], 20),
      roundInput("r2", [report("fixture-work", [])], 2),
    ]);
    const entry = rebuilt.entries[fingerprint("fixture-work", finding())]!;
    expect(entry.status).toBe("open");
    expect(entry.clearedRounds).toBe(0);
    expect(ledgerDiff(wronglyFixed, rebuilt)).toEqual([
      { fp: fingerprint("fixture-work", finding()), from: "fixed", to: "open" },
    ]);
  });

  test("a rebuild keeps the fix attempts and notes it cannot re-derive from reports", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const withFix = recordFix(r1.ledger, "r1", "deadbee", "narrowed the receipt path");
    const rebuilt = recheckLedger(withFix, [roundInput("r1", [report("fixture-trade", [finding()])], 20)]);
    expect(rebuilt.entries[fingerprint("fixture-trade", finding())]!.fixAttempts).toEqual([
      { round: "r1", commit: "deadbee", note: "narrowed the receipt path" },
    ]);
    expect(rebuilt.rounds[0]!.fixCommit).toBe("deadbee");
  });

  test("a rebuild keeps hand mutes — a muted finding must not come back as work", () => {
    const r1 = fold(emptyLedger(), "r1", [report("fixture-trade", [finding()])]);
    const muted = mute(r1.ledger, fingerprint("fixture-trade", finding()), "accepted noise");
    const rebuilt = recheckLedger(muted, [roundInput("r1", [report("fixture-trade", [finding()])], 20)]);
    const entry = rebuilt.entries[fingerprint("fixture-trade", finding())]!;
    expect(entry.status).toBe("muted");
    expect(entry.note).toBe("accepted noise");
  });

  test("a rebuild sees only the rounds it is given — the CLI must refuse when reports went missing", () => {
    // The footgun the --recheck guard exists for: prune reports/, rebuild, and every finding whose
    // only evidence lived in a pruned round is gone from the loop's memory. Pinned here so the
    // rebuild's lossiness stays a deliberate, guarded property rather than a surprise.
    const rounds = [
      roundInput("r1", [report("fixture-trade", [finding()])], 20),
      roundInput("r2", [report("fixture-combat", [finding({ key: "onlySeenInR2" })])], 20),
    ];
    const full = rounds.reduce((led, r) => foldRound(led, r).ledger, emptyLedger());
    expect(Object.keys(full.entries)).toHaveLength(2);

    const withoutR2 = recheckLedger(full, [rounds[0]!]);
    expect(Object.keys(withoutR2.entries)).toHaveLength(1);
    expect(withoutR2.entries[fingerprint("fixture-combat", finding({ key: "onlySeenInR2" }))]).toBeUndefined();
  });

  test("rechecking a ledger already consistent with the rules changes nothing", () => {
    const rounds = [
      roundInput("r1", [report("fixture-trade", [finding()])], 20),
      roundInput("r2", [report("fixture-trade", [])], 20),
    ];
    const built = rounds.reduce((led, r) => foldRound(led, r).ledger, emptyLedger());
    expect(ledgerDiff(built, recheckLedger(built, rounds))).toEqual([]);
  });
});

describe("loop.sh round-note extraction", () => {
  // FIX-AGENT.md asks the fixer to end with a FENCED summary block whose FIRST line is the
  // headline, and loop.sh stores that line as the ledger's round note. Two earlier passes both
  // read from the TOP of the log and both blanked it: the first non-blank line stored the literal
  // ```, and skipping fences and labels stored the fixer's own preamble prose ("Committed f82e7d7.
  // Only the loop-owned ledger.json remains unstaged" — round 2026-08-02T17-14-58). The note is
  // what the next round's "your predecessor's diagnosis was wrong" rule reads, so losing it costs
  // the loop its memory. The filter now anchors on the block's labels instead of the file's top.
  const loopSh = readFileSync(fileURLToPath(new URL("../playtest/auto/loop.sh", import.meta.url)), "utf8");

  /** The whole `FIX_NOTE=...` assignment, which spans several lines now that it embeds awk. */
  const fixNoteAssignment = (): string => {
    const lines = loopSh.split("\n");
    const start = lines.findIndex((l) => l.trim().startsWith("FIX_NOTE="));
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i >= start && l.includes('cut -c1-160)"'));
    expect(end).toBeGreaterThan(-1);
    return lines.slice(start, end + 1).join("\n");
  };

  /** Run the EXACT assignment the script uses, so the filter cannot drift away from this test. */
  const noteFor = async (fixLog: string, tag: string): Promise<string> => {
    const tmp = join(tmpdir(), `seed-fixnote-${process.pid}-${tag}.log`);
    writeFileSync(tmp, fixLog);
    try {
      const script = `FIX_LOG=${JSON.stringify(tmp)}\n${fixNoteAssignment()}\nprintf '%s' "$FIX_NOTE"`;
      const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "ignore" });
      return await new Response(proc.stdout).text();
    } finally {
      rmSync(tmp, { force: true });
    }
  };

  const HEADLINE = "Category asks now quote the kind-filtered counter, and the browse cap counts what it hides.";
  const BLOCK = [
    "```",
    HEADLINE,
    "closed: fixture-trade::state-inert::inert-stretch",
    "left:   none",
    "tests:  3430 passing / typecheck clean",
    "```",
    "",
  ];

  test("takes the block's headline, not the fence or the block's own labels", async () => {
    const note = await noteFor(BLOCK.join("\n"), "clean");
    expect(note).toBe(HEADLINE);
    expect(note).not.toContain("```");
  });

  test("takes the headline even when the fixer writes prose ABOVE the block", async () => {
    // The regression from round 2026-08-02T17-14-58, verbatim in shape.
    const note = await noteFor(
      ["Committed `f82e7d7`. Only the loop-owned ledger.json remains unstaged, as prior rounds left it.", ...BLOCK].join("\n"),
      "preamble",
    );
    expect(note).toBe(HEADLINE);
    expect(note).not.toContain("Committed");
  });

  test("a fixer that skips the block shape still yields its first content line", async () => {
    const note = await noteFor(["", "Narrowed nothing; could not diagnose the inert stretch.", ""].join("\n"), "noblock");
    expect(note).toBe("Narrowed nothing; could not diagnose the inert stretch.");
  });

  test("loop.sh will not call a round converged while findings went unmeasured", () => {
    expect(loopSh).toContain("UNMEASURED=");
    // The convergence branch must be guarded by the unmeasured count, not just the work order.
    const convergeAt = loopSh.indexOf("converged — stopping");
    const guardAt = loopSh.indexOf('"${UNMEASURED:-0}" -gt 0');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(convergeAt);
  });

  // Every triage writes the ledger; only the fix stage used to commit it. A round that ends
  // without one left that fold uncommitted, and the loop's OWN dirty-tree preflight then refused
  // the next run — the 2026-08-02 loop stopped on unmeasured findings and stranded round
  // 2026-08-02T22-54-22 exactly this way. The commit must survive every `break`.
  test("loop.sh commits the ledger on an exit that ran no fix stage", () => {
    expect(loopSh).toContain("commit_ledger()");
    // Placed after the round loop, which is where all three `break` paths land.
    const loopEnd = loopSh.lastIndexOf("\ndone\n");
    expect(loopEnd).toBeGreaterThan(-1);
    expect(loopSh.indexOf('commit_ledger "${ROUND_ID:-}"')).toBeGreaterThan(loopEnd);
  });

  test("commit_ledger stages the ledger alone, never the whole tree", () => {
    const body = loopSh.slice(loopSh.indexOf("commit_ledger()"), loopSh.indexOf("# --- preflight"));
    expect(body).toContain('git add "$HERE/ledger.json"');
    // `git add -A` here would sweep an unrelated edit into a loop commit.
    expect(body).not.toContain("git add -A");
  });
});

describe("fix-stage routing", () => {
  const item = (over: Partial<TriageItem["entry"]> & { verdict?: TriageItem["verdict"] } = {}): TriageItem => {
    const { verdict = "new", ...entry } = over;
    return {
      verdict,
      count: 1,
      entry: {
        fp: "fixture-trade::audit-violation::verbatimDropped",
        scenarioId: "fixture-trade",
        class: "audit-violation",
        status: "open",
        firstRound: "r1",
        lastSeenRound: "r1",
        seenRounds: 1,
        clearedRounds: 0,
        regressions: 0,
        oscillations: 0,
        lastCount: 1,
        fixAttempts: [],
        exampleSummary: "s",
        exampleTurns: [1],
        confidence: "confirmed",
        ...entry,
      },
    };
  };
  const attempts = (n: number) => Array.from({ length: n }, (_, i) => ({ round: `r${i}`, commit: `c${i}` }));

  test("a couple of new confirmed findings in one scenario is a mechanical close — Sonnet at medium", () => {
    const tier = routeFixTier([item(), item({ fp: "fixture-trade::audit-violation::castPresence" })]);
    expect(tier).toMatchObject({ model: "claude-sonnet-5", effort: "medium", ultracode: false });
  });

  test("a review-confidence finding is not mechanical — it needs judgement, so Opus", () => {
    expect(routeFixTier([item({ confidence: "review" })]).model).toBe("claude-opus-5");
  });

  test("two scenarios is not mechanical either — two code paths, not one", () => {
    const tier = routeFixTier([item(), item({ scenarioId: "fixture-combat", fp: "fixture-combat::audit-violation::x" })]);
    expect(tier.model).toBe("claude-opus-5");
  });

  test("an ordinary mixed round is Opus at high, no ultracode", () => {
    const tier = routeFixTier([item({ verdict: "recurring" }), item({ confidence: "review" }), item()]);
    expect(tier).toMatchObject({ model: "claude-opus-5", effort: "high", ultracode: false });
  });

  test("a regression escalates to Fable with ultracode — a fix that worked was undone", () => {
    const tier = routeFixTier([item({ verdict: "regressed" }), item()]);
    expect(tier).toMatchObject({ model: "claude-fable-5", effort: "xhigh", ultracode: true });
    expect(tier.reason).toContain("regressed");
  });

  test("two failed fix attempts escalate the same way — the cheap read is known wrong", () => {
    const tier = routeFixTier([item({ verdict: "recurring", fixAttempts: attempts(2) })]);
    expect(tier).toMatchObject({ model: "claude-fable-5", effort: "xhigh", ultracode: true });
  });

  test("three failed attempts goes to max — three wrong diagnoses is not a budget problem", () => {
    const tier = routeFixTier([item({ verdict: "recurring", fixAttempts: attempts(3) })]);
    expect(tier).toMatchObject({ model: "claude-fable-5", effort: "max", ultracode: true });
  });

  test("a broad round is Fable at xhigh but NOT ultracode — volume, not subtlety", () => {
    const many = ["audit-violation", "state-inert", "grounding-fallback", "stranded-scene"].flatMap((c, i) =>
      [0, 1].map((n) => item({ class: c as never, fp: `fixture-trade::${c}::k${i}${n}` })),
    );
    const tier = routeFixTier(many);
    expect(tier).toMatchObject({ model: "claude-fable-5", effort: "xhigh", ultracode: false });
  });

  test("many findings of ONE class is not broad — it is one cause, so Opus", () => {
    const many = Array.from({ length: 9 }, (_, n) => item({ fp: `fixture-trade::audit-violation::k${n}` }));
    expect(routeFixTier(many).model).toBe("claude-opus-5");
  });

  test("an empty work order never spends anything", () => {
    expect(routeFixTier([])).toMatchObject({ model: "claude-sonnet-5", effort: "low", ultracode: false });
  });

  test("pinning the model keeps the round's derived effort and ultracode", () => {
    const auto = routeFixTier([item({ verdict: "regressed" })]);
    const pinned = pinModel(auto, "sonnet");
    expect(pinned).toMatchObject({ model: "claude-sonnet-5", effort: "xhigh", ultracode: true });
    expect(pinned.reason).toContain("pinned to sonnet");
  });

  test("routing is not part of the measurement surface — how hard the fixer thinks cannot redefine a finding", () => {
    expect(MEASUREMENT_FILES).not.toContain("routing.ts");
  });
});
