/**
 * Category asks at a vendor counter — engine-level regressions from playtest r13 (fixture-trade).
 *
 * The r13 sweep's driver asked for weapons five distinct ways ("best blade", "blades or axes",
 * "a cudgel", "ash cudgel", "your cheapest weapon") at a vendor whose DATA stocked three
 * affordable weapons, and got the same head-shake refusal every time: category words share no
 * token with any SRD weapon name, and the browse cap's dead "and more besides" tail made the
 * eight-mundane-ware counter claim completeness. Sixteen turns, 150 cp untouched, a 1 gp spear
 * on the shelf throughout — the state-inert stretch the rubric flagged.
 *
 * The fix is QUOTE-ONLY: a category ask answers with the kind-filtered counter (cheapest first)
 * and moves nothing, on the inquiry path or off it — the r10 F-2 (a question is answered, never
 * executed) and F-3 (no uncorroborated substitution) contracts must hold throughout.
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
import { wareKindAskOf } from "../src/rules/items.ts";
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
        coins: 150,
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

/**
 * A regression vendor's authored stock: eight distinct mundane wares first, then the
 * steel — so the browse cap lands exactly on the mundane/weapon boundary, the shape that hid the
 * spear in r13. The fix must work against this ordering, not a reordered convenience.
 */
const VEIL_SHAPED_STOCK = [
  "apparel.shirt",
  "apparel.trousers",
  "apparel.boots",
  "apparel.vest",
  "item.rations",
  "item.rations",
  "item.waterskin",
  "item.lantern-hooded",
  "item.oil-flask",
  "weapon.spear",
  "weapon.dagger",
  "weapon.shortsword",
  "armor.leather",
];

async function makeEngine(
  classifier: TurnClassifier,
  stock: string[] = VEIL_SHAPED_STOCK,
  carried: string[] = [],
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  const brann = playset.world.npcs.find((n) => n.id === "npc.brann")! as unknown as Record<string, unknown>;
  brann.vendor = { priceModifier: 1 };
  brann.inventory = stock;
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

const askWeapons = (itemWords: string, extras: Record<string, unknown> = {}) =>
  planClassifier({
    kind: "trade",
    trade: {
      direction: "buy",
      itemId: null,
      vendorId: "npc.brann",
      inquiry: true,
      itemWords,
      ...extras,
    } as TurnPlan["trade"],
  });

describe("r13 — a category ask quotes the kind-filtered counter", () => {
  test("'best blade' surfaces the stocked steel past the browse cap, cheapest first, moving nothing", async () => {
    const { engine, events } = await makeEngine(askWeapons("best blade"));
    await engine.submitPlayerInput("What's the best blade I can buy for 150 coppers?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("no best blade here");
    expect(prose).toContain("But weapons they do sell:");
    expect(prose).toContain("Spear (1 gp)");
    expect(prose).toContain("Dagger (2 gp)");
    expect(prose).toContain("Shortsword (10 gp)");
    // Cheapest first — "your cheapest weapon" must be literally answered by reading order.
    expect(prose.indexOf("Spear")).toBeLessThan(prose.indexOf("Dagger"));
    expect(prose.indexOf("Dagger")).toBeLessThan(prose.indexOf("Shortsword"));
    // The armor stays out of a weapons quote.
    expect(prose).not.toContain("Leather Armor");
    // r10 F-2: a question is answered, never executed.
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(150);
  });

  test("a COMMITTED category buy with an uncorroborated guess quotes — never substitutes, never executes", async () => {
    // r13 t11 verbatim: itemWords "ash cudgel", classifier guessed weapon.club, no club stocked.
    const { engine, events } = await makeEngine(
      askWeapons("ash cudgel", { inquiry: false, itemId: "weapon.club" }),
    );
    await engine.submitPlayerInput("I buy the ash cudgel.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("no ash cudgel here");
    expect(prose).toContain("But weapons they do sell:");
    // The uncorroborated masterlist guess must stay dead (r10 F-3) — no club materializes.
    expect(prose).not.toContain("Club");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(150);
    expect(engine.getState().actors["pc.you"]?.inventory).toHaveLength(0);
  });

  test("a category ask at a counter with no such kind falls to the honest head-shake", async () => {
    const { engine, events } = await makeEngine(askWeapons("best blade"), ["item.waterskin"]);
    await engine.submitPlayerInput("Any blades for sale?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("shakes their head");
    expect(prose).toContain("no best blade here");
    expect(prose).not.toContain("But weapons they do sell:");
    expect(prose).toContain("On offer:");
    expect(prose).toContain("Waterskin");
  });

  test("the map is high-precision: 'flint and steel' is not a weapons ask", async () => {
    const { engine, events } = await makeEngine(askWeapons("flint and steel"));
    await engine.submitPlayerInput("Do you have flint and steel?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).not.toContain("But weapons they do sell:");
    expect(prose).toContain("no flint and steel here");
  });
});

describe("r14 — the sell side answers to the pack the sale itself checks", () => {
  const sellPlan = (extras: Record<string, unknown>) =>
    planClassifier({
      kind: "trade",
      trade: {
        direction: "sell",
        itemId: null,
        vendorId: "npc.brann",
        ...extras,
      } as TurnPlan["trade"],
    });

  test("a sell QUOTE for an uncarried ware refuses honestly and names what would fetch coin", async () => {
    // fixture-trade t6→t7: the masterlist fallback quoted 3 sp for a shirt the player never carried,
    // and the sale one turn later refused "you are not carrying it" — quote and sale contradicted.
    const { engine, events } = await makeEngine(
      sellPlan({ itemId: "apparel.shirt", inquiry: true, itemWords: "my old shirt" }),
      VEIL_SHAPED_STOCK,
      ["weapon.club"],
    );
    await engine.submitPlayerInput("How many copper will you give me for my old shirt?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("You carry no Shirt to sell.");
    expect(prose).not.toContain("would give");
    expect(prose).toContain("From what you carry,");
    expect(prose).toContain("Club (");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
  });

  test("a sell quote for a CARRIED ware still quotes exactly as before", async () => {
    const { engine, events } = await makeEngine(
      sellPlan({ itemId: "weapon.club", inquiry: true, itemWords: "my club" }),
      VEIL_SHAPED_STOCK,
      ["weapon.club"],
    );
    await engine.submitPlayerInput("What would you give for my club?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("looks the Club over and would give");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
  });

  test("pack-deixis itemWords answer with the sell-side counter, never a mangled splice", async () => {
    // fixture-trade t8: "name what you'd pay for from what I'm carrying" arrived as an item named
    // "what I'm carrying" and shipped "You reach for the what I'm carrying…".
    const { engine, events } = await makeEngine(
      sellPlan({ inquiry: true, itemWords: "what I'm carrying" }),
      VEIL_SHAPED_STOCK,
      ["weapon.club", "item.waterskin"],
    );
    await engine.submitPlayerInput("Name what you'd pay for from what I'm carrying.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).not.toContain("You reach for the what");
    expect(prose).toContain("From what you carry,");
    expect(prose).toContain("Club (");
    expect(prose).toContain("Waterskin (");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
  });

  test("'everything I own' and a bare pay-ask are pack-deixis too (skeptic pass, r14)", async () => {
    for (const words of ["everything I own", "what would you pay for"]) {
      const { engine, events } = await makeEngine(
        sellPlan({ inquiry: true, itemWords: words }),
        VEIL_SHAPED_STOCK,
        ["weapon.club"],
      );
      await engine.submitPlayerInput(`Name a price — ${words}.`);
      const prose = byKind(events, "narration").at(-1)?.text ?? "";
      expect(prose, words).not.toContain("You reach for");
      expect(prose, words).toContain("From what you carry,");
      expect(byKind(events, "coinsChanged"), words).toHaveLength(0);
    }
  });

  test("a corroboration-rail sell refusal teaches the counter (r14, fixture-trade t14–t16)", async () => {
    // The driver tried to sell the CARRIED ware under a paraphrase the rail rightly refused to
    // gamble on ("this remedy potion" for the hedge-remedy) — three refusals, zero teach. The
    // refusal stays; it now names what the pack really holds.
    const { engine, events } = await makeEngine(
      sellPlan({ itemId: "item.waterskin", inquiry: true, itemWords: "this little water pouch" }),
      VEIL_SHAPED_STOCK,
      ["item.waterskin"],
    );
    await engine.submitPlayerInput("I'll sell you this little water pouch — what's it worth?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("nothing you carry answers to that name.");
    expect(prose).toContain("From what you carry,");
    expect(prose).toContain("Waterskin (");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
  });

  test("pack-deixis over an empty pack gets the honest nothing-worth-a-coin line", async () => {
    const { engine, events } = await makeEngine(
      sellPlan({ inquiry: true, itemWords: "anything I have" }),
      VEIL_SHAPED_STOCK,
      [],
    );
    await engine.submitPlayerInput("Would you buy anything I have?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("finds nothing worth a coin");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
  });

  test("a COMMITTED sell of an uncarried ware keeps the honest refusal and now teaches the counter", async () => {
    const { engine, events } = await makeEngine(
      sellPlan({ itemId: "apparel.shirt", itemWords: "my old shirt" }),
      VEIL_SHAPED_STOCK,
      ["weapon.club"],
    );
    await engine.submitPlayerInput("I sell you my old shirt for 3 silver.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("You reach for the Shirt, but you are not carrying it.");
    expect(prose).toContain("From what you carry,");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
  });
});

describe("r13 — the counter line stops lying about its own edges", () => {
  test("a browse over a 12-ware counter caps at eight and says how many more there are", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "buy", itemId: null, vendorId: "npc.brann", inquiry: true, itemWords: "" } as TurnPlan["trade"],
      }),
    );
    await engine.submitPlayerInput("Show me what you sell.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("On offer:");
    // 12 distinct resolvable wares: 8 shown, 4 past the cap — the tail must COUNT them, not
    // vanish (the old break-before-visit left `seen.size === wares.length` on every cap hit).
    expect(prose).toContain(", and 4 more besides");
  });

  test("a counter of eight or fewer keeps the tail-less line byte-shape", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "trade",
        trade: { direction: "buy", itemId: null, vendorId: "npc.brann", inquiry: true, itemWords: "" } as TurnPlan["trade"],
      }),
      ["item.waterskin", "item.rations"],
    );
    await engine.submitPlayerInput("Show me what you sell.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("On offer:");
    expect(prose).not.toContain("more besides");
  });

  test("the refusal strips the spliced determiner — 'no cudgel here', not 'no a cudgel here'", async () => {
    const { engine, events } = await makeEngine(askWeapons("a cudgel"), ["item.waterskin"]);
    await engine.submitPlayerInput("How much for a cudgel?");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("no cudgel here");
    expect(prose).not.toContain("no a cudgel");
  });
});

describe("wareKindAskOf — the closed category vocabulary", () => {
  test("weapon and armor terms ground; near-misses stay null", () => {
    expect(wareKindAskOf("best blade")).toBe("weapon");
    expect(wareKindAskOf("blades or axes")).toBe("weapon");
    expect(wareKindAskOf("your cheapest weapon")).toBe("weapon");
    expect(wareKindAskOf("ash cudgel")).toBe("weapon");
    expect(wareKindAskOf("knives")).toBe("weapon");
    expect(wareKindAskOf("chain mail")).toBe("armor");
    expect(wareKindAskOf("a shield")).toBe("armor");
    expect(wareKindAskOf("flint and steel")).toBeNull();
    expect(wareKindAskOf("seasoned tarp")).toBeNull();
    expect(wareKindAskOf("")).toBeNull();
  });
});
