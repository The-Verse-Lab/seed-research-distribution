/**
 * Trade corroboration rail + inquiry quotes — engine-level regressions from the r10 sweep.
 *
 * r10 F-2: "I ask the tanner the price of the seasoned waterskin" executed a PURCHASE — an inquiry
 * must quote and move nothing. r10 F-3: "sell my old belt knife" arrived from the classifier as
 * `weapon.club` (ware substitution) and the id short-circuit sold the club unasked — when the
 * player named the ware in words, the grounded guess must answer to those words or refuse honestly.
 * Anaphora ("I'll take it" — no words) must keep trusting the conversation-grounded id.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { byKind, loadExample } from "./support/harness.ts";

const baseCheck = { warranted: false as const, ability: null, skill: null, dc: null, reason: "" };

/** A classifier stub that returns a fixed, already-reconciled plan. */
const planClassifier = (plan: Partial<TurnPlan> & { kind: TurnPlan["kind"] }): TurnClassifier => ({
  classify: () =>
    Promise.resolve({
      targetId: null,
      destinationLocationId: null,
      check: baseCheck,
      confidence: 0.9,
      ...plan,
    } as TurnPlan),
});

function seededState(playset: PlaySet, inventory: string[]): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: {
      "pc.you": {
        id: "pc.you",
        currentHp: 10,
        locationId: "loc.tavern",
        inventory,
        conditions: [],
        coins: 100,
        energy: 100,
        maxEnergy: 100,
        exhaustion: 0,
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    flags: {},
  };
}

/** Brann behind a real counter: a statted vendor stocking exactly one waterskin. */
async function makeEngine(
  classifier: TurnClassifier,
  carried: string[] = [],
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  const brann = playset.world.npcs.find((n) => n.id === "npc.brann")! as unknown as Record<string, unknown>;
  brann.vendor = { priceModifier: 1 };
  brann.inventory = ["item.waterskin"];
  brann.stats = {
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 12, cha: 12 },
    maxHp: 8,
    armorClass: 10,
    level: 1,
    speed: 30,
    proficiencies: [],
    spells: [],
  };
  const store = new InMemoryGameStateStore();
  await store.save(
    makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]),
    seededState(playset, carried),
  );
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
    classifier,
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("r10 F-2 — an inquiry is answered, never executed", () => {
  test("a buy-side price question quotes the real price and moves NOTHING", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: {
          direction: "buy",
          itemId: "item.waterskin",
          vendorId: "npc.brann",
          inquiry: true,
          itemWords: "waterskin",
        },
      }),
    );
    await engine.submitPlayerInput("I ask Brann the price of a waterskin.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("quotes");
    expect(prose).toContain("Waterskin");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    expect(engine.getState().actors["pc.you"]?.inventory).toHaveLength(0);
  });

  test("a sell-side worth question quotes what the vendor would give and keeps the goods", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "sell", itemId: "weapon.club", vendorId: "npc.brann", inquiry: true, itemWords: "club" },
      }),
      ["weapon.club"],
    );
    await engine.submitPlayerInput("What would you give me for my club?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("would give");
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.inventory).toEqual(["weapon.club"]);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });
});

describe("r10 F-3 — the ware guess must answer to the player's own words", () => {
  test("an unknown spoken name refuses honestly instead of selling the substituted item", async () => {
    // The classifier substituted "old belt knife" into weapon.club; the id is IN the pack, and
    // before the rail the short-circuit sold it.
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "sell", itemId: "weapon.club", vendorId: "npc.brann", itemWords: "old belt knife" },
      }),
      ["weapon.club"],
    );
    await engine.submitPlayerInput("I'll sell my old belt knife for 10 copper.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("nothing you carry answers to that name");
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.inventory).toEqual(["weapon.club"]);
  });

  test("a corroborated sell still sells", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "sell", itemId: "weapon.club", vendorId: "npc.brann", itemWords: "club" },
      }),
      ["weapon.club"],
    );
    await engine.submitPlayerInput("I sell my club.");
    expect(byKind(events, "itemTransferred")).toHaveLength(1);
    expect(engine.getState().actors["pc.you"]?.inventory).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBeGreaterThan(100);
  });

  test("anaphora — no itemWords — keeps trusting the conversation-grounded id", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "buy", itemId: "item.waterskin", vendorId: "npc.brann" },
      }),
    );
    await engine.submitPlayerInput("I'll take it.");
    expect(byKind(events, "itemTransferred")).toHaveLength(1);
    expect(engine.getState().actors["pc.you"]?.inventory).toEqual(["item.waterskin"]);
  });

  test("the words HEAL a wrong guess when the pool really stocks what the player named", async () => {
    // The classifier guessed weapon.club (not stocked); the player said "waterskin" and Brann
    // stocks one — the rail re-grounds by the words instead of refusing.
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "buy", itemId: "weapon.club", vendorId: "npc.brann", itemWords: "waterskin" },
      }),
    );
    await engine.submitPlayerInput("I buy the waterskin.");
    expect(byKind(events, "itemTransferred")).toHaveLength(1);
    expect(engine.getState().actors["pc.you"]?.inventory).toEqual(["item.waterskin"]);
  });

  test("a buy-side unknown name refuses with the spoken words and the real counter", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "buy", itemId: "item.waterskin", vendorId: "npc.brann", itemWords: "seasoned tarp" },
      }),
    );
    await engine.submitPlayerInput("I buy the seasoned tarp.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("no seasoned tarp here");
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });

  test("t7 teaching refusal survives: a corroborated but uncarried ware names the real item", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "sell", itemId: "item.waterskin", vendorId: "npc.brann", itemWords: "waterskin" },
      }),
      ["weapon.club"],
    );
    await engine.submitPlayerInput("I sell my waterskin.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("You reach for the Waterskin, but you are not carrying it.");
    expect(engine.getState().actors["pc.you"]?.inventory).toEqual(["weapon.club"]);
  });
});
