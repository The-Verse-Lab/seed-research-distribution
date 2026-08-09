/**
 * Routine rules — pure unit tests for the schedule math (src/rules/routine.ts): the DAY_PHASES ↔
 * dayPhaseOf lockstep, slot eligibility (phase/weekly-day/conditions), target precedence
 * (override > variance-hold > slot > default > hold), keyed-pick phase stability, the slice
 * reader's defaulting copy, and the exact beat strings. Deterministic, no engine, no network.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { dayPhaseOf } from "../src/agents/context.ts";
import type { DayPhase, NpcSchedule } from "../src/content/schema.ts";
import {
  DAY_PHASES,
  arriveBeat,
  dayOf,
  defaultRoutinesSlice,
  departBeat,
  eligibleSlots,
  phaseKeyOf,
  readRoutinesSlice,
  resolveRoutineTarget,
  type RoutinesSlice,
} from "../src/rules/routine.ts";

const always = (): boolean => true;
const never = (): boolean => false;

function schedule(over: Partial<NpcSchedule> = {}): NpcSchedule {
  return { slots: [], variance: 0, ...over } as NpcSchedule;
}

describe("DAY_PHASES ↔ dayPhaseOf lockstep", () => {
  test("every boundary minute maps into DAY_PHASES, in the expected bucket", () => {
    const expected: Array<[number, string]> = [
      [0, "deep night"],
      [299, "deep night"],
      [300, "dawn"],
      [419, "dawn"],
      [420, "morning"],
      [719, "morning"],
      [720, "afternoon"],
      [1019, "afternoon"],
      [1020, "dusk"],
      [1199, "dusk"],
      [1200, "night"],
      [1439, "night"],
    ];
    for (const [minute, phase] of expected) {
      expect(dayPhaseOf(minute)).toBe(phase);
      expect(DAY_PHASES).toContain(dayPhaseOf(minute) as DayPhase);
    }
    // Next-day wrap stays in the vocabulary too.
    expect(DAY_PHASES).toContain(dayPhaseOf(1440 + 600) as DayPhase);
  });

  test("dayOf and phaseKeyOf", () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(1439)).toBe(0);
    expect(dayOf(1440)).toBe(1);
    expect(phaseKeyOf(12, "morning")).toBe("12:morning");
  });
});

describe("eligibleSlots", () => {
  const sched = schedule({
    slots: [
      { phases: ["morning"], locationId: "loc.forge", activity: "", weight: 1, conditions: [], venue: false },
      { phases: ["morning"], days: [0, 3], locationId: "loc.market", activity: "", weight: 1, conditions: [], venue: false },
      {
        phases: ["dusk"],
        locationId: "loc.inn",
        activity: "",
        weight: 1,
        conditions: [{ kind: "flag", key: "festival" }],
        venue: false,
      },
    ],
  });

  test("filters by phase", () => {
    expect(eligibleSlots(sched, 1, "morning", always).map((e) => e.index)).toEqual([0]);
    expect(eligibleSlots(sched, 1, "night", always)).toEqual([]);
  });

  test("filters by weekly day (day % 7)", () => {
    expect(eligibleSlots(sched, 7, "morning", always).map((e) => e.index)).toEqual([0, 1]); // day 7 → weekday 0
    expect(eligibleSlots(sched, 10, "morning", always).map((e) => e.index)).toEqual([0, 1]); // weekday 3
    expect(eligibleSlots(sched, 8, "morning", always).map((e) => e.index)).toEqual([0]); // weekday 1
  });

  test("filters by conditions via the callback", () => {
    expect(eligibleSlots(sched, 1, "dusk", always).map((e) => e.index)).toEqual([2]);
    expect(eligibleSlots(sched, 1, "dusk", never)).toEqual([]);
  });
});

describe("resolveRoutineTarget precedence", () => {
  const sched = schedule({
    slots: [{ phases: ["morning"], locationId: "loc.forge", activity: "hammering", weight: 1, conditions: [], venue: true }],
    defaultLocationId: "loc.home",
    defaultActivity: "resting",
  });

  test("an active override pins the NPC outright", () => {
    const t = resolveRoutineTarget("npc.s", sched, 2, "morning", { locationId: "loc.shrine", activity: "praying", untilDay: 5 }, always);
    expect(t).toEqual({ locationId: "loc.shrine", activity: "praying", venue: false, source: "override" });
  });

  test("an expired override is ignored", () => {
    const t = resolveRoutineTarget("npc.s", sched, 5, "morning", { locationId: "loc.shrine", untilDay: 5 }, always);
    expect(t.source).toBe("slot");
    expect(t.locationId).toBe("loc.forge");
    expect(t.venue).toBe(true);
  });

  test("variance 1 always holds position", () => {
    const varied = schedule({ ...sched, variance: 1 });
    const t = resolveRoutineTarget("npc.s", varied, 2, "morning", undefined, always);
    expect(t).toEqual({ locationId: null, activity: "", venue: false, source: "hold" });
  });

  test("no matching slot falls back to the default location", () => {
    const t = resolveRoutineTarget("npc.s", sched, 2, "night", undefined, always);
    expect(t).toEqual({ locationId: "loc.home", activity: "resting", venue: false, source: "default" });
  });

  test("no slot and no default holds position", () => {
    const bare = schedule({ slots: sched.slots });
    const t = resolveRoutineTarget("npc.s", bare, 2, "night", undefined, always);
    expect(t).toEqual({ locationId: null, activity: "", venue: false, source: "hold" });
  });

  test("the slot pick is stable for the same (npc, day, phase) and keyed privately", () => {
    const two = schedule({
      slots: [
        { phases: ["morning"], locationId: "loc.forge", activity: "", weight: 3, conditions: [], venue: false },
        { phases: ["morning"], locationId: "loc.market", activity: "", weight: 1, conditions: [], venue: false },
      ],
    });
    const first = resolveRoutineTarget("npc.s", two, 4, "morning", undefined, always);
    for (let i = 0; i < 5; i++) {
      expect(resolveRoutineTarget("npc.s", two, 4, "morning", undefined, always)).toEqual(first);
    }
    expect(["loc.forge", "loc.market"]).toContain(first.locationId as string);
  });
});

describe("routines slice reader", () => {
  test("defaults an absent slice without storing anything back", () => {
    const modules: Record<string, unknown> = {};
    const slice = readRoutinesSlice(modules);
    expect(slice).toEqual(defaultRoutinesSlice());
    expect(modules.routines).toBeUndefined(); // never materialized (byte-stable snapshots)
  });

  test("returns an isolated copy — mutating it never touches the source", () => {
    const source: RoutinesSlice = {
      lastDay: 3,
      lastPhase: "dusk",
      applied: { "npc.s": "3:dusk" },
      activity: { "npc.s": "drinking" },
      venues: { "npc.s": true },
      overrides: { "npc.s": { locationId: "loc.x", untilDay: 9 } },
    };
    const modules = { routines: source };
    const copy = readRoutinesSlice(modules);
    copy.applied["npc.s"] = "4:morning";
    copy.overrides["npc.s"]!.untilDay = 1;
    delete copy.activity["npc.s"];
    expect(source.applied["npc.s"]).toBe("3:dusk");
    expect(source.overrides["npc.s"]!.untilDay).toBe(9);
    expect(source.activity["npc.s"]).toBe("drinking");
  });
});

describe("beat strings", () => {
  test("depart and arrive templates, with and without an activity", () => {
    expect(departBeat("Smith", "The Inn", "pouring ale")).toBe("Smith sets off toward The Inn — pouring ale.");
    expect(departBeat("Smith", "The Inn", "")).toBe("Smith sets off toward The Inn.");
    expect(arriveBeat("Smith", "pouring ale")).toBe("Smith arrives — pouring ale.");
    expect(arriveBeat("Smith", "")).toBe("Smith arrives.");
  });
});
