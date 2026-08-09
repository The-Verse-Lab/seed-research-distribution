/**
 * Routine learnability — sightings, habits, and ask-around whereabouts. Pure units for the
 * sightings math (dedupe/cap/threshold/tie-break), the whereabouts renderer, and the
 * who-knows-whom rule; engine-wired specs for habit minting across days, the presentDetail
 * projection, and the `# KNOWN WHEREABOUTS` reply-brief injection (present for a same-region
 * replier, absent for a stranger). Deterministic, no network.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type NpcSchedule, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { CompletionChunk, CompletionRequest, CompletionResult, LlmRole } from "../src/llm/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import {
  habitOf,
  nameMentioned,
  recordSighting,
  renderHabitLine,
  replierKnowsTarget,
  whereaboutsLines,
  type Sighting,
  type SightingsSlice,
} from "../src/rules/sightings.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";

const SEED = 13;
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

/** OfflineGateway that also records every narrator prompt (turn briefs AND NPC replies). */
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

const SMITH_SCHEDULE: NpcSchedule = {
  slots: [
    { phases: ["morning"], locationId: "loc.forge", activity: "hammering at the forge", weight: 1, conditions: [], venue: false },
    { phases: ["afternoon"], locationId: "loc.inn", activity: "pouring ale", weight: 1, conditions: [], venue: true },
  ],
  variance: 0,
  defaultLocationId: "loc.forge",
  defaultActivity: "asleep above the forge",
};

/** Forge village (region vale) + a hermit's cave in another region (waste). */
function askAroundPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.ask",
    name: "Askworld",
    summary: "A village and a waste.",
    locations: [
      { id: "loc.forge", name: "The Forge", description: "Soot.", region: "vale", connections: ["loc.inn", "loc.cave"], npcs: ["npc.smith", "npc.bard"] },
      { id: "loc.inn", name: "The Inn", description: "Ale.", region: "vale", connections: ["loc.forge"] },
      { id: "loc.cave", name: "The Cave", description: "Cold.", region: "waste", connections: ["loc.forge"], npcs: ["npc.hermit"] },
    ],
    npcs: [
      { id: "npc.smith", name: "Smith", summary: "the village smith", persona: "Taciturn.", age: 40, schedule: SMITH_SCHEDULE },
      { id: "npc.bard", name: "Bard", summary: "a nosy bard", persona: "Chatty.", age: 30 },
      { id: "npc.hermit", name: "Hermit", summary: "a stranger to the vale", persona: "Withdrawn.", age: 60 },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.ask",
    name: "Ask Campaign",
    worldId: "w.ask",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.forge", clock: 480, party: ["pc.you"], companions: [] },
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

const sightingsOf = (engine: GameEngine): SightingsSlice | undefined =>
  engine.getState().modules?.sightings as SightingsSlice | undefined;

// --- pure units -------------------------------------------------------------

describe("recordSighting", () => {
  const s = (day: number, phase = "morning", locationId = "loc.a"): Sighting => ({ day, phase, locationId });

  test("dedupes the same (day, phase) — lingering is one observation", () => {
    const first = recordSighting([], s(1));
    expect(first.changed).toBe(true);
    const again = recordSighting(first.list, s(1, "morning", "loc.b"));
    expect(again.changed).toBe(false);
    expect(again.list.length).toBe(1);
  });

  test("caps drop-oldest", () => {
    let list: Sighting[] = [];
    for (let day = 0; day < 6; day++) list = recordSighting(list, s(day), 4).list;
    expect(list.length).toBe(4);
    expect(list[0]!.day).toBe(2);
  });
});

describe("habitOf", () => {
  test("below the threshold there is no habit", () => {
    expect(habitOf([{ day: 1, phase: "morning", locationId: "loc.a" }])).toBeNull();
  });

  test("two sightings of one (phase, location) mint the habit; ties break by phase order then id", () => {
    const list: Sighting[] = [
      { day: 1, phase: "dusk", locationId: "loc.inn" },
      { day: 2, phase: "dusk", locationId: "loc.inn" },
      { day: 3, phase: "morning", locationId: "loc.forge" },
      { day: 4, phase: "morning", locationId: "loc.forge" },
    ];
    // Same count (2 each): morning outranks dusk in day-phase order.
    expect(habitOf(list)).toEqual({ phase: "morning", locationId: "loc.forge", count: 2 });
    expect(renderHabitLine(habitOf(list)!, (id) => (id === "loc.forge" ? "The Forge" : id))).toBe(
      "usually at The Forge in the morning",
    );
  });
});

describe("nameMentioned", () => {
  test("whole-word full-name and first-token matches; no substring false positives", () => {
    expect(nameMentioned("where can i find smith?", "Smith")).toBe(true);
    expect(nameMentioned("where is wren two-knives now", "Wren Two-Knives")).toBe(true);
    expect(nameMentioned("wren keeps the inn, right?", "Wren Two-Knives")).toBe(true);
    expect(nameMentioned("the blacksmithy is closed", "Smith")).toBe(false);
    expect(nameMentioned("look alive", "Al")).toBe(false); // first token under 3 chars never matches
  });
});

describe("whereaboutsLines", () => {
  test("modal slots merge into phase ranges; an override adds the Lately line", () => {
    const locName = (id: string): string => ({ "loc.forge": "The Forge", "loc.inn": "The Inn", "loc.shrine": "The Shrine" })[id] ?? id;
    const target = {
      name: "Smith",
      schedule: {
        slots: [
          { phases: ["morning", "afternoon"], locationId: "loc.forge", activity: "hammering", weight: 1, conditions: [], venue: false },
          { phases: ["dusk"], locationId: "loc.inn", activity: "pouring ale", weight: 1, conditions: [], venue: true },
        ],
        variance: 0,
      } as NpcSchedule,
    };
    expect(whereaboutsLines(target, undefined, locName)).toEqual([
      "- Smith: morning–afternoon at The Forge (hammering); dusk at The Inn (pouring ale).",
    ]);
    expect(whereaboutsLines(target, { locationId: "loc.shrine", activity: "praying", untilDay: 9 }, locName)).toEqual([
      "- Smith: morning–afternoon at The Forge (hammering); dusk at The Inn (pouring ale).",
      "- Lately: keeps to The Shrine (praying).",
    ]);
  });
});

describe("replierKnowsTarget", () => {
  const homes: Record<string, string> = { "npc.a": "loc.x", "npc.b": "loc.x", "npc.c": "loc.y" };
  const regions: Record<string, string> = { "loc.x": "vale", "loc.y": "waste" };
  const homeLocOf = (id: string): string | undefined => homes[id];
  const regionOf = (loc: string | undefined): string | undefined => (loc ? regions[loc] : undefined);

  test("same region / same faction / any relationship — else no", () => {
    expect(replierKnowsTarget({ id: "npc.a" }, { id: "npc.b" }, regionOf, homeLocOf, undefined)).toBe(true); // region
    expect(replierKnowsTarget({ id: "npc.c", factionId: "f.g" }, { id: "npc.b", factionId: "f.g" }, regionOf, homeLocOf, undefined)).toBe(true); // faction
    expect(replierKnowsTarget({ id: "npc.c" }, { id: "npc.b" }, regionOf, homeLocOf, -5)).toBe(true); // relationship
    expect(replierKnowsTarget({ id: "npc.c" }, { id: "npc.b" }, regionOf, homeLocOf, 0)).toBe(false);
    expect(replierKnowsTarget(undefined, { id: "npc.b" }, regionOf, homeLocOf, 50)).toBe(false);
  });
});

// --- engine-wired -----------------------------------------------------------

describe("sightings — engine", () => {
  test("a traveling companion is not a sighting", async () => {
    const world = WorldSchema.parse({
      id: "w.comp",
      name: "Compworld",
      summary: "s",
      locations: [{ id: "loc.forge", name: "The Forge", description: "d", npcs: ["npc.smith"] }],
      npcs: [
        { id: "npc.smith", name: "Smith", persona: "T.", age: 40, stats: pcStats, schedule: SMITH_SCHEDULE },
      ],
    });
    const campaign = CampaignSchema.parse({
      id: "c.comp",
      name: "C",
      worldId: "w.comp",
      characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
      startingState: { locationId: "loc.forge", clock: 480, party: ["pc.you"], companions: ["npc.smith"] },
    });
    const { engine } = engineWith({ world, campaign }, [planOf({}), planOf({})]);
    await engine.start();
    await engine.submitPlayerInput("We walk together.");
    await engine.submitPlayerInput("We keep walking.");
    expect(sightingsOf(engine)?.byNpc["npc.smith"]).toBeUndefined();
  });
});

describe("ask-around whereabouts — reply briefs", () => {
  test("a same-region replier gets # KNOWN WHEREABOUTS facts about the asked-about NPC", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(askAroundPlayset(), [talkTo("npc.bard")], { gateway });
    await engine.start();
    await engine.submitPlayerInput("Bard, where can I find Smith these days?");
    const brief = gateway.briefs.find((b) => b.includes("# KNOWN WHEREABOUTS"));
    expect(brief).toBeDefined();
    expect(brief).toContain("- Smith: morning at The Forge (hammering at the forge); afternoon at The Inn (pouring ale).");
  });

  test("a stranger (other region, no faction, no relationship) gets no whereabouts block", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(askAroundPlayset(), [planOf({ kind: "movement", destinationLocationId: "loc.cave" }), talkTo("npc.hermit")], { gateway });
    await engine.start();
    await engine.submitPlayerInput("I hike out to the cave.");
    await engine.submitPlayerInput("Hermit, where can I find Smith?");
    expect(gateway.briefs.some((b) => b.includes("# KNOWN WHEREABOUTS"))).toBe(false);
  });

  test("a line that names nobody scheduled injects nothing", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(askAroundPlayset(), [talkTo("npc.bard")], { gateway });
    await engine.start();
    await engine.submitPlayerInput("Bard, where can I find the Hermit?"); // hermit has no schedule
    expect(gateway.briefs.some((b) => b.includes("# KNOWN WHEREABOUTS"))).toBe(false);
  });
});

/**
 * The `player-query` name surface (r8), end to end. "Dray" is the original regression case
 * reproduced in miniature: a rostered, scheduled NPC whose whole name is an ordinary English word,
 * so the binder could only reach him off a CAPITAL — "where can i find dray?" answered nobody.
 * The unlock is the classifier's own read of the same line (`plan.dialogueAsk`), never the text.
 */
describe("ask-around whereabouts — the player-query surface", () => {
  /** Same village, plus a quartermaster named after the cart he drives. */
  function drayPlayset(): PlaySet {
    const playset = askAroundPlayset();
    playset.world.npcs.push({
      ...playset.world.npcs.find((n) => n.id === "npc.smith")!,
      id: "npc.dray",
      name: "Dray",
      summary: "the yard quartermaster",
      schedule: SMITH_SCHEDULE,
    });
    playset.world.locations.find((l) => l.id === "loc.inn")!.npcs.push("npc.dray");
    return playset;
  }
  const asksWhereabouts = planOf({ kind: "dialogueToNpc", targetId: "npc.bard", dialogueAsk: "whereabouts" });

  test("REPRO — lower-case 'where can i find dray?' now answers, once the classifier calls it a whereabouts ask", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(drayPlayset(), [asksWhereabouts], { gateway });
    await engine.start();
    await engine.submitPlayerInput("bard, where can i find dray these days?");
    const brief = gateway.briefs.find((b) => b.includes("# KNOWN WHEREABOUTS"));
    expect(brief).toBeDefined();
    expect(brief).toContain("- Dray: morning at The Forge");
  });

  test("REPRO (the reverted attempt) — the same word in an ACTION line is still a cart", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(
      drayPlayset(),
      [planOf({ kind: "dialogueToNpc", targetId: "npc.bard", dialogueAsk: "other" })],
      { gateway },
    );
    await engine.start();
    await engine.submitPlayerInput("bard, we should hitch the dray and load the crates before dark");
    expect(gateway.briefs.some((b) => b.includes("# KNOWN WHEREABOUTS"))).toBe(false);
  });

  test("no dialogueAsk (a stub, a private whisper, a classifier outage) degrades to the strict surface", async () => {
    const gateway = new RecordingGateway();
    const { engine } = engineWith(drayPlayset(), [talkTo("npc.bard")], { gateway });
    await engine.start();
    await engine.submitPlayerInput("bard, where can i find dray these days?");
    expect(gateway.briefs.some((b) => b.includes("# KNOWN WHEREABOUTS"))).toBe(false);
    // The capital was, and still is, the other way in.
    const cap = new RecordingGateway();
    const { engine: e2 } = engineWith(drayPlayset(), [talkTo("npc.bard")], { gateway: cap });
    await e2.start();
    await e2.submitPlayerInput("Bard, where can I find Dray these days?");
    expect(cap.briefs.some((b) => b.includes("# KNOWN WHEREABOUTS"))).toBe(true);
  });

  test("the classifier is TOLD routines exist — the flag that arms the guidance, omitted where nobody keeps one", async () => {
    const seen: ClassifierContext[] = [];
    const capturing: TurnClassifier = {
      classify: (_text, ctx) => {
        seen.push(ctx);
        return Promise.resolve(talkTo("npc.bard"));
      },
    };
    const run = async (playset: PlaySet): Promise<ClassifierContext> => {
      const engine = new GameEngine({
        classifier: capturing,
        playset,
        store: new InMemoryGameStateStore(),
        gateway: new OfflineGateway(),
        rng: mulberry32(SEED),
      });
      await engine.start();
      await engine.submitPlayerInput("bard, where can i find dray these days?");
      return seen[seen.length - 1]!;
    };
    expect((await run(drayPlayset())).routinesKnown).toBe(true);
    // Strip every schedule and the flag goes away with it: asking where somebody is is a question
    // this world cannot answer, so the prompt stays byte-identical (the `abed` discipline).
    const scheduleless = drayPlayset();
    for (const npc of scheduleless.world.npcs) delete (npc as { schedule?: unknown }).schedule;
    expect((await run(scheduleless)).routinesKnown).toBeUndefined();
  });

  test("a distinctive name is unaffected by the surface — Smith answers either way", async () => {
    for (const plan of [asksWhereabouts, talkTo("npc.bard")]) {
      const gateway = new RecordingGateway();
      const { engine } = engineWith(drayPlayset(), [plan], { gateway });
      await engine.start();
      await engine.submitPlayerInput("bard, where can i find smith these days?");
      expect(gateway.briefs.some((b) => b.includes("- Smith: morning at The Forge"))).toBe(true);
    }
  });
});
