/**
 * Seeded fallback schedules — the world `seededRoutines` opt-in. Pure units for the derivation
 * (home anchoring, keyed venue pick determinism, the accessor's authored-wins/off-by-default
 * contract) and engine specs proving a derived routine moves an unscheduled NPC at dusk, feeds
 * the whereabouts block, and that a world WITHOUT the flag stays fully inert. Deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet, type World } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { CompletionChunk, CompletionRequest, CompletionResult, LlmRole } from "../src/llm/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { deriveSchedule, effectiveScheduleOf, type RoutinesSlice } from "../src/rules/routine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { byKind } from "./support/harness.ts";

const SEED = 23;
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

/** A mill village: the miller has NO authored schedule; the Dusty Inn is the region's one venue. */
function seededWorld(over: Partial<Record<string, unknown>> = {}): World {
  return WorldSchema.parse({
    id: "w.seeded",
    name: "Seededworld",
    summary: "A village that runs itself.",
    seededRoutines: true,
    locations: [
      { id: "loc.mill", name: "The Mill", description: "Grain dust.", region: "vale", connections: ["loc.inn", "loc.field"], npcs: ["npc.miller", "npc.bard"] },
      { id: "loc.inn", name: "The Dusty Inn", description: "A low taproom.", region: "vale", connections: ["loc.mill"] },
      { id: "loc.field", name: "The Field", description: "Stubble.", region: "vale", connections: ["loc.mill"] },
    ],
    npcs: [
      { id: "npc.miller", name: "Miller", summary: "the village miller", persona: "Floury.", age: 45, socialRole: "milling the village grain" },
      { id: "npc.bard", name: "Bard", summary: "a nosy bard", persona: "Chatty.", age: 30 },
    ],
    ...over,
  });
}

function playsetOf(world: World, clock: number): PlaySet {
  const campaign = CampaignSchema.parse({
    id: "c.seeded",
    name: "Seeded Campaign",
    worldId: world.id,
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.mill", clock, party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function engineWith(playset: PlaySet, plans: TurnPlan[], opts: { gateway?: OfflineGateway } = {}) {
  const engine = new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: new InMemoryGameStateStore(),
    gateway: opts.gateway ?? new OfflineGateway(),
    rng: mulberry32(SEED),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

const routinesOf = (engine: GameEngine): RoutinesSlice | undefined =>
  engine.getState().modules?.routines as RoutinesSlice | undefined;

// --- pure -------------------------------------------------------------------

describe("deriveSchedule", () => {
  test("anchors days at the roster location and evenings at a same-region venue", () => {
    const world = seededWorld();
    const sched = deriveSchedule(world.npcs[0]!, world)!;
    expect(sched).toBeDefined();
    const day = sched.slots.find((s) => s.phases.includes("morning"))!;
    expect(day.locationId).toBe("loc.mill");
    expect(day.phases).toEqual(["dawn", "morning", "afternoon"]);
    expect(day.activity).toBe("milling the village grain"); // socialRole becomes the activity
    const dusk = sched.slots.find((s) => s.phases.includes("dusk"))!;
    expect(dusk.locationId).toBe("loc.inn"); // the only social-venue match in the region
    expect(dusk.venue).toBe(false); // derived slots never mint rumor stops
    const night = sched.slots.find((s) => s.phases.includes("night"))!;
    expect(night.locationId).toBe("loc.mill");
    expect(sched.variance).toBe(0);
    expect(sched.defaultLocationId).toBe("loc.mill");
  });

  test("is deterministic per NPC id and skips the dusk haunt when the region has no venue", () => {
    const world = seededWorld();
    expect(deriveSchedule(world.npcs[0]!, world)).toEqual(deriveSchedule(world.npcs[0]!, world));
    const bare = seededWorld({
      locations: [
        { id: "loc.mill", name: "The Mill", description: "Grain dust.", region: "vale", npcs: ["npc.miller"] },
        { id: "loc.field", name: "The Field", description: "Stubble.", region: "vale" },
      ],
    });
    const sched = deriveSchedule(bare.npcs[0]!, bare)!;
    expect(sched.slots.some((s) => s.phases.includes("dusk"))).toBe(false); // evenings default home
  });

  test("an NPC with no roster location derives nothing", () => {
    const world = seededWorld({
      npcs: [{ id: "npc.ghost", name: "Ghost", persona: "Unmoored.", age: 30 }],
    });
    expect(deriveSchedule(world.npcs[0]!, world)).toBeUndefined();
  });
});

describe("effectiveScheduleOf", () => {
  test("authored wins; the flag gates derivation; absent flag means none", () => {
    const authored = seededWorld({
      npcs: [
        {
          id: "npc.miller",
          name: "Miller",
          persona: "Floury.",
          age: 45,
          schedule: { slots: [{ phases: ["morning"], locationId: "loc.field" }] },
        },
      ],
    });
    expect(effectiveScheduleOf(authored.npcs[0]!, authored)!.slots[0]!.locationId).toBe("loc.field");

    const on = seededWorld();
    expect(effectiveScheduleOf(on.npcs[0]!, on)).toBeDefined();

    const off = WorldSchema.parse({ ...seededWorld(), seededRoutines: undefined });
    expect(off.seededRoutines).toBeUndefined();
    expect(effectiveScheduleOf(off.npcs[0]!, off)).toBeUndefined();
  });
});

// --- engine -------------------------------------------------------------------

describe("seeded routines — engine", () => {
  test("an unscheduled NPC keeps derived hours: dusk moves him to the inn with a depart beat", async () => {
    // 1019 → the first turn commits past 1020 (dusk); the second reconciles.
    const { engine, events } = engineWith(playsetOf(seededWorld(), 1019), [planOf({}), planOf({})]);
    await engine.start();
    await engine.submitPlayerInput("I watch the mill wheel turn."); // seed (afternoon)
    await engine.submitPlayerInput("I linger in the doorway."); // dusk: miller heads out
    expect(engine.getState().authoredNpcs?.["npc.miller"]?.locationId).toBe("loc.inn");
    expect(routinesOf(engine)?.activity["npc.miller"]).toBe("passing the evening at The Dusty Inn");
    expect(byKind(events, "narration").map((e) => e.text)).toContain(
      "Miller sets off toward The Dusty Inn — passing the evening at The Dusty Inn.",
    );
  });

  test("the whereabouts block reads derived schedules too", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(playsetOf(seededWorld(), 480), [talkTo("npc.bard")], { gateway });
    await engine.start();
    await engine.submitPlayerInput("Bard, where can I find the Miller?");
    const brief = gateway.briefs.find((b) => b.includes("# KNOWN WHEREABOUTS"));
    expect(brief).toBeDefined();
    // Merged in DAY_PHASES order by location: the deep-night and dawn–afternoon slots share The
    // Mill, so they fold into one range whose activity comes from the range's first phase.
    expect(brief).toContain(
      "- Miller: deep night–afternoon at The Mill (settled in for the night); dusk at The Dusty Inn (passing the evening at The Dusty Inn); night at The Mill (settled in for the night).",
    );
  });

  test("without the flag the same world stays fully inert", async () => {
    const off = WorldSchema.parse({ ...seededWorld(), seededRoutines: undefined });
    const { engine, events } = engineWith(playsetOf(off, 1019), [planOf({}), planOf({}), planOf({})]);
    await engine.start();
    await engine.submitPlayerInput("look");
    await engine.submitPlayerInput("wait");
    await engine.submitPlayerInput("wait");
    expect(routinesOf(engine)).toBeUndefined();
    expect(engine.getState().authoredNpcs?.["npc.miller"]?.locationId).toBe("loc.mill");
    expect(byKind(events, "narration").some((e) => e.text.startsWith("Miller sets off"))).toBe(false);
  });
});
