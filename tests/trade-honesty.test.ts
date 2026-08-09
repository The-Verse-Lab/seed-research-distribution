/**
 * Trade honesty + ambient coin-gift phrasing — engine-level regressions from the r4 live wave.
 *
 * r4-C: with no merchant present, a "buy a dagger" fell to freeform and the narrator invented a
 * vendor, then asserted the completed deal against the sheet. The kind now SURVIVES ungrounded and
 * the engine answers with a deterministic honest refusal that applies nothing.
 *
 * r4-B: "I give one copper to the beggar" moved no coins — the gift matcher only knew the literal
 * word "coin(s)", not a counted bare denomination. The counted form now deducts; uncounted metal
 * mentions ("a copper kettle") still never read as money.
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

function seededState(playset: PlaySet, coins = 100): GameState {
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
        inventory: [],
        conditions: [],
        coins,
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

async function makeEngine(
  classifier: TurnClassifier,
  mutatePlayset?: (playset: PlaySet) => void,
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  mutatePlayset?.(playset);
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), seededState(playset));
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

describe("trade honesty (kind survives ungrounded)", () => {
  test("no merchant present: deterministic refusal, nothing applied, no fabricated deal", async () => {
    const { engine, events } = await makeEngine(planClassifier({ kind: "trade" }));
    await engine.submitPlayerInput("I buy a dagger from a vendor");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("no merchant is at hand here");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    expect(engine.getState().actors["pc.you"]?.inventory).toHaveLength(0);
  });

  test("a present vendor with a vague offer is acknowledged — never 'no merchant here'", async () => {
    // The prompt allows a null itemId (and a hallucinated vendorId drops the payload) even when a
    // real stall stands in the room — the refusal must not lie about the merchant's existence.
    const { engine, events } = await makeEngine(planClassifier({ kind: "trade" }), (playset) => {
      const brann = playset.world.npcs.find((n) => n.id === "npc.brann")!;
      brann.vendor = { priceModifier: 1 };
      brann.stats = {
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 12, cha: 12 },
        maxHp: 8,
        armorClass: 10,
        level: 1,
        speed: 30,
        proficiencies: [],
        spells: [],
      };
    });
    await engine.submitPlayerInput("I buy something useful");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("Brann");
    expect(prose).not.toContain("no merchant is at hand");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });

  test("a vendor id that matches no present entity refuses honestly too", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({ kind: "trade", trade: { direction: "buy", itemId: "weapon.dagger", vendorId: "npc.ghost-vendor" } }),
    );
    await engine.submitPlayerInput("I buy a dagger");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("no one here to trade with");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });
});

describe("ambient coin gift — counted bare denominations (r4-B)", () => {
  test("'I give one copper to the beggar' deducts exactly 1 copper", async () => {
    const { engine, events } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I give one copper from my wage to the beggar I met this morning.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(99);
    const beat = byKind(events, "stateChanged").find((e) => e.summary?.includes("give away"));
    expect(beat?.summary).toContain("1 copper");
  });

  test("'I toss her two silvers' deducts 20 copper", async () => {
    const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I toss her two silvers for the trouble.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(80);
  });

  test("an uncounted metal mention never reads as money", async () => {
    const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I drop a copper kettle on the counter and give it a polish.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });

  test("a counted metal ADJECTIVE never reads as money either", async () => {
    // "two silver rings" / "one copper kettle": the count is present but the denomination
    // modifies a following noun — deducting here would mint a phantom loss on a gift of goods.
    const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I toss her two silver rings from the hoard.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    await engine.submitPlayerInput("I give one copper kettle to the tinker.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });

  test("'three silver pieces' still reads as money (money noun after the denomination)", async () => {
    const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I hand the ferryman three silver pieces.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(70);
  });

  test("PAYING a counter is paying: 'I count five silver onto the counter' really costs five silver", async () => {
    // r5 P2, verbatim: the salvage clerk demanded "five silver, nonrefundable, payable now", the
    // player counted it out, she wrote the contract — and the purse read 15 gp before and after.
    const { engine, events } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I count five silver onto the counter and wait for the writ.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(50);
    expect(byKind(events, "stateChanged").find((e) => e.summary?.includes("give away"))?.summary).toContain(
      "5 silver",
    );
  });

  test("the other counter verbs pay too — lay, set, push, pay", async () => {
    for (const line of [
      "I lay two silver on the boards between us.",
      "I set two silver down where she can see it.",
      "I push two silver across the counter.",
      "I pay her two silver for the room.",
    ]) {
      const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
      await engine.submitPlayerInput(line);
      expect(engine.getState().actors["pc.you"]?.coins).toBe(80);
    }
  });

  test("the new verbs do not turn goods into money", async () => {
    const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I set the silver ring on the counter and push it toward her.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    await engine.submitPlayerInput("I lay two silver rings out beside the lamp.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });

  test("the 'no coin' negation still refuses the deduction", async () => {
    const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I offer a steady hand, no coin required — just point me at honest trouble.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });
});

describe("ambient coin gift — a priced purchase is atomic (r15 fixture-trade t3)", () => {
  // The live repro: the classifier read "I'll take the spear for 1 gold—count out 100 coppers. Then
  // I'll sell this club; what do you give me?" as freeformNarrative (two halves, confidence 0.4), the
  // ambient rescue matched "count out 100 coppers", and 100 cp left the purse for a spear that never
  // transferred. The player sold their club two turns later and fought the remaining fourteen turns
  // of the sweep resolving every swing as `Unarmed Strike` — the fight was still live at the cap.
  test("'I'll take the spear for 1 gold — count out 100 coppers' charges NOTHING", async () => {
    const { engine, events } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput(
      "I’ll take the spear for 1 gold—count out 100 coppers. Then I’ll sell this club; what do you give me?",
    );
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "stateChanged").some((e) => e.summary?.includes("give away"))).toBe(false);
  });

  test("the refusal ships a receipt — it is never a silent nothing-happened turn", async () => {
    const { engine, events } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
    await engine.submitPlayerInput("I'll purchase the lantern for five silver and count out five silver on the counter.");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    const receipt = byKind(events, "stateChanged").find((e) => e.summary?.includes("No deal closes"));
    expect(receipt).toBeDefined();
    expect(receipt?.quiet).toBeFalsy();
  });

  test("a bare payment is NOT a purchase — the counter verbs still pay", async () => {
    // The guard needs an acquisition verb AND a price clause. "Pay X for the room" names a service,
    // "hand the ferryman three silver" names no goods at all: both must keep the r5 P2 / r6 contract.
    for (const [line, left] of [
      ["I pay her two silver for the room.", 80],
      ["I hand the ferryman three silver pieces for the crossing.", 70],
      ["I count five silver onto the counter and wait for the writ.", 50],
    ] as const) {
      const { engine } = await makeEngine(planClassifier({ kind: "freeformNarrative" }));
      await engine.submitPlayerInput(line);
      expect(engine.getState().actors["pc.you"]?.coins).toBe(left);
    }
  });

  test("a purchase whose GOODS grounded is a completed exchange — and still pays", async () => {
    const { engine } = await makeEngine(
      planClassifier({
        kind: "freeformNarrative",
        effects: [
          { type: "acceptItem", amountCp: null, itemId: "weapon.dagger", toNpcId: "npc.brann" },
        ],
      }),
      (playset) => {
        playset.world.npcs.find((n) => n.id === "npc.brann")!.inventory = ["weapon.dagger"];
      },
    );
    await engine.submitPlayerInput("I’ll take the dagger for one silver, and count out one silver onto the boards.");
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("weapon.dagger");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(90);
  });
});
