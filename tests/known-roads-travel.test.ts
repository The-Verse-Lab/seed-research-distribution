/**
 * Known-roads travel (2026-07-25 fix wave) — naming a VISITED multi-hop place no longer teleports
 * over a minted wormhole at flat cost. The engine QUOTES the journey (route + true summed minutes),
 * arms a one-turn confirmation, and only a "yes" (or naming the destination again) walks it —
 * leg by leg through the reducer, priced at the commit chokepoint. Mid-combat there is no quote
 * and no cross-map dash: one leg toward the named place, exactly as far as legs carry.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { DEFAULT_TURN_MINUTES } from "../src/rules/costs.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
const NO_CHECK = { warranted: false, ability: null, skill: null, dc: null, reason: "" };

/** Gate ⇄ Bridge ⇄ Keep, authored minutes 60 and 120 each way. */
function mkPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.roads",
    name: "Roadworld",
    summary: "A world of long honest roads.",
    locations: [
      {
        id: "loc.gate",
        name: "The Gate",
        description: "A toll gate.",
        exits: [{ to: "loc.bridge", name: "the long road to the bridge", locked: false, hidden: false, minutes: 60 }],
      },
      {
        id: "loc.bridge",
        name: "The Bridge",
        description: "A stone span.",
        exits: [
          { to: "loc.gate", name: "back to the gate", locked: false, hidden: false, minutes: 60 },
          { to: "loc.keep", name: "up to the keep", locked: false, hidden: false, minutes: 120 },
        ],
      },
      {
        id: "loc.keep",
        name: "The Keep",
        description: "A cold hall.",
        exits: [{ to: "loc.bridge", name: "down to the bridge", locked: false, hidden: false, minutes: 120 }],
      },
    ],
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.roads",
    name: "Roads Campaign",
    worldId: "w.roads",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.gate", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

const move = (destinationLocationId: string | null, destinationName: string | null): TurnPlan =>
  ({
    kind: "movement",
    targetId: null,
    destinationLocationId,
    destinationName,
    movementMiss: destinationLocationId === null,
    check: NO_CHECK,
    confidence: 1,
  }) as TurnPlan;

/** Scripted classifier that pops plans off a queue (the yes/no answers never reach it). */
function scripted(plans: TurnPlan[]): TurnClassifier {
  return { classify: async () => plans.shift() ?? move(null, null) };
}

async function walkToKeep(engine: GameEngine): Promise<void> {
  await engine.submitPlayerInput("take the road to the bridge");
  await engine.submitPlayerInput("climb to the keep");
  expect(engine.getState().partyLocationId).toBe("loc.keep");
}

describe("known-roads travel — quote, confirm, honest cost", () => {
  test("multi-leg reach QUOTES first (no move, spoken-beat price), then 'yes' walks it at true cost", async () => {
    const playset = mkPlayset();
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: scripted([move("loc.bridge", null), move("loc.keep", null), move(null, "The Gate")]),
      rng: mulberry32(7),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    await walkToKeep(engine);

    const clockAtKeep = engine.getState().clock;
    await engine.submitPlayerInput("head back to the gate"); // reach-miss → QUOTE
    expect(engine.getState().partyLocationId).toBe("loc.keep"); // did not move
    expect(engine.getState().clock - clockAtKeep).toBe(DEFAULT_TURN_MINUTES); // spoken beat, not travel

    const clockAtQuote = engine.getState().clock;
    const energyBefore = engine.getState().actors["pc.you"]!.energy ?? 100;
    await engine.submitPlayerInput("yes"); // confirm → walk keep→bridge→gate
    expect(engine.getState().partyLocationId).toBe("loc.gate");
    expect(engine.getState().clock - clockAtQuote).toBe(180); // 120 + 60 authored minutes
    // Energy scales with the true duration: scaledEnergy(8, 180, 30) = 23, not the flat 8.
    const energyAfter = engine.getState().actors["pc.you"]!.energy ?? 100;
    expect(energyBefore - energyAfter).toBe(23);
    // No wormhole was ever minted.
    expect(events.some((e) => e.kind === "exitLinked")).toBe(false);
    expect(playset.world.locations.find((l) => l.id === "loc.keep")!.exits.some((e) => e.to === "loc.gate")).toBe(false);
    // Playtest r9 F-5: the quote reaches the screen as a DETERMINISTIC receipt — the confirmation
    // window must never depend on the narrator relaying the trigger (it wrote over it live).
    const receipt = events.find(
      (e): e is Extract<GameEvent, { kind: "stateChanged" }> =>
        e.kind === "stateChanged" && typeof e.summary === "string" && e.summary.startsWith("The road to The Gate is"),
    );
    expect(receipt?.summary).toContain("name it again to set out");
  });

  test("naming the destination AGAIN also confirms (movement-line channel)", async () => {
    const playset = mkPlayset();
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: scripted([
        move("loc.bridge", null),
        move("loc.keep", null),
        move(null, "The Gate"), // quote
        move(null, "The Gate"), // re-named → confirm
      ]),
      rng: mulberry32(7),
    });
    await engine.start();
    await walkToKeep(engine);

    await engine.submitPlayerInput("set out for the gate");
    expect(engine.getState().partyLocationId).toBe("loc.keep"); // quoted, waiting
    await engine.submitPlayerInput("to the gate, then");
    expect(engine.getState().partyLocationId).toBe("loc.gate"); // walked
  });

  test("'no' declines; the quote does not survive to a later 'yes'", async () => {
    const playset = mkPlayset();
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: scripted([
        move("loc.bridge", null),
        move("loc.keep", null),
        move(null, "The Gate"), // quote
        // "no" and the later "yes" are handled by the deterministic matchers / classifier fallback.
      ]),
      rng: mulberry32(7),
    });
    await engine.start();
    await walkToKeep(engine);

    await engine.submitPlayerInput("head back to the gate"); // quote
    await engine.submitPlayerInput("no"); // decline
    expect(engine.getState().partyLocationId).toBe("loc.keep");
    await engine.submitPlayerInput("yes"); // nothing armed — must NOT travel
    expect(engine.getState().partyLocationId).toBe("loc.keep");
  });

  test("an unrelated turn lets the quote rest — the next naming quotes afresh instead of executing", async () => {
    const playset = mkPlayset();
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: scripted([
        move("loc.bridge", null),
        move("loc.keep", null),
        move(null, "The Gate"), // quote
        { kind: "freeformNarrative", targetId: null, destinationLocationId: null, check: NO_CHECK, confidence: 1 } as TurnPlan,
        move(null, "The Gate"), // names it again — but the old quote lapsed, so this QUOTES again
      ]),
      rng: mulberry32(7),
    });
    await engine.start();
    await walkToKeep(engine);

    await engine.submitPlayerInput("head back to the gate"); // quote
    await engine.submitPlayerInput("I check my pack"); // unrelated — quote lapses
    await engine.submitPlayerInput("head back to the gate"); // fresh quote, not an execution
    expect(engine.getState().partyLocationId).toBe("loc.keep");
    await engine.submitPlayerInput("yes"); // now confirm the fresh quote
    expect(engine.getState().partyLocationId).toBe("loc.gate");
  });
});

describe("arrival vs return — a revisited place is not restaged (r5 P4)", () => {
  test("the FIRST arrival is a plain travel line; a RETURN asks for what changed", async () => {
    // Thornwick's arrival beat replayed near word for word on day 3, because the trigger said the
    // same thing both times and the authored description is re-injected every visit. The move now
    // tells the narrator which one this is.
    const playset = mkPlayset();
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: scripted([move("loc.bridge", null), move("loc.gate", null), move("loc.bridge", null)]),
      rng: mulberry32(7),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("take the road to the bridge");
    const first = events.filter((e) => e.kind === "narration").at(-1) as Extract<GameEvent, { kind: "narration" }>;
    expect(first.text).toContain("You travel to The Bridge.");
    expect(first.text).not.toContain("been here before");

    await engine.submitPlayerInput("back to the gate");
    events.length = 0;
    await engine.submitPlayerInput("take the road to the bridge");
    const again = events.filter((e) => e.kind === "narration").at(-1) as Extract<GameEvent, { kind: "narration" }>;
    expect(again.text).toContain("You travel to The Bridge.");
    expect(again.text).toContain("been here before");
    expect(again.text).toContain("what has changed");
  });
});
