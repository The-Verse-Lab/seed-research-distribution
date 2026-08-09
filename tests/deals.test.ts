/**
 * Deals are state, not scrollback — PROSE-TO-CODE §2.2.
 *
 * Run 6's best content was its bargains (a first-refusal contract, a strongbox stake, credit on a
 * vest) and none of them was recorded anywhere, so the world could neither honour nor invoke them.
 * A settled agreement is now a real row: the classifier reports `makeDeal` on the line that settles
 * it, the reducer owns the ledger (dedup, cap, close), the brief carries the open ones as
 * `# STANDING DEALS`, and `/state` plus the read-only projection expose them.
 *
 * The bar this wave commits to is CAPTURE + VISIBILITY, not enforcement — these tests pin exactly
 * that, plus the persistence round-trip module slices need and `Entity.flags` never had.
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
import type { TurnEffect, TurnPlan } from "../src/engine/turn-plan.ts";
import { byKind, loadExample } from "./support/harness.ts";
import { standingDealsLines } from "../src/agents/context.ts";
import { dealsOf } from "../src/state/projections.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState } from "../src/world/model.ts";
import {
  DEALS_CAP,
  hasEquivalentOpenDeal,
  normalizeTerms,
  openDealWith,
  openDeals,
  readDealsSlice,
  renderDeal,
  type Deal,
} from "../src/rules/deals.ts";

const baseCheck = { warranted: false as const, ability: null, skill: null, dc: null, reason: "" };

/** A classifier stub returning a fixed, already-reconciled dialogue plan carrying `effects`. */
const dialogueWith = (effects: TurnEffect[]): TurnClassifier => ({
  classify: () =>
    Promise.resolve({
      kind: "dialogueToNpc",
      targetId: "npc.brann",
      destinationLocationId: null,
      check: baseCheck,
      confidence: 0.9,
      effects,
    } as unknown as TurnPlan),
});

const dealEffect = (over: Partial<TurnEffect> = {}): TurnEffect =>
  ({
    type: "makeDeal",
    amountCp: null,
    itemId: null,
    toNpcId: "npc.brann",
    terms: "first refusal on any glass I bring back",
    ...over,
  }) as TurnEffect;

function seededState(playset: PlaySet, modules?: Record<string, unknown>): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 480,
    party: ["pc.you"],
    companions: [],
    actors: {
      "pc.you": {
        id: "pc.you",
        currentHp: 10,
        locationId: "loc.tavern",
        inventory: [],
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
    ...(modules ? { modules } : {}),
  };
}

async function makeEngine(
  classifier: TurnClassifier,
  modules?: Record<string, unknown>,
): Promise<{ engine: GameEngine; events: GameEvent[]; store: InMemoryGameStateStore; playset: PlaySet }> {
  const playset = await loadExample();
  const store = new InMemoryGameStateStore();
  await store.save(
    makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]),
    seededState(playset, modules),
  );
  const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), rng: mulberry32(7), classifier });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events, store, playset };
}

const deal = (over: Partial<Deal> = {}): Deal => ({
  id: 1,
  parties: ["pc.you", "npc.brann"],
  partyNames: ["You", "Brann"],
  terms: "first refusal on any glass I bring back",
  state: "open",
  atClock: 480,
  closedAtClock: null,
  ...over,
});

describe("the deals slice (the math leaf)", () => {
  test("terms normalize to one capped clause; the dedup key ignores case and spacing", () => {
    expect(normalizeTerms("  first   refusal\non any glass  ")).toBe("first refusal on any glass");
    expect(normalizeTerms("x".repeat(400))).toHaveLength(160);
    const slice = { records: [deal()], nextId: 2 };
    expect(hasEquivalentOpenDeal(slice, ["npc.brann", "pc.you"], "First Refusal  On Any Glass I Bring Back")).toBe(true);
    expect(hasEquivalentOpenDeal(slice, ["pc.you", "npc.lyra"], "first refusal on any glass I bring back")).toBe(false);
  });

  test("a CLOSED deal no longer blocks striking the same bargain again", () => {
    const slice = { records: [deal({ state: "honoured" })], nextId: 2 };
    expect(hasEquivalentOpenDeal(slice, ["pc.you", "npc.brann"], "first refusal on any glass I bring back")).toBe(false);
  });

  test("openDealWith prefers the most recent standing deal with that party", () => {
    const slice = {
      records: [
        deal({ id: 1, terms: "older" }),
        deal({ id: 2, terms: "with someone else", parties: ["pc.you", "npc.lyra"] }),
        deal({ id: 3, terms: "newer" }),
      ],
      nextId: 4,
    };
    expect(openDealWith(slice, "npc.brann")?.id).toBe(3);
    expect(openDealWith(slice, "npc.lyra")?.id).toBe(2);
    expect(openDealWith(slice, null)?.id).toBe(3);
    expect(openDealWith(slice, "npc.nobody")).toBeUndefined();
  });

  test("readDealsSlice hands back copies and drops malformed rows", () => {
    const stored = [deal(), { id: 9, terms: "no state" }];
    const modules = { deals: { records: stored, nextId: 10 } };
    const read = readDealsSlice(modules);
    expect(read.records).toHaveLength(1);
    read.records[0]!.terms = "tampered";
    expect((stored[0] as Deal).terms).toBe("first refusal on any glass I bring back");
  });

  test("renderDeal names the OTHER party, never the player", () => {
    expect(renderDeal(deal(), "pc.you")).toBe("with Brann — first refusal on any glass I bring back");
  });
});

describe("the reducer owns the ledger", () => {
  async function model() {
    const playset = await loadExample();
    return fromGameState(seededState(playset), playset.world, playset.campaign);
  }

  test("recordDeal appends a row and emits the ABSOLUTE post-state", async () => {
    const m = await model();
    const result = applyCommand(m, { type: "recordDeal", deal: { ...deal(), id: undefined } as never });
    expect(result.rejected).toBeUndefined();
    expect(result.deltas[0]).toMatchObject({ kind: "modulePatched", module: "deals" });
    expect(readDealsSlice(m.modules).records).toHaveLength(1);
    expect(readDealsSlice(m.modules).nextId).toBe(2);
  });

  test("the same standing bargain re-reported is a NO-OP — a three-turn haggle is one deal", async () => {
    const m = await model();
    applyCommand(m, { type: "recordDeal", deal: { ...deal(), id: undefined } as never });
    const again = applyCommand(m, {
      type: "recordDeal",
      deal: { ...deal(), id: undefined, terms: "First Refusal on any glass I bring back  " } as never,
    });
    expect(again.deltas).toHaveLength(0);
    expect(readDealsSlice(m.modules).records).toHaveLength(1);
  });

  test("terms that normalize to nothing are rejected outright", async () => {
    const m = await model();
    expect(applyCommand(m, { type: "recordDeal", deal: { ...deal(), id: undefined, terms: "   " } as never }).rejected).toBeTruthy();
  });

  test("setDealState closes a row and stamps the clock; a repeat is a no-op", async () => {
    const m = await model();
    applyCommand(m, { type: "recordDeal", deal: { ...deal(), id: undefined } as never });
    applyCommand(m, { type: "setDealState", dealId: 1, state: "honoured", atClock: 900 });
    const row = readDealsSlice(m.modules).records[0]!;
    expect(row.state).toBe("honoured");
    expect(row.closedAtClock).toBe(900);
    expect(applyCommand(m, { type: "setDealState", dealId: 1, state: "honoured", atClock: 999 }).deltas).toHaveLength(0);
    expect(applyCommand(m, { type: "setDealState", dealId: 42, state: "broken", atClock: 999 }).rejected).toBeTruthy();
  });

  test("the ledger is bounded", async () => {
    const m = await model();
    for (let i = 0; i < DEALS_CAP + 3; i++) {
      applyCommand(m, { type: "recordDeal", deal: { ...deal(), id: undefined, terms: `bargain ${i}` } as never });
    }
    expect(readDealsSlice(m.modules).records).toHaveLength(DEALS_CAP);
  });
});

describe("a settled line becomes a row (end to end)", () => {
  test("makeDeal on a dialogue line records the terms, quietly, and persists", async () => {
    const { engine, events, store, playset } = await makeEngine(dialogueWith([dealEffect()]));
    await engine.submitPlayerInput("Brann — you'll have first refusal on any glass I bring back.");
    const rows = openDeals(readDealsSlice(engine.getState().modules ?? {}));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parties: ["pc.you", "npc.brann"],
      terms: "first refusal on any glass I bring back",
      state: "open",
    });
    const receipt = byKind(events, "stateChanged").find((e) => e.summary.startsWith("Deal struck"));
    expect(receipt?.quiet).toBe(true);
    // Module slices survive a save/reload — the trap `Entity.flags` fell into.
    const saved = await store.load(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]));
    expect(openDeals(readDealsSlice(saved?.modules ?? {}))).toHaveLength(1);
  });

  test("an absent counterparty grounds to nothing — a bargain is struck with someone in the room", async () => {
    const { engine } = await makeEngine(dialogueWith([dealEffect({ toNpcId: "npc.ghost" })]));
    await engine.submitPlayerInput("I settle terms with a voice on the wind.");
    expect(openDeals(readDealsSlice(engine.getState().modules ?? {}))).toHaveLength(0);
  });

  test("blank terms record nothing", async () => {
    const { engine } = await makeEngine(dialogueWith([dealEffect({ terms: "   " })]));
    await engine.submitPlayerInput("Brann — we have an understanding.");
    expect(openDeals(readDealsSlice(engine.getState().modules ?? {}))).toHaveLength(0);
  });

  test("dealAction closes the standing deal with that party", async () => {
    const { engine } = await makeEngine(
      dialogueWith([dealEffect({ type: "dealAction", dealState: "honoured", terms: null } as Partial<TurnEffect>)]),
      { deals: { records: [deal()], nextId: 2 } },
    );
    await engine.submitPlayerInput("Here's the glass, Brann — as agreed.");
    const slice = readDealsSlice(engine.getState().modules ?? {});
    expect(slice.records[0]?.state).toBe("honoured");
    expect(openDeals(slice)).toHaveLength(0);
  });

  test("a break is recorded as a break, not silence", async () => {
    const { engine, events } = await makeEngine(
      dialogueWith([dealEffect({ type: "dealAction", dealState: "broken", terms: null } as Partial<TurnEffect>)]),
      { deals: { records: [deal()], nextId: 2 } },
    );
    await engine.submitPlayerInput("I sold it elsewhere, Brann. Your claim can wait.");
    expect(readDealsSlice(engine.getState().modules ?? {}).records[0]?.state).toBe("broken");
    expect(byKind(events, "stateChanged").some((e) => e.summary.startsWith("Deal broken"))).toBe(true);
  });

  test("a dealAction with no standing deal changes nothing", async () => {
    const { engine } = await makeEngine(
      dialogueWith([dealEffect({ type: "dealAction", dealState: "honoured", terms: null } as Partial<TurnEffect>)]),
    );
    await engine.submitPlayerInput("As agreed, Brann.");
    expect(readDealsSlice(engine.getState().modules ?? {}).records).toHaveLength(0);
  });
});

describe("visibility", () => {
  test("the brief block omits entirely when nothing stands, and carries open rows when it does", async () => {
    const playset = await loadExample();
    expect(standingDealsLines(seededState(playset))).toEqual([]);
    const lines = standingDealsLines(seededState(playset, { deals: { records: [deal()], nextId: 2 } }));
    expect(lines[0]).toBe("# STANDING DEALS");
    expect(lines.join("\n")).toContain("with Brann — first refusal on any glass I bring back");
    // A closed deal is history, not a standing obligation.
    expect(standingDealsLines(seededState(playset, { deals: { records: [deal({ state: "broken" })], nextId: 2 } }))).toEqual([]);
  });

  test("an NPC brief sees only the deals it is party to", async () => {
    const playset = await loadExample();
    const state = seededState(playset, { deals: { records: [deal()], nextId: 2 } });
    const bystander = { ids: new Set(["npc.lyra"]), partyMember: false };
    const counterparty = { ids: new Set(["npc.brann"]), partyMember: false };
    expect(standingDealsLines(state, bystander)).toEqual([]);
    expect(standingDealsLines(state, counterparty).length).toBeGreaterThan(0);
    // A companion who stood beside the counter keeps the row.
    expect(standingDealsLines(state, { ids: new Set(["npc.lyra"]), partyMember: true }).length).toBeGreaterThan(0);
  });

  test("the read-only projection includes the other party, terms, and time struck", async () => {
    const playset = await loadExample();
    const rows = dealsOf(seededState(playset, { deals: { records: [deal()], nextId: 2 } }));
    expect(rows).toEqual([
      { id: 1, withWhom: "Brann", terms: "first refusal on any glass I bring back", day: 1, phase: rows[0]!.phase },
    ]);
    expect(dealsOf(seededState(playset))).toEqual([]);
  });
});
