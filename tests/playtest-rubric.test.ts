/**
 * Auto-playtest rubric — the failure-class scorers over synthetic recorded runs. Pure-data specs:
 * each scorer reads traces + deltas the way the live harness records them, so a signature that
 * drifts (field rename, kind rename) fails here before a live run silently scores nothing.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnTrace } from "../src/logging/types.ts";
import {
  findClassifierFallbacks,
  findStateInertStretch,
  findFreeProsePayments,
  findInvoluntaryRelocation,
  findStrandedScenes,
  findSwallowedTravel,
  renderReportMarkdown,
  scoreRun,
  statsOf,
} from "../playtest/auto/rubric.ts";
import type { RecordedRun, RecordedTurn, StateSnapshot } from "../playtest/auto/types.ts";
import { SCENARIOS } from "../playtest/auto/scenarios.ts";

let seq = 0;
function ev(partial: Record<string, unknown>): GameEvent {
  seq += 1;
  return { id: `e${seq}`, at: 0, seq, ...partial } as unknown as GameEvent;
}

function snap(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return { locationId: "loc.a", hp: 10, coins: 100, clock: 480, combatActive: false, questStates: {}, ...over };
}

function trace(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    campaignId: "c",
    characterId: "pc.you",
    turnSeq: ++seq,
    seqStart: seq,
    seqEnd: seq,
    atStart: 0,
    atEnd: 0,
    trigger: "player",
    ...over,
  };
}

function turn(n: number, over: Partial<RecordedTurn> = {}): RecordedTurn {
  return { turn: n, input: `line ${n}`, ms: 100, events: [], traces: [trace()], after: snap(), ...over };
}

function run(turns: RecordedTurn[], initial: StateSnapshot = snap()): RecordedRun {
  return {
    scenario: SCENARIOS[0]!,
    startedAt: 0,
    endedAt: 0,
    turns,
    initial,
    stopped: "maxTurns",
  };
}

describe("auto-playtest rubric scorers", () => {
  test("swallowed travel: movement turn, no move, no explanation → flagged", () => {
    const r = run([
      turn(1, {
        input: "I head to the mill",
        traces: [trace({ classifierKind: "movement" })],
        events: [],
        after: snap(), // same location as initial
      }),
    ]);
    const f = findSwallowedTravel(r);
    expect(f).toHaveLength(1);
    expect(f[0]!.class).toBe("swallowed-travel");
    expect(f[0]!.key).toBe("silent-refusal");
  });

  // MEASUREMENT (2026-08-03, owner-approved). This scorer carried a `prose.length < 40` gate and
  // had never fired in six rounds — fixture-combat 2026-08-02T17-14-58 t6–t8 (three movement turns,
  // ~1kB of prose each, party never left the square, no delta/dice/receipt) scored CLEAN here
  // because they were too wordy, and the report read as "this class is clean". Volume now picks
  // the key instead of suppressing the finding.
  test("swallowed travel: an unmoved movement turn that NARRATED still flags, keyed apart", () => {
    const loud = "The road unfolds beneath your boots as the yellow haze thickens to the west. ".repeat(4);
    const r = run([
      turn(1, {
        input: "I keep walking west",
        traces: [trace({ classifierKind: "movement" })],
        events: [ev({ kind: "narration", text: loud })],
        after: snap(), // never left
      }),
    ]);
    const f = findSwallowedTravel(r);
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe("narrated-nonmove");
    expect(f[0]!.summary).toContain("moved nobody, yet narrated");
    // The quiet case must keep its own identity — one key for both would blur the ledger's memory.
    expect(f[0]!.key).not.toBe("silent-refusal");
  });

  test("swallowed travel: loud prose does NOT excuse a turn, but a receipt still does", () => {
    const loud = "You set out west along the ash road, and the wind picks up as the light fails. ";
    const withReceipt = run([
      turn(1, {
        traces: [trace({ classifierKind: "movement" })],
        events: [ev({ kind: "narration", text: loud }), ev({ kind: "system", level: "info", message: "The gate is barred." })],
      }),
    ]);
    expect(findSwallowedTravel(withReceipt)).toHaveLength(0);
  });

  test("swallowed travel: a refusal WITH a visible line is not flagged", () => {
    const r = run([
      turn(1, {
        traces: [trace({ classifierKind: "movement" })],
        events: [ev({ kind: "system", level: "info", message: "The gate is barred." })],
      }),
    ]);
    expect(findSwallowedTravel(r)).toHaveLength(0);
  });

  test("swallowed travel: a move that actually moved is not flagged", () => {
    const r = run([
      turn(1, {
        traces: [trace({ classifierKind: "movement" })],
        after: snap({ locationId: "loc.b" }),
      }),
    ]);
    expect(findSwallowedTravel(r)).toHaveLength(0);
  });

  test("involuntary relocation: location change on a dialogue turn → flagged; movement turn → clean", () => {
    const r = run([
      turn(1, {
        traces: [trace({ classifierKind: "dialogueToNpc" })],
        after: snap({ locationId: "loc.b" }),
      }),
      turn(2, {
        traces: [trace({ classifierKind: "movement" })],
        after: snap({ locationId: "loc.c" }),
      }),
    ]);
    const f = findInvoluntaryRelocation(r);
    expect(f).toHaveLength(1);
    expect(f[0]!.turn).toBe(1);
  });

  test("settle-then-move: a move the player asked for in the same line is exempt; a mismatched one is not", () => {
    // r13 fixture-combat t9 — "I sign the salvage claim for the overdue caravan, then head west on the
    // Ashwild road" classifies `questAction` and moves the party ON PURPOSE (r11 §2.4). The exemption
    // is keyed to the reconciled destination, so a settle-then-move that lands SOMEWHERE ELSE still
    // flags — the class this scorer exists for (a relocation the player never asked for) is intact.
    const r = run([
      turn(1, {
        traces: [
          trace({
            classifierKind: "questAction",
            classifierSecondaryMove: { destinationLocationId: "loc.b", destinationName: "Ashford" },
          }),
        ],
        after: snap({ locationId: "loc.b" }),
      }),
      turn(2, {
        traces: [
          trace({
            classifierKind: "questAction",
            classifierSecondaryMove: { destinationLocationId: "loc.b", destinationName: "Ashford" },
          }),
        ],
        after: snap({ locationId: "loc.z" }),
      }),
    ]);
    const f = findInvoluntaryRelocation(r);
    expect(f).toHaveLength(1);
    expect(f[0]!.turn).toBe(2);
  });

  test("free prose payment: coin prose with no coinsChanged → flagged; with the delta → clean", () => {
    const paidInProse = turn(1, {
      events: [ev({ kind: "narration", text: "You count out 8 gp and the smith pockets them." })],
    });
    const paidForReal = turn(2, {
      events: [
        ev({ kind: "narration", text: "You count out 8 gp and the smith pockets them." }),
        ev({ kind: "coinsChanged", entityId: "pc.you", coins: 20 }),
      ],
    });
    const f = findFreeProsePayments(run([paidInProse, paidForReal]));
    expect(f).toHaveLength(1);
    expect(f[0]!.turn).toBe(1);
  });

  test("free prose payment: the PLAYER's own haggling line never trips the scan", () => {
    const haggle = turn(1, {
      events: [ev({ kind: "dialogue", actorId: "pc.you", text: "One hundred copper for the blade, counted twice." })],
    });
    expect(findFreeProsePayments(run([haggle]))).toHaveLength(0);
  });

  test("r10 F-8: a vendor STOCK LISTING is a counter being described, never a payment", () => {
    const listing = turn(1, {
      events: [
        ev({ kind: "narration", text: "Veil lays it out: Trousers (8 sp), Boots (2 gp), a coil of rope (1 sp)." }),
      ],
    });
    expect(findFreeProsePayments(run([listing]))).toHaveLength(0);
  });

  test("r10 F-8: wage TALK is not a payment ('the River Guild pays at the docks')", () => {
    const wages = turn(1, {
      events: [ev({ kind: "narration", text: "The River Guild pays at the docks, two silver a shift, she says." })],
    });
    expect(findFreeProsePayments(run([wages]))).toHaveLength(0);
  });

  test("r10 F-8: the engine's own honest refusal never reads as a phantom payment", () => {
    const refusal = turn(1, {
      events: [
        ev({ kind: "narration", text: "You have 3 sp — not enough, and no coin changes hands." }),
      ],
    });
    expect(findFreeProsePayments(run([refusal]))).toHaveLength(0);
  });

  test("r10 F-8: a RECEIVED payment with no delta still fires ('Veil pays you five silver')", () => {
    const phantom = turn(1, {
      events: [ev({ kind: "narration", text: "Veil pays you five silver for the ledger work." })],
    });
    const f = findFreeProsePayments(run([phantom]));
    expect(f).toHaveLength(1);
  });

  test("r14: ambient MARKET coin scenery is not the player's purse", () => {
    // fixture-travel t5, live: "I thank Sela and hurry west toward Vellmere" classified `movement` and
    // applied exactly `moveParty` — the engine was right. "coins change hands" names no payer, so
    // it read the crowd's money as the player's. A subjectless claim needs the player in its sentence.
    const arrival = turn(1, {
      events: [
        ev({
          kind: "narration",
          text:
            "The gate's weight settles behind you like a ledger closing. Moments ago the rope went " +
            "tight on the west wall; already the market has turned back to its work, though the " +
            "voices stay low and the coins change hands a half-beat quicker than they should.",
        }),
      ],
    });
    expect(findFreeProsePayments(run([arrival]))).toHaveLength(0);
  });

  test("r14: 'coins change hands' still fires when the player is a party to it", () => {
    const bought = turn(1, {
      events: [ev({ kind: "narration", text: "Coins change hands, and the lantern is yours." })],
    });
    const f = findFreeProsePayments(run([bought]));
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe("phantom-payment");
  });

  // The limit the sentence-scope rule used to have, now closed: an anchor in one sentence and the
  // exchange in the next is one payment, and the scorer reads it as one.
  test("r14: a payment split across sentences is detected", () => {
    const split = turn(1, {
      events: [
        ev({
          kind: "narration",
          text: "You set the lantern on the counter and the keeper nods. Coins change hands.",
        }),
      ],
    });
    const f = findFreeProsePayments(run([split]));
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe("phantom-payment");
  });

  test("r14: the exchange may also precede the player's act", () => {
    const after = turn(1, {
      events: [ev({ kind: "narration", text: "Coins change hands. You pocket the lantern." })],
    });
    expect(findFreeProsePayments(run([after]))).toHaveLength(1);
  });

  // The guard that keeps the widening honest. The market-scenery false positive has "settles behind
  // you" ONE SENTENCE EARLIER, so a bare `you` in the neighbour window would hand it straight back —
  // the player must be the AGENT of a transfer, not merely present in the paragraph.
  test("r14: a bare 'you' in the neighbouring sentence does not carry the claim", () => {
    const scenery = turn(1, {
      events: [
        ev({
          kind: "narration",
          text:
            "The gate's weight settles behind you like a ledger closing. Moments ago the rope went " +
            "tight on the west wall; already the market has turned back to its work, though the " +
            "voices stay low and the coins change hands a half-beat quicker than they should. " +
            "Beyond the arcade the city opens.",
        }),
      ],
    });
    expect(findFreeProsePayments(run([scenery]))).toHaveLength(0);
  });

  test("r14: a player act two sentences away is out of window", () => {
    const distant = turn(1, {
      events: [
        ev({
          kind: "narration",
          text: "You set the lantern down. The keeper studies the ledger a while. Coins change hands.",
        }),
      ],
    });
    expect(findFreeProsePayments(run([distant]))).toHaveLength(0);
  });

  test("classifier fallback turns are confirmed findings", () => {
    const r = run([turn(1, { traces: [trace({ fallback: "double-failure" })] })]);
    const f = findClassifierFallbacks(r);
    expect(f).toHaveLength(1);
    expect(f[0]!.confidence).toBe("confirmed");
  });

  test("stranded scene: run ends with combat active → confirmed finding", () => {
    const r = run([turn(1, { after: snap({ combatActive: true }) })]);
    const f = findStrandedScenes(r);
    expect(f.some((x) => x.confidence === "confirmed")).toBe(true);
  });

  test("stranded scene: combat that BEGAN on the final turn is censored, not stuck (r13)", () => {
    const r = run([
      turn(1, { after: snap({ combatActive: false }) }),
      turn(2, { events: [ev({ kind: "combatStarted" })], after: snap({ combatActive: true }) }),
    ]);
    expect(findStrandedScenes(r).some((x) => x.key === "ended-in-combat")).toBe(false);
  });

  test("stranded scene: combat already live entering the final turn still fires, even with a combatStarted on it", () => {
    const r = run([
      turn(1, { after: snap({ combatActive: true }) }),
      turn(2, { events: [ev({ kind: "combatStarted" })], after: snap({ combatActive: true }) }),
    ]);
    expect(
      findStrandedScenes(r).some((x) => x.key === "ended-in-combat" && x.confidence === "confirmed"),
    ).toBe(true);
  });

  test("stranded scene: 4 stagnant combat turns → review finding", () => {
    const turns = [1, 2, 3, 4].map((n) => turn(n, { after: snap({ combatActive: true }) }));
    // End the fight on the last turn so only the stagnation signature (not run-end) fires.
    turns.push(turn(5, { after: snap({ combatActive: false }) }));
    const f = findStrandedScenes(run(turns));
    expect(f).toHaveLength(1);
    expect(f[0]!.confidence).toBe("review");
  });

  test("state-inert: 3+ zero-delta turns flag once; any delta breaks the stretch", () => {
    const inert = (n: number) => turn(n, { events: [ev({ kind: "narration", text: "You walk on." })] });
    const active = (n: number) =>
      turn(n, { events: [ev({ kind: "narration", text: "x" }), ev({ kind: "clockAdvanced", minutes: 30 })] });
    const flagged = findStateInertStretch(run([inert(1), inert(2), inert(3), inert(4), active(5)]));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.turn).toBe(1);
    expect(flagged[0]!.summary).toContain("4 world-silent turns");
    // A delta every other turn ⇒ no stretch ever reaches 3.
    const healthy = findStateInertStretch(run([inert(1), active(2), inert(3), active(4), inert(5)]));
    expect(healthy).toHaveLength(0);
  });

  // MEASUREMENT (2026-08-03, owner-approved). "No deltas for 3 turns" conflated a fabricated
  // journey with two kinds of correct stillness and cost five straight fix rounds on
  // fixture-trade::state-inert::inert-stretch. Each narrowing below is pinned WITH the case that must
  // still fire — the whole point is that the real bug stays visible, not that the scorer goes
  // quiet. Evidence: rounds 2026-08-02T{17-14-58,19-43-12,22-54-22}.
  describe("state-inert narrowing (measurement change)", () => {
    const silent = (n: number, over: Partial<TurnTrace> = {}) =>
      turn(n, { events: [ev({ kind: "narration", text: "Prose, and nothing else." })], traces: [trace(over)] });

    test("MUST STILL FIRE: three movement turns that moved nobody and explained nothing", () => {
      // fixture-combat 2026-08-02T17-14-58 t6–t8, verbatim in shape: ~1kB of prose each narrating a
      // westward walk, party never left the square, no delta, no dice, no receipt. This is the bug
      // the scorer was built for and it had been read as noise for five rounds.
      const f = findStateInertStretch(
        run([1, 2, 3].map((n) => silent(n, { classifierKind: "movement" }))),
      );
      expect(f).toHaveLength(1);
      expect(f[0]!.summary).toContain("all movement");
      expect(f[0]!.summary).toContain("t1, t2, t3");
    });

    test("talking, asking after work, and an OOC aside move nothing BY DESIGN", () => {
      for (const kind of ["dialogueToNpc", "workInquiry", "metaOOC"]) {
        expect(findStateInertStretch(run([1, 2, 3, 4].map((n) => silent(n, { classifierKind: kind }))))).toEqual([]);
      }
    });

    test("a trade INQUIRY moves no coin by design; a trade that is not an inquiry still counts", () => {
      const asks = [1, 2, 3].map((n) =>
        silent(n, { classifierKind: "trade", classifierTrade: { direction: "buy", itemId: null, vendorId: null, inquiry: true } }),
      );
      expect(findStateInertStretch(run(asks))).toEqual([]);
      // The r10 F-2 gate is why a question does not sell — but a SELL that moves nothing is the
      // class this scorer exists for.
      const sells = [1, 2, 3].map((n) =>
        silent(n, { classifierKind: "trade", classifierTrade: { direction: "sell", itemId: "i", vendorId: "v" } }),
      );
      expect(findStateInertStretch(run(sells))).toHaveLength(1);
    });

    test("a turn that shipped a receipt or rolled dice explained itself", () => {
      const withReceipt = (n: number, e: Record<string, unknown>) =>
        turn(n, {
          events: [ev({ kind: "narration", text: "x" }), ev(e)],
          traces: [trace({ classifierKind: "movement" })],
        });
      // Honest refusals ship receipts (r7); a failed check is the world adjudicating (8/8 of the
      // delta-free attemptRequiringCheck turns in the 2026-08-02 rounds had rolled).
      for (const e of [
        { kind: "system", message: "The gate is barred." },
        { kind: "stateChanged", summary: "You stay put.", quiet: false },
        { kind: "diceRolled", notation: "1d20", total: 7, success: false },
      ]) {
        expect(findStateInertStretch(run([1, 2, 3].map((n) => withReceipt(n, e))))).toEqual([]);
      }
      // A QUIET stateChanged is a receipt the player never saw — it explains nothing.
      const quiet = (n: number) =>
        turn(n, {
          events: [ev({ kind: "narration", text: "x" }), ev({ kind: "stateChanged", summary: "s", quiet: true })],
          traces: [trace({ classifierKind: "movement" })],
        });
      expect(findStateInertStretch(run([1, 2, 3].map(quiet)))).toHaveLength(1);
    });

    test("an exempt turn is transparent — it cannot launder a real stretch into two short ones", () => {
      // A question asked mid-journey must not split t1/t3/t5 into three stretches of one.
      const f = findStateInertStretch(
        run([
          silent(1, { classifierKind: "movement" }),
          silent(2, { classifierKind: "dialogueToNpc" }),
          silent(3, { classifierKind: "movement" }),
          silent(4, { classifierKind: "dialogueToNpc" }),
          silent(5, { classifierKind: "movement" }),
        ]),
      );
      expect(f).toHaveLength(1);
      // Listed, not spanned: "t1–t5" would claim five counted turns where three were counted.
      expect(f[0]!.summary).toContain("t1, t3, t5");
      expect(f[0]!.summary).not.toContain("t1–t5");
    });
  });

  test("stats aggregate kinds, fallbacks and module cost; report renders", () => {
    const r = run([
      turn(1, {
        traces: [
          trace({
            classifierKind: "movement",
            modules: [
              { moduleId: "prose-entities", phase: "narrate", ms: 6000 },
              { moduleId: "narration", phase: "narrate", ms: 900 },
            ],
          }),
        ],
      }),
      turn(2, { traces: [trace({ classifierKind: "movement", fallback: "double-failure" })] }),
    ]);
    const report = scoreRun(r);
    const stats = statsOf(r, report.findings);
    expect(stats.classifierKinds.movement).toBe(2);
    expect(stats.fallbackTurns).toBe(1);
    expect(stats.moduleCostMs["prose-entities"]).toBe(6000);
    const md = renderReportMarkdown(r, report);
    expect(md).toContain("# Auto-playtest — wakeward-cold-passage");
    expect(md).toContain("prose-entities: 6000");
  });
});
