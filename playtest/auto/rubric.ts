/**
 * Automated playtest harness — the rubric (Concordia transfer #5).
 *
 * Scores a completed RecordedRun against the failure classes `docs/PROSE-TO-CODE.md` names, from
 * the TRACE and DELTA LOG wherever the class has a mechanical signature. Pure functions over
 * recorded data — no engine, no model — so every scorer is unit-testable offline and a wave can
 * diff two reports turn-for-turn.
 *
 * Confidence discipline: `confirmed` only where the signature is unambiguous (the auditor already
 * flagged it, a classifier fallback fired, an NPC action was rejected). Anything inferring INTENT
 * from prose or kind (swallowed travel, involuntary relocation, free prose payment) is `review` —
 * the rubric flags for a human/judge look, it does not convict. Seed is Dramatist: the rubric
 * scores failure classes, never the fiction.
 *
 * @author Runkai Zhang
 */
import type { GameEvent } from "../../src/events/types.ts";
import type { Finding, RecordedRun, RecordedTurn, RubricReport, RunStats, StateSnapshot } from "./types.ts";

/** Player-visible prose of a turn (narration + dialogue), joined for signature scans.
 *  `excludeActorId` drops that actor's own spoken lines — the payment scan uses it for the PC,
 *  whose haggling ("One hundred copper for the blade") is an OFFER, not a narrated transaction. */
function proseOf(t: RecordedTurn, excludeActorId?: string): string {
  const parts: string[] = [];
  for (const e of t.events) {
    if (e.kind === "narration") parts.push(e.text);
    else if (e.kind === "dialogue" && e.actorId !== excludeActorId) parts.push(e.text);
  }
  return parts.join("\n");
}

function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function deltasOf(t: RecordedTurn, kind: string): GameEvent[] {
  return t.events.filter((e) => e.kind === kind);
}

/** The player tick's trace for a turn (heartbeats may add more rows; the player one carries the plan). */
function playerTraceOf(t: RecordedTurn) {
  return t.traces.find((tr) => tr.trigger === "player");
}

/** Above this much prose, a turn that refused to move did not do it quietly — it narrated. */
const QUIET_PROSE_CHARS = 40;

/**
 * Turns where a movement-classified line left the party exactly where it stood, with nothing
 * visible to say why — the r9 "multi-leg travel silently swallowed" class. A refusal is fine when
 * SOMETHING said so (a system line, a non-quiet stateChanged, a dice contest); unexplained is the
 * bug.
 *
 * MEASUREMENT (2026-08-03, owner-approved): this scorer had a `prose.length < 40` gate and had
 * therefore NEVER fired — not once in six rounds — while its exact failure mode was happening in
 * front of it. fixture-combat 2026-08-02T17-14-58 t6–t8 are three consecutive movement turns, ~1kB of
 * prose each narrating a westward walk, party never leaving the square, no delta, no dice, no
 * receipt; all three scored clean here because they were too WORDY. A scorer that stays silent
 * through its own class is worse than no scorer, because the report reads as "this class is
 * clean". Prose volume now picks the KEY instead of suppressing the finding: quiet is the original
 * `silent-refusal`, loud is `narrated-nonmove` — the engine filling the gap where a receipt should
 * be, which is the worse of the two and the one that had been invisible.
 */
export function findSwallowedTravel(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  let prev: StateSnapshot = run.initial;
  for (const t of run.turns) {
    const trace = playerTraceOf(t);
    if (trace?.classifierKind === "movement" && t.after.locationId === prev.locationId) {
      const explained = t.events.some(
        (e) =>
          e.kind === "system" ||
          (e.kind === "stateChanged" && !e.quiet) ||
          e.kind === "diceRolled",
      );
      const prose = proseOf(t);
      if (!explained) {
        const quiet = prose.length < QUIET_PROSE_CHARS;
        out.push({
          class: "swallowed-travel",
          turn: t.turn,
          key: quiet ? "silent-refusal" : "narrated-nonmove",
          summary: quiet
            ? `movement turn ("${excerpt(t.input, 60)}") moved nobody and nothing said why`
            : `movement turn ("${excerpt(t.input, 60)}") moved nobody, yet narrated ${prose.length} chars over the gap — no receipt, no dice`,
          evidence: excerpt(prose || "(no prose)"),
          confidence: "review",
        });
      }
    }
    prev = t.after;
  }
  return out;
}

const MOVEMENT_KINDS = new Set(["movement", "enterCamp", "endDay", "rest", "wakeInRoom", "rentRoom"]);

/**
 * Turns where the party location CHANGED though the player asked for something else — the r3
 * "AGREE walked the party across the map" class. Movement-family kinds (and quest/party actions,
 * which may legitimately relocate via an accepted proposal) are exempt from flagging only when the
 * turn also shows a proposal/travel affordance; otherwise flagged for review.
 */
export function findInvoluntaryRelocation(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  let prev: StateSnapshot = run.initial;
  for (const t of run.turns) {
    const moved = t.after.locationId !== prev.locationId;
    const trace = playerTraceOf(t);
    const kind = trace?.classifierKind ?? "(none)";
    // MEASUREMENT: a settle-then-move (r11 §2.4) is a relocation the player asked for IN THE SAME
    // SENTENCE — "I sign the salvage claim for the overdue caravan, then head west on the Ashwild
    // road" classifies as `questAction` and moves the party on purpose. The exemption is keyed to the
    // trace's reconciled destination MATCHING where the party ended up, so a settle-then-move that
    // relocated somewhere ELSE still flags.
    const asked = trace?.classifierSecondaryMove?.destinationLocationId;
    if (moved && asked && asked === t.after.locationId) {
      prev = t.after;
      continue;
    }
    if (moved && !MOVEMENT_KINDS.has(kind)) {
      out.push({
        class: "involuntary-relocation",
        turn: t.turn,
        key: kind,
        summary: `party moved ${prev.locationId ?? "?"} → ${t.after.locationId ?? "?"} on a "${kind}" turn ("${excerpt(t.input, 50)}")`,
        confidence: "review",
      });
    }
    prev = t.after;
  }
  return out;
}

/** A COMPLETED payment claim about the player — a subject actually moving coin — never a bare
 *  currency token (r10 F-8: the old any-coin-token regex fired 15/15 false positives on vendor
 *  stock lists, wage talk and the engine's own honest refusals, burying the one real phantom).
 *  Dev-tooling scan over model output — the product never does this; review-confidence only. */
const COMPLETED_PAYMENT_RE =
  /\byou\s+(?:pay|paid|hand(?:\s+over|ed\s+over)?|count(?:\s+out|ed\s+out)|slide|slid|press|pressed|drop|dropped|toss|tossed)\b[^.!?\n]{0,60}?\b(?:\d+\s*)?(?:cp|sp|gp|coppers?|silvers?|golds?|coins?)\b|\b(?:pays?|paid|hands?|handed)\s+you\b[^.!?\n]{0,60}?\b(?:\d+\s*)?(?:cp|sp|gp|coppers?|silvers?|golds?|coins?)\b|\byou\s+settle\s+(?:the|your)\s+(?:bill|debt|tab|price)\b/i;
/** "coins change hands" names no payer at all, so unlike every branch above it cannot tell the
 *  player's purse from the CROWD's (r14 fixture-travel t5: an arrival at Vellmere's market — "already the
 *  market has turned back to its work, though the voices stay low and the coins change hands a
 *  half-beat quicker than they should" — on a `movement` turn that applied exactly `moveParty`).
 *  Third-party market scenery is prose the world is not supposed to move. It counts only when the
 *  player is a party to the sentence it lives in ("Coins change hands, and the lantern is yours"). */
const HANDS_EXCHANGE_RE = /\bcoins?\s+changes?\s+hands\b/i;
const PLAYER_PARTY_RE = /\b(?:you|your|yours)\b/i;
/**
 * The player as the AGENT of a transfer, in an adjacent sentence — the anchor a subjectless
 * exchange attaches to when the payment is narrated across a sentence boundary ("You set the
 * lantern on the counter and the keeper nods. Coins change hands.").
 *
 * Deliberately NOT `PLAYER_PARTY_RE` over the neighbours: the market-scenery false positive this
 * scorer was narrowed for has "the gate's weight settles behind you" one sentence earlier, so a
 * bare `you` in the window would hand it straight back. The player must be DOING the transfer, not
 * merely present for it.
 *
 * `take`/`claim` are left out on purpose — "you take the road", "you take a breath" are movement
 * and idiom, and a genuine acquisition almost always says whose it is ("the lantern is yours"),
 * which the same-sentence rule already catches.
 */
const PLAYER_TRANSFER_RE =
  /\byou\s+(?:set|lay|place|placed|put|slide|slid|push|pushed|hand|handed|pass|passed|offer|offered|count|counted|drop|dropped|give|gave|pay|paid|buy|bought|purchase|purchased|accept|accepted|collect|collected|pocket|pocketed)\b/i;
/** Parenthesized price listings — "(8 sp)", "(2 gp each)" — are a counter being described, not a
 *  payment happening; strip before scanning. */
const PRICE_LISTING_RE = /\([^()]*\d+\s*(?:cp|sp|gp)[^()]*\)/gi;
/** The prose SAYING money did NOT move is the engine being honest, not a phantom payment. */
const PAYMENT_NEGATION_RE =
  /\bno\s+coins?\b|\bnot\s+enough\b|\bnothing\s+changes?\s+hands\b|\bwithout\s+(?:pay(?:ing|ment)?|coin)\b|\bcan(?:not|'t)\s+afford\b/i;

/** Sentence spans in order — one notion of "sentence" for every scope rule below. */
function sentenceSpansOf(prose: string): Array<{ text: string; start: number; end: number }> {
  const spans: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < prose.length; i++) {
    const c = prose[i]!;
    if (c === "." || c === "!" || c === "?" || c === "\n") {
      spans.push({ text: prose.slice(start, i + 1), start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < prose.length) spans.push({ text: prose.slice(start), start, end: prose.length });
  return spans;
}

/** The sentence `index` falls inside — the scope a subjectless claim is read against. */
function sentenceAt(prose: string, index: number): string {
  return sentenceSpansOf(prose).find((s) => index >= s.start && index < s.end)?.text ?? prose;
}

/** The sentences on either side of `index` — one step of context, never the whole paragraph. */
function neighbourSentencesOf(prose: string, index: number): string[] {
  const spans = sentenceSpansOf(prose);
  const at = spans.findIndex((s) => index >= s.start && index < s.end);
  if (at < 0) return [];
  return [spans[at - 1]?.text, spans[at + 1]?.text].filter((s): s is string => s !== undefined);
}

/** The first completed-payment claim the player is a party to, or null. */
function paymentClaimIn(prose: string): { text: string; index: number } | null {
  const anchored = COMPLETED_PAYMENT_RE.exec(prose);
  if (anchored) return { text: anchored[0], index: anchored.index };
  const loose = HANDS_EXCHANGE_RE.exec(prose);
  if (!loose) return null;
  // Own sentence: the player named at all is enough ("the lantern is yours"). Adjacent sentence:
  // only the player ACTING carries the claim across the boundary — see PLAYER_TRANSFER_RE.
  const carried =
    PLAYER_PARTY_RE.test(sentenceAt(prose, loose.index)) ||
    neighbourSentencesOf(prose, loose.index).some((s) => PLAYER_TRANSFER_RE.test(s));
  return carried ? { text: loose[0], index: loose.index } : null;
}

/**
 * Turns whose prose narrates money moving while no `coinsChanged` delta fired — the r6 "free prose
 * payments" class (the vest, the 8 gp). Requires a completed-payment CLAIM (subject + verb + coin),
 * skips described stock/wage listings and honest refusals.
 */
export function findFreeProsePayments(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  for (const t of run.turns) {
    const prose = proseOf(t, run.scenario.characterId).replace(PRICE_LISTING_RE, "");
    const m = paymentClaimIn(prose);
    if (!m) continue;
    if (PAYMENT_NEGATION_RE.test(prose)) continue;
    if (deltasOf(t, "coinsChanged").length > 0) continue;
    if (deltasOf(t, "itemTransferred").length > 0) continue; // barter/quest hand-ins move goods, not coins
    out.push({
      class: "free-prose-payment",
      turn: t.turn,
      key: "phantom-payment",
      summary: `prose narrates a completed payment ("${excerpt(m.text, 40)}") but no coins or items moved`,
      evidence: excerpt(prose.slice(Math.max(0, m.index - 60), m.index + 100)),
      confidence: "review",
    });
  }
  return out;
}

/** Auditor findings are already machine-confirmed — surface each with its turn. */
export function findAuditViolations(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  for (const t of run.turns) {
    for (const trace of t.traces) {
      for (const a of trace.audit ?? []) {
        out.push({
          class: "audit-violation",
          turn: t.turn,
          key: a.kind,
          summary: `turn auditor: ${a.kind}`,
          evidence: excerpt(a.detail),
          confidence: "confirmed",
        });
      }
    }
  }
  return out;
}

/** Classifier double-failures (the LLM-only classifier degraded to freeform). */
export function findClassifierFallbacks(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  for (const t of run.turns) {
    const trace = playerTraceOf(t);
    if (trace?.fallback) {
      out.push({
        class: "classifier-fallback",
        turn: t.turn,
        key: trace.fallback,
        summary: `classifier fell back (${trace.fallback}) on "${excerpt(t.input, 60)}"`,
        confidence: "confirmed",
      });
    }
  }
  return out;
}

/** NPC directives dropped to speech (low-confidence/illegal) + rejected beats — grounded-agency loss. */
export function findGroundingFallbacks(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  for (const t of run.turns) {
    for (const trace of t.traces) {
      for (const g of trace.groundingFallbacks ?? []) {
        out.push({
          class: "grounding-fallback",
          turn: t.turn,
          key: g.reason,
          summary: `${g.actorId} action dropped (${g.reason}, confidence ${g.confidence.toFixed(2)})`,
          confidence: "confirmed",
        });
      }
      for (const b of trace.npcBeats ?? []) {
        if (b.accepted === false) {
          out.push({
            class: "npc-action-rejected",
            turn: t.turn,
            key: b.rejectedReason ?? "unknown",
            summary: `${b.name}: "${excerpt(b.action ?? "", 60)}" rejected (${b.rejectedReason ?? "?"})`,
            confidence: "confirmed",
          });
        }
      }
    }
  }
  return out;
}

/**
 * A scene that will not end — the #6 motivation. Two signatures: combat still active when the run
 * stopped, and a live combat stretch of ≥ 4 turns in which no hp ever changed (nothing is
 * happening, nobody can leave).
 */
export function findStrandedScenes(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  let stagnant = 0;
  for (const t of run.turns) {
    if (t.after.combatActive && deltasOf(t, "hpChanged").length === 0) stagnant += 1;
    else stagnant = 0;
    if (stagnant === 4) {
      out.push({
        class: "stranded-scene",
        turn: t.turn,
        key: "stagnant-combat",
        summary: "combat active 4+ turns with no hp movement — likely a fight with nothing in it",
        confidence: "review",
      });
    }
  }
  const last = run.turns[run.turns.length - 1];
  if (last?.after.combatActive) {
    // MEASUREMENT (r13): a fight that BEGAN on the run's final turn is a censored observation —
    // the cap fell mid-scene and the fight had zero turns in which to end — not a scene that will
    // not end (fixture-combat 2026-08-02T19-43-12: t1–t19 combatActive=false, t20 combatStarted,
    // stopped=maxTurns). Exempt ONLY that shape: the previous turn (or the initial snapshot for a
    // one-turn run) was out of combat AND combatStarted fired on the last turn itself. A fight
    // already live entering the final turn still fires, whatever else lands on that turn.
    const prevActive =
      run.turns.length > 1 ? run.turns[run.turns.length - 2]!.after.combatActive : run.initial.combatActive;
    const openedHere = last.events.some((e) => e.kind === "combatStarted");
    if (!(openedHere && !prevActive)) {
      out.push({
        class: "stranded-scene",
        turn: last.turn,
        key: "ended-in-combat",
        summary: "run ended with combat still active",
        confidence: "confirmed",
      });
    }
  }
  return out;
}

/**
 * The base (non-delta) event kinds. Anything else on the bus IS a typed delta — testing by
 * exclusion means a delta kind added later counts automatically instead of silently not.
 */
const BASE_EVENT_KINDS = new Set([
  "narration",
  "dialogue",
  "diceRolled",
  "stateChanged",
  "npcProposal",
  "questOffered",
  "system",
]);

/**
 * Turn kinds that move no world state BY DESIGN. Talking to someone, asking after work, and an
 * out-of-character aside are complete when the words land; there is nothing for the reducer to
 * write. Counting them as "the world is not taking it" is measuring the design, not a defect.
 */
const DESIGN_INERT_KINDS = new Set(["dialogueToNpc", "workInquiry", "metaOOC"]);

/**
 * The turn said, mechanically, why nothing moved: a system line, a non-quiet `stateChanged`
 * receipt, or a dice contest the world adjudicated. Same notion `findSwallowedTravel` uses — a
 * refusal that ships a receipt is the engine being honest (r7), and every delta-free
 * `attemptRequiringCheck` in the 2026-08-02 rounds (8/8) was a roll that simply failed.
 */
function explainedMechanically(t: RecordedTurn): boolean {
  return t.events.some(
    (e) => e.kind === "system" || (e.kind === "stateChanged" && !e.quiet) || e.kind === "diceRolled",
  );
}

/** A turn whose own classified intent asks nothing of the world. */
function designInert(t: RecordedTurn): boolean {
  const trace = playerTraceOf(t);
  const kind = trace?.classifierKind;
  if (kind !== undefined && DESIGN_INERT_KINDS.has(kind)) return true;
  // A price/availability ASK is a trade turn that must NOT move coin — the r10 F-2 inquiry gate
  // exists so a question does not sell, and the trace records which one the classifier meant.
  if (kind === "trade" && trace?.classifierTrade?.inquiry === true) return true;
  return false;
}

/**
 * Stretches where the fiction moves and the world does not — the umbrella "state-lags-prose"
 * signature, caught live on the first fixture-combat run: five consecutive turns narrated a westward
 * journey to a named ravine while every turn emitted dialogue+narration and NOTHING else, and the
 * party never left the starting square.
 *
 * MEASUREMENT (2026-08-03, owner-approved): "no deltas for 3 turns" conflated that bug with two
 * kinds of correct stillness, and the confusion cost five straight fix rounds. Of the delta-free
 * turns in rounds 17-14-58/19-43-12/22-54-22: 16 were `dialogueToNpc`, 7 were trade INQUIRIES
 * (non-mutating by design), 8/8 `attemptRequiringCheck` turns had rolled dice, and 9 of 13
 * delta-free `movement` turns shipped a system/stateChanged receipt saying why. Every one of those
 * is the engine working. What remained was fixture-combat t6–t8 — three consecutive `movement` turns,
 * ~1kB of prose each narrating a westward walk, party never left the square, no delta, no dice, no
 * receipt. The finding was RIGHT about that and was read as noise because it arrived wrapped in
 * the rest. A turn now counts as inert only when nothing explained it and its own kind asked
 * something of the world; exempt turns are TRANSPARENT (they neither count nor reset), so a
 * question asked mid-journey cannot hide a real stretch. The summary names the kinds involved,
 * because "3 turns emitted no state change" is what five fixers each read differently.
 */
export function findStateInertStretch(run: RecordedRun): Finding[] {
  const out: Finding[] = [];
  /** The counted turns of the current run, as (turn, kind) — exempt turns are not in here. */
  let stretch: Array<{ turn: number; kind: string }> = [];
  const flush = () => {
    if (stretch.length >= 3) {
      const unique = [...new Set(stretch.map((s) => s.kind))];
      const named = unique.length === 1 ? `all ${unique[0]}` : unique.join(", ");
      // The turns are listed, not spanned: exempt turns may sit between them, so "t7–t14" would
      // claim a run of eight where three were counted.
      const at = stretch.map((s) => `t${s.turn}`).join(", ");
      out.push({
        class: "state-inert",
        turn: stretch[0]!.turn,
        key: "inert-stretch",
        summary: `${stretch.length} world-silent turns (${at}) — ${named} — emitted no state change and nothing explained why (no receipt, no dice); the prose may be advancing a journey, deal, or fight the world is not taking`,
        confidence: "review",
      });
    }
    stretch = [];
  };
  for (const t of run.turns) {
    const hasDelta = t.events.some((e) => !BASE_EVENT_KINDS.has(e.kind));
    if (hasDelta) {
      flush();
      continue;
    }
    // Transparent, not a reset: an inquiry or an aside in the middle of a fabricated journey must
    // not launder the stretch into two short ones.
    if (designInert(t) || explainedMechanically(t)) continue;
    stretch.push({ turn: t.turn, kind: playerTraceOf(t)?.classifierKind ?? "(unclassified)" });
  }
  flush();
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function statsOf(run: RecordedRun, findings: Finding[]): RunStats {
  const wall = run.turns.map((t) => t.ms);
  const sorted = [...wall].sort((a, b) => a - b);
  const kinds: Record<string, number> = {};
  let fallbackTurns = 0;
  const moduleCostMs: Record<string, number> = {};
  const consentBlocks: Record<string, number> = {};
  for (const t of run.turns) {
    const trace = playerTraceOf(t);
    const kind = trace?.classifierKind ?? "(unclassified)";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (trace?.fallback) fallbackTurns += 1;
    for (const tr of t.traces) {
      for (const m of tr.modules ?? []) {
        moduleCostMs[m.moduleId] = (moduleCostMs[m.moduleId] ?? 0) + m.ms;
      }
      for (const c of tr.consentBlocks ?? []) {
        const key = `${c.command}/${c.path}`;
        consentBlocks[key] = (consentBlocks[key] ?? 0) + 1;
      }
    }
  }
  const findingsByClass: Record<string, number> = {};
  for (const f of findings) findingsByClass[f.class] = (findingsByClass[f.class] ?? 0) + 1;
  return {
    turns: run.turns.length,
    wallMsTotal: wall.reduce((a, b) => a + b, 0),
    wallMsMean: wall.length ? Math.round(wall.reduce((a, b) => a + b, 0) / wall.length) : 0,
    wallMsP90: percentile(sorted, 90),
    classifierKinds: kinds,
    fallbackTurns,
    moduleCostMs,
    consentBlocks,
    findingsByClass,
  };
}

/** Score one run: every failure-class scorer, then the aggregate stats. */
export function scoreRun(run: RecordedRun): RubricReport {
  const findings: Finding[] = [
    ...findSwallowedTravel(run),
    ...findInvoluntaryRelocation(run),
    ...findFreeProsePayments(run),
    ...findAuditViolations(run),
    ...findClassifierFallbacks(run),
    ...findGroundingFallbacks(run),
    ...findStrandedScenes(run),
    ...findStateInertStretch(run),
  ].sort((a, b) => a.turn - b.turn);
  return { scenarioId: run.scenario.id, stats: statsOf(run, findings), findings };
}

/** Render a report to the markdown shape the human playtest reports use, so runs stay comparable. */
export function renderReportMarkdown(run: RecordedRun, report: RubricReport): string {
  const s = report.stats;
  const lines: string[] = [
    `# Auto-playtest — ${run.scenario.id}`,
    "",
    `Goal: ${run.scenario.goal}`,
    `Turns: ${s.turns}/${run.scenario.maxTurns} · stopped: ${run.stopped}${run.driverNote ? ` (“${run.driverNote}”)` : ""}`,
    `Wall: total ${(s.wallMsTotal / 1000).toFixed(1)}s · mean ${(s.wallMsMean / 1000).toFixed(1)}s · p90 ${(s.wallMsP90 / 1000).toFixed(1)}s`,
    `Classifier fallbacks: ${s.fallbackTurns}/${s.turns}`,
    "",
    "## Findings",
    "",
  ];
  if (report.findings.length === 0) lines.push("_None — every scorer came back clean._");
  const byClass = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const arr = byClass.get(f.class) ?? [];
    arr.push(f);
    byClass.set(f.class, arr);
  }
  for (const [cls, fs] of byClass) {
    lines.push(`### ${cls} (${fs.length})`, "");
    for (const f of fs) {
      lines.push(`- t${f.turn} [${f.confidence}] ${f.summary}${f.evidence ? ` — “${f.evidence}”` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Classifier kinds", "");
  for (const [k, n] of Object.entries(s.classifierKinds).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${n}`);
  }
  const modules = Object.entries(s.moduleCostMs).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (modules.length > 0) {
    lines.push("", "## Module cost (ms, run total)", "");
    for (const [id, ms] of modules) lines.push(`- ${id}: ${Math.round(ms)}`);
  }
  const consent = Object.entries(s.consentBlocks).sort((a, b) => b[1] - a[1]);
  if (consent.length > 0) {
    lines.push("", "## Consent gate (Director acts held for your word)", "");
    for (const [k, n] of consent) lines.push(`- ${k}: ${n}`);
  }
  if (report.judge) {
    lines.push("", "## Judge (prose quality)", "");
    for (const [k, v] of Object.entries(report.judge.scores)) lines.push(`- ${k}: ${v}/3`);
    for (const n of report.judge.notes) lines.push(`- ${n}`);
    if (report.judge.worstMoment) lines.push("", `Worst moment: ${report.judge.worstMoment}`);
  }
  lines.push("");
  return lines.join("\n");
}
