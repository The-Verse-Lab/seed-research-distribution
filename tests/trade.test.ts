/**
 * Trade tests — Phase 1 buy/sell wired end-to-end through the engine.
 *
 * Exercises the vendor pricing math (rules-level, pure), the heuristic classifier's trade
 * detection, reconcilePlan grounding of model-authored trade payloads, and the engine's
 * code-only resolution: an affordable buy moves coins+item atomically, an unaffordable one
 * applies NOTHING, a sell pays half the asking price, and an unpriceable item is refused.
 * Offline gateway throughout — every assertion is deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { NpcTemplateSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { formatCoins, getMasterItem, tradePriceCp } from "../src/rules/items.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { heuristicClassifier, heuristicClassify } from "./support/test-classifier.ts";
import { reconcilePlan } from "../src/engine/classify.ts";
import type { ClassifierContext } from "../src/engine/turn-plan.ts";
import { byKind, loadExample } from "./support/harness.ts";

// --- pricing math (pure, rules-level) ---------------------------------------

describe("tradePriceCp", () => {
  test("list price at modifier 1: buy = base, sell = half floored", () => {
    const potion = getMasterItem("item.potion-healing")!;
    expect(tradePriceCp(potion, 1)).toEqual({ buy: 5000, sell: 2500 });
    const spear = getMasterItem("weapon.spear")!; // 100 cp → sell 50
    expect(tradePriceCp(spear)).toEqual({ buy: 100, sell: 50 });
  });

  test("priceModifier scales and rounds; sell floors the halved buy", () => {
    const dagger = getMasterItem("weapon.dagger")!; // 200 cp
    expect(tradePriceCp(dagger, 1.5)).toEqual({ buy: 300, sell: 150 });
    const club = getMasterItem("weapon.club")!; // 10 cp × 1.25 = 12.5 → 13; sell floor(6.5) = 6
    expect(tradePriceCp(club, 1.25)).toEqual({ buy: 13, sell: 6 });
  });

  test("a priced item never becomes free (buy clamps at 1 cp); a torch sells for nothing", () => {
    const torch = getMasterItem("item.torch")!; // 1 cp
    expect(tradePriceCp(torch, 0.1)).toEqual({ buy: 1, sell: 0 });
    expect(tradePriceCp(torch, 1)).toEqual({ buy: 1, sell: 0 });
  });

  test("an item with no resolvable base cost cannot be priced", () => {
    expect(tradePriceCp({ id: "item.mystery", name: "Mystery", description: "", kind: "misc", properties: {} })).toBeUndefined();
  });
});

describe("formatCoins", () => {
  test("renders gp/sp/cp, omitting zero denominations", () => {
    expect(formatCoins(0)).toBe("0 cp");
    expect(formatCoins(5)).toBe("5 cp");
    expect(formatCoins(100)).toBe("1 gp");
    expect(formatCoins(111)).toBe("1 gp 1 sp 1 cp");
    expect(formatCoins(1530)).toBe("15 gp 3 sp");
  });
});

// --- heuristic classification ------------------------------------------------

function tradeCtx(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    playerActorId: "pc.you",
    locationId: "loc.market",
    locationName: "The Market",
    exits: [],
    presentEntities: [{ id: "npc.trader", name: "Maro the Trader" }],
    companionIds: [],
    carriedItems: [{ id: "weapon.dagger", name: "Dagger" }],
    vendors: [
      {
        id: "npc.trader",
        name: "Maro the Trader",
        stock: [
          { id: "item.potion-healing", name: "Potion of Healing" },
          { id: "weapon.spear", name: "Spear" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("heuristic trade classification", () => {
  test("buying names the vendor's stocked item", () => {
    const plan = heuristicClassify("I buy a potion of healing", tradeCtx());
    expect(plan.kind).toBe("trade");
    expect(plan.trade).toEqual({ direction: "buy", itemId: "item.potion-healing", vendorId: "npc.trader" });
    expect(plan.targetId).toBe("npc.trader");
  });

  test("selling names a carried item", () => {
    const plan = heuristicClassify("I sell my dagger to Maro", tradeCtx());
    expect(plan.kind).toBe("trade");
    expect(plan.trade).toEqual({ direction: "sell", itemId: "weapon.dagger", vendorId: "npc.trader" });
  });

  test("no vendor present ⇒ commerce verbs never classify as trade", () => {
    const plan = heuristicClassify("I sell my dagger", tradeCtx({ vendors: [] }));
    expect(plan.kind).not.toBe("trade");
  });

  test("a buy verb with nothing stocked matching falls through", () => {
    const plan = heuristicClassify("I buy a warhorse", tradeCtx());
    expect(plan.kind).not.toBe("trade");
  });

  test("attack with a named weapon still beats trade-less handling ('sell' absent)", () => {
    const plan = heuristicClassify("I stab Maro with the dagger", tradeCtx());
    expect(plan.kind).toBe("attack");
  });

  test("'sell me X' asks the vendor to sell — the player is BUYING, never selling their own", () => {
    const buy = heuristicClassify("Will you sell me a spear?", tradeCtx());
    expect(buy.kind).toBe("trade");
    expect(buy.trade).toEqual({ direction: "buy", itemId: "weapon.spear", vendorId: "npc.trader" });
    // asking for something un-stocked must never fall back to selling the player's dagger
    expect(heuristicClassify("Will you sell me a dagger?", tradeCtx()).kind).not.toBe("trade");
    expect(heuristicClassify("Sell me a dagger", tradeCtx()).kind).not.toBe("trade");
  });

  test("a price INQUIRY is conversation, never an executed transaction", () => {
    expect(heuristicClassify("I ask the trader what he'd pay for my dagger", tradeCtx()).kind).not.toBe("trade");
    expect(heuristicClassify("What would you pay for my dagger?", tradeCtx()).kind).not.toBe("trade");
    expect(heuristicClassify("How much does the spear cost?", tradeCtx()).kind).not.toBe("trade");
  });

  test("negated commerce never trades", () => {
    expect(heuristicClassify("I won't sell my dagger", tradeCtx()).kind).not.toBe("trade");
    expect(heuristicClassify("I refuse to sell the dagger", tradeCtx()).kind).not.toBe("trade");
  });
});

describe("reconcilePlan trade grounding", () => {
  const rawPlan = (trade: Record<string, unknown>) => ({
    kind: "trade",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    item: null,
    trade,
    confidence: 0.8,
  });

  test("a hallucinated vendor beside ONE real stall repairs to that stall (r2 P0: the prose-chandler)", () => {
    // r2 P0: the player bought from a chandler who existed only in prose; the hallucinated vendor
    // id dropped the whole payload and the turn died on "too vague to close". With exactly one real
    // vendor present the player clearly meant the only merchant here — repair to them, and let the
    // engine answer per-case against their REAL stock ("has no X to sell you. On offer: …").
    const plan = reconcilePlan(rawPlan({ direction: "buy", itemId: "item.potion-healing", vendorId: "npc.ghost" }), tradeCtx());
    expect(plan.kind).toBe("trade");
    expect(plan.trade).toEqual({ direction: "buy", itemId: "item.potion-healing", vendorId: "npc.trader" });
  });

  test("a null vendorId grounds to the only vendor present", () => {
    const plan = reconcilePlan(rawPlan({ direction: "buy", itemId: "weapon.spear", vendorId: null }), tradeCtx());
    expect(plan.kind).toBe("trade");
    expect(plan.trade).toEqual({ direction: "buy", itemId: "weapon.spear", vendorId: "npc.trader" });
  });

  test("an ungrounded WARE passes through with the grounded vendor (engine refuses per case)", () => {
    // The engine is the resolve-time authority: "Maro has no X to sell you" / "you are not
    // carrying it" only work if the un-stocked/un-carried id survives reconciliation instead of
    // collapsing to freeform (where the narrator would happily close the sale).
    const sellUnheld = reconcilePlan(rawPlan({ direction: "sell", itemId: "weapon.spear", vendorId: "npc.trader" }), tradeCtx());
    expect(sellUnheld.kind).toBe("trade");
    expect(sellUnheld.trade).toEqual({ direction: "sell", itemId: "weapon.spear", vendorId: "npc.trader" });
    const buyUnstocked = reconcilePlan(rawPlan({ direction: "buy", itemId: "weapon.dagger", vendorId: "npc.trader" }), tradeCtx());
    expect(buyUnstocked.kind).toBe("trade");
    expect(buyUnstocked.trade).toEqual({ direction: "buy", itemId: "weapon.dagger", vendorId: "npc.trader" });
  });
});

// --- engine resolution --------------------------------------------------------

/** The example tavern plus a resident trader whose template opts into vending. */
function vendorPlayset(base: PlaySet): PlaySet {
  const playset = structuredClone(base);
  playset.world.npcs.push(
    NpcTemplateSchema.parse({
      id: "npc.trader",
      name: "Maro",
      summary: "A tavern-corner trader with a scale and a ledger.",
      persona: "Brisk, fair, and allergic to haggling.",
      appearance: "A stout figure behind a folding counter.",
      // Stock: a dagger (cheap), a potion (dear), and the world's own unpriceable lantern.
      inventory: ["weapon.dagger", "item.potion-healing", "item.lantern"],
      vendor: { priceModifier: 1 },
    }),
  );
  playset.world.locations.find((loc) => loc.id === "loc.tavern")?.npcs.push("npc.trader");
  return playset;
}

/** A PC with a modest purse, a sellable longsword, and the world lantern (unpriceable). */
function seededState(playset: PlaySet): GameState {
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
        inventory: ["weapon.longsword", "item.lantern", "item.torch"],
        conditions: [],
        coins: 1000,
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    flags: {},
  };
}

async function makeTradeEngine(seed = 7): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = vendorPlayset(await loadExample());
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), seededState(playset));
  const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), rng: mulberry32(seed), classifier: heuristicClassifier });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("engine trade resolution", () => {
  test("the vendor's template stock is seeded onto its entity (statless template gets a body)", async () => {
    const { engine } = await makeTradeEngine();
    const vendor = engine.getState().actors["npc.trader"];
    expect(vendor).toBeDefined();
    expect(vendor?.inventory).toEqual(["weapon.dagger", "item.potion-healing", "item.lantern"]);
  });

  test("an affordable buy moves the item and the coins together", async () => {
    const { engine, events } = await makeTradeEngine();

    await engine.submitPlayerInput("I buy the dagger from Maro");

    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "weapon.dagger", from: "npc.trader", to: "pc.you" }),
    ]);
    expect(byKind(events, "coinsChanged")).toEqual([
      expect.objectContaining({ entityId: "pc.you", coins: 800 }), // 1000 − 200
    ]);
    const state = engine.getState();
    expect(state.actors["pc.you"]?.inventory).toContain("weapon.dagger");
    expect(state.actors["pc.you"]?.coins).toBe(800);
    expect(state.actors["npc.trader"]?.inventory).not.toContain("weapon.dagger");
    const changed = byKind(events, "stateChanged");
    expect(changed.some((e) => e.summary.includes("buy the Dagger") && e.summary.includes("2 gp"))).toBe(true);
  });

  test("an unaffordable buy applies NOTHING — no coins move, no item moves", async () => {
    const { engine, events } = await makeTradeEngine();

    await engine.submitPlayerInput("I buy the potion of healing"); // 5000 cp > 1000 cp purse

    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    const state = engine.getState();
    expect(state.actors["pc.you"]?.coins).toBe(1000);
    expect(state.actors["pc.you"]?.inventory).not.toContain("item.potion-healing");
    expect(state.actors["npc.trader"]?.inventory).toContain("item.potion-healing");
    // The refusal is narrated (offline narration echoes the deterministic trigger).
    const narrations = byKind(events, "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    expect(narrations[0]!.text).toContain("not enough");
  });

  test("selling pays half the asking price and hands the item across the counter", async () => {
    const { engine, events } = await makeTradeEngine();

    await engine.submitPlayerInput("I sell the longsword to Maro"); // 1500 cp → 750 cp

    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "weapon.longsword", from: "pc.you", to: "npc.trader" }),
    ]);
    expect(byKind(events, "coinsChanged")).toEqual([
      expect.objectContaining({ entityId: "pc.you", coins: 1750 }), // 1000 + 750
    ]);
    const state = engine.getState();
    expect(state.actors["pc.you"]?.inventory).not.toContain("weapon.longsword");
    expect(state.actors["npc.trader"]?.inventory).toContain("weapon.longsword");
  });

  test("an unpriceable item cannot be traded — the vendor shrugs, nothing moves", async () => {
    const { engine, events } = await makeTradeEngine();

    await engine.submitPlayerInput("I sell the warded lantern to Maro");

    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.lantern");
    const narrations = byKind(events, "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    expect(narrations[0]!.text).toContain("no price");
  });

  test("a worthless sell (half price floors to 0) is refused rather than a free give-away", async () => {
    const { engine, events } = await makeTradeEngine();

    await engine.submitPlayerInput("I sell the torch to Maro"); // 1 cp → sell 0

    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.torch");
  });
});

// --- trade in combat ----------------------------------------------------------

/** The vendor tavern plus a hostile bandit tough enough that a fight can host a trade. */
function combatVendorPlayset(base: PlaySet): PlaySet {
  const playset = vendorPlayset(base);
  playset.world.npcs.push(
    NpcTemplateSchema.parse({
      id: "npc.bandit",
      name: "Bandit",
      summary: "A desperate road-cutter with a raised knife.",
      persona: "Cruel, jumpy, and direct.",
      appearance: "A wiry bandit in a patched coat, knuckles white around a knife.",
      stats: {
        abilities: { str: 14, dex: 10, con: 10, int: 9, wis: 10, cha: 8 },
        maxHp: 30,
        armorClass: 10,
        level: 1,
        speed: 30,
        proficiencies: [],
        spells: [],
      },
      autonomy: { isPartyMember: false, level: "passive", canLead: false, heartbeatSeconds: 40, replyDecayAlpha: 0.2 },
    }),
  );
  playset.world.locations.find((loc) => loc.id === "loc.tavern")?.npcs.push("npc.bandit");
  return playset;
}

async function makeCombatTradeEngine(seed = 7): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = combatVendorPlayset(await loadExample());
  const state = seededState(playset);
  state.actors["pc.you"]!.currentHp = 20; // sturdy enough to survive counter-swings
  state.actors["npc.bandit"] = {
    id: "npc.bandit",
    currentHp: 30,
    locationId: "loc.tavern",
    inventory: [],
    conditions: [],
  };
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), state);
  const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), rng: mulberry32(seed), classifier: heuristicClassifier });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("trade in combat", () => {
  test("a completed buy mid-fight spends the player's combat turn — commerce is not a free action", async () => {
    const { engine, events } = await makeCombatTradeEngine();

    await engine.submitPlayerInput("attack the bandit");
    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);

    events.length = 0;
    await engine.submitPlayerInput("I buy the dagger from Maro");

    // The trade resolved (item + coins moved atomically)...
    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "weapon.dagger", from: "npc.trader", to: "pc.you" }),
    ]);
    expect(byKind(events, "coinsChanged")).toEqual([
      expect.objectContaining({ entityId: "pc.you", coins: 800 }), // 1000 − 200
    ]);
    // ...and it cost the turn: initiative advanced and the enemy side acted.
    expect(byKind(events, "combatTurnAdvanced").length).toBeGreaterThanOrEqual(1);
    const foeSwings = byKind(events, "diceRolled").filter((e) => e.purpose?.startsWith("Bandit →"));
    expect(foeSwings.length).toBeGreaterThanOrEqual(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);
  });
});
