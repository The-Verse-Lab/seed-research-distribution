/**
 * Travel-events — engine-wired. Drives real movement so the TravelEventsModule fires on arrival,
 * and asserts the seeded courier event end to end: the courier hands a letter (which opens the inline
 * quest-offer card on read). Also locks `once`/cooldown suppression and cursor persistence across reload.
 *
 * `travelEventChance: 1` + a single eligible event makes each fire deterministic; the roll itself is a
 * private keyed rng, so the shared engine `rng` is irrelevant to the outcome (pinned anyway).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { byKind } from "./support/harness.ts";

const SEED = 7;
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
/** Return the scripted plans in order (clamping to the last) — one per submitted turn. */
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
}
const move = (to: string): TurnPlan => planOf({ kind: "movement", destinationLocationId: to });
const readItem = (itemId: string): TurnPlan => planOf({ kind: "itemAction", item: { verb: "read", itemId, targetId: null } });

const pcInv = (engine: GameEngine): string[] => engine.getState().actors["pc.you"]?.inventory ?? [];

function engineWith(playset: PlaySet, plans: TurnPlan[], opts: { store?: InMemoryGameStateStore } = {}) {
  const engine = new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: opts.store ?? new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(SEED),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

// --- Courier -------------------------------------------------------------------

const LETTER = "item.travel-letter";
const QUEST = "quest.travel-bridge";

function courierPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.trav",
    name: "Roadworld",
    summary: "A test road.",
    locations: [
      { id: "loc.road", name: "The Road", description: "A muddy road.", connections: ["loc.square"] },
      { id: "loc.square", name: "The Square", description: "A market square.", connections: ["loc.road"] },
    ],
    items: [
      {
        id: LETTER,
        name: "Sealed Letter",
        description: "A wax-sealed letter.",
        kind: "quest",
        properties: { body: "Meet me at the old bridge at dusk. — V", offersQuest: QUEST },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.trav",
    name: "Road Campaign",
    worldId: "w.trav",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    quests: [{ id: QUEST, name: "The Bridge at Dusk", description: "A letter names the old bridge.", state: "hidden" }],
    travelEventChance: 1,
    travelEvents: [
      {
        id: "tev.courier",
        once: "campaign",
        effects: [
          { kind: "narrate", text: "A mud-spattered runner presses a sealed letter into your hand and is gone." },
          { kind: "giveItem", itemId: LETTER },
        ],
      },
    ],
    startingState: { locationId: "loc.road", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

describe("courier travel event", () => {
  test("hands the player a letter on a MOVE (not the opening turn); reading it offers the quest", async () => {
    const { engine, events } = engineWith(courierPlayset(), [
      planOf({}), // turn 1 at the start = seed the cursor, NO fire
      move("loc.square"), // turn 2 = a real traversal → courier fires
      readItem(LETTER), // turn 3 = read the delivered letter
    ]);
    await engine.start();

    await engine.submitPlayerInput("I look around the road.");
    expect(pcInv(engine)).not.toContain(LETTER); // the spawn-in turn never fires a travel event

    await engine.submitPlayerInput("I walk to the square.");
    expect(pcInv(engine)).toContain(LETTER); // the traversal delivered it
    // The lead-in prose emitted through the shared eventBeats → EventsModule.onNarrate path.
    expect(byKind(events, "narration").some((e) => e.text.includes("runner presses a sealed letter"))).toBe(true);

    await engine.submitPlayerInput("I break the seal and read it.");
    expect(engine.getState().quests[QUEST]).toBe("offered");
    expect(byKind(events, "questOffered").some((e) => e.questId === QUEST)).toBe(true);
  });

  test("`once: campaign` delivers exactly one letter across many moves", async () => {
    const { engine } = engineWith(courierPlayset(), [planOf({}), move("loc.square"), move("loc.road"), move("loc.square")]);
    await engine.start();
    await engine.submitPlayerInput("look"); // seed
    await engine.submitPlayerInput("go square"); // fire
    await engine.submitPlayerInput("go road"); // arrival, but once-fired → inert
    await engine.submitPlayerInput("go square"); // arrival, still inert
    expect(pcInv(engine).filter((i) => i === LETTER).length).toBe(1);
  });

  test("the travel-events cursor persists across reload — no re-delivery", async () => {
    const store = new InMemoryGameStateStore();
    const first = engineWith(courierPlayset(), [planOf({}), move("loc.square")], { store });
    await first.engine.start();
    await first.engine.submitPlayerInput("look"); // seed
    await first.engine.submitPlayerInput("go square"); // fire (once: campaign)
    expect(pcInv(first.engine).filter((i) => i === LETTER).length).toBe(1);

    // A fresh engine on the SAME store resumes; moving again must not re-deliver (firedCampaign survived).
    const second = engineWith(courierPlayset(), [move("loc.road"), move("loc.square")], { store });
    await second.engine.start();
    await second.engine.submitPlayerInput("go road");
    await second.engine.submitPlayerInput("go square");
    expect(pcInv(second.engine).filter((i) => i === LETTER).length).toBe(1);
  });
});

// --- Combat drought (r11 F-10) --------------------------------------------------

function droughtPlayset(effects: unknown[]): PlaySet {
  const world = WorldSchema.parse({
    id: "w.drought",
    name: "Drought",
    premise: "Two rooms and a road between them.",
    constitution: { tone: "grim" },
    locations: [
      { id: "loc.road", name: "Road", description: "A road.", exits: [{ to: "loc.square", direction: "north" }] },
      { id: "loc.square", name: "Square", description: "A square.", exits: [{ to: "loc.road", direction: "south" }] },
    ],
    npcs: [],
    monsters: [
      {
        id: "foe.brigand",
        name: "Brigand",
        summary: "A road-cutter.",
        stats: { abilities: { str: 12, dex: 12, con: 10, int: 8, wis: 8, cha: 8 }, maxHp: 6, armorClass: 11 },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.drought",
    worldId: "w.drought",
    name: "Drought",
    synopsis: "Walk.",
    characters: [{ id: "pc.you", name: "You", role: "pc", stats: pcStats }],
    travelEventChance: 1,
    travelEvents: [{ id: "tev.x", effects }],
    startingState: { locationId: "loc.road", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

const droughtCursor = (engine: GameEngine): { quietMoves?: number } =>
  (engine.getState().modules?.travelEvents as { quietMoves?: number } | undefined) ?? {};

describe("combat drought — the roller's own pity timer (r11 F-10)", () => {
  test("every fightless arrival extends the quiet, and it persists on the cursor", async () => {
    const { engine } = engineWith(droughtPlayset([{ kind: "narrate", text: "The road is quiet." }]), [
      planOf({}),
      move("loc.square"),
      move("loc.road"),
      move("loc.square"),
    ]);
    await engine.start();
    await engine.submitPlayerInput("look"); // seed — no roll, no count
    expect(droughtCursor(engine).quietMoves).toBe(0);
    await engine.submitPlayerInput("north");
    expect(droughtCursor(engine).quietMoves).toBe(1);
    await engine.submitPlayerInput("south");
    await engine.submitPlayerInput("north");
    expect(droughtCursor(engine).quietMoves).toBe(3);
  });

  test("a fight the roller actually opened resets it to zero", async () => {
    const { engine } = engineWith(
      droughtPlayset([
        { kind: "narrate", text: "Steel in the hedgerow." },
        { kind: "ambush", templateId: "foe.brigand", name: "Brigand", hp: 6 },
      ]),
      [planOf({}), move("loc.square")],
    );
    await engine.start();
    await engine.submitPlayerInput("look"); // seed
    await engine.submitPlayerInput("north"); // traversal → the ambush fires
    expect((engine.getState().modules?.combat as { active?: boolean } | undefined)?.active).toBe(true);
    expect(droughtCursor(engine).quietMoves).toBe(0);
  });
});
