/**
 * Playtest run-2 fix wave — regression specs for the five load-bearing repairs:
 *
 *   1. Trade: a vendor-grounded browse (null itemId) answers with the REAL counter (stock+prices);
 *      a name-shape miss ("item.water-skin" vs stocked "item.waterskin") grounds via the loose
 *      matcher instead of refusing on a hyphen; refusals teach (they name the counter).
 *   2. matchExit: the model's NAMED destination is never outvoted by incidental raw-line tokens —
 *      "walk the glass-road west to the dry wash" must not snap to the road's far end.
 *   3. Continuity: phantomSupplies (prose provisions the party never bought) and timeDrift (a
 *      narrated dawn on a turn whose clock advance cannot contain one) are Tier-1 violations.
 *   4. endDay at non-camp chains through enterCamp (one turn, one night) — covered in camp.test.ts.
 *   5. Ambush defeat suspension — a fight that OPENS and would fully resolve to a defeat in the
 *      same tick suspends instead (combat stays active; the consequence lands a visible turn later).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { matchItemLoosely } from "../src/rules/items.ts";
import { matchExit } from "../src/world/exit-match.ts";
import { checkPhantomSupplies, checkTimeDrift } from "../src/rules/continuity.ts";
import { byKind, loadExample } from "./support/harness.ts";

const baseCheck = { warranted: false as const, ability: null, skill: null, dc: null, reason: "" };

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

/** Brann becomes a statted vendor stocking a waterskin, rations, and a dagger. */
function stockBrann(playset: PlaySet): void {
  const brann = playset.world.npcs.find((n) => n.id === "npc.brann")!;
  brann.vendor = { priceModifier: 1 };
  brann.inventory = ["item.waterskin", "item.rations", "weapon.dagger"];
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

function seededState(playset: PlaySet, coins = 1000): GameState {
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
  mutate?: (playset: PlaySet) => void,
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  mutate?.(playset);
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

describe("matchItemLoosely — name-shape grounding", () => {
  const world = { items: [] };
  test("squashed equality bridges hyphen/prefix variants", () => {
    expect(matchItemLoosely("item.water-skin", ["item.waterskin", "item.holy-water"], world)).toBe("item.waterskin");
    expect(matchItemLoosely("Waterskin", ["item.waterskin", "item.rations"], world)).toBe("item.waterskin");
  });
  test("token containment finds the stocked rations from a plural/name guess", () => {
    expect(matchItemLoosely("item.ration", ["item.rations", "weapon.dagger"], world)).toBe("item.rations");
  });
  test("an ambiguous or unknown guess stays null (never a blind pick)", () => {
    expect(matchItemLoosely("item.water", ["item.water-skin", "item.water-flask"], world)).toBeNull();
    expect(matchItemLoosely("item.gloves", ["item.waterskin", "item.rations"], world)).toBeNull();
  });
  test("an '-es' plural folds to the stocked singular (r8 regex audit)", () => {
    // The de-pluraler stripped a bare "s", so "torches" folded to "torche" and matched nothing:
    // reproduced as `matchItemLoosely("two torches", ["item.torch", …], world) => null`, i.e. the
    // counter answered "we deal in nothing by that name" with the torches in the rack. A plural is
    // how a player asks for the one item they always buy more than one of.
    expect(matchItemLoosely("two torches", ["item.torch", "item.rations"], world)).toBe("item.torch");
    expect(matchItemLoosely("torches", ["item.torch"], world)).toBe("item.torch");
    // Both sides fold the same way, so the singular query and the plural id still meet.
    expect(matchItemLoosely("breeches", ["apparel.breeches", "item.torch"], world)).toBe("apparel.breeches");
    // …and it widens nothing: an unstocked plural is still an honest miss.
    expect(matchItemLoosely("torches", ["item.rations", "weapon.dagger"], world)).toBeNull();
  });
});

describe("trade — browse + loose grounding + teaching refusals (r2 P0)", () => {
  test("a vendor-grounded browse (null itemId) answers with the real counter", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({ kind: "trade", trade: { direction: "buy", itemId: null, vendorId: "npc.brann" } }),
      stockBrann,
    );
    await engine.submitPlayerInput("Show me what you have to sell and name your prices.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    expect(prose).toContain("Brann");
    expect(prose).toContain("On offer:");
    expect(prose).toContain("Waterskin");
    expect(prose).toContain("Rations");
    // Prices are the same tradePriceCp numbers a purchase pays.
    expect(prose).toMatch(/Waterskin \(\d+ [gsc]p\)/);
    // A browse closes no deal.
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
  });

  test("a hyphenated item guess grounds to the stocked ware and the buy completes", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({ kind: "trade", trade: { direction: "buy", itemId: "item.water-skin", vendorId: "npc.brann" } }),
      stockBrann,
    );
    await engine.submitPlayerInput("I buy a water-skin from Brann.");
    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "item.waterskin", from: "npc.brann", to: "pc.you" }),
    ]);
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.waterskin");
  });

  test("an unstocked ware refuses honestly AND names the counter", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({ kind: "trade", trade: { direction: "buy", itemId: "weapon.longsword", vendorId: "npc.brann" } }),
      stockBrann,
    );
    await engine.submitPlayerInput("I buy a longsword from Brann.");
    const prose = byKind(events, "narration").at(-1)?.text ?? "";
    // r6 P1: the refusal is diegetic — the vendor says it isn't theirs to sell — and still names
    // the counter so it teaches instead of stonewalling.
    expect(prose).toContain("That one's spoken for — not mine to sell");
    expect(prose).toContain("On offer:");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
  });
});

describe("matchExit — the named destination is never outvoted by the raw line (r2 P1)", () => {
  const EXITS = [
    { id: "loc.vellmere", name: "the glass-road west to Vellmere", direction: "west" },
    { id: "loc.ashford", name: "the Salt Run east", direction: "east" },
  ];
  test("a prose-only named place stays an honest miss despite road tokens in the line", () => {
    // The r2 teleport bug: "walk the glass-road west to the dry wash" token-matched the road exit
    // and silently arrived two stops on. The model NAMED "the dry wash": that guess rules.
    expect(
      matchExit(null, "we walk the glass-road west to the dry wash and read the ruts", EXITS, undefined, "the dry wash"),
    ).toBeNull();
  });
  test("the raw line still grounds a bare direction when the model named nothing", () => {
    expect(matchExit(null, "let's head west", EXITS)).toBe("loc.vellmere");
  });
  test("a named destination that IS an exit still grounds by name", () => {
    expect(matchExit(null, "back along the Salt Run", EXITS, undefined, "the Salt Run east")).toBe("loc.ashford");
  });
});

describe("continuity — phantomSupplies + timeDrift (r2 P1)", () => {
  test("prose provisioning an unprovisioned party is a violation", () => {
    const v = checkPhantomSupplies('Oda shoulders the pack. "We\'ve got your rations and water," he says.', [
      "Quarterstaff",
      "Potion of Healing",
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("phantomSupplies");
  });
  test("carried staples, commerce talk, and lack-talk stay legal", () => {
    expect(checkPhantomSupplies("You check your rations twice.", ["Rations (1 day)"])).toHaveLength(0);
    expect(checkPhantomSupplies("You have no rations for the crossing.", ["Quarterstaff"])).toHaveLength(0);
    expect(checkPhantomSupplies('"Three silver will buy your rations," she says.', ["Quarterstaff"])).toHaveLength(0);
  });
  test("a narrated dawn on a 1-minute turn is a violation; a real night is legal", () => {
    expect(checkTimeDrift("The night passes. Dawn finds you stiff and cold in the ditch.", 1)).toHaveLength(1);
    expect(checkTimeDrift("The night passes. Dawn finds you rested.", 600)).toHaveLength(0);
    // Deadline talk is not passage: the bond expiring at dawn must never trip the check.
    expect(checkTimeDrift("The bond holds till dawn, then the Guild posts its own rate.", 1)).toHaveLength(0);
  });
});
