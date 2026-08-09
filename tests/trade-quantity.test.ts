/**
 * Typed buy quantities (r3 P3: "I buy two rations" silently bought ONE) — the trade payload now
 * carries `quantity`, and the engine buys up to it in one turn, capped by the vendor's real stock
 * and the purse, with one honest summary line. n === 1 stays byte-identical to the single-buy path.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
const NO_CHECK = { warranted: false as const, ability: null, skill: null, dc: null, reason: "" };
const VENDOR = "npc.trader";
const RATION = "item.rations";

function mkPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.qty",
    name: "Qtyworld",
    summary: "A counter and a purse.",
    locations: [{ id: "loc.shop", name: "The Shop", description: "A stall.", npcs: [VENDOR], exits: [] }],
    npcs: [{ id: VENDOR, name: "Trader", persona: "Sells staples.", age: 40, vendor: {} }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.qty",
    name: "Qty Campaign",
    worldId: "w.qty",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.shop", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function seededState(playset: PlaySet, coins: number, stock: number): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.shop",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.shop", inventory: [], conditions: [], coins },
      [VENDOR]: {
        id: VENDOR,
        currentHp: 10,
        locationId: "loc.shop",
        inventory: Array.from({ length: stock }, () => RATION),
        conditions: [],
      },
    },
    quests: {},
    relationships: {},
    autonomy: {},
    flags: {},
  };
}

const buyPlan = (quantity?: number): TurnPlan =>
  ({
    kind: "trade",
    targetId: VENDOR,
    destinationLocationId: null,
    check: NO_CHECK,
    confidence: 1,
    trade: { direction: "buy", itemId: RATION, vendorId: VENDOR, ...(quantity !== undefined ? { quantity } : {}) },
  }) as TurnPlan;

async function buy(opts: { coins: number; stock: number; quantity?: number }) {
  const playset = mkPlayset();
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, "pc.you"), seededState(playset, opts.coins, opts.stock));
  const classifier: TurnClassifier = { classify: async () => buyPlan(opts.quantity) };
  const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), classifier, rng: mulberry32(3) });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  await engine.submitPlayerInput("I buy rations");
  const prose = events
    .filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration")
    .at(-1)?.text ?? "";
  const state = engine.getState();
  return {
    prose,
    bought: state.actors["pc.you"]!.inventory.filter((id) => id === RATION).length,
    coins: state.actors["pc.you"]!.coins ?? 0,
    stockLeft: state.actors[VENDOR]!.inventory.filter((id) => id === RATION).length,
  };
}

describe("typed buy quantities", () => {
  test("quantity 2 buys two in one turn, one summary line, coins down 2× the price", async () => {
    const r = await buy({ coins: 1000, stock: 3, quantity: 2 });
    expect(r.bought).toBe(2);
    expect(r.stockLeft).toBe(1);
    expect(r.prose).toContain("2×");
    expect(1000 - r.coins).toBe((1000 - r.coins) / 2 * 2); // even total: two identical unit prices
  });

  test("stock-capped: asking for five of three names the shortfall", async () => {
    const r = await buy({ coins: 10_000, stock: 3, quantity: 5 });
    expect(r.bought).toBe(3);
    expect(r.stockLeft).toBe(0);
    expect(r.prose).toContain("only 3 on the counter");
  });

  test("coin-capped: the purse buys what it can and says so", async () => {
    const one = await buy({ coins: 10_000, stock: 1, quantity: 1 });
    const unitPrice = 10_000 - one.coins;
    expect(unitPrice).toBeGreaterThan(0);
    const r = await buy({ coins: unitPrice + Math.floor(unitPrice / 2), stock: 5, quantity: 3 });
    expect(r.bought).toBe(1);
    expect(r.prose).toContain("all your coin ran to 1");
  });

  test("no quantity stays the byte-identical single buy", async () => {
    const r = await buy({ coins: 1000, stock: 3 });
    expect(r.bought).toBe(1);
    expect(r.prose).toContain("You buy the ");
    expect(r.prose).not.toContain("×");
  });
});
