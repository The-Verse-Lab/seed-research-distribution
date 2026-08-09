/**
 * Grounded freeform effects — the channel that ends the "prose-only transaction" class.
 *
 * A freeform/dialogue line that physically hands over money or objects rides an `effects[]`
 * proposal on the SAME classifier call; `reconcilePlan` grounds each against the world and the
 * engine mints real reducer commands (reusing the itemAction resolvers), with an honest note when
 * nothing grounds. Covers: reconcile grounding/dropping, engine minting + purse clamp, the
 * ambient-coin-regex precedence (no double deduction), and the honest-refusal note.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { reconcilePlan, type TurnClassifier } from "../src/engine/classify.ts";
import { freeformPlan, type ClassifierContext, type TurnEffect, type TurnPlan } from "../src/engine/turn-plan.ts";
import { byKind, loadExample } from "./support/harness.ts";
import type { PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

// --- reconcilePlan grounding (pure) ----------------------------------------

const baseCheck = { warranted: false, ability: null, skill: null, dc: null, reason: "" };

const CTX: ClassifierContext = {
  playerActorId: "pc.you",
  locationId: "loc.tavern",
  locationName: "The Ashen Tankard",
  exits: [{ id: "loc.square", name: "Emberford Square" }],
  presentEntities: [{ id: "npc.brann", name: "Brann" }],
  companionIds: [],
  carriedItems: [{ id: "weapon.dagger", name: "Dagger" }],
  floorItems: [{ id: "weapon.club", name: "Club" }],
};

const rawFreeform = (effects: unknown) => ({
  kind: "freeformNarrative",
  targetId: null,
  destinationLocationId: null,
  check: baseCheck,
  effects,
  confidence: 0.9,
});

describe("reconcilePlan effects grounding", () => {
  test("a sane spendCoins grounds (amount kept, recipient present-checked)", () => {
    const p = reconcilePlan(rawFreeform([{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId: "npc.brann" }]), CTX);
    expect(p.effects).toEqual([{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId: "npc.brann" }]);
    expect(p.effectsDropped).toBeUndefined();
    // A hallucinated recipient degrades to an unaimed spend, not a dropped effect.
    const ghost = reconcilePlan(rawFreeform([{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId: "npc.ghost" }]), CTX);
    expect(ghost.effects?.[0]?.toNpcId).toBeNull();
  });

  test("nonsense amounts and hallucinated ids DROP, marking effectsDropped when nothing survives", () => {
    for (const bad of [0, -5, 2.5, null]) {
      const p = reconcilePlan(rawFreeform([{ type: "spendCoins", amountCp: bad, itemId: null, toNpcId: null }]), CTX);
      expect(p.effects).toBeUndefined();
      expect(p.effectsDropped).toBe(true);
    }
    const badItem = reconcilePlan(rawFreeform([{ type: "giveItem", amountCp: null, itemId: "item.hallucinated", toNpcId: "npc.brann" }]), CTX);
    expect(badItem.effects).toBeUndefined();
    expect(badItem.effectsDropped).toBe(true);
  });

  test("giveItem needs carried + present; pickupItem grounds against the FLOOR pool", () => {
    const give = reconcilePlan(rawFreeform([{ type: "giveItem", amountCp: null, itemId: "weapon.dagger", toNpcId: "npc.brann" }]), CTX);
    expect(give.effects?.[0]).toMatchObject({ type: "giveItem", itemId: "weapon.dagger", toNpcId: "npc.brann" });
    const pickup = reconcilePlan(rawFreeform([{ type: "pickupItem", amountCp: null, itemId: "weapon.club", toNpcId: null }]), CTX);
    expect(pickup.effects?.[0]).toMatchObject({ type: "pickupItem", itemId: "weapon.club" });
    // Carried id is not a pickup target; floor id is not a give target.
    expect(reconcilePlan(rawFreeform([{ type: "pickupItem", amountCp: null, itemId: "weapon.dagger", toNpcId: null }]), CTX).effectsDropped).toBe(true);
    expect(reconcilePlan(rawFreeform([{ type: "giveItem", amountCp: null, itemId: "weapon.club", toNpcId: "npc.brann" }]), CTX).effectsDropped).toBe(true);
  });

  test("acceptItem with NO giver grounds as the unattended-prop take (r5 P2)", () => {
    const take = reconcilePlan(
      rawFreeform([{ type: "acceptItem", amountCp: null, itemId: "sealed note", toNpcId: null }]),
      CTX,
    );
    expect(take.effects?.[0]).toMatchObject({ type: "acceptItem", itemId: "item.sealed-note", toNpcId: null });
    // A giver who is NOT present still drops: that is a hand-over that did not happen.
    expect(
      reconcilePlan(
        rawFreeform([{ type: "acceptItem", amountCp: null, itemId: "ribbon", toNpcId: "npc.ghost" }]),
        CTX,
      ).effectsDropped,
    ).toBe(true);
  });

  test("the effect count caps at 3 and non-freeform kinds carry no effects", () => {
    const many = Array.from({ length: 6 }, () => ({ type: "spendCoins", amountCp: 1, itemId: null, toNpcId: null }));
    expect(reconcilePlan(rawFreeform(many), CTX).effects).toHaveLength(3);
    const onAttack = reconcilePlan(
      { ...rawFreeform([{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId: null }]), kind: "attack", targetId: "npc.brann" },
      CTX,
    );
    expect(onAttack.effects).toBeUndefined();
  });

  test("a CHECKED attempt carries the transfer — the r14 coin-throw (fixture-travel t8)", () => {
    // "I fling a fistful of copper at the revenant's eyes and break for the door" classifies as
    // attemptRequiringCheck (dex/Sleight of Hand); the roll decides whether the throw blinds it,
    // never whether the coppers were real. Live, the plan could not carry the transfer at all:
    // the narrator wrote "the coppers leave your hand in a scatter" and the purse never moved.
    const thrown = reconcilePlan(
      {
        ...rawFreeform([{ type: "spendCoins", amountCp: 5, itemId: null, toNpcId: null }]),
        kind: "attemptRequiringCheck",
        check: { warranted: true, ability: "dex", skill: "Sleight of Hand", dc: 13, reason: "blinding the revenant" },
      },
      CTX,
    );
    expect(thrown.effects).toEqual([{ type: "spendCoins", amountCp: 5, itemId: null, toNpcId: null }]);
    // A carried thing shoved into someone's hands mid-scramble grounds the same way.
    const shoved = reconcilePlan(
      {
        ...rawFreeform([{ type: "giveItem", amountCp: null, itemId: "weapon.dagger", toNpcId: "npc.brann" }]),
        kind: "attemptRequiringCheck",
      },
      CTX,
    );
    expect(shoved.effects?.[0]).toMatchObject({ type: "giveItem", itemId: "weapon.dagger", toNpcId: "npc.brann" });
  });
});

// --- Engine minting (end-to-end) -------------------------------------------

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
        currentHp: 24,
        locationId: "loc.tavern",
        coins: 750,
        inventory: ["weapon.dagger"],
        conditions: [],
      },
      // Statted so the give resolver can hand him things (a statless NPC honestly refuses).
      "npc.brann": {
        id: "npc.brann",
        currentHp: 10,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    flags: {},
  };
}

function effectsClassifier(effects: TurnEffect[] | null, extra: Partial<TurnPlan> = {}): TurnClassifier {
  return {
    classify: async () => ({
      ...freeformPlan(),
      ...(effects ? { effects } : {}),
      ...extra,
    }),
  };
}

async function makeEngine(classifier: TurnClassifier): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), seededState(playset));
  const engine = new GameEngine({ classifier, playset, store, gateway: new OfflineGateway(), rng: mulberry32(7) });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("engine minting of grounded effects", () => {
  test("a grounded spendCoins deducts through the reducer and prepends the mechanical beat (the stew repro)", async () => {
    const { engine, events } = await makeEngine(
      effectsClassifier([{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId: "npc.brann" }]),
    );

    await engine.submitPlayerInput("I set two silver on Brann's counter for a bowl of stew");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(730);
    const coinLines = byKind(events, "stateChanged").filter((e) => e.summary.includes("hand over"));
    expect(coinLines).toHaveLength(1);
    expect(coinLines[0]?.summary).toBe("You hand over 2 sp to Brann.");
    // The narration trigger leads with the authoritative beat, so the prose grounds on the real spend.
    expect(byKind(events, "narration")[0]?.text).toContain("You hand over 2 sp to Brann.");
  });

  test("the spend clamps to the purse and says so", async () => {
    const { engine, events } = await makeEngine(
      effectsClassifier([{ type: "spendCoins", amountCp: 100_000, itemId: null, toNpcId: null }]),
    );

    await engine.submitPlayerInput("I dump my whole purse on the table");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(0);
    expect(byKind(events, "stateChanged").some((e) => e.summary.includes("all you have"))).toBe(true);
  });

  test("a giveItem effect transfers through the SAME give resolver (warmth included), once", async () => {
    const { engine, events } = await makeEngine(
      effectsClassifier([{ type: "giveItem", amountCp: null, itemId: "weapon.dagger", toNpcId: "npc.brann" }]),
    );

    await engine.submitPlayerInput("I slide my dagger across the bar to Brann, hilt first");

    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "weapon.dagger", from: "pc.you", to: "npc.brann" }),
    ]);
    expect(engine.getState().actors["pc.you"]?.inventory).not.toContain("weapon.dagger");
    expect(byKind(events, "relationshipChanged").length).toBeGreaterThanOrEqual(1);
  });

  test("a grounded spendCoins takes precedence over the ambient coin regex — ONE deduction", async () => {
    const { engine, events } = await makeEngine(
      effectsClassifier([{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId: "npc.brann" }]),
    );

    // This phrasing also matches the legacy ambient-gift regex; only the grounded effect may fire.
    await engine.submitPlayerInput("I give two silver to Brann");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(730);
    const coinChanges = byKind(events, "coinsChanged");
    expect(coinChanges).toHaveLength(1);
  });

  test("effectsDropped yields the honest nothing-changed note and an untouched purse", async () => {
    const { engine, events } = await makeEngine(effectsClassifier(null, { effectsDropped: true, coinsDropped: true }));

    await engine.submitPlayerInput("I pay the ferryman with the ghost coins of my ancestors");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(750);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(byKind(events, "narration")[0]?.text).toContain("Nothing actually changes hands");
  });

  test("a dropped ITEM transfer must NOT shield a real prose payment (the r6 vest exploit)", async () => {
    // Live r6: "I count five silver onto the table" for a salt-iron vest the PC didn't yet own.
    // The classifier's giveItem dropped (not carried), which silenced the coin rescue — the vest
    // entered the fiction and the purse never moved. A dropped item must not quiet the coins.
    const { engine, events } = await makeEngine(
      effectsClassifier([{ type: "giveItem", amountCp: null, itemId: "item.salt-iron-vest", toNpcId: "npc.brann" }]),
    );

    await engine.submitPlayerInput("I count five silver onto the table for the vest");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(700);
    expect(byKind(events, "stateChanged").some((e) => e.summary.includes("give away 5 silver"))).toBe(true);
    expect(byKind(events, "narration")[0]?.text).not.toContain("Nothing actually changes hands");
  });

  test("an unattended prose object really enters the pack — and only if the prose put it there", async () => {
    // r5 P2: "I fold Veil's sealed note into my coat" ended with the narration insisting the note
    // still lay on the counter, and the note never became anything the player could read or carry.
    const NOTE = { type: "acceptItem", amountCp: null, itemId: "item.sealed-note", toNpcId: null } as TurnEffect;

    // Nothing in the transcript has ever mentioned a sealed note ⇒ the player cannot mint one.
    const bare = await makeEngine(effectsClassifier([NOTE]));
    await bare.engine.submitPlayerInput("I fold the sealed note into my coat.");
    expect(bare.engine.getState().actors["pc.you"]?.inventory).not.toContain("item.sealed-note");

    // With the scene having NAMED it, the same line lands: the note becomes a real, carried object.
    const playset = await loadExample();
    const store = new InMemoryGameStateStore();
    const key = makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]);
    await store.save(key, seededState(playset));
    await store.commitTurn(key, seededState(playset), [
      { kind: "narration", seq: 1, text: "A sealed note lies on the counter where the sergeant left it." } as GameEvent,
    ]);
    const engine = new GameEngine({
      classifier: effectsClassifier([NOTE]),
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await engine.start();
    await engine.submitPlayerInput("I fold the sealed note into my coat.");
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.sealed-note");
  });

  test("the legacy ambient regex still works when NO effects ride the plan (fallback intact)", async () => {
    const { engine, events } = await makeEngine(effectsClassifier(null));

    await engine.submitPlayerInput("I give two silver to the barkeep");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(730);
    expect(byKind(events, "stateChanged").some((e) => e.summary.includes("give away"))).toBe(true);
  });

  test("coins thrown UNDER A ROLL really leave the purse (r14 fixture-travel t8)", async () => {
    const attempt = {
      kind: "attemptRequiringCheck" as const,
      check: { warranted: true, ability: "dex" as const, skill: "Sleight of Hand", dc: 13, reason: "blinding it" },
    };
    const { engine, events } = await makeEngine(
      effectsClassifier([{ type: "spendCoins", amountCp: 5, itemId: null, toNpcId: null }], attempt),
    );

    await engine.submitPlayerInput("I fling a fistful of copper at its eyes and break for the door.");

    // Live, the check outranked the transfer: the prose scattered the coppers and the purse read
    // 750 before and 750 after, and the NEXT turn's narration was still spending money that never left.
    expect(engine.getState().actors["pc.you"]?.coins).toBe(745);
    expect(byKind(events, "coinsChanged")).toHaveLength(1);
    // The narrator is handed the real spend as a fact to ground on, so the prose can't invent one.
    expect(byKind(events, "narration")[0]?.text).toContain("5 cp");
  });

  test("the ambient coin REGEX stays off a checked attempt (no rescue-charge for money not spent)", async () => {
    // The rescue reads the raw line and was tuned on transfers; on an attempt it would charge for
    // coin the player is stealing, counting or merely reaching for. Only a grounded effect may pay.
    const { engine, events } = await makeEngine(
      effectsClassifier(null, {
        kind: "attemptRequiringCheck",
        check: { warranted: true, ability: "dex", skill: "Sleight of Hand", dc: 13, reason: "lifting the purse" },
      }),
    );

    await engine.submitPlayerInput("I slip two silver coins out of the barkeep's till without a sound");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(750);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
  });
});

describe("compound-intent honest drop (PROSE-TO-CODE §2.4)", () => {
  test("a plan carrying droppedIntent surfaces the unrepresented half as a ledger line", async () => {
    const { engine, events } = await makeEngine({
      classify: async () => ({ ...freeformPlan(), kind: "movement", destinationLocationId: "loc.square", droppedIntent: "sending the others away" }),
    });
    await engine.submitPlayerInput("We go to the square — just the two of us.");
    const note = events.find(
      (e): e is Extract<GameEvent, { kind: "stateChanged" }> =>
        e.kind === "stateChanged" && typeof e.summary === "string" && e.summary.includes("sending the others away"),
    );
    expect(note?.summary).toContain("One thing at a time");
    expect(note?.summary).toContain("hasn't happened");
  });

  test("no droppedIntent ⇒ no note (byte-stable silence for whole-line plans)", async () => {
    const { engine, events } = await makeEngine({
      classify: async () => ({ ...freeformPlan(), kind: "movement", destinationLocationId: "loc.square" }),
    });
    await engine.submitPlayerInput("We go to the square.");
    expect(events.some((e) => e.kind === "stateChanged" && String((e as { summary?: string }).summary).includes("One thing at a time"))).toBe(false);
  });
});

describe("settle-then-move (PROSE-TO-CODE §2.4 / r11 F-11)", () => {
  const rawWith = (kind: string, secondaryMove: unknown) => ({
    kind,
    targetId: null,
    destinationLocationId: null,
    check: baseCheck,
    secondaryMove,
    confidence: 0.9,
  });

  test("a settle kind keeps a GROUNDED walk; the id survives reconcile", () => {
    const p = reconcilePlan(
      rawWith("questAction", { destinationLocationId: "loc.square", destinationName: "the square" }),
      CTX,
    );
    expect(p.secondaryMove).toEqual({ destinationLocationId: "loc.square", destinationName: "the square" });
  });

  test("an ungrounded name, the room you're already in, and a movement primary all drop it", () => {
    expect(
      reconcilePlan(rawWith("questAction", { destinationLocationId: null, destinationName: "Vellmere" }), CTX)
        .secondaryMove,
    ).toBeUndefined();
    expect(
      reconcilePlan(rawWith("trade", { destinationLocationId: "loc.tavern", destinationName: null }), CTX)
        .secondaryMove,
    ).toBeUndefined();
    // A movement line's walk IS the plan — never a second half of itself.
    expect(
      reconcilePlan(rawWith("movement", { destinationLocationId: "loc.square", destinationName: null }), CTX)
        .secondaryMove,
    ).toBeUndefined();
  });

  test("a NON-settle kind cannot smuggle a move (the whitelist is the whole guarantee)", () => {
    for (const kind of ["freeformNarrative", "attack", "rest", "itemAction", "attemptRequiringCheck"]) {
      expect(
        reconcilePlan(rawWith(kind, { destinationLocationId: "loc.square", destinationName: null }), CTX).secondaryMove,
      ).toBeUndefined();
    }
  });

  test("the engine settles FIRST and then walks — the r11 repro, both halves honoured", async () => {
    // r11 F-11: "I take the caravan salvage claim and head west on the road" kept the movement and
    // dropped the accept; the flagship's own set-piece then sat `offered` for the rest of the run.
    const { engine, events } = await makeEngine({
      classify: async () => ({
        ...freeformPlan(),
        kind: "dialogueToNpc",
        targetId: "npc.brann",
        effects: [{ type: "spendCoins", amountCp: 20, itemId: null, toNpcId: "npc.brann" }],
        secondaryMove: { destinationLocationId: "loc.square", destinationName: "the square" },
      }),
    });

    await engine.submitPlayerInput("Two silver for the bond, Brann — then I'm away to the square.");

    expect(engine.getState().actors["pc.you"]?.coins).toBe(730); // the settle committed FIRST
    expect(engine.getState().partyLocationId).toBe("loc.square");
    expect(
      byKind(events, "stateChanged").some((e) => e.summary.includes("The party moves to Emberford Square")),
    ).toBe(true);
  });

  test("a DETERMINISTIC settle's tail is prose, never an instruction (live r11 regression)", async () => {
    // The first live pass appended a GM instruction to the quest-accept line — which is finished
    // player-facing prose that skips the model — and the instruction printed on screen word for word.
    // The settle is an INQUIRY (r12): a question settles by being answered, so its tail move runs
    // without a committed exchange — a non-inquiry trade that never commits now keeps the party put
    // (see tests/settle-then-move.test.ts).
    const { engine, events } = await makeEngine({
      classify: async () => ({
        ...freeformPlan(),
        kind: "trade",
        trade: { direction: "buy", itemId: null, vendorId: null, inquiry: true },
        secondaryMove: { destinationLocationId: "loc.square", destinationName: "the square" },
      }),
    });

    await engine.submitPlayerInput("I settle up here and I'm off to the square.");

    expect(engine.getState().partyLocationId).toBe("loc.square");
    const prose = byKind(events, "narration").map((e) => e.text).join("\n");
    expect(prose).not.toContain("(GM:");
    expect(prose).not.toContain("narrate the leaving");
  });
});
