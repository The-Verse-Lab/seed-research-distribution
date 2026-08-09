/**
 * Verbally-offered goods mint stock — PROSE-TO-CODE §2.1.
 *
 * The seam: an NPC's own dialogue prices a ware ("this lantern's five gold") and the trade path,
 * which only ever matched authored inventory, answered with the r7 diegetic refusal. The fiction
 * asserted something the mechanics would not honour.
 *
 * The closure, exercised end to end here: the NPC agent SELF-REPORTS the offer as structured JSON
 * (never a regex over its prose), the reducer records it into the `pendingOffers` slice, and the
 * trade resolver's miss-path cashes it — at the vendor's OWN quoted price, through the same
 * `tradeWith` command a catalogue sale runs, so coins/receipts/dedup behave identically.
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
import { buildClassifyUserMessage, type TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { byKind, loadExample } from "./support/harness.ts";
import { parseNpcTurnIntent } from "../src/agents/npc.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { itemIdByName, itemRefMatchesStrongly, sceneItemIdFor } from "../src/rules/items.ts";
import {
  dropOffer,
  liveOffersFor,
  MAX_OFFERS_PER_NPC,
  offersPatch,
  OFFER_TTL_MINUTES,
  PENDING_OFFERS_MODULE,
  pushOffers,
  readOffers,
  type PendingOffer,
} from "../src/rules/pending-offers.ts";

const baseCheck = { warranted: false as const, ability: null, skill: null, dc: null, reason: "" };

/** A classifier stub that returns a fixed, already-reconciled plan (the trade-honesty pattern). */
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

const offer = (over: Partial<PendingOffer> = {}): PendingOffer => ({
  name: "salt-iron vest",
  priceCp: 800,
  locationId: "loc.tavern",
  atClock: 0,
  ...over,
});

function seededState(playset: PlaySet, coins: number, offers: PendingOffer[]): GameState {
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
    modules: { [PENDING_OFFERS_MODULE]: { "npc.brann": offers } },
  };
}

/** Brann behind the counter with an empty stall — every purchase here has to come from an offer. */
function makeVendor(playset: PlaySet): void {
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
}

async function makeEngine(
  itemAsk: string,
  opts: { coins?: number; offers?: PendingOffer[]; quantity?: number } = {},
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  makeVendor(playset);
  const store = new InMemoryGameStateStore();
  await store.save(
    makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]),
    seededState(playset, opts.coins ?? 1000, opts.offers ?? [offer()]),
  );
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
    classifier: planClassifier({
      kind: "trade",
      trade: {
        direction: "buy",
        itemId: itemAsk,
        vendorId: "npc.brann",
        ...(opts.quantity ? { quantity: opts.quantity } : {}),
      },
    } as Partial<TurnPlan> & { kind: TurnPlan["kind"] }),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("pendingOffers slice (the math leaf)", () => {
  test("push is bounded per NPC, oldest first out", () => {
    const modules: Record<string, unknown> = {};
    let list: PendingOffer[] = [];
    for (let i = 0; i < MAX_OFFERS_PER_NPC + 2; i++) {
      list = pushOffers(modules, "npc.veil", [offer({ name: `ware ${i}` })]);
      modules[PENDING_OFFERS_MODULE] = { "npc.veil": list };
    }
    expect(list).toHaveLength(MAX_OFFERS_PER_NPC);
    expect(list[0]!.name).toBe("ware 2");
    expect(list.at(-1)!.name).toBe(`ware ${MAX_OFFERS_PER_NPC + 1}`);
  });

  test("a re-quote replaces the older row rather than stacking a second lantern", () => {
    const modules: Record<string, unknown> = {
      [PENDING_OFFERS_MODULE]: { "npc.veil": [offer({ name: "Brass Lantern", priceCp: 500 })] },
    };
    const next = pushOffers(modules, "npc.veil", [offer({ name: "brass  lantern", priceCp: 400 })]);
    expect(next).toHaveLength(1);
    expect(next[0]!.priceCp).toBe(400);
  });

  test("readOffers hands back COPIES — a caller cannot dirty the slice", () => {
    const stored = [offer()];
    const modules: Record<string, unknown> = { [PENDING_OFFERS_MODULE]: { "npc.veil": stored } };
    const read = readOffers(modules, "npc.veil");
    read[0]!.priceCp = 1;
    expect(stored[0]!.priceCp).toBe(800);
  });

  test("malformed rows are dropped, never trusted", () => {
    const modules: Record<string, unknown> = {
      [PENDING_OFFERS_MODULE]: {
        "npc.veil": [{ name: "", priceCp: 5, locationId: "l", atClock: 0 }, { name: "x", priceCp: 0, locationId: "l", atClock: 0 }, offer()],
      },
    };
    expect(readOffers(modules, "npc.veil")).toHaveLength(1);
  });

  test("an offer is live only where it was spoken, and only inside the TTL", () => {
    const modules: Record<string, unknown> = { [PENDING_OFFERS_MODULE]: { "npc.veil": [offer({ atClock: 100 })] } };
    expect(liveOffersFor(modules, "npc.veil", "loc.tavern", 120)).toHaveLength(1);
    expect(liveOffersFor(modules, "npc.veil", "loc.road", 120)).toHaveLength(0);
    expect(liveOffersFor(modules, "npc.veil", "loc.tavern", 100 + OFFER_TTL_MINUTES + 1)).toHaveLength(0);
  });

  test("dropOffer removes exactly the cashed quote", () => {
    const a = offer({ name: "vest", atClock: 10 });
    const b = offer({ name: "lantern", atClock: 20 });
    const modules: Record<string, unknown> = { [PENDING_OFFERS_MODULE]: { "npc.veil": [a, b] } };
    expect(dropOffer(modules, "npc.veil", a).map((o) => o.name)).toEqual(["lantern"]);
  });

  test("offersPatch stamps place + clock and targets the right slice", () => {
    const patch = offersPatch({}, "npc.veil", [{ name: "vest", priceCp: 800 }], "loc.tavern", 640);
    expect(patch.module).toBe(PENDING_OFFERS_MODULE);
    const rows = (patch.patch["npc.veil"] as PendingOffer[])!;
    expect(rows[0]).toEqual({ name: "vest", priceCp: 800, locationId: "loc.tavern", atClock: 640 });
  });
});

describe("offer self-report parsing (structured, never extracted from prose)", () => {
  test("a well-formed offer survives the reply JSON", () => {
    const parsed = parseNpcTurnIntent(
      `{"speech":[{"say":"Five gold for the lantern.","mood":"neutral"}],"offers":[{"name":"brass lantern","priceCp":500}]}`,
    );
    expect(parsed?.offers).toEqual([{ name: "brass lantern", priceCp: 500 }]);
  });

  test("rows missing a name or a price are dropped; the cap holds at three", () => {
    const parsed = parseNpcTurnIntent(
      `{"speech":[],"offers":[{"name":"a"},{"priceCp":5},{"name":"b","priceCp":0},{"name":"c","priceCp":10},` +
        `{"name":"d","priceCp":20},{"name":"e","priceCp":30},{"name":"f","priceCp":40}]}`,
    );
    expect(parsed?.offers?.map((o) => o.name)).toEqual(["c", "d", "e"]);
  });

  test("no offers field ⇒ nothing recorded (byte-identical to before the field existed)", () => {
    expect(parseNpcTurnIntent(`{"speech":[{"say":"Nothing for sale.","mood":"cold"}]}`)?.offers).toBeUndefined();
  });
});

describe("spoken-name → catalogue id (strict)", () => {
  test("a specific ask resolves to the SRD row that contains every one of its words", () => {
    expect(itemIdByName("hooded lantern", { items: [] })).toBe("item.lantern-hooded");
  });

  test("an ambiguous ask resolves to nothing rather than the wrong lantern", () => {
    expect(itemIdByName("lantern", { items: [] })).toBeNull();
  });

  test("an ask MORE specific than the catalogue mints instead of demoting to the generic row", () => {
    expect(itemIdByName("salt-iron vest", { items: [] })).toBeNull();
    expect(sceneItemIdFor("salt-iron vest")).toBe("item.salt-iron-vest");
  });
});

describe("capture — an NPC's own reply binds the offer", () => {
  /** Answers any NPC reply (the `# DIRECT ADDRESS` brief) with scripted intent JSON; else offline. */
  class OfferingGateway implements LlmGateway {
    private readonly inner = new OfflineGateway();
    constructor(private readonly json: string) {}
    complete(role: LlmRole, req: CompletionRequest) {
      return this.inner.complete(role, req);
    }
    async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
      const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user");
      if (role === "narrator" && user?.content.includes(BRIEF_MARKERS.directAddress)) {
        yield { delta: this.json, done: true };
        return;
      }
      yield* this.inner.stream(role, req);
    }
    embed(role: LlmRole, texts: string[]) {
      return this.inner.embed(role, texts);
    }
  }

  async function askBrann(json: string): Promise<GameEngine> {
    const playset = await loadExample();
    makeVendor(playset);
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfferingGateway(json),
    });
    await engine.start();
    await engine.submitPlayerInput("Brann, what will you sell me?");
    return engine;
  }

  test("a priced ware in the reply lands in the slice, stamped with this place and clock", async () => {
    const engine = await askBrann(
      `{"speech":[{"say":"Salt-iron vest, eight gold, and it's yours.","mood":"neutral"}],` +
        `"offers":[{"name":"salt-iron vest","priceCp":800}]}`,
    );
    const recorded = readOffers(engine.getState().modules ?? {}, "npc.brann");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ name: "salt-iron vest", priceCp: 800, locationId: "loc.tavern" });
    // Persisted like every other module slice — a reload does not forget the price he named.
    expect((engine.getState().modules?.[PENDING_OFFERS_MODULE] as Record<string, unknown>)?.["npc.brann"]).toBeDefined();
  });

  test("a reply that prices nothing writes no slice at all", async () => {
    const engine = await askBrann(`{"speech":[{"say":"Nothing's for sale tonight.","mood":"cold"}]}`);
    expect(readOffers(engine.getState().modules ?? {}, "npc.brann")).toHaveLength(0);
  });
});

describe("a live offer is grounding fodder for the classifier", () => {
  test("the vendor line carries what they priced aloud, name and price", () => {
    const msg = buildClassifyUserMessage("I'll take the cloak", {
      playerActorId: "pc.you",
      locationId: "loc.tavern",
      locationName: "Tavern",
      exits: [],
      presentEntities: [{ id: "npc.brann", name: "Brann" }],
      companionIds: [],
      carriedItems: [],
      vendors: [
        {
          id: "npc.brann",
          name: "Brann",
          stock: [{ id: "apparel.shirt", name: "Shirt" }],
          offers: [{ name: "oiled wool cloak", priceCp: 50 }],
        },
      ],
    });
    expect(msg).toContain(`offered aloud ["oiled wool cloak" (50cp)]`);
  });

  test("a vendor with no live offer renders the line exactly as before", () => {
    const base = {
      playerActorId: "pc.you",
      locationId: "loc.tavern",
      locationName: "Tavern",
      exits: [],
      presentEntities: [],
      companionIds: [],
      carriedItems: [],
      vendors: [{ id: "npc.brann", name: "Brann", stock: [{ id: "apparel.shirt", name: "Shirt" }] }],
    };
    expect(buildClassifyUserMessage("hello", base)).toContain("VENDORS: npc.brann=Brann stocking [apparel.shirt=Shirt]\n");
  });
});

describe("a spoken quote outranks a weak shelf match", () => {
  test("strong matches are spelling variants, never neighbours", () => {
    const world = { items: [] };
    expect(itemRefMatchesStrongly("item.water-skin", "item.waterskin", world)).toBe(true);
    expect(itemRefMatchesStrongly("two torches", "item.torch", world)).toBe(true);
    expect(itemRefMatchesStrongly("oiled wool cloak", "apparel.wool-shirt", world)).toBe(false);
  });
});

describe("the counter honours what the vendor said (§2.1)", () => {
  test("a ware no catalogue knows is minted, sold at the QUOTED price, and lands in the pack", async () => {
    const { engine, events } = await makeEngine("salt-iron vest");
    await engine.submitPlayerInput("I'll take the salt-iron vest");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("Salt Iron Vest");
    expect(prose).not.toContain("spoken for");
    const pc = engine.getState().actors["pc.you"]!;
    expect(pc.coins).toBe(200); // 1000 − the vendor's own 800cp quote, not a masterlist price
    expect(pc.inventory).toContain("item.salt-iron-vest");
  });

  // Which honest refusal fires is a pre-existing distinction this wave leaves alone: a ware NO
  // catalogue knows gets "they deal in nothing by that name", a catalogued ware the vendor simply
  // does not stock gets the r7 "spoken for". Both apply nothing.
  const REFUSED = "deal in nothing by that name";

  test("the quote is SPENT — the same sentence cannot be cashed twice", async () => {
    const { engine, events } = await makeEngine("salt-iron vest");
    await engine.submitPlayerInput("I'll take the salt-iron vest");
    events.length = 0;
    await engine.submitPlayerInput("I'll take another salt-iron vest");
    expect(byKind(events, "narration").at(-1)?.text ?? "").toContain(REFUSED);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(200);
    expect(engine.getState().actors["pc.you"]?.inventory.filter((i) => i === "item.salt-iron-vest")).toHaveLength(1);
  });

  test("a catalogued ware the vendor never offered still gets the r7 diegetic refusal", async () => {
    const { engine, events } = await makeEngine("weapon.dagger");
    await engine.submitPlayerInput("I'll buy a dagger");
    expect(byKind(events, "narration").at(-1)?.text ?? "").toContain("spoken for");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(1000);
  });

  test("an offered ware the SRD does know resolves to the real row", async () => {
    const { engine } = await makeEngine("hooded lantern", {
      offers: [offer({ name: "hooded lantern", priceCp: 300 })],
    });
    await engine.submitPlayerInput("I'll take the hooded lantern");
    const pc = engine.getState().actors["pc.you"]!;
    expect(pc.inventory).toContain("item.lantern-hooded");
    expect(pc.coins).toBe(700); // the quoted 300, NOT the masterlist's 500
  });

  test("an offer from another place does not follow the player — the refusal stands", async () => {
    const { engine, events } = await makeEngine("salt-iron vest", {
      offers: [offer({ locationId: "loc.road" })],
    });
    await engine.submitPlayerInput("I'll take the salt-iron vest");
    expect(byKind(events, "narration").at(-1)?.text ?? "").toContain(REFUSED);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(1000);
    expect(engine.getState().actors["pc.you"]?.inventory).toHaveLength(0);
  });

  test("a shared adjective is not a match — 'iron shortsword' cannot cash a 'salt-iron vest'", async () => {
    const { engine, events } = await makeEngine("iron shortsword");
    await engine.submitPlayerInput("I'll buy an iron shortsword");
    expect(byKind(events, "narration").at(-1)?.text ?? "").toContain(REFUSED);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(1000);
    expect(engine.getState().actors["pc.you"]?.inventory).toHaveLength(0);
  });

  test("a shorter ask for the same thing DOES cash it — 'the vest'", async () => {
    const { engine } = await makeEngine("vest");
    await engine.submitPlayerInput("I'll take the vest");
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.salt-iron-vest");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(200);
  });

  test("a purchase the purse cannot close mints NOTHING — atomic or nothing", async () => {
    const { engine, events } = await makeEngine("salt-iron vest", { coins: 100 });
    await engine.submitPlayerInput("I'll take the salt-iron vest");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("not enough");
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    // The offer is untouched, so paying later still works.
    expect(readOffers(engine.getState().modules ?? {}, "npc.brann")).toHaveLength(1);
  });

  test("one offered lantern is one lantern — a multi-buy cannot multiply the fiction", async () => {
    const { engine } = await makeEngine("salt-iron vest", { quantity: 3 });
    await engine.submitPlayerInput("I'll take three salt-iron vests");
    const pc = engine.getState().actors["pc.you"]!;
    expect(pc.inventory.filter((i) => i === "item.salt-iron-vest")).toHaveLength(1);
    expect(pc.coins).toBe(200);
  });

  test("the offered sale rides the normal receipt machinery (quiet stateChanged + dealings ledger)", async () => {
    const { engine, events } = await makeEngine("salt-iron vest");
    await engine.submitPlayerInput("I'll take the salt-iron vest");
    const receipt = byKind(events, "stateChanged").find((e) => e.summary.startsWith("You buy "));
    expect(receipt?.quiet).toBe(true);
    expect(receipt?.changes).toMatchObject({ itemId: "item.salt-iron-vest", vendorId: "npc.brann", priceCp: 800 });
    expect(byKind(events, "itemTransferred").some((e) => e.to === "pc.you")).toBe(true);
  });
});
