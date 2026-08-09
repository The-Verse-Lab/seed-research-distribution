/**
 * Errands — the away-and-back primitive (r5 fix wave, r4 playtest P3).
 *
 * "A delegated errand returns no report": the r4 run sent a companion to a guild with two precise
 * questions, met him again later, and got nothing. The fix is a code-owned result — these tests
 * pin that the finding is COMPUTED from authored content and live registry rows, never improvised,
 * and that it reaches the player three ways (beat, the runner's own journal, the case ledger).
 *
 * The zero-rng assertion is load-bearing: an errand turn that drew from the shared stream would
 * shift every downstream roll and break the exact-value combat tests.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  ERRANDS_MODULE,
  bestKnowledgeLine,
  defaultErrandsSlice,
  errandDueClock,
  errandEtaLabel,
  errandFee,
  readErrandsSlice,
  resolveErrandTask,
  type Errand,
} from "../src/rules/errands.ts";
import { ErrandsModule } from "../src/modules/errands/module.ts";
import { EVENTS_MODULE, readEventsCursor } from "../src/modules/events/module.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { applyCommand } from "../src/world/reducer.ts";
import type { Command } from "../src/world/commands.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { reduceDeltas } from "./support/replay.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";

const CASE_ID = "case.the-list";

/**
 * Two neutral authored beats stand AT the errand destination: a flag-gated repeat toll
 * (`once: "visit"`) and a quest-gated hand-over (`once: "campaign"`). Both carry a second trigger
 * clause so delegated travel cannot fire an event selected only by its location clause.
 */
const DESTINATION_EVENTS = [
  {
    id: "ev.toll-again",
    when: "onEnterLocation",
    once: "visit",
    trigger: {
      allOf: [
        { kind: "atLocation", locationId: "loc.there" },
        { kind: "flag", key: "there.tolled", equals: true },
      ],
    },
    effects: [
      { kind: "narrate", text: "The clerk knows the hand before he knows the face: two coppers." },
      { kind: "adjustCoins", by: -2 },
    ],
  },
  {
    id: "ev.wreck-found",
    when: "onEnterLocation",
    once: "campaign",
    trigger: {
      allOf: [
        { kind: "atLocation", locationId: "loc.there" },
        { kind: "questState", questId: "q.salvage", state: "active" },
      ],
    },
    effects: [
      { kind: "narrate", text: "Under the lead driver's bench, the bond-writ." },
      { kind: "giveItem", itemId: "item.writ", to: "pc.you" },
      { kind: "setObjectiveDone", questId: "q.salvage", objectiveId: "o1" },
    ],
  },
];

function buildPlayset(withDestinationEvents = false): PlaySet {
  const world = WorldSchema.parse({
    id: "w.errand",
    name: "Two Towns",
    summary: "A test world.",
    items: [{ id: "item.writ", name: "Writ of Salt", description: "A guild instrument.", kind: "quest", properties: { baseCostCp: 100 } }],
    locations: [
      {
        id: "loc.here",
        name: "The Taproom",
        description: "A low room.",
        npcs: ["npc.oda"],
        exits: [{ to: "loc.there", name: "the west road", minutes: 60 }],
      },
      {
        id: "loc.there",
        name: "The Counting-House",
        description: "A hall of ledgers and dust.",
        npcs: ["npc.selis"],
        exits: [{ to: "loc.here", name: "back east", minutes: 60 }],
      },
    ],
    npcs: [
      { id: "npc.oda", name: "Oda", persona: "A weathered wayfarer.", age: 50 },
      {
        id: "npc.selis",
        name: "Selis",
        persona: "A guild factor.",
        age: 60,
        knowledge: [
          "The salt-bond was lodged against a caravan that never arrived.",
          "The harbor tolls were raised twice this season.",
        ],
        knownLore: "The Guild keeps no counter west of here.",
        vendor: { priceModifier: 1.2 },
        inventory: ["item.writ"],
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.errand",
    name: "Test Campaign",
    worldId: "w.errand",
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 },
        coins: 500,
        age: 30,
      },
    ],
    startingState: { locationId: "loc.here", party: ["pc.you"], clock: 480 },
    // Opt-in so every pre-existing spec parses a byte-identical campaign.
    ...(withDestinationEvents ? { events: DESTINATION_EVENTS } : {}),
    quests: [
      { id: "q.list", name: "The List", description: "Find the list.", state: "active", objectives: [] },
      ...(withDestinationEvents
        ? [
            {
              id: "q.salvage",
              name: "Salvage",
              description: "Find the wreck.",
              state: "hidden",
              objectives: [{ id: "o1", description: "Recover the bond-writ." }],
            },
          ]
        : []),
    ],
    cases: [
      {
        id: CASE_ID,
        name: "The List",
        questId: "q.list",
        truth: { culpritId: "npc.selis", method: "ledger", motive: "debt", summary: "She sold it." },
        facts: [
          { id: "fact.ledger", text: "The bond was signed twice.", kind: "physical", core: true },
          { id: "fact.name", text: "The factor's own hand is on both.", kind: "testimony", core: true },
        ],
        clues: [{ id: "clue.talk", revealsFactIds: ["fact.ledger", "fact.name"], via: "testimony", sourceId: "npc.selis" }],
        npcKnowledge: { "npc.selis": { knows: ["fact.ledger"], believes: [], asserts: [] } },
        accusation: { requiredCoreFacts: ["fact.ledger", "fact.name"], culpritResponse: "surrender" },
      },
    ],
  });
  return { world, campaign };
}

async function buildModel(withDestinationEvents = false): Promise<{ model: WorldModel; playset: PlaySet }> {
  const playset = buildPlayset(withDestinationEvents);
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
  await engine.start();
  return { model: fromGameState(engine.getState(), playset.world, playset.campaign), playset };
}

const RESOLVE_CTX = (model: WorldModel, playset: PlaySet, destinationId: string, playerCoins = 500) => ({
  model,
  world: playset.world,
  campaign: playset.campaign,
  runnerName: "Oda",
  destinationId,
  playerCoins,
});

function seedErrand(model: WorldModel, over: Partial<Errand> = {}): Errand {
  const errand: Errand = {
    id: "err:npc.oda:480",
    runnerId: "npc.oda",
    task: { kind: "ask", subjectId: "npc.selis", topic: "the salt-bond" },
    destinationId: "loc.there",
    reportLocationId: "loc.here",
    homeLocationId: "loc.here",
    departedAtClock: 480,
    dueAtClock: 485,
    feeCp: 20,
    ...over,
  };
  const slice = defaultErrandsSlice();
  slice.active[errand.runnerId] = errand;
  applyCommand(model, { type: "modulePatch", module: ERRANDS_MODULE, patch: { ...slice } });
  applyCommand(model, { type: "moveEntity", entityId: errand.runnerId, to: errand.destinationId, teleport: true });
  return errand;
}

function fakeCtx(model: WorldModel, clockMinutes = 10) {
  const enqueued: Command[] = [];
  const silent: Command[] = [];
  const data: Record<string, unknown> = { clockMinutes };
  const ctx = {
    trigger: { kind: "player", input: "I wait." },
    model,
    services: {},
    recent: [],
    data,
    queue: [] as Command[],
    enqueue: (c: Command) => enqueued.push(c),
    apply: () => {},
    applySilent: (c: Command) => {
      silent.push(c);
      applyCommand(model, c);
    },
    emit: () => {},
    state: () => toGameState(model),
  } as unknown as TickContext;
  return { ctx, enqueued, silent, data };
}

/** Run the module, then apply what it enqueued — the commit chokepoint, in miniature. */
function land(model: WorldModel, playset: PlaySet, clockMinutes = 10) {
  const { ctx, enqueued, silent, data } = fakeCtx(model, clockMinutes);
  new ErrandsModule(playset.world, playset.campaign).phases.react?.(ctx);
  for (const cmd of enqueued) applyCommand(model, cmd);
  return { enqueued, silent, data };
}

describe("resolveErrandTask — the finding is computed, never improvised", () => {
  test("ask picks the authored knowledge line with the best topic overlap", async () => {
    const { model, playset } = await buildModel();
    applyCommand(model, { type: "modulePatch", module: "cases", patch: {} });
    // Give the player the case fact already, so the knowledge branch (not the case branch) runs.
    applyCommand(model, {
      type: "revealCaseFact",
      caseId: CASE_ID,
      factId: "fact.ledger",
      factText: "The bond was signed twice.",
      witnesses: [],
    });
    const out = resolveErrandTask(
      { kind: "ask", subjectId: "npc.selis", topic: "harbor tolls this season" },
      RESOLVE_CTX(model, playset, "loc.there"),
    );
    expect(out.outcome).toBe("delivered");
    expect(out.findings.join(" ")).toContain("harbor tolls were raised twice");
  });

  test("ask prefers an unshared CASE fact over flavour knowledge, and names it for the ledger", async () => {
    const { model, playset } = await buildModel();
    const out = resolveErrandTask(
      { kind: "ask", subjectId: "npc.selis", topic: "the salt-bond" },
      RESOLVE_CTX(model, playset, "loc.there"),
    );
    expect(out.caseFact).toEqual({ caseId: CASE_ID, factId: "fact.ledger" });
    expect(out.findings.join(" ")).toContain("The bond was signed twice.");
  });

  test("a subject who has moved away yields an EMPTY report that names the absence", async () => {
    const { model, playset } = await buildModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.selis", to: "loc.here", teleport: true });
    const out = resolveErrandTask(
      { kind: "ask", subjectId: "npc.selis", topic: "anything" },
      RESOLVE_CTX(model, playset, "loc.there"),
    );
    expect(out.outcome).toBe("empty");
    expect(out.findings[0]).toBe("Oda found no sign of Selis at The Counting-House.");
  });

  test("bring delivers a present, conscious, unaffiliated subject", async () => {
    const { model, playset } = await buildModel();
    const out = resolveErrandTask({ kind: "bring", subjectId: "npc.selis" }, RESOLVE_CTX(model, playset, "loc.there"));
    expect(out.outcome).toBe("delivered");
    expect(out.broughtId).toBe("npc.selis");
  });

  test("scout reports the real occupants and the authored description, inventing nothing", async () => {
    const { model, playset } = await buildModel();
    const out = resolveErrandTask({ kind: "scout", locationId: "loc.there" }, RESOLVE_CTX(model, playset, "loc.there"));
    expect(out.findings.join(" ")).toContain("A hall of ledgers and dust.");
    expect(out.findings.join(" ")).toContain("Who was there: Selis.");
  });

  test("fetch prices off the vendor's own modifier and refuses beyond the player's purse", async () => {
    const { model, playset } = await buildModel();
    const ok = resolveErrandTask(
      { kind: "fetch", locationId: "loc.there", itemId: "item.writ" },
      RESOLVE_CTX(model, playset, "loc.there"),
    );
    expect(ok.bought).toEqual({ itemId: "item.writ", costCp: 120 }); // 100 base x 1.2
    const broke = resolveErrandTask(
      { kind: "fetch", locationId: "loc.there", itemId: "item.writ" },
      RESOLVE_CTX(model, playset, "loc.there", 5),
    );
    expect(broke.outcome).toBe("empty");
    expect(broke.bought).toBeUndefined();
  });

  test("bestKnowledgeLine returns null rather than an unrelated line", () => {
    expect(bestKnowledgeLine({ knowledge: ["the tide runs east"] } as never, "glassmaking quotas")).toBeNull();
  });

  test("fee/ETA helpers are pure arithmetic on the route", () => {
    expect(errandFee(60)).toBe(10); // floored
    expect(errandFee(600)).toBe(100);
    expect(errandDueClock(480, 60)).toBe(480 + 120 + 30);
    expect(errandEtaLabel(480 + 150)).toContain("day 1");
  });
});

describe("ErrandsModule — landing the errand", () => {
  test("a due errand walks the runner home, beats it, journals it, and clears the slice", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model);
    const { enqueued, data } = land(model, playset);

    expect(enqueued.some((c) => c.type === "moveEntity" && c.entityId === "npc.oda" && c.to === "loc.here")).toBe(true);
    expect(enqueued.some((c) => c.type === "recordNpcMemory" && c.npcId === "npc.oda")).toBe(true);
    // The case fact reaches BOTH the runner's head and the case ledger.
    expect(
      enqueued.some((c) => c.type === "npcLearnCaseFact" && c.npcId === "npc.oda" && c.factId === "fact.ledger"),
    ).toBe(true);
    expect((data.eventBeats as string[]).join(" ")).toContain("Oda is back from The Counting-House.");
    const slice = readErrandsSlice(model.modules);
    expect(slice.active["npc.oda"]).toBeUndefined();
    expect(slice.reports["npc.oda"]?.outcome).toBe("delivered");
  });

  test("an errand that is NOT yet due does nothing at all", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model, { dueAtClock: 5000 });
    const { enqueued, data } = land(model, playset);
    expect(enqueued).toHaveLength(0);
    expect(data.eventBeats).toBeUndefined();
    expect(readErrandsSlice(model.modules).active["npc.oda"]).toBeDefined();
  });

  test("it lands on the turn whose OWN clock cost crosses the due hour", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model, { dueAtClock: 540 }); // clock is 480; a 10-minute turn is not enough
    expect(land(model, playset, 10).enqueued).toHaveLength(0);
    expect(land(model, playset, 60).enqueued.length).toBeGreaterThan(0);
  });

  test("a delivered bring teleports the subject too and PINS them, so routines cannot reclaim them", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model, { task: { kind: "bring", subjectId: "npc.selis" } });
    land(model, playset);
    expect(model.entities.get("npc.selis")?.locationId).toBe("loc.here");
    const routines = (model.modules.routines ?? {}) as { overrides?: Record<string, { locationId: string }> };
    expect(routines.overrides?.["npc.selis"]?.locationId).toBe("loc.here");
  });

  test("a report delivered while the party is ELSEWHERE writes state but narrates nothing", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model);
    applyCommand(model, { type: "moveParty", to: "loc.there", teleport: true });
    const { data } = land(model, playset);
    expect(data.eventBeats).toBeUndefined();
    expect(readErrandsSlice(model.modules).reports["npc.oda"]).toBeDefined();
  });

  test("a runner downed mid-errand is dropped cleanly — no ghost walks home", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model);
    applyCommand(model, {
      type: "spawnEntity",
      entity: { id: "npc.oda2", kind: "npc", tier: "tracked", name: "Oda", locationId: "loc.there", stats: { currentHp: 0, maxHp: 10, inventory: [] } },
    });
    // Re-seed onto the statted, downed body.
    const slice = defaultErrandsSlice();
    slice.active["npc.oda2"] = { ...seedErrand(model), runnerId: "npc.oda2" };
    applyCommand(model, { type: "modulePatch", module: ERRANDS_MODULE, patch: { ...slice } });
    const { enqueued } = land(model, playset);
    expect(enqueued.some((c) => c.type === "moveEntity" && c.entityId === "npc.oda2")).toBe(false);
    expect(readErrandsSlice(model.modules).active["npc.oda2"]).toBeUndefined();
  });

  test("a paid errand that produced nothing refunds the fee, paired so no coin is minted", async () => {
    const { model, playset } = await buildModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.selis", to: "loc.here", teleport: true });
    seedErrand(model, { feeCp: 20 });
    const { enqueued } = land(model, playset);
    const credit = enqueued.filter((c) => c.type === "adjustCoins" && c.entityId === "pc.you" && c.by === 20);
    expect(credit).toHaveLength(1);
    // The runner is statless here, so no debit is emitted against a body that cannot hold coin —
    // and the credit still lands. (A statted runner gets the paired debit.)
    expect(enqueued.some((c) => c.type === "adjustCoins" && c.entityId === "npc.oda")).toBe(false);
  });

  test("combat defers the landing by a turn rather than teleporting a body into a fight", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model);
    applyCommand(model, { type: "startCombat", locationId: "loc.here", order: ["pc.you"], round: 1, turnIndex: 0 });
    expect(land(model, playset).enqueued).toHaveLength(0);
    applyCommand(model, { type: "endCombat" });
    expect(land(model, playset).enqueued.length).toBeGreaterThan(0);
  });

  test("an errand turn draws ZERO from the shared rng — no downstream roll can shift", async () => {
    const { model, playset } = await buildModel();
    seedErrand(model);
    let draws = 0;
    const { ctx, enqueued } = fakeCtx(model);
    (ctx.services as unknown as Record<string, unknown>).rng = () => {
      draws++;
      return 0.5;
    };
    new ErrandsModule(playset.world, playset.campaign).phases.react?.(ctx);
    expect(enqueued.length).toBeGreaterThan(0);
    expect(draws).toBe(0);
  });

  test("snapshot == fold(deltas) across a full dispatch → return", async () => {
    const { model, playset } = await buildModel();
    const seed = fromGameState(toGameState(model), playset.world, playset.campaign);
    const deltas: DeltaEvent[] = [];
    const record = (cmd: Command): void => {
      const res = applyCommand(model, cmd);
      deltas.push(...(res.deltas as DeltaEvent[]));
    };

    const errand = seedErrand(model);
    // Re-record those two through the delta collector so the fold sees them.
    const slice = defaultErrandsSlice();
    slice.active[errand.runnerId] = errand;
    record({ type: "modulePatch", module: ERRANDS_MODULE, patch: { ...slice } });
    record({ type: "moveEntity", entityId: errand.runnerId, to: errand.destinationId, teleport: true });

    const { ctx, enqueued, silent } = fakeCtx(model, 200);
    // Capture the module's own silent writes as deltas too.
    (ctx as unknown as { applySilent: (c: Command) => void }).applySilent = (c: Command) => {
      silent.push(c);
      deltas.push(...(applyCommand(model, c).deltas as DeltaEvent[]));
    };
    new ErrandsModule(playset.world, playset.campaign).phases.react?.(ctx);
    for (const cmd of enqueued) record(cmd);

    reduceDeltas(seed, deltas);
    expect(toGameState(seed)).toEqual(toGameState(model));
  });
});

/**
 * Offstage authored beats — the r8 P0.
 *
 * `fireOffstageEvents` used to select any `onEnterLocation` event that merely CONTAINED an
 * `atLocation` clause naming the destination, then run its effects: every other clause of the
 * `allOf` was ignored, and so was the `once` cursor. In the original authored corpus that meant an
 * errand to Umberwick paid the countess's repeat toll with `umberwick.tolled` still false and
 * re-paid it on every subsequent errand, and an errand to the caravan wreck handed over the
 * bond-writ (and ticked its objective) while the quest gating it was still HIDDEN — then handed it
 * over a second time when the player actually walked in. The sibling offstage path
 * (`src/modules/npc-events/module.ts`) always ran the full `evalPredicate`; errands were the one
 * place that didn't.
 *
 * The destination stands in for the party location, because the runner is the one in that room —
 * every other clause reads the real world.
 */
describe("ErrandsModule — an offstage beat obeys the WHOLE predicate and the once cursor", () => {
  const coinsOf = (model: WorldModel): number => model.entities.get("pc.you")?.stats?.coins ?? 0;
  const holdsWrit = (model: WorldModel): boolean =>
    model.entities.get("pc.you")?.stats?.inventory.includes("item.writ") ?? false;
  const findings = (model: WorldModel): string => (readErrandsSlice(model.modules).reports["npc.oda"]?.findings ?? []).join(" ");

  test("a FALSE clause keeps the beat shut — no toll is paid that was never levied", async () => {
    const { model, playset } = await buildModel(true);
    seedErrand(model);
    const before = coinsOf(model);
    const { enqueued } = land(model, playset);

    expect(enqueued.some((c) => c.type === "adjustCoins" && c.entityId === "pc.you")).toBe(false);
    expect(coinsOf(model)).toBe(before);
    expect(findings(model)).not.toContain("two coppers");
    // Nothing fired ⇒ nothing to record: the shared cursor is untouched.
    expect(readEventsCursor(model).visitFired).not.toContain("ev.toll-again");
  });

  test("with the gating flag TRUE it fires once — and the visit cursor stops the next errand re-charging", async () => {
    const { model, playset } = await buildModel(true);
    applyCommand(model, { type: "setFlag", scope: "world", key: "there.tolled", value: true });

    seedErrand(model);
    const before = coinsOf(model);
    land(model, playset);
    expect(coinsOf(model)).toBe(before - 2);
    expect(findings(model)).toContain("two coppers");
    expect(readEventsCursor(model).visitFired).toContain("ev.toll-again");

    // Send them again from the same standing spot: the toll is already paid for this visit.
    seedErrand(model, { dueAtClock: model.clock });
    land(model, playset);
    expect(coinsOf(model)).toBe(before - 2);
  });

  test("a HIDDEN quest's hand-over stays hidden — no writ, no objective, and the cursor is not burned", async () => {
    const { model, playset } = await buildModel(true);
    seedErrand(model);
    const { enqueued } = land(model, playset);

    expect(enqueued.some((c) => c.type === "transferItem" && c.itemId === "item.writ")).toBe(false);
    expect(enqueued.some((c) => c.type === "setObjectiveDone")).toBe(false);
    expect(holdsWrit(model)).toBe(false);
    // Crucially the beat is still AVAILABLE — it was never consumed, so the real scene survives.
    expect(readEventsCursor(model).fired).not.toContain("ev.wreck-found");
  });

  test("once the quest is active it fires EXACTLY once — the campaign cursor is written, so no double hand-over", async () => {
    const { model, playset } = await buildModel(true);
    applyCommand(model, { type: "setQuestState", questId: "q.salvage", state: "active" });

    seedErrand(model);
    land(model, playset);
    expect(holdsWrit(model)).toBe(true);
    expect(findings(model)).toContain("bond-writ");
    expect(readEventsCursor(model).fired).toContain("ev.wreck-found");

    seedErrand(model, { dueAtClock: model.clock });
    const { enqueued } = land(model, playset);
    expect(enqueued.some((c) => c.type === "transferItem" && c.itemId === "item.writ")).toBe(false);
    expect(enqueued.some((c) => c.type === "setObjectiveDone")).toBe(false);
  });

  test("the cursor reaches state through the REDUCER — a modulePatch, never a direct mutation", async () => {
    const { model, playset } = await buildModel(true);
    applyCommand(model, { type: "setQuestState", questId: "q.salvage", state: "active" });
    // Give `lastLoc` a real value first, so "errands leave it alone" is an assertion and not a tie.
    applyCommand(model, { type: "modulePatch", module: EVENTS_MODULE, patch: { fired: [], visitFired: [], lastLoc: "loc.here" } });
    seedErrand(model);
    const { silent } = land(model, playset);

    const patch = silent.find((c) => c.type === "modulePatch" && c.module === EVENTS_MODULE);
    expect(patch).toBeDefined();
    expect((patch as unknown as { patch: { fired: string[] } }).patch.fired).toContain("ev.wreck-found");
    // …and the whole cursor rides along: `lastLoc` is the events module's, and errands never move it.
    expect(readEventsCursor(model).lastLoc).toBe("loc.here");
  });

  test("snapshot == fold(deltas) with an offstage beat firing", async () => {
    const { model, playset } = await buildModel(true);
    applyCommand(model, { type: "setQuestState", questId: "q.salvage", state: "active" });
    const seed = fromGameState(toGameState(model), playset.world, playset.campaign);
    const deltas: DeltaEvent[] = [];
    const record = (cmd: Command): void => {
      deltas.push(...(applyCommand(model, cmd).deltas as DeltaEvent[]));
    };

    const errand = seedErrand(model);
    const slice = defaultErrandsSlice();
    slice.active[errand.runnerId] = errand;
    record({ type: "modulePatch", module: ERRANDS_MODULE, patch: { ...slice } });
    record({ type: "moveEntity", entityId: errand.runnerId, to: errand.destinationId, teleport: true });

    const { ctx, enqueued, silent } = fakeCtx(model, 200);
    (ctx as unknown as { applySilent: (c: Command) => void }).applySilent = (c: Command) => {
      silent.push(c);
      record(c);
    };
    new ErrandsModule(playset.world, playset.campaign).phases.react?.(ctx);
    for (const cmd of enqueued) record(cmd);

    expect(silent.some((c) => c.type === "modulePatch" && c.module === "events")).toBe(true);
    reduceDeltas(seed, deltas);
    expect(toGameState(seed)).toEqual(toGameState(model));
  });
});
