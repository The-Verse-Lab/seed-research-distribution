/**
 * NPC personal events — engine-wired + pure. Locks the roll cadence (one pass per day-phase),
 * co-located playout through the shared eventBeats path, offstage `anywhere` fires (world truth
 * moves, narration queues as rumors drained one-per-turn at social venues), day-based cooldowns
 * across End Day, once:campaign across reload, routineOverride pins (immediate relocation, expiry,
 * the whereabouts "Lately" line), and the
 * loader's offstage-interactivity restriction.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { validateReferences } from "../src/content/loader.ts";
import {
  CampaignSchema,
  WorldSchema,
  type NpcEvent,
  type NpcSchedule,
  type PlaySet,
} from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { CompletionChunk, CompletionRequest, CompletionResult, LlmRole } from "../src/llm/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import {
  cooledDownByDay,
  isInteractiveEffect,
  pushRumor,
  readNpcEventsSlice,
  rollNpcEvent,
  type NpcEventsSlice,
  type Rumor,
} from "../src/rules/npc-events.ts";
import type { RoutinesSlice } from "../src/rules/routine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { byKind } from "./support/harness.ts";

const SEED = 17;
const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 12, armorClass: 10 };

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
}
const move = (to: string): TurnPlan => planOf({ kind: "movement", destinationLocationId: to });
const talkTo = (npcId: string): TurnPlan => planOf({ kind: "dialogueToNpc", targetId: npcId });

class RecordingGateway extends OfflineGateway {
  briefs: string[] = [];
  private record(role: LlmRole, req: CompletionRequest): void {
    if (role !== "narrator") return;
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i];
      if (m && m.role === "user") {
        this.briefs.push(m.content);
        return;
      }
    }
  }
  override complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    this.record(role, req);
    return super.complete(role, req);
  }
  override async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    this.record(role, req);
    yield* super.stream(role, req);
  }
}

/** Smith works the forge morning AND afternoon (stays put across the first boundary). */
const FORGE_ALL_DAY: NpcSchedule = {
  slots: [
    { phases: ["morning", "afternoon"], locationId: "loc.forge", activity: "hammering at the forge", weight: 1, conditions: [], venue: false },
  ],
  variance: 0,
  defaultLocationId: "loc.forge",
  defaultActivity: "asleep above the forge",
};

function eventPlayset(opts: {
  smithEvents: NpcEvent[];
  smithSchedule?: NpcSchedule;
  clock?: number;
} ): PlaySet {
  const world = WorldSchema.parse({
    id: "w.npcev",
    name: "Eventworld",
    summary: "A village with gossip.",
    locations: [
      { id: "loc.forge", name: "The Forge", description: "Soot.", region: "vale", connections: ["loc.inn", "loc.cave"], npcs: ["npc.smith", "npc.bard"] },
      { id: "loc.inn", name: "The Inn", description: "Ale.", region: "vale", connections: ["loc.forge"], npcs: ["npc.keeper"] },
      { id: "loc.cave", name: "The Cave", description: "Cold.", region: "vale", connections: ["loc.forge"] },
    ],
    items: [{ id: "item.token", name: "Smith's Token", description: "A stamped iron token.", kind: "misc" }],
    npcs: [
      {
        id: "npc.smith",
        name: "Smith",
        summary: "the village smith",
        persona: "Taciturn.",
        age: 40,
        schedule: opts.smithSchedule ?? FORGE_ALL_DAY,
        events: opts.smithEvents,
      },
      { id: "npc.bard", name: "Bard", summary: "a nosy bard", persona: "Chatty.", age: 30 },
      {
        id: "npc.keeper",
        name: "Keeper",
        summary: "the innkeep",
        persona: "Warm.",
        age: 50,
        schedule: {
          slots: [
            {
              phases: ["deep night", "dawn", "morning", "afternoon", "dusk", "night"],
              locationId: "loc.inn",
              activity: "keeping the taproom",
              weight: 1,
              conditions: [],
              venue: true,
            },
          ],
          variance: 0,
        },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.npcev",
    name: "Event Campaign",
    worldId: "w.npcev",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.forge", clock: opts.clock ?? 719, party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function engineWith(playset: PlaySet, plans: TurnPlan[], opts: { store?: InMemoryGameStateStore; gateway?: OfflineGateway } = {}) {
  const engine = new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: opts.store ?? new InMemoryGameStateStore(),
    gateway: opts.gateway ?? new OfflineGateway(),
    rng: mulberry32(SEED),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

const pcInv = (engine: GameEngine): string[] => engine.getState().actors["pc.you"]?.inventory ?? [];
const npcEventsOf = (engine: GameEngine): NpcEventsSlice | undefined =>
  engine.getState().modules?.npcEvents as NpcEventsSlice | undefined;
const routinesOf = (engine: GameEngine): RoutinesSlice | undefined =>
  engine.getState().modules?.routines as RoutinesSlice | undefined;
const narrations = (events: GameEvent[]): string[] => byKind(events, "narration").map((e) => e.text);

// --- pure units -------------------------------------------------------------

describe("npc-events rules", () => {
  test("pushRumor is a bounded FIFO", () => {
    let rumors: Rumor[] = [];
    for (let day = 0; day < 25; day++) rumors = pushRumor(rumors, { day, text: `r${day}` });
    expect(rumors.length).toBe(20);
    expect(rumors[0]!.text).toBe("r5");
  });

  test("cooledDownByDay", () => {
    expect(cooledDownByDay(undefined, 5, 0)).toBe(true);
    expect(cooledDownByDay(3, 0, 3)).toBe(true);
    expect(cooledDownByDay(3, 2, 4)).toBe(false);
    expect(cooledDownByDay(3, 2, 5)).toBe(true);
  });

  test("rollNpcEvent is keyed-deterministic", () => {
    const ev = (id: string, chance: number): NpcEvent => ({
      id,
      trigger: { allOf: [] },
      scope: "co-located",
      chance,
      cooldownDays: 0,
      once: "always",
      weight: 1,
      effects: [],
    });
    const eligible = [ev("ev.a", 0.5), ev("ev.b", 0.5)];
    const first = rollNpcEvent("npc.s", eligible, 3, "morning");
    for (let i = 0; i < 5; i++) expect(rollNpcEvent("npc.s", eligible, 3, "morning")).toEqual(first);
    expect(rollNpcEvent("npc.s", [ev("ev.c", 0)], 3, "morning")).toBeNull();
    expect(rollNpcEvent("npc.s", [ev("ev.c", 1)], 3, "morning")?.id).toBe("ev.c");
  });
});

// --- engine-wired -----------------------------------------------------------

describe("npc events — co-located playout", () => {
  const giftEvent: NpcEvent = {
    id: "ev.gift",
    trigger: { allOf: [] },
    scope: "co-located",
    chance: 1,
    cooldownDays: 0,
    once: "always",
    weight: 1,
    effects: [
      { kind: "narrate", text: "Smith waves you over and presses a stamped token into your palm." },
      { kind: "giveItem", itemId: "item.token" },
    ],
  };

  test("plays out through beats + reducer when the player shares the NPC's location — and only once per phase", async () => {
    const { engine, events } = engineWith(eventPlayset({ smithEvents: [giftEvent] }), [planOf({})]);
    await engine.start();
    await engine.submitPlayerInput("I warm my hands."); // seed pass (morning) — no roll on first boot
    expect(pcInv(engine)).not.toContain("item.token");

    await engine.submitPlayerInput("I linger."); // afternoon: roll pass fires the gift, co-located
    expect(pcInv(engine).filter((i) => i === "item.token").length).toBe(1);
    expect(narrations(events)).toContain("Smith waves you over and presses a stamped token into your palm.");

    await engine.submitPlayerInput("I wait."); // same phase — one roll pass per (day, phase)
    await engine.submitPlayerInput("I keep waiting.");
    expect(pcInv(engine).filter((i) => i === "item.token").length).toBe(1);
  });

  test("cooldownDays gates by day across End Day", async () => {
    const cooled: NpcEvent = { ...giftEvent, id: "ev.cooled", cooldownDays: 2 };
    const { engine } = engineWith(eventPlayset({ smithEvents: [cooled] }), [
      planOf({}), // seed (morning day 0)
      planOf({}), // afternoon day 0: fire #1
      planOf({ kind: "enterCamp" }),
      planOf({ kind: "endDay" }), // wake day 1 morning: 1 < 2 — still cooling
      planOf({ kind: "enterCamp" }),
      planOf({ kind: "endDay" }), // wake day 2 morning: cooled — fire #2
    ]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("wait");
    expect(pcInv(engine).filter((i) => i === "item.token").length).toBe(1);
    await engine.submitPlayerInput("camp");
    await engine.submitPlayerInput("sleep");
    expect(pcInv(engine).filter((i) => i === "item.token").length).toBe(1);
    await engine.submitPlayerInput("camp");
    await engine.submitPlayerInput("sleep");
    expect(pcInv(engine).filter((i) => i === "item.token").length).toBe(2);
  });

  test("once:campaign survives reload", async () => {
    const once: NpcEvent = { ...giftEvent, id: "ev.once", once: "campaign" };
    const store = new InMemoryGameStateStore();
    const first = engineWith(eventPlayset({ smithEvents: [once] }), [planOf({}), planOf({})], { store });
    await first.engine.start();
    await first.engine.submitPlayerInput("look"); // seed
    await first.engine.submitPlayerInput("wait"); // afternoon: fires
    expect(pcInv(first.engine).filter((i) => i === "item.token").length).toBe(1);

    const second = engineWith(
      eventPlayset({ smithEvents: [once] }),
      [planOf({ kind: "enterCamp" }), planOf({ kind: "endDay" }), planOf({})],
      { store },
    );
    await second.engine.start();
    await second.engine.submitPlayerInput("camp");
    await second.engine.submitPlayerInput("sleep"); // new day, new phases — but once:campaign survived
    await second.engine.submitPlayerInput("wait");
    expect(pcInv(second.engine).filter((i) => i === "item.token").length).toBe(1);
  });
});

describe("npc events — offstage rumors", () => {
  const rumorEvent: NpcEvent = {
    id: "ev.rumor",
    trigger: { allOf: [] },
    scope: "anywhere",
    chance: 1,
    cooldownDays: 9,
    once: "always",
    weight: 1,
    effects: [
      { kind: "narrate", text: "the smith broke his best anvil and swore loud enough to wake the vale." },
      { kind: "setFlag", key: "smith_rumored", value: true },
    ],
  };

  test("effects apply offstage; narration queues as a rumor and drains ONE per turn at a social venue", async () => {
    const gateway = new RecordingGateway();
    const { engine, events } = engineWith(
      eventPlayset({
        smithEvents: [rumorEvent],
        // Smith spends afternoons away in the cave, so the fire is genuinely offstage.
        smithSchedule: {
          slots: [
            { phases: ["morning"], locationId: "loc.forge", activity: "hammering", weight: 1, conditions: [], venue: false },
            { phases: ["afternoon"], locationId: "loc.cave", activity: "prospecting", weight: 1, conditions: [], venue: false },
          ],
          variance: 0,
          defaultLocationId: "loc.forge",
        },
      }),
      [planOf({}), planOf({}), move("loc.inn"), planOf({})],
      { gateway },
    );
    await engine.start();
    await engine.submitPlayerInput("look"); // seed (morning)
    await engine.submitPlayerInput("wait"); // afternoon: offstage fire → flag set, rumor queued, nothing narrated
    expect(engine.getState().flags["smith_rumored"]).toBe(true);
    expect(npcEventsOf(engine)?.rumors.length).toBe(1);
    expect(narrations(events).some((t) => t.includes("broke his best anvil"))).toBe(false);

    await engine.submitPlayerInput("I head to the inn."); // the Keeper's venue slot — the rumor lands
    // r11 F-12: the rumor is the NARRATOR'S material, not a printed beat. It drains from the queue
    // and reaches the GM's brief as `=== OVERHEARD`; no deterministic overhear line is ever emitted.
    expect(npcEventsOf(engine)?.rumors.length).toBe(0);
    expect(narrations(events).some((t) => t.startsWith("You overhear talk at"))).toBe(false);
    const brief = gateway.briefs.at(-1) ?? "";
    expect(brief).toContain("=== OVERHEARD");
    expect(brief).toContain("broke his best anvil");
  });

  test("no rumor drains away from a social venue", async () => {
    const { engine, events } = engineWith(
      eventPlayset({
        smithEvents: [rumorEvent],
        smithSchedule: {
          slots: [
            { phases: ["morning"], locationId: "loc.forge", activity: "hammering", weight: 1, conditions: [], venue: false },
            { phases: ["afternoon"], locationId: "loc.cave", activity: "prospecting", weight: 1, conditions: [], venue: false },
          ],
          variance: 0,
          defaultLocationId: "loc.forge",
        },
      }),
      [planOf({})],
    );
    await engine.start();
    await engine.submitPlayerInput("look"); // seed
    await engine.submitPlayerInput("wait"); // offstage fire
    await engine.submitPlayerInput("wait"); // still at the forge — no vendor, no venue slot here
    await engine.submitPlayerInput("wait");
    expect(npcEventsOf(engine)?.rumors.length).toBe(1);
    expect(narrations(events).some((t) => t.startsWith("You overhear talk at"))).toBe(false);
  });
});

describe("npc events — routineOverride", () => {
  const calledAway: NpcEvent = {
    id: "ev.called",
    trigger: { allOf: [] },
    scope: "anywhere",
    chance: 1,
    cooldownDays: 9,
    once: "campaign",
    weight: 1,
    effects: [
      { kind: "narrate", text: "the smith was called away to the cave over some find." },
      { kind: "routineOverride", locationId: "loc.cave", activity: "digging at a find", days: 1 },
    ],
  };

  test("pins the NPC immediately, holds through boundaries, expires next day; whereabouts shows the Lately line", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(eventPlayset({ smithEvents: [calledAway] }), [
      planOf({}), // seed (morning day 0)
      planOf({}), // afternoon: override fires → smith relocates to the cave
      talkTo("npc.bard"), // ask around — the Lately line rides the whereabouts block
      planOf({ kind: "enterCamp" }),
      planOf({ kind: "endDay" }), // day 1 morning: override (untilDay 1) has expired
    ], { gateway });
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("wait");
    expect(engine.getState().authoredNpcs?.["npc.smith"]?.locationId).toBe("loc.cave");
    expect(routinesOf(engine)?.overrides["npc.smith"]).toEqual({ locationId: "loc.cave", activity: "digging at a find", untilDay: 1 });

    await engine.submitPlayerInput("Bard, where has Smith gone?");
    const brief = gateway.briefs.find((b) => b.includes("# KNOWN WHEREABOUTS"));
    expect(brief).toBeDefined();
    expect(brief).toContain("- Lately: keeps to The Cave (digging at a find).");

    await engine.submitPlayerInput("camp");
    await engine.submitPlayerInput("sleep");
    // Day 1 morning: the pin expired and the morning slot reasserts the forge.
    expect(engine.getState().authoredNpcs?.["npc.smith"]?.locationId).toBe("loc.forge");
    expect(routinesOf(engine)?.overrides["npc.smith"]).toBeUndefined();
  });
});

describe("npc events — loader validation", () => {
  function playsetWith(events: NpcEvent[]): PlaySet {
    return eventPlayset({ smithEvents: events });
  }

  test("an anywhere event with an interactive effect fails at load", () => {
    const bad: NpcEvent = {
      id: "ev.bad",
      trigger: { allOf: [] },
      scope: "anywhere",
      chance: 1,
      cooldownDays: 0,
      once: "always",
      weight: 1,
      effects: [{ kind: "giveItem", itemId: "item.token" }],
    };
    const { world, campaign } = playsetWith([bad]);
    expect(() => validateReferences(world, campaign)).toThrow(/ev\.bad.*anywhere.*interactive/);
  });

  test("a routineOverride naming an unknown NPC or location fails at load", () => {
    const badNpc: NpcEvent = {
      id: "ev.badnpc",
      trigger: { allOf: [] },
      scope: "anywhere",
      chance: 1,
      cooldownDays: 0,
      once: "always",
      weight: 1,
      effects: [{ kind: "routineOverride", npcId: "npc.ghost", locationId: "loc.cave", days: 1 }],
    };
    const a = playsetWith([badNpc]);
    expect(() => validateReferences(a.world, a.campaign)).toThrow(/routineOverride.*npc\.ghost/);

    const badLoc: NpcEvent = { ...badNpc, id: "ev.badloc", effects: [{ kind: "routineOverride", locationId: "loc.void", days: 1 }] };
    const b = playsetWith([badLoc]);
    expect(() => validateReferences(b.world, b.campaign)).toThrow(/routineOverride.*loc\.void/);
  });
});
