/**
 * Exchange & service layer (r8, the dealings ledger) — reducer, replay, engine, and classifier
 * coverage for `src/rules/exchange.ts` + the reducer's `recordExchange`/`serviceBegin`/
 * `serviceComplete` cases + the engine's `resolveTradeBatch`/`resolveService`/`settleDueServices`.
 *
 * The spine: `serviceBegin` strikes a fee-for-work deal ATOMICALLY (fee leaves the purse, a
 * custody item moves player→NPC, the agreement is appended) — never a SALE of the item, which was
 * the r7 exploit ("sharpen it and name your price" resolved as a half-price liquidation). Every
 * executed exchange is also appended to the bounded dealings ledger so briefs can refer back to
 * what actually happened instead of the prose quietly re-narrating it.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { PlaySet } from "../src/content/schema.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { ActorRuntime, GameState } from "../src/state/types.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { reconcilePlan, type TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import {
  EXCHANGE_CAP,
  readExchangesSlice,
  readServicesSlice,
  type ExchangeRecord,
  type ServiceAgreement,
} from "../src/rules/exchange.ts";
import type { Command } from "../src/world/commands.ts";
import { exchangesSlice, servicesSlice } from "../src/world/module-slices.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { applyDelta, reduceDeltas } from "./support/replay.ts";
import { byKind, loadExample } from "./support/harness.ts";

const baseCheck = { warranted: false as const, ability: null, skill: null, dc: null, reason: "" };

// ============================================================================================
// Reducer-level: serviceBegin / serviceComplete / recordExchange, direct model + applyCommand.
// No engine/content template needed — these commands only ever touch entities + modules.
// ============================================================================================

/** A minimal PC (rapier equipped + a dagger, 100cp) and a statted "Tailor" NPC — enough body for
 *  a custody strike, built via `fromGameState` so the model is a REAL WorldModel (map/quests/etc
 *  all present), not a bare `{modules,entities}` stub. "npc.tailor" carries no content template —
 *  `fromGameState` hydrates any id present in `GameState.actors` regardless (audit above). */
async function serviceReducerModel(): Promise<WorldModel> {
  const playset = await loadExample();
  const state: GameState = {
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
        inventory: ["weapon.rapier", "weapon.dagger"],
        conditions: [],
        coins: 100,
        equipped: { weapon: "weapon.rapier" },
      },
      "npc.tailor": {
        id: "npc.tailor",
        currentHp: 8,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
        name: "Tailor",
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    flags: {},
  };
  return fromGameState(state, playset.world, playset.campaign);
}

const makeAgreement = (overrides: Partial<ServiceAgreement> = {}): ServiceAgreement => ({
  id: "svc-1",
  npcId: "npc.tailor",
  npcName: "Tailor",
  label: "Sharpen and dress the Rapier",
  feeCp: 40,
  itemId: "weapon.rapier",
  itemName: "Rapier",
  custody: true,
  dueDay: 1,
  dueMinute: 300,
  state: "active",
  ...overrides,
});

const makeExchangeRecord = (i: number): Omit<ExchangeRecord, "id"> => ({
  day: 1,
  minute: i,
  npcId: "npc.tailor",
  npcName: "Tailor",
  kind: "service",
  lines: [],
  coinsCp: 0,
  note: `note ${i}`,
});

describe("reducer — serviceBegin (r8: the anti-money-printing strike)", () => {
  test("charges the fee, moves the custody item PC→NPC, vacates the equipped slot, and appends an active agreement", async () => {
    const model = await serviceReducerModel();
    const res = applyCommand(model, { type: "serviceBegin", pcId: "pc.you", agreement: makeAgreement() });

    expect(res.mutated).toBe(true);
    expect(res.rejected).toBeUndefined();
    // Order matches the reducer: fee, then custody transfer, then the vacated equip slot, then the
    // absolute agreement-list patch — asserting it pins the atomic all-or-nothing shape.
    expect(res.deltas.map((d) => d.kind)).toEqual([
      "coinsChanged",
      "itemTransferred",
      "equipmentChanged",
      "modulePatched",
    ]);

    const pc = model.entities.get("pc.you")!;
    expect(pc.stats!.coins).toBe(60); // 100 − 40
    expect(pc.stats!.inventory).toEqual(["weapon.dagger"]); // the rapier left the pack...
    expect(pc.stats!.equipped).toEqual({}); // ...and the weapon slot it filled is vacated, not dangling

    const tailor = model.entities.get("npc.tailor")!;
    expect(tailor.stats!.inventory).toContain("weapon.rapier");

    expect(servicesSlice(model).agreements).toEqual([{ ...makeAgreement(), state: "active" }]);
  });

  test("rejects on an unaffordable fee — nothing moves, no agreement is struck", async () => {
    const model = await serviceReducerModel();
    const res = applyCommand(model, {
      type: "serviceBegin",
      pcId: "pc.you",
      agreement: makeAgreement({ feeCp: 150 }), // > the PC's 100cp purse
    });

    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("cannot afford");

    const pc = model.entities.get("pc.you")!;
    expect(pc.stats!.coins).toBe(100);
    expect(pc.stats!.inventory).toEqual(["weapon.rapier", "weapon.dagger"]);
    expect(pc.stats!.equipped).toEqual({ weapon: "weapon.rapier" });
    expect(servicesSlice(model).agreements).toHaveLength(0);
  });
});

describe("reducer — serviceComplete", () => {
  test("returns the custody item and marks the agreement done", async () => {
    const model = await serviceReducerModel();
    applyCommand(model, { type: "serviceBegin", pcId: "pc.you", agreement: makeAgreement() });

    const res = applyCommand(model, { type: "serviceComplete", agreementId: "svc-1" });
    expect(res.mutated).toBe(true);
    expect(res.deltas.some((d) => d.kind === "itemTransferred")).toBe(true);

    const pc = model.entities.get("pc.you")!;
    expect(pc.stats!.inventory).toContain("weapon.rapier");
    const tailor = model.entities.get("npc.tailor")!;
    expect(tailor.stats!.inventory).not.toContain("weapon.rapier");

    const agreement = servicesSlice(model).agreements.find((a) => a.id === "svc-1")!;
    expect(agreement.state).toBe("done");
  });

  test("an unknown agreement id is rejected", async () => {
    const model = await serviceReducerModel();
    const res = applyCommand(model, { type: "serviceComplete", agreementId: "svc-ghost" });
    expect(res.mutated).toBe(false);
    expect(res.rejected?.reason).toContain("no agreement");
  });

  test("completing an already-done agreement a second time is a noop, not an error", async () => {
    const model = await serviceReducerModel();
    applyCommand(model, { type: "serviceBegin", pcId: "pc.you", agreement: makeAgreement() });
    applyCommand(model, { type: "serviceComplete", agreementId: "svc-1" });

    const again = applyCommand(model, { type: "serviceComplete", agreementId: "svc-1" });
    expect(again.mutated).toBe(false);
    expect(again.rejected).toBeUndefined();
    expect(again.deltas).toHaveLength(0);
  });
});

describe("reducer — recordExchange (the dealings ledger)", () => {
  test("appends one receipt and emits the absolute post-append slice", async () => {
    const model = await serviceReducerModel();
    const res = applyCommand(model, { type: "recordExchange", record: makeExchangeRecord(0) });

    expect(res.mutated).toBe(true);
    expect(res.deltas).toHaveLength(1);
    expect(res.deltas[0]?.kind).toBe("modulePatched");
    expect(exchangesSlice(model).records).toEqual([{ ...makeExchangeRecord(0), id: 1 }]);
    expect(exchangesSlice(model).nextId).toBe(2);
  });

  test("caps at EXCHANGE_CAP, dropping the oldest, nextId strictly monotonic", async () => {
    const model = await serviceReducerModel();
    for (let i = 0; i < EXCHANGE_CAP + 5; i++) {
      applyCommand(model, { type: "recordExchange", record: makeExchangeRecord(i) });
    }

    const slice = exchangesSlice(model);
    expect(slice.records).toHaveLength(EXCHANGE_CAP);
    // The 5 oldest (notes 0..4) fell off the front; the ids keep counting from the true push order.
    expect(slice.records[0]?.note).toBe("note 5");
    expect(slice.records[0]?.id).toBe(6);
    expect(slice.records.at(-1)?.note).toBe(`note ${EXCHANGE_CAP + 4}`);
    expect(slice.records.at(-1)?.id).toBe(EXCHANGE_CAP + 5);
    expect(slice.nextId).toBe(EXCHANGE_CAP + 6);
  });
});

describe("replay — serviceBegin + serviceComplete + recordExchange (r8)", () => {
  test("snapshot == fold(deltas)", async () => {
    const model = await serviceReducerModel();
    const seed = structuredClone(model);

    const deltas: EmittedDelta[] = [];
    const drive = (cmd: Command): void => {
      deltas.push(...applyCommand(model, cmd).deltas);
    };

    drive({ type: "serviceBegin", pcId: "pc.you", agreement: makeAgreement() });
    drive({ type: "serviceComplete", agreementId: "svc-1" });
    drive({
      type: "recordExchange",
      record: {
        day: 1,
        minute: 320,
        npcId: "npc.tailor",
        npcName: "Tailor",
        kind: "service",
        lines: [{ itemId: "weapon.rapier", name: "Rapier", quantity: 1, eachCp: null }],
        coinsCp: -40,
        note: "You pay Tailor 4 sp for sharpen and dress the rapier: rapier.",
      },
    });

    expect(deltas.length).toBeGreaterThan(0);
    const stamped: DeltaEvent[] = deltas.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent);
    const folded = reduceDeltas(seed, stamped);
    expect(toGameState(folded)).toEqual(toGameState(model));
    // Re-applying the same absolute delta stream is idempotent (the modulePatched overwrite precedent).
    for (const d of stamped) applyDelta(folded, d);
    expect(toGameState(folded)).toEqual(toGameState(model));
  });
});

// ============================================================================================
// Engine-level: resolveTradeBatch / resolveService / the downed gate, through a scripted
// classifier so the plan is already "reconciled" (no LLM, no zod re-validation).
// ============================================================================================

/** A classifier stub that returns a fixed, already-reconciled plan (the trade-honesty precedent). */
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

/**
 * A narrator-only override so a resolver's "do NOT repeat the ledger line" contract can be tested
 * against a real model's OWN prose, instead of OfflineGateway's literal `# NOW` echo — which would
 * trivially embed the quoted receipt, since the trigger cites it in an aside meant for a real LLM
 * to read and not repeat, not for a stub that parrots its whole prompt back. Every other role still
 * answers exactly like OfflineGateway.
 */
class FixedNarratorGateway extends OfflineGateway {
  constructor(private readonly narratorText: string) {
    super();
  }
  override complete(role: Parameters<OfflineGateway["complete"]>[0], req: Parameters<OfflineGateway["complete"]>[1]) {
    if (role === "narrator") return Promise.resolve({ text: this.narratorText, model: "fixed-narrator" });
    return super.complete(role, req);
  }
  override async *stream(role: Parameters<OfflineGateway["stream"]>[0], req: Parameters<OfflineGateway["stream"]>[1]) {
    const { text } = await this.complete(role, req);
    yield { delta: text, done: false };
    yield { delta: "", done: true };
  }
}

function seededState(playset: PlaySet, actor: Partial<ActorRuntime> = {}): GameState {
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
        coins: 200,
        ...actor,
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
  actor: Partial<ActorRuntime> = {},
  mutatePlayset?: (playset: PlaySet) => void,
  gateway: OfflineGateway = new OfflineGateway(),
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  mutatePlayset?.(playset);
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), seededState(playset, actor));
  const engine = new GameEngine({ playset, store, gateway, rng: mulberry32(7), classifier });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

/** Brann statted as a vendor stocking exactly 2 rations (a batch buy of 2 must exhaust the stock). */
function stockBrannForBatch(playset: PlaySet): void {
  const brann = playset.world.npcs.find((n) => n.id === "npc.brann")!;
  brann.vendor = { priceModifier: 1 };
  brann.inventory = ["item.rations", "item.rations"];
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

describe("engine tradeBatch — one vendor, many lines, one turn (r8)", () => {
  test("buying 2x and selling 1x moves inventory/coins atomically with one quiet receipt and fresh prose", async () => {
    const freshProse = "The counter clears and you shoulder your restocked pack.";
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "tradeBatch",
        tradeBatch: {
          vendorId: "npc.brann",
          lines: [
            { direction: "buy", itemId: "item.rations", quantity: 2 },
            { direction: "sell", itemId: "weapon.longsword", quantity: 1 },
          ],
        },
      }),
      { inventory: ["weapon.longsword"], coins: 1000 },
      stockBrannForBatch,
      new FixedNarratorGateway(freshProse),
    );

    await engine.submitPlayerInput("I stock up on rations and clear out the longsword.");

    const state = engine.getState();
    // item.rations 50cp × 2 = 100 spent; weapon.longsword 1500cp sells for half (750) → net +650.
    expect(state.actors["pc.you"]?.coins).toBe(1650); // 1000 − 100 + 750
    expect(state.actors["pc.you"]?.inventory).toEqual(["item.rations", "item.rations"]);
    expect(state.actors["npc.brann"]?.inventory).toEqual(["weapon.longsword"]); // stock fully turned over

    // Exactly ONE quiet receipt line (r7: "four Buy clicks ≈ four minutes" / double-printed receipts).
    const receipts = byKind(events, "stateChanged").filter((e) => e.quiet === true);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.summary).toContain("Brann");
    expect(receipts[0]?.changes).toEqual({ vendorId: "npc.brann", netCp: 650, lines: 2 });

    // The narration is the model's OWN prose, never a forced re-print of the ledger sentence.
    const narrations = byKind(events, "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    const narrationText = narrations.at(-1)!.text;
    expect(narrationText).toContain(freshProse);
    expect(narrationText).not.toContain(receipts[0]!.summary);

    // The dealings ledger recorded it too.
    const exchanges = readExchangesSlice(state.modules);
    expect(exchanges.records).toHaveLength(1);
    expect(exchanges.records[0]?.npcId).toBe("npc.brann");
    expect(exchanges.records[0]?.coinsCp).toBe(650);
    expect(exchanges.records[0]?.lines).toHaveLength(2);
  });
});

/** Brann statted as a vendor offering ONE custody service: sharpen-and-dress, 40cp, overnight. */
function stockBrannWithService(playset: PlaySet): void {
  const brann = playset.world.npcs.find((n) => n.id === "npc.brann")!;
  brann.vendor = {
    priceModifier: 1,
    services: [
      { id: "svc.sharpen", label: "Sharpen and dress a blade", priceCp: 40, needsItem: true, custody: true, minutes: 480 },
    ],
  };
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

describe("engine service — a struck custody deal never pays the player (r7 exploit regression)", () => {
  test("the fee leaves the purse, the rapier moves into the vendor's custody, and the agreement is active", async () => {
    const { engine } = await makeEngine(
      planClassifier({
        kind: "service",
        targetId: "npc.brann",
        service: { npcId: "npc.brann", serviceId: "svc.sharpen", itemId: "weapon.rapier" },
      }),
      { inventory: ["weapon.rapier"], coins: 200 },
      stockBrannWithService,
    );

    await engine.submitPlayerInput("Brann, sharpen and dress my rapier — name your price.");

    const state = engine.getState();
    // The r7 regression: this must NEVER be > 200 (a sale) — it may only ever fall.
    expect(state.actors["pc.you"]?.coins).toBeLessThan(200);
    expect(state.actors["pc.you"]?.coins).toBe(160); // exactly the 40cp fee
    expect(state.actors["pc.you"]?.inventory).not.toContain("weapon.rapier");
    expect(state.actors["npc.brann"]?.inventory).toContain("weapon.rapier");

    const services = readServicesSlice(state.modules);
    expect(services.agreements).toHaveLength(1);
    const agreement = services.agreements[0]!;
    expect(agreement.state).toBe("active");
    expect(agreement.custody).toBe(true);
    expect(agreement.itemId).toBe("weapon.rapier");
    expect(agreement.feeCp).toBe(40);
    expect(agreement.dueDay).not.toBeNull(); // an overnight custody job carries a real due stamp

    // The ledger's own record of the deal agrees: a fee paid out, never coin received.
    const exchanges = readExchangesSlice(state.modules);
    const last = exchanges.records.at(-1);
    expect(last?.kind).toBe("service");
    expect(last?.coinsCp).toBe(-40);
  });
});

describe("engine service — honest refusal when the NPC offers no services", () => {
  function stockBrannNoServices(playset: PlaySet): void {
    const brann = playset.world.npcs.find((n) => n.id === "npc.brann")!;
    brann.vendor = { priceModifier: 1 }; // a real vendor, but no `services` on the counter
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

  test("the player's goods do not move and the refusal is diegetic", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "service",
        targetId: "npc.brann",
        service: { npcId: "npc.brann", serviceId: null, itemId: "weapon.rapier" },
      }),
      { inventory: ["weapon.rapier"], coins: 200 },
      stockBrannNoServices,
    );

    await engine.submitPlayerInput("Brann, sharpen my rapier.");

    const state = engine.getState();
    expect(state.actors["pc.you"]?.coins).toBe(200);
    expect(state.actors["pc.you"]?.inventory).toContain("weapon.rapier");
    expect(readServicesSlice(state.modules).agreements).toHaveLength(0);

    const narrations = byKind(events, "narration");
    expect(narrations.at(-1)?.text).toContain("keep hold of what is yours");
  });
});

describe("engine — the downed gate blocks a check attempt before it ever rolls (r7 P2)", () => {
  test("a PC at 0 HP gets the unconscious refusal and no dice roll fires", async () => {
    const { engine, events } = await makeEngine(
      planClassifier({
        kind: "attemptRequiringCheck",
        check: { warranted: true, ability: "wis", skill: "perception", dc: 13, reason: "scan the road for tracks" },
      }),
      { currentHp: 0 },
    );

    await engine.submitPlayerInput("I search the road for tracks.");

    const narrations = byKind(events, "narration");
    expect(narrations.at(-1)?.text).toContain("You are down");
    expect(byKind(events, "diceRolled")).toHaveLength(0);
  });
});

// ============================================================================================
// classify.ts — reconcilePlan unit tests (pure, no engine).
// ============================================================================================

describe("reconcilePlan — the service backstop + the sell-addressee guard (r8/r7)", () => {
  const CTX: ClassifierContext = {
    playerActorId: "pc.you",
    locationId: "loc.market",
    locationName: "Market Row",
    exits: [],
    presentEntities: [
      { id: "npc.veil", name: "Sergeant Veil" },
      { id: "npc.oda", name: "Oda" },
    ],
    companionIds: ["npc.oda"],
    carriedItems: [{ id: "weapon.rapier", name: "Rapier" }],
    vendors: [
      {
        id: "npc.veil",
        name: "Sergeant Veil",
        stock: [],
        services: [{ id: "svc.sharpen", name: "Sharpen and dress a blade" }],
      },
    ],
  };

  const rawTradePlan = (targetId: string | null, trade: Record<string, unknown>) => ({
    kind: "trade",
    targetId,
    destinationLocationId: null,
    check: baseCheck,
    trade,
    confidence: 0.8,
  });

  test("a sell addressed to someone OTHER than the sole vendor drops the trade payload but keeps the kind", () => {
    // r7 rapier exploit shape: the sole-vendor repair is right for a bare "I sell my dagger" in a
    // one-stall market, and catastrophically wrong once the player is plainly dealing with someone
    // ELSE — the trade must not silently repair itself onto whichever merchant happens to be present.
    const plan = reconcilePlan(
      rawTradePlan("npc.oda", { direction: "sell", itemId: "weapon.rapier", vendorId: null }),
      CTX,
      "I hand Oda the rapier, name your price",
    );
    expect(plan.kind).toBe("trade");
    expect(plan.trade).toBeUndefined();
  });

  test("(r8) the SERVICE-VERB BACKSTOP is gone — 'I sell the dress' stays a sale", () => {
    // THE REPRODUCED MISFIRE. The backstop re-routed any `sell` whose RAW LINE matched
    // /\b(sharpen|whet|hone|dress|repair|mend|…)\b/ to `service`. Executed against the shipped
    // regex, SERVICE_VERB_RE.test("I sell the dress to Brann.") === true — "dress" is an ordinary
    // noun — so a plain sale became an appraisal: the player was charged the service fee for a
    // garment they meant to be paid for. The regex was second-guessing the classifier's own answer
    // about the same sentence, and the prompt already carries a worked sell-vs-service section
    // ("SELLING is ONLY parting with goods FOR COIN, stated as such … is kind \"service\", NEVER
    // trade with direction \"sell\""), so the model owns the distinction outright now.
    const plan = reconcilePlan(
      rawTradePlan(null, { direction: "sell", itemId: "weapon.rapier", vendorId: "npc.veil" }),
      CTX,
      "I sell the dress to Brann.",
    );
    expect(plan.kind).toBe("trade");
    expect(plan.trade).toEqual({ direction: "sell", itemId: "weapon.rapier", vendorId: "npc.veil" });
    expect(plan.service).toBeUndefined();
  });

  test("(r8) a model-declared `service` still grounds host + item — the kind is the model's call", () => {
    // The half that matters is untouched: when the classifier says `service`, the payload still
    // grounds against PRESENT entities and the pack, and the player keeps the item.
    const plan = reconcilePlan(
      {
        kind: "service",
        targetId: "npc.veil",
        destinationLocationId: null,
        check: baseCheck,
        service: { npcId: "npc.veil", serviceId: null, itemId: "weapon.rapier" },
        confidence: 0.8,
      },
      CTX,
      "sharpen my rapier and name your price",
    );
    expect(plan.kind).toBe("service");
    expect(plan.service).toEqual({ npcId: "npc.veil", serviceId: null, itemId: "weapon.rapier" });
    expect(plan.trade).toBeUndefined();
  });
});

describe("reconcilePlan — spendCoins payee guard (r7 tip bug: unaddressed companion stays unowned)", () => {
  const CTX: ClassifierContext = {
    playerActorId: "pc.you",
    locationId: "loc.room",
    locationName: "A Rented Room",
    exits: [],
    presentEntities: [{ id: "npc.oda", name: "Oda" }],
    companionIds: ["npc.oda"],
    carriedItems: [],
  };

  const rawFreeform = (toNpcId: string | null) => ({
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: baseCheck,
    effects: [{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId }],
    confidence: 0.9,
  });

  test("a companion payee the line never names stays unowned — never mis-credited", () => {
    const plan = reconcilePlan(rawFreeform("npc.oda"), CTX, "I leave two silver on the crate beside the cup.");
    expect(plan.effects?.[0]?.toNpcId).toBeNull();
  });

  test("the SAME companion payee is kept once the line actually names them", () => {
    const plan = reconcilePlan(rawFreeform("npc.oda"), CTX, "I leave two silver on the crate for Oda.");
    expect(plan.effects?.[0]?.toNpcId).toBe("npc.oda");
  });
});
