/**
 * Routines — engine-wired. Drives real turns across day-phase boundaries and asserts the
 * RoutineModule end to end: first-boot seeding (opening staging holds), boundary reconcile via
 * teleport moveEntity, depart/arrive beats only where the player stands, End Day catching up to
 * the woken phase in one pass, suspension (party member / combat), full inertness in a
 * schedule-less world, reload persistence, and the `Present:` activity annotation in the brief.
 *
 * Mirrors tests/travel-events-engine.test.ts: inline playset, scripted classifier, OfflineGateway,
 * pinned rng (irrelevant to routine picks — they draw from private keyed rng only).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type NpcSchedule, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TickContext } from "../src/engine/tick.ts";
import type { CompletionChunk, CompletionRequest, CompletionResult, LlmRole } from "../src/llm/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { RoutinesSlice } from "../src/rules/routine.ts";
import { RoutineModule } from "../src/modules/routines/module.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { byKind } from "./support/harness.ts";

const SEED = 11;
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

/** OfflineGateway that also records every narrator brief (the last user message). */
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

/** The default fixture routine: mornings at the forge, afternoons pouring ale at the inn. */
const FORGE_THEN_INN: NpcSchedule = {
  slots: [
    { phases: ["morning"], locationId: "loc.forge", activity: "hammering at the forge", weight: 1, conditions: [], venue: false },
    { phases: ["afternoon"], locationId: "loc.inn", activity: "pouring ale", weight: 1, conditions: [], venue: true },
  ],
  variance: 0,
  defaultLocationId: "loc.home",
  defaultActivity: "resting at home",
};

function routinePlayset(opts: {
  /** The smith's routine: omit ⇒ FORGE_THEN_INN; null ⇒ schedule-less (inertness fixture). */
  schedule?: NpcSchedule | null;
  clock?: number;
  companions?: string[];
  smithStats?: boolean;
} = {}): PlaySet {
  const schedule = opts.schedule === null ? undefined : (opts.schedule ?? FORGE_THEN_INN);
  const world = WorldSchema.parse({
    id: "w.rout",
    name: "Routineworld",
    summary: "A village with habits.",
    locations: [
      { id: "loc.forge", name: "The Forge", description: "Soot and sparks.", connections: ["loc.inn", "loc.home"], npcs: ["npc.smith"] },
      { id: "loc.inn", name: "The Inn", description: "A low common room.", connections: ["loc.forge", "loc.home"] },
      { id: "loc.home", name: "The Cottage", description: "A small cottage.", connections: ["loc.forge", "loc.inn"] },
    ],
    npcs: [
      {
        id: "npc.smith",
        name: "Smith",
        summary: "the village smith",
        persona: "A taciturn smith.",
        age: 40,
        ...(opts.smithStats ? { stats: pcStats } : {}),
        ...(schedule ? { schedule } : {}),
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.rout",
    name: "Routine Campaign",
    worldId: "w.rout",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: {
      locationId: "loc.forge",
      clock: opts.clock ?? 719, // one 1-minute turn from the morning→afternoon boundary (720)
      party: ["pc.you"],
      companions: opts.companions ?? [],
    },
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

/** Smith's live position — statless authored NPC (authoredNpcs) or statted companion (actors). */
function smithLoc(engine: GameEngine): string | undefined {
  const s = engine.getState();
  return s.actors["npc.smith"]?.locationId ?? s.authoredNpcs?.["npc.smith"]?.locationId;
}
function routines(engine: GameEngine): RoutinesSlice | undefined {
  return engine.getState().modules?.routines as RoutinesSlice | undefined;
}
const narrations = (events: GameEvent[]): string[] => byKind(events, "narration").map((e) => e.text);

describe("routines — reconcile lifecycle", () => {
  test("the first tick seeds the cursor WITHOUT moving anyone (opening staging holds)", async () => {
    // Dawn: no slot matches, so a reconcile WOULD send the smith home — the seed must not.
    const { engine } = engineWith(routinePlayset({ clock: 320 }), [planOf({})]);
    await engine.start();
    await engine.submitPlayerInput("I look around the forge.");
    expect(smithLoc(engine)).toBe("loc.forge");
    const slice = routines(engine);
    expect(slice?.lastDay).toBe(0);
    expect(slice?.lastPhase).toBe("dawn");
    expect(slice?.applied["npc.smith"]).toBe("0:dawn");
  });

  test("a boundary reconcile teleports the NPC, records the activity, and narrates the arrival where the player stands", async () => {
    const { engine, events } = engineWith(routinePlayset(), [planOf({}), move("loc.inn")]);
    await engine.start();
    await engine.submitPlayerInput("I warm my hands at the forge."); // seed at morning; commit → 720
    await engine.submitPlayerInput("I head to the inn."); // afternoon: smith reconciles to the inn too
    expect(smithLoc(engine)).toBe("loc.inn");
    expect(routines(engine)?.activity["npc.smith"]).toBe("pouring ale");
    expect(routines(engine)?.venues["npc.smith"]).toBe(true);
    expect(narrations(events)).toContain("Smith arrives — pouring ale.");
  });

  test("a departure from the player's location narrates the depart beat", async () => {
    const { engine, events } = engineWith(routinePlayset(), [planOf({})]);
    await engine.start();
    await engine.submitPlayerInput("I watch the smith work."); // seed; commit → 720
    await engine.submitPlayerInput("I linger by the anvil."); // afternoon: smith leaves for the inn
    expect(smithLoc(engine)).toBe("loc.inn");
    expect(narrations(events)).toContain("Smith sets off toward The Inn — pouring ale.");
  });

  test("End Day catches up to the woken phase in ONE pass — no intermediate-phase beats", async () => {
    const sched: NpcSchedule = {
      slots: [
        { phases: ["morning"], locationId: "loc.forge", activity: "hammering at the forge", weight: 1, conditions: [], venue: false },
        { phases: ["dusk"], locationId: "loc.inn", activity: "drinking at the inn", weight: 1, conditions: [], venue: true },
      ],
      variance: 0,
    };
    const { engine, events } = engineWith(routinePlayset({ schedule: sched, clock: 1019 }), [
      planOf({}), // seed (afternoon); commit → 1020
      planOf({}), // dusk: smith departs for the inn (player at the forge)
      planOf({ kind: "enterCamp" }),
      planOf({ kind: "endDay" }),
    ]);
    await engine.start();
    await engine.submitPlayerInput("I bank the forge fire.");
    await engine.submitPlayerInput("I sweep the floor.");
    expect(smithLoc(engine)).toBe("loc.inn");
    expect(narrations(events)).toContain("Smith sets off toward The Inn — drinking at the inn.");

    await engine.submitPlayerInput("I make camp.");
    await engine.submitPlayerInput("I turn in for the night.");
    // Woke next morning at 07:00: the smith is back at the forge, reconciled once to the ARRIVED
    // phase — the skipped night/deep-night/dawn produced no moves and no beats.
    expect(smithLoc(engine)).toBe("loc.forge");
    expect(routines(engine)?.applied["npc.smith"]).toBe("1:morning");
    expect(routines(engine)?.activity["npc.smith"]).toBe("hammering at the forge");
    expect(narrations(events)).toContain("Smith arrives — hammering at the forge.");
    expect(narrations(events).filter((t) => t.startsWith("Smith")).length).toBe(2); // one depart + one arrive
  });

  test("a party-member companion is never reconciled", async () => {
    const { engine, events } = engineWith(
      routinePlayset({ companions: ["npc.smith"], smithStats: true }),
      [planOf({}), planOf({})],
    );
    await engine.start();
    await engine.submitPlayerInput("We stand together at the forge."); // seed; commit → 720
    await engine.submitPlayerInput("We keep talking."); // afternoon boundary — smith must NOT leave
    expect(smithLoc(engine)).toBe("loc.forge");
    // Suspension skips WITHOUT a fresh stamp — the seed stamp is still the morning key.
    expect(routines(engine)?.applied["npc.smith"]).toBe("0:morning");
    expect(narrations(events).some((t) => t.startsWith("Smith sets off"))).toBe(false);
  });

  test("a schedule-less world writes nothing — the module is fully inert", async () => {
    const { engine } = engineWith(routinePlayset({ schedule: null }), [planOf({}), move("loc.inn"), planOf({})]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("go inn");
    await engine.submitPlayerInput("wait");
    expect(routines(engine)).toBeUndefined();
    expect(smithLoc(engine)).toBe("loc.forge");
  });

  test("cursor and positions survive reload — no re-move, no duplicate beat", async () => {
    const store = new InMemoryGameStateStore();
    const first = engineWith(routinePlayset(), [planOf({}), planOf({})], { store });
    await first.engine.start();
    await first.engine.submitPlayerInput("I watch the street."); // seed; commit → 720
    await first.engine.submitPlayerInput("I wait."); // afternoon: smith → inn
    expect(smithLoc(first.engine)).toBe("loc.inn");

    const second = engineWith(routinePlayset(), [planOf({})], { store });
    await second.engine.start();
    expect(smithLoc(second.engine)).toBe("loc.inn"); // position restored
    await second.engine.submitPlayerInput("I stretch."); // same phase — applied stamp survived
    expect(smithLoc(second.engine)).toBe("loc.inn");
    expect(narrations(second.events).some((t) => t.startsWith("Smith"))).toBe(false);
  });

  test("the narrator brief's Present: line carries the routine activity", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(routinePlayset(), [planOf({}), move("loc.inn"), planOf({})], { gateway });
    await engine.start();
    await engine.submitPlayerInput("I set out."); // seed; commit → 720
    await engine.submitPlayerInput("I head to the inn."); // smith arrives at the inn with us
    await engine.submitPlayerInput("I look around the room."); // next brief renders his activity
    // Any narrator brief after the reconcile carries the annotated row (the rolling-summary
    // prompt shares the narrator role, so "last" is not necessarily the turn brief).
    expect(gateway.briefs.some((b) => b.includes("Present: Smith — the village smith (pouring ale)"))).toBe(true);
  });
});

describe("routines — trigger guards (unit)", () => {
  test("a heartbeat trigger is a no-op", () => {
    const { world } = routinePlayset();
    const module = new RoutineModule(world);
    let writes = 0;
    const ctx = {
      trigger: { kind: "heartbeat", npcId: "npc.smith" },
      applySilent: () => {
        writes++;
        return { deltas: [], mutated: false };
      },
    } as unknown as TickContext;
    module.phases.react!(ctx);
    expect(writes).toBe(0);
  });

  test("combat suppresses the pass; the NPC catches up mid-phase once combat ends", () => {
    const { world } = routinePlayset();
    const module = new RoutineModule(world);
    const entities = new Map([
      ["pc.you", { id: "pc.you", kind: "pc", tier: "significant", name: "You", locationId: "loc.forge", partyMember: true, flags: {} }],
      ["npc.smith", { id: "npc.smith", kind: "npc", tier: "tracked", name: "Smith", locationId: "loc.forge", partyMember: false, flags: {} }],
    ]);
    const model = {
      campaignId: "c.rout",
      worldId: "w.rout",
      clock: 800, // afternoon, day 0
      entities,
      quests: new Map(),
      relationships: new Map(),
      modules: {
        combat: { active: true, order: ["pc.you"] },
        // Pre-seeded cursor: the boundary into afternoon happened while combat raged.
        routines: {
          lastDay: 0,
          lastPhase: "afternoon",
          applied: { "npc.smith": "0:morning" },
          activity: {},
          venues: {},
          overrides: {},
        },
      },
      flags: {},
    };
    const queued: Array<Record<string, unknown>> = [];
    const ctx = {
      trigger: { kind: "player", input: "x" },
      model,
      data: {},
      enqueue: (cmd: Record<string, unknown>) => queued.push(cmd),
      applySilent: (cmd: { module: string; patch: Record<string, unknown> }) => {
        model.modules[cmd.module as "routines"] = {
          ...(model.modules[cmd.module as "routines"] ?? {}),
          ...cmd.patch,
        } as never;
        return { deltas: [], mutated: true };
      },
    } as unknown as TickContext;

    module.phases.react!(ctx); // combat live → whole pass skipped
    expect(queued.length).toBe(0);

    (model.modules.combat as { active: boolean }).active = false;
    module.phases.react!(ctx); // same phase, stale stamp → catch-up move fires
    expect(queued).toContainEqual({ type: "moveEntity", entityId: "npc.smith", to: "loc.inn", teleport: true });
    expect((model.modules.routines as RoutinesSlice).applied["npc.smith"]).toBe("0:afternoon");
  });

  test("the NPC the player is addressing holds its ground across a phase boundary, then departs (r4)", async () => {
    // 10-minute dialogue beats cross phase boundaries mid-conversation now; the addressed NPC
    // must not teleport away mid-sentence — and must still leave (beat and all) once let go.
    const talk = planOf({ kind: "dialogueToNpc", targetId: "npc.smith" });
    const { engine } = engineWith(routinePlayset(), [talk, talk, planOf({})]);
    await engine.start();

    await engine.submitPlayerInput("Smith, about that blade."); // seeds the cursor; 719 → 729 (afternoon)
    expect(smithLoc(engine)).toBe("loc.forge");

    await engine.submitPlayerInput("And the tempering?"); // boundary observed — but the smith is ADDRESSED
    expect(smithLoc(engine)).toBe("loc.forge"); // held mid-conversation
    expect(routines(engine)?.applied["npc.smith"]).toBe("0:morning"); // no fresh stamp — catches up later

    await engine.submitPlayerInput("I look around the forge."); // let go — the routine catches up
    expect(smithLoc(engine)).toBe("loc.inn");
    expect(routines(engine)?.applied["npc.smith"]).toBe("0:afternoon");
  });
});
