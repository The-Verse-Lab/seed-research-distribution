/**
 * submitAction tests — the GROUNDED-action channel (engine.submitAction) wired end-to-end.
 *
 * `submitAction` mirrors `submitPlayerInput` but BYPASSES the LLM classifier: a typed
 * `GroundedAction` (a clicked exit / item / quest / trade / rest / attack) maps
 * 1:1 to a `TurnPlan` the engine builds directly and runs through the SAME resolve pipeline, so the
 * reducer still does every mutation. These specs assert the REDUCER effect of each action (party
 * moved, item equipped, quest flipped, item+coins crossed the counter atomically, the day counter
 * rolled over on rest) and that an invalid target is rejected without throwing or consuming a turn.
 * Offline gateway + seeded rng throughout — every assertion is deterministic.
 *
 * They also pin the COST of the four mechanical clicks (equip/unequip/buy/sell): those resolve to
 * finished player-facing prose, so they must reach the player verbatim with ZERO narrator calls.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { ItemSchema, NpcTemplateSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { GameEngine, restAdvanceMinutes } from "../src/engine/engine.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { reduceDeltas } from "./support/replay.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import { byKind, loadExample } from "./support/harness.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";

const PC = "pc.you";
const VENDOR = "npc.merchant";
/** An authored, explicitly-priced trinket so trade prices are exact (buy 100cp, sell 50cp) and do
 *  not depend on the SRD masterlist. */
const TRINKET = "item.trinket";
const TRINKET_BUY = 100;
const TRINKET_SELL = 50;

/** The example tavern with a merchant NPC (a priced trinket in stock) added at loc.tavern. */
function tradePlayset(base: PlaySet): PlaySet {
  const playset = structuredClone(base);
  // An authored priced item — world items win over the masterlist, so the price is exact.
  playset.world.items.push(
    ItemSchema.parse({
      id: TRINKET,
      name: "Brass Trinket",
      description: "A cheap brass bauble.",
      kind: "treasure",
      properties: { baseCostCp: TRINKET_BUY },
    }),
  );
  playset.world.npcs.push(
    NpcTemplateSchema.parse({
      id: VENDOR,
      name: "Merchant",
      summary: "A stall-keeper with a tray of trinkets.",
      persona: "Genial, mercantile, keen-eyed.",
      appearance: "A round trader behind a laden counter.",
      goals: ["Turn a profit"],
      knowledge: [],
      relationships: {},
      inventory: [TRINKET],
      vendor: { priceModifier: 1 },
      autonomy: { isPartyMember: false, level: "passive", canLead: false, heartbeatSeconds: 40, replyDecayAlpha: 0.2 },
    }),
  );
  playset.world.locations.find((loc) => loc.id === "loc.tavern")?.npcs.push(VENDOR);
  return playset;
}

/**
 * A PC at the tavern with coins, a longsword to equip, and a trinket to sell; the merchant holds a
 * trinket to buy. The example's one quest is forced to "offered" so acceptQuest has a target.
 */
function seededState(playset: PlaySet, overrides: Partial<GameState> = {}): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 0,
    party: [PC],
    companions: [],
    actors: {
      [PC]: {
        id: PC,
        currentHp: 20,
        locationId: "loc.tavern",
        inventory: ["weapon.longsword", TRINKET],
        conditions: [],
        coins: 500,
      },
      [VENDOR]: {
        id: VENDOR,
        currentHp: 12,
        locationId: "loc.tavern",
        inventory: [TRINKET],
        conditions: [],
      },
    },
    quests: { "quest.missing-caravan": "offered" },
    relationships: {},
    autonomy: {},
    flags: {},
    ...overrides,
  };
}

/**
 * Every gateway call this run, by role — the observable for "did this click pay a model round-trip?".
 * Behaves exactly like the offline gateway otherwise, so the rest of the suite stays byte-stable.
 */
class RoleCountingGateway extends OfflineGateway {
  readonly calls: { role: LlmRole; prompt: string }[] = [];

  private record(role: LlmRole, req: CompletionRequest): void {
    this.calls.push({ role, prompt: req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "" });
  }
  override complete(role: LlmRole, req: CompletionRequest) {
    this.record(role, req);
    return super.complete(role, req);
  }
  override async *stream(role: LlmRole, req: CompletionRequest) {
    this.record(role, req);
    yield* super.stream(role, req);
  }
  /**
   * How many times the GM narration brief was streamed — the expensive call a mechanical click must
   * not pay. Keyed on `# NOW` (the ubiquity invariant: every assembled narrator brief carries it) so
   * other prose-role work in the same turn is not miscounted as the click's cost: the rolling
   * summarizer also rides the `narrator` role, and so does an NPC beat/reply.
   */
  narratorCalls(): number {
    return this.calls.filter((c) => c.role === "narrator" && c.prompt.includes(BRIEF_MARKERS.now)).length;
  }
}

async function makeActionEngine(
  opts: { seed?: number; state?: (p: PlaySet) => GameState; gateway?: LlmGateway } = {},
): Promise<{ engine: GameEngine; events: GameEvent[]; playset: PlaySet }> {
  const playset = tradePlayset(await loadExample());
  const store = new InMemoryGameStateStore();
  const state = (opts.state ?? seededState)(playset);
  await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), state);
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store,
    gateway: opts.gateway ?? new OfflineGateway(),
    rng: mulberry32(opts.seed ?? 7),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events, playset };
}

describe("submitAction — movement", () => {
  test("move to a real exit id relocates the whole party through the reducer", async () => {
    const { engine, events } = await makeActionEngine();
    expect(engine.getState().partyLocationId).toBe("loc.tavern");

    await engine.submitAction({ kind: "move", exitId: "loc.square" });

    expect(engine.getState().partyLocationId).toBe("loc.square");
    expect(engine.getState().actors[PC]!.locationId).toBe("loc.square");
    // The move landed as an authoritative state change (reducer-emitted), not just narration.
    expect(byKind(events, "stateChanged").some((e) => e.changes?.partyLocationId === "loc.square")).toBe(true);
  });

  test("move to a non-adjacent / unknown exit id is rejected — no throw, party stays put", async () => {
    const { engine } = await makeActionEngine();

    // A location id that is NOT an exit from the tavern: the movement resolver finds no route and
    // refuses (open-world reach only fires for a NAMED place, never a bare id), consuming no move.
    await expect(engine.submitAction({ kind: "move", exitId: "loc.nowhere" })).resolves.toBeUndefined();
    expect(engine.getState().partyLocationId).toBe("loc.tavern");
  });
});

describe("submitAction — items", () => {
  test("equip readies the item into its slot via the reducer", async () => {
    const { engine, events } = await makeActionEngine();
    // The starting kit is worn from turn one now (r5 P3), so clear the slot before re-equipping it.
    await engine.submitAction({ kind: "unequip", slot: "weapon" });
    expect(engine.getState().actors[PC]!.equipped?.weapon).toBeUndefined();

    await engine.submitAction({ kind: "equip", itemId: "weapon.longsword", slot: "weapon" });

    expect(engine.getState().actors[PC]!.equipped?.weapon).toBe("weapon.longsword");
    expect(byKind(events, "stateChanged").length).toBeGreaterThan(0);
  });

  test("unequip clears the slot the item occupies", async () => {
    const { engine } = await makeActionEngine();
    await engine.submitAction({ kind: "equip", itemId: "weapon.longsword", slot: "weapon" });
    expect(engine.getState().actors[PC]!.equipped?.weapon).toBe("weapon.longsword");

    await engine.submitAction({ kind: "unequip", slot: "weapon" });

    expect(engine.getState().actors[PC]!.equipped?.weapon).toBeUndefined();
  });

  test("an equip of an item the PC does not carry is rejected without throwing", async () => {
    const { engine } = await makeActionEngine();

    await expect(
      engine.submitAction({ kind: "equip", itemId: "weapon.warhammer", slot: "weapon" }),
    ).resolves.toBeUndefined();
    // The slot still holds what the character actually owns — never the uncarried hammer.
    expect(engine.getState().actors[PC]!.equipped?.weapon).toBe("weapon.longsword");
  });

  test("clothing updates the paper-doll wardrobe slice without consuming an item", async () => {
    const { engine, events } = await makeActionEngine();

    await engine.submitAction({ kind: "clothing", slotId: "upper", state: "removed" });

    const state = engine.getState();
    const wardrobe = state.modules?.wardrobe as Record<string, { upper?: string }> | undefined;
    expect(wardrobe?.[PC]?.upper).toBe("removed");
    expect(state.actors[PC]!.inventory).toContain(TRINKET);
    expect(byKind(events, "stateChanged").some((e) => e.changes?.wardrobe !== undefined)).toBe(true);
  });

  test("clothing is BLOCKED mid-combat (I9) — the no-turn doll toggle can't dodge the fight, notice emitted", async () => {
    const { engine, events } = await makeActionEngine({
      state: (p) =>
        seededState(p, {
          modules: { combat: { active: true, locationId: "loc.tavern", order: [PC], turnIndex: 0, round: 1 } },
        } as unknown as Partial<GameState>),
    });

    await engine.submitAction({ kind: "clothing", slotId: "upper", state: "removed" });

    // The wardrobe slice is untouched — the doll toggle did not apply (the typed strip path is the
    // in-fight route, and it spends the turn).
    const wardrobe = engine.getState().modules?.wardrobe as Record<string, { upper?: string }> | undefined;
    expect(wardrobe?.[PC]?.upper).toBeUndefined();
    // ...and the player is told why.
    expect(events.some((e) => e.kind === "system" && /blades are out/i.test(e.message ?? ""))).toBe(true);
  });

  test("clothing is blocked with a reason while captive (the former silent gate)", async () => {
    const { engine, events } = await makeActionEngine({
      state: (p) =>
        seededState(p, {
          modules: { captivity: { active: true } },
        }),
    });

    await engine.submitAction({ kind: "clothing", slotId: "upper", state: "removed" });

    const wardrobe = engine.getState().modules?.wardrobe as Record<string, { upper?: string }> | undefined;
    expect(wardrobe?.[PC]?.upper).toBeUndefined();
    expect(
      events.some((e) => e.kind === "system" && /held captive/i.test(e.message ?? "")),
    ).toBe(true);
  });

});

describe("submitAction — quests", () => {
  test("acceptQuest flips an offered quest to active through the reducer", async () => {
    const { engine, events } = await makeActionEngine();
    expect(engine.getState().quests["quest.missing-caravan"]).toBe("offered");

    await engine.submitAction({ kind: "acceptQuest", questId: "quest.missing-caravan" });

    expect(engine.getState().quests["quest.missing-caravan"]).toBe("active");
    expect(
      byKind(events, "stateChanged").some((e) => e.changes?.questState === "active"),
    ).toBe(true);
  });

  test("declineQuest withdraws an offered quest (back to hidden)", async () => {
    const { engine } = await makeActionEngine();

    await engine.submitAction({ kind: "declineQuest", questId: "quest.missing-caravan" });

    expect(engine.getState().quests["quest.missing-caravan"]).toBe("hidden");
  });

  test("accepting a quest that is not on offer is rejected without throwing", async () => {
    const { engine } = await makeActionEngine();
    // Consume the offer first, then try to accept the (now hidden) quest again.
    await engine.submitAction({ kind: "declineQuest", questId: "quest.missing-caravan" });

    await expect(
      engine.submitAction({ kind: "acceptQuest", questId: "quest.missing-caravan" }),
    ).resolves.toBeUndefined();
    expect(engine.getState().quests["quest.missing-caravan"]).toBe("hidden");
  });
});

describe("submitAction — trade (atomic tradeWith)", () => {
  test("buy moves the item to the PC and debits the exact price", async () => {
    const { engine } = await makeActionEngine();
    expect(engine.getState().actors[PC]!.coins).toBe(500);

    await engine.submitAction({ kind: "trade", direction: "buy", itemId: TRINKET, vendorId: VENDOR });

    const pc = engine.getState().actors[PC]!;
    const vendor = engine.getState().actors[VENDOR]!;
    // Item crossed the counter to the PC (the PC now holds TWO — the seeded one + the bought one),
    // the vendor's stock is emptied, and coins dropped by exactly the buy price.
    expect(pc.inventory.filter((i) => i === TRINKET)).toHaveLength(2);
    expect(vendor.inventory).not.toContain(TRINKET);
    expect(pc.coins).toBe(500 - TRINKET_BUY);
  });

  test("sell moves the item to the vendor and credits half the price", async () => {
    const { engine } = await makeActionEngine();

    await engine.submitAction({ kind: "trade", direction: "sell", itemId: TRINKET, vendorId: VENDOR });

    const pc = engine.getState().actors[PC]!;
    const vendor = engine.getState().actors[VENDOR]!;
    expect(pc.inventory).not.toContain(TRINKET); // the PC's only trinket left their pack
    expect(vendor.inventory.filter((i) => i === TRINKET)).toHaveLength(2); // vendor's stock grew
    expect(pc.coins).toBe(500 + TRINKET_SELL);
  });

  test("a buy the PC cannot afford is atomic-or-nothing: no item, no coins move", async () => {
    const { engine } = await makeActionEngine({
      state: (p) => seededState(p, { actors: { ...seededState(p).actors, [PC]: { ...seededState(p).actors[PC]!, coins: 10 } } }),
    });
    expect(engine.getState().actors[PC]!.coins).toBe(10);

    await expect(
      engine.submitAction({ kind: "trade", direction: "buy", itemId: TRINKET, vendorId: VENDOR }),
    ).resolves.toBeUndefined();

    const pc = engine.getState().actors[PC]!;
    const vendor = engine.getState().actors[VENDOR]!;
    expect(pc.coins).toBe(10); // untouched
    expect(pc.inventory.filter((i) => i === TRINKET)).toHaveLength(1); // still just the seeded one
    expect(vendor.inventory).toContain(TRINKET); // stock untouched
  });
});

describe("submitAction — mechanical clicks cost NO narrator call", () => {
  // Live 07-24: a typed equip/buy/sell action paid one full streamed narrator round-trip (60-120s on a
  // reasoning model) just to re-say a line the resolver had already written as finished prose. The
  // four bookkeeping successes are now `deterministic`, so NarrationModule emits them verbatim.
  test("an equip action issues ZERO narrator-role gateway calls and emits the resolver's line verbatim", async () => {
    const gateway = new RoleCountingGateway();
    const { engine, events } = await makeActionEngine({ gateway });
    // The starting kit is already worn (r5 P3) — stow it first so this measures a real equip action.
    await engine.submitAction({ kind: "unequip", slot: "weapon" });
    gateway.calls.length = 0; // ignore whatever start-up narration cost
    events.length = 0;

    await engine.submitAction({ kind: "equip", itemId: "weapon.longsword", slot: "weapon" });

    expect(gateway.narratorCalls()).toBe(0);
    expect(engine.getState().actors[PC]!.equipped?.weapon).toBe("weapon.longsword");
    expect(byKind(events, "narration").map((e) => e.text)).toEqual(["You ready the Longsword for use."]);
  });

  test("an unequip action is free too", async () => {
    const gateway = new RoleCountingGateway();
    const { engine, events } = await makeActionEngine({ gateway });
    await engine.submitAction({ kind: "equip", itemId: "weapon.longsword", slot: "weapon" });
    events.length = 0;
    gateway.calls.length = 0;

    await engine.submitAction({ kind: "unequip", slot: "weapon" });

    expect(gateway.narratorCalls()).toBe(0);
    expect(byKind(events, "narration").map((e) => e.text)).toEqual(["You stow the Longsword."]);
  });

  test("buy and sell narrate the resolver's own line BYTE-for-byte (the model never rewrites a receipt)", async () => {
    const gateway = new RoleCountingGateway();
    const { engine, events } = await makeActionEngine({ gateway });
    gateway.calls.length = 0;

    await engine.submitAction({ kind: "trade", direction: "buy", itemId: TRINKET, vendorId: VENDOR });
    // 100 cp = "1 gp" — item, vendor and price exactly as `resolveTrade` composed them.
    expect(byKind(events, "narration").map((e) => e.text)).toEqual([
      "You buy the Brass Trinket from Merchant for 1 gp.",
    ]);

    events.length = 0;
    await engine.submitAction({ kind: "trade", direction: "sell", itemId: TRINKET, vendorId: VENDOR });
    // 50 cp = "5 sp".
    expect(byKind(events, "narration").map((e) => e.text)).toEqual([
      "You sell the Brass Trinket to Merchant for 5 sp.",
    ]);

    expect(gateway.narratorCalls()).toBe(0);
  });
});

describe("submitAction — a long rest advances the DAY", () => {
  test("End Day (after making camp) crosses a day boundary (the day counter rolls over)", async () => {
    // Start mid-morning of day 1 (clock 600 → day = floor(600/1440)+1 = 1).
    const { engine } = await makeActionEngine({
      state: (p) => seededState(p, { clock: 600 }),
    });
    const before = engine.getState().clock;
    expect(Math.floor(before / 1440) + 1).toBe(1);

    // The long rest is two grounded actions: make camp (time frozen), then End Day (advances the day).
    await engine.submitAction({ kind: "enterCamp" });
    await engine.submitAction({ kind: "endDay" });

    const after = engine.getState().clock;
    // The clock is absolute monotonic minutes; End Day advances to the next day's wake hour, so the
    // derived day counter (floor(clock/1440)+1) is now day 2.
    expect(after).toBeGreaterThan(before);
    expect(Math.floor(after / 1440) + 1).toBe(2);
  });

  test("restAdvanceMinutes always lands on a wake hour (07:00 = 420) — and never skips a day", () => {
    // From a WAKING hour, resting reaches minute 420 of the FOLLOWING day.
    expect(600 + restAdvanceMinutes(600)).toBe(1440 + 420); // day-1 10:00 → day-2 07:00
    // Resting AT/AFTER the wake hour still crosses exactly one midnight (never a ~0-minute skip).
    expect(Math.floor((500 + restAdvanceMinutes(500)) / 1440)).toBe(1);
    for (const clock of [420, 421, 1000, 1439, 1440 + 600, 5000]) {
      const next = clock + restAdvanceMinutes(clock);
      expect(next % 1440).toBe(420); // always wakes at 07:00
      expect(Math.floor(next / 1440)).toBe(Math.floor(clock / 1440) + 1); // exactly one day later
    }
    // From the SMALL HOURS the night ends at THIS day's dawn: turning in at 01:00 is one night's
    // sleep, not thirty hours (r5 P2 — the old unconditional +1 day ate a day and the quest
    // deadline riding on it).
    expect(restAdvanceMinutes(0)).toBe(420); // day-1 00:00 → day-1 07:00
    expect(1440 + 60 + restAdvanceMinutes(1440 + 60)).toBe(1440 + 420); // day-2 01:00 → day-2 07:00
    for (const clock of [0, 60, 300, 419, 1440, 1440 + 419]) {
      const next = clock + restAdvanceMinutes(clock);
      expect(next % 1440).toBe(420); // still the wake hour
      expect(Math.floor(next / 1440)).toBe(Math.floor(clock / 1440)); // the same day, at dawn
    }
  });
});

describe("tradeWith reducer — atomic + replay-safe", () => {
  /** A fresh model seeded from a started engine (PC with coins + trinket, merchant with a trinket). */
  async function tradeModel(): Promise<{ model: WorldModel; playset: PlaySet }> {
    const playset = tradePlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), seededState(playset));
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await engine.start();
    return { model: fromGameState(engine.getState(), playset.world, playset.campaign), playset };
  }

  const stamp = (pre: EmittedDelta, seq: number): DeltaEvent =>
    ({ ...pre, id: `d${seq}`, at: 0, seq }) as DeltaEvent;

  test("a buy is snapshot == fold(deltas): folding the emitted deltas reproduces the live state", async () => {
    const { model, playset } = await tradeModel();
    const seed = fromGameState(toGameState(model), playset.world, playset.campaign);

    const res = applyCommand(model, {
      type: "tradeWith",
      pcId: PC,
      vendorId: VENDOR,
      itemId: TRINKET,
      direction: "buy",
      priceCp: TRINKET_BUY,
    });
    expect(res.mutated).toBe(true);
    expect(res.rejected).toBeUndefined();

    // Fold the emitted deltas onto the pre-command seed and compare the observable slices.
    const folded = reduceDeltas(seed, res.deltas.map((d, i) => stamp(d, i)));
    const live = model.entities.get(PC)!.stats!;
    const rebuilt = folded.entities.get(PC)!.stats!;
    expect(rebuilt.coins).toBe(live.coins);
    expect(rebuilt.coins).toBe(500 - TRINKET_BUY);
    expect([...rebuilt.inventory].sort()).toEqual([...live.inventory].sort());
    expect(folded.entities.get(VENDOR)!.stats!.inventory).toEqual(model.entities.get(VENDOR)!.stats!.inventory);
  });

  test("a sell is snapshot == fold(deltas)", async () => {
    const { model, playset } = await tradeModel();
    const seed = fromGameState(toGameState(model), playset.world, playset.campaign);

    const res = applyCommand(model, {
      type: "tradeWith",
      pcId: PC,
      vendorId: VENDOR,
      itemId: TRINKET,
      direction: "sell",
      priceCp: TRINKET_SELL,
    });
    expect(res.mutated).toBe(true);

    const folded = reduceDeltas(seed, res.deltas.map((d, i) => stamp(d, i)));
    expect(folded.entities.get(PC)!.stats!.coins).toBe(model.entities.get(PC)!.stats!.coins);
    expect(folded.entities.get(PC)!.stats!.coins).toBe(500 + TRINKET_SELL);
    expect([...folded.entities.get(VENDOR)!.stats!.inventory].sort()).toEqual(
      [...model.entities.get(VENDOR)!.stats!.inventory].sort(),
    );
  });

  test("an unaffordable buy rejects atomically: no mutation, no deltas", async () => {
    const { model } = await tradeModel();
    model.entities.get(PC)!.stats!.coins = 5; // less than TRINKET_BUY

    const res = applyCommand(model, {
      type: "tradeWith",
      pcId: PC,
      vendorId: VENDOR,
      itemId: TRINKET,
      direction: "buy",
      priceCp: TRINKET_BUY,
    });
    expect(res.mutated).toBe(false);
    expect(res.deltas).toHaveLength(0);
    expect(res.rejected?.reason).toMatch(/afford/);
    expect(model.entities.get(PC)!.stats!.coins).toBe(5); // untouched
    expect(model.entities.get(VENDOR)!.stats!.inventory).toContain(TRINKET); // stock untouched
  });

  test("selling an item the PC does not hold rejects atomically", async () => {
    const { model } = await tradeModel();
    // Strip the trinket from the PC first.
    model.entities.get(PC)!.stats!.inventory = model.entities.get(PC)!.stats!.inventory.filter((i) => i !== TRINKET);

    const res = applyCommand(model, {
      type: "tradeWith",
      pcId: PC,
      vendorId: VENDOR,
      itemId: TRINKET,
      direction: "sell",
      priceCp: TRINKET_SELL,
    });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toMatch(/does not hold/);
    expect(model.entities.get(PC)!.stats!.coins).toBe(500); // no credit for a phantom sale
  });
});
