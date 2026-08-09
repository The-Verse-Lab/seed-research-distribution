/**
 * Travel event effects — engine-wired coverage for the expanded effect vocabulary.
 *
 * Drives real movement through GameEngine so default PC targeting, keyed check branching, reducer
 * clamping, and synthetic ambush combat all cross the same module/commit boundary used in play.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { keyedCheck } from "../src/rules/travel-events.ts";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { byKind } from "./support/harness.ts";

const PC = "pc.you";
const pcStats = { abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, maxHp: 20, armorClass: 12 };

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
const attack = (targetId: string): TurnPlan => planOf({ kind: "attack", targetId });

function scriptedRng(values: number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index++];
    if (value === undefined) throw new Error(`scripted rng exhausted at roll ${index}`);
    return value;
  };
}

function playsetWith(events: unknown[], opts: { coins?: number } = {}): PlaySet {
  const world = WorldSchema.parse({
    id: "w.travel-effects",
    name: "Travel Effects",
    summary: "A small road.",
    locations: [
      { id: "loc.a", name: "Road A", description: "The first road.", connections: ["loc.b"] },
      { id: "loc.b", name: "Road B", description: "The second road.", connections: ["loc.a"] },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.travel-effects",
    name: "Travel Effects Campaign",
    worldId: "w.travel-effects",
    characters: [{ id: PC, name: "You", stats: pcStats, age: 30, ...(opts.coins === undefined ? {} : { coins: opts.coins }) }],
    travelEventChance: 1,
    travelEvents: events,
    startingState: { locationId: "loc.a", party: [PC], companions: [] },
  });
  return { world, campaign };
}

async function runMove(playset: PlaySet, plans: TurnPlan[] = [planOf({}), move("loc.b")], rng: Rng = mulberry32(7)) {
  const engine = new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng,
  });
  const events: GameEvent[] = [];
  engine.subscribe((event) => events.push(event));
  await engine.start();
  await engine.submitPlayerInput("I look down the road.");
  await engine.submitPlayerInput("I walk on.");
  return { engine, events };
}

describe("travel event effects", () => {
  test("adjustCoins and adjustEnergy default to the PC and clamp through the reducer", async () => {
    const { engine } = await runMove(
      playsetWith(
        [
          {
            id: "tev.cost",
            effects: [
              { kind: "adjustCoins", by: -10 },
              { kind: "adjustEnergy", by: -999 },
            ],
          },
        ],
        { coins: 4 },
      ),
    );

    const pc = engine.getState().actors[PC];
    expect(pc?.coins).toBe(0);
    // adjustEnergy(-999) drains to 0; the movement's cost (8) overflows into exhaustion (0→1)
    // and the depletion gate refills energy to workingCap(1,100) - 8 = 82.
    expect(pc?.energy).toBe(82);
    expect(pc?.exhaustion).toBe(1);
  });

  test("check resolves from the keyed d20 and fires the matching branch reproducibly", async () => {
    const key = "travel-check:tev.branch:loc.b:1";
    const expected = keyedCheck(0, 11, key).success ? 11 : 3;
    const playset = playsetWith([
      {
        id: "tev.branch",
        effects: [
          {
            kind: "check",
            ability: "wis",
            dc: 11,
            onSuccess: [{ kind: "adjustCoins", by: 11 }],
            onFail: [{ kind: "adjustCoins", by: 3 }],
          },
        ],
      },
    ]);

    const first = await runMove(playset);
    const second = await runMove(playset);

    expect(first.engine.getState().actors[PC]?.coins).toBe(expected);
    expect(second.engine.getState().actors[PC]?.coins).toBe(expected);
  });

  test("ambush spawns a synthetic foe and starts combat at the arrival location", async () => {
    const { engine, events } = await runMove(
      playsetWith([
        {
          id: "tev.ambush",
          effects: [
            { kind: "narrate", text: "A test bandit jumps from the ditch." },
            { kind: "ambush", templateId: "foe.test-bandit", name: "Test Bandit", hp: 1 },
          ],
        },
      ]),
      [planOf({}), move("loc.b"), attack("foe.test-bandit#0")],
      scriptedRng([0.99, 0.5, 0.5]),
    );

    let state = engine.getState();
    expect(state.actors["foe.test-bandit#0"]).toMatchObject({ id: "foe.test-bandit#0", currentHp: 1, locationId: "loc.b" });
    expect(state.modules?.combat).toMatchObject({
      active: true,
      locationId: "loc.b",
      order: ["foe.test-bandit#0", PC],
      turnIndex: 1,
    });
    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect(byKind(events, "narration").some((event) => event.text.includes("test bandit jumps"))).toBe(true);

    await engine.submitPlayerInput("I strike the bandit.");
    state = engine.getState();
    expect(state.actors["foe.test-bandit#0"]?.currentHp).toBe(0);
    expect((state.modules?.combat as { active?: boolean } | undefined)?.active).toBe(false);
  });
});
