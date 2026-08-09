/**
 * Daily upkeep (the hall-as-hub wave, Phase C) — `UpkeepModule`: merc WAGES paid cheapest-first
 * from the PC purse (an unaffordable merc is dismissed and soured), and FOOD (one `item.rations`
 * per day shared across the whole party, unfed days accruing per-member hunger that bites into
 * exhaustion past `HUNGER_EXHAUSTION_AT`). Keyed on the in-world day counter (`upkeepDayOf`), so it
 * settles once per day crossed regardless of how the crossing happened (here: camp → End Day, the
 * cleanest deterministic way to roll the clock into the next day). Offline gateway + a minimal,
 * purpose-built world (no mercs/rations baked into the shipped example) throughout.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { readUpkeepSlice, upkeepDayOf, type UpkeepSlice } from "../src/rules/upkeep.ts";
import type { PartyWagesSlice } from "../src/rules/recruit.ts";

const PC = "pc.you";
const HALL = "loc.hall";
const MERC_A = "npc.merc.a";
const MERC_B = "npc.merc.b";

const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 20, armorClass: 10 };

/** A single quiet location — no guild/work/lodging content, just somewhere to camp from. */
function upkeepPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.upkeep",
    name: "Upkeep Test",
    summary: "A quiet hall for testing daily upkeep.",
    locations: [{ id: HALL, name: "The Hall", description: "A place to rest." }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.upkeep",
    name: "Upkeep Campaign",
    worldId: world.id,
    characters: [{ id: PC, name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: HALL, party: [PC], companions: [] },
  });
  return { world, campaign };
}

/** The same quiet hall, but MERC_A has an authored template — so a party-member merc gets a live
 *  companion agent + heartbeat registration at load (templates are the agent source). */
function upkeepPlaysetWithMercTemplate(): PlaySet {
  const base = upkeepPlayset();
  const world = WorldSchema.parse({
    ...base.world,
    locations: base.world.locations.map((l) => ({ ...l, npcs: [MERC_A] })),
    npcs: [
      {
        id: MERC_A,
        name: "Merc A",
        persona: "A sellsword who works for coin and nothing else.",
        autonomy: { isPartyMember: false, level: "reactive" },
      },
    ],
  });
  return { world, campaign: base.campaign };
}

interface StateOpts {
  coins?: number;
  companions?: string[];
  mercWages?: Record<string, number>;
  wageOf?: Record<string, number>;
  inventory?: string[];
  exhaustion?: number;
  clock?: number;
  /** Pre-seed the upkeep slice (e.g. a lagging lastDay + accrued hunger) to force a multi-day settle. */
  upkeepSeed?: UpkeepSlice;
}

/** The PC (optionally with hired mercs) at the hall. `mercWages` doubles as the companion roster. */
function upkeepState(opts: StateOpts = {}): GameState {
  const companions = opts.companions ?? Object.keys(opts.mercWages ?? {});
  const actors: GameState["actors"] = {
    [PC]: {
      id: PC,
      currentHp: pcStats.maxHp,
      locationId: HALL,
      inventory: opts.inventory ?? [],
      conditions: [],
      coins: opts.coins ?? 0,
      ...(opts.exhaustion !== undefined ? { exhaustion: opts.exhaustion } : {}),
    },
  };
  for (const id of companions) {
    actors[id] = { id, currentHp: 16, locationId: HALL, inventory: [], conditions: [] };
  }
  return {
    campaignId: "c.upkeep",
    worldId: "w.upkeep",
    partyLocationId: HALL,
    clock: opts.clock ?? 480, // day 0, morning
    party: [PC],
    companions,
    actors,
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {
      ...(opts.mercWages ? { partyWages: opts.mercWages } : {}),
      ...(opts.upkeepSeed ? { upkeep: opts.upkeepSeed } : {}),
    },
    flags: {},
  };
}

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
}

async function engineWith(state: GameState, plans: TurnPlan[], playset: PlaySet = upkeepPlayset()): Promise<GameEngine> {
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, PC), state);
  const engine = new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store,
    gateway: new OfflineGateway(),
    rng: mulberry32(11),
  });
  await engine.start();
  return engine;
}

const CAMP_END_DAY = [planOf({ kind: "enterCamp" }), planOf({ kind: "endDay" })];
const CROSS_TWO_DAYS = [...CAMP_END_DAY, ...CAMP_END_DAY];

const upkeepSliceOf = (engine: GameEngine): UpkeepSlice => readUpkeepSlice(engine.getState().modules);
const wagesSliceOf = (engine: GameEngine): PartyWagesSlice =>
  (engine.getState().modules?.partyWages as PartyWagesSlice | undefined) ?? {};

/** Cross exactly one in-world day via camp → End Day (the cleanest deterministic day-boundary). */
async function crossOneDay(engine: GameEngine): Promise<void> {
  await engine.submitPlayerInput("make camp for the night");
  await engine.submitPlayerInput("end the day");
}

describe("UpkeepModule — wages", () => {
  test("an affordable merc's wage is deducted from the PC purse; the merc stays", async () => {
    const engine = await engineWith(upkeepState({ coins: 100, mercWages: { [MERC_A]: 5 } }), CAMP_END_DAY);
    await crossOneDay(engine);

    const s = engine.getState();
    expect(s.actors[PC]?.coins).toBe(95);
    expect(s.companions).toContain(MERC_A);
    expect(s.actors[MERC_A]).toBeTruthy();
    expect(wagesSliceOf(engine)[MERC_A]).toBe(5);
  });

  test("an unaffordable merc is dismissed: no membership, soured relationship, purse untouched", async () => {
    const engine = await engineWith(upkeepState({ coins: 10, mercWages: { [MERC_A]: 50 } }), CAMP_END_DAY);
    await crossOneDay(engine);

    const s = engine.getState();
    expect(s.actors[PC]?.coins).toBe(10); // nothing affordable to pay — purse is untouched
    expect(s.companions).not.toContain(MERC_A);
    expect(s.relationships[MERC_A]?.[PC]).toBe(-10);
    // The dismissed merc's wage entry is ZEROED (retired) — `modulePatch` can't delete a key, so the
    // module overwrites it to 0, which makes it provably inert.
    expect(wagesSliceOf(engine)[MERC_A]).toBe(0);
  });

  test("two mercs, purse covers only the cheaper: cheaper kept and charged, dearer dismissed", async () => {
    const engine = await engineWith(
      upkeepState({ coins: 10, mercWages: { [MERC_A]: 5, [MERC_B]: 50 } }),
      CAMP_END_DAY,
    );
    await crossOneDay(engine);

    const s = engine.getState();
    expect(s.actors[PC]?.coins).toBe(5); // 10 − 5 (MERC_A only; MERC_B's 50 was unaffordable)
    expect(s.companions).toContain(MERC_A);
    expect(s.companions).not.toContain(MERC_B);
    expect(s.relationships[MERC_B]?.[PC]).toBe(-10);
    expect(s.relationships[MERC_A]?.[PC] ?? 0).toBe(0); // the paid merc's regard is untouched
    expect(wagesSliceOf(engine)[MERC_A]).toBe(5);
  });
});

describe("UpkeepModule — a dismissed merc's wage is retired (zeroed) and never charged again", () => {
  // `modulePatch` is a shallow Object.assign (src/world/reducer.ts:608-611): it can OVERWRITE a key but
  // never DELETE one the patch omits. So `settleWages` retires a dismissed merc by overwriting its wage
  // to 0 (provably inert: owed 0, and the partyMember filter already excludes it), rather than a no-op
  // "delete then patch the reduced map" that the merge would silently ignore.
  test("a dismissed merc's wage entry is zeroed to inert", async () => {
    const engine = await engineWith(upkeepState({ coins: 10, mercWages: { [MERC_A]: 50 } }), CAMP_END_DAY);
    await crossOneDay(engine);
    expect(wagesSliceOf(engine)[MERC_A]).toBe(0);
  });

  test("two mercs: the dearer dismissed one's wage is zeroed too", async () => {
    const engine = await engineWith(
      upkeepState({ coins: 10, mercWages: { [MERC_A]: 5, [MERC_B]: 50 } }),
      CAMP_END_DAY,
    );
    await crossOneDay(engine);
    expect(wagesSliceOf(engine)[MERC_B]).toBe(0);
    expect(wagesSliceOf(engine)[MERC_A]).toBe(5); // the kept merc's wage is untouched
  });
});

describe("UpkeepModule — hunger → exhaustion", () => {
  test("day 1 unfed: hunger accrues but stays below the threshold — no exhaustion bite yet", async () => {
    const engine = await engineWith(upkeepState({}), CAMP_END_DAY);
    await crossOneDay(engine);

    const s = engine.getState();
    expect(s.actors[PC]?.exhaustion ?? 0).toBe(0);
    expect(upkeepSliceOf(engine).hunger[PC]).toBe(1);
  });

  test("day 2 unfed: the threshold bites — exhaustion +1, hunger resets to 0", async () => {
    const engine = await engineWith(upkeepState({}), CROSS_TWO_DAYS);
    await crossOneDay(engine);
    await crossOneDay(engine);

    const s = engine.getState();
    expect(s.actors[PC]?.exhaustion).toBe(1);
    expect(upkeepSliceOf(engine).hunger[PC]).toBe(0);
  });

  test("a ration in the pack is consumed: exhaustion eases, hunger stays at 0", async () => {
    const engine = await engineWith(
      upkeepState({ inventory: ["item.rations"], exhaustion: 3 }),
      CAMP_END_DAY,
    );
    await crossOneDay(engine);

    const s = engine.getState();
    expect(s.actors[PC]?.inventory).toEqual([]); // the ration was consumed
    expect(s.actors[PC]?.exhaustion).toBe(2); // 3 − 1 (fed relief)
    expect(upkeepSliceOf(engine).hunger[PC] ?? 0).toBe(0);
  });
});

describe("UpkeepModule — first observation", () => {
  test("the very first player tick only seeds the day cursor — no wage deduction, no hunger bump", async () => {
    const engine = await engineWith(upkeepState({ coins: 100, mercWages: { [MERC_A]: 5 } }), CAMP_END_DAY);
    // A single player turn (enterCamp) — the FIRST observation. No day has been crossed yet.
    await engine.submitPlayerInput("make camp for the night");

    const s = engine.getState();
    expect(s.actors[PC]?.coins).toBe(100); // no wage charged on the seeding tick
    expect(s.companions).toContain(MERC_A); // merc untouched
    expect(upkeepSliceOf(engine)).toEqual({ lastDay: upkeepDayOf(480), hunger: {} });
  });
});

describe("UpkeepModule — a dismissed merc's companion agent is retired", () => {
  // The dismissal fires from a TICK MODULE (settleWages enqueues setPartyMembership), which cannot
  // reach engine internals — agent teardown happens in the engine's post-apply hook on the
  // `partyMembershipChanged` delta. Without it, the "unpaid, walks" merc kept a live heartbeat and
  // kept acting as a companion until the next reload reconciled agents.
  const liveAgentsOf = (engine: GameEngine): Map<string, unknown> =>
    (engine as unknown as { npcs: Map<string, unknown> }).npcs;

  test("the dismissed merc's live agent + heartbeat are dropped on the same tick they walk", async () => {
    const engine = await engineWith(
      upkeepState({ coins: 10, mercWages: { [MERC_A]: 50 } }),
      CAMP_END_DAY,
      upkeepPlaysetWithMercTemplate(),
    );
    // At load the engine rebuilt a live companion agent for the party-member merc.
    expect(liveAgentsOf(engine).has(MERC_A)).toBe(true);

    await crossOneDay(engine);

    const s = engine.getState();
    expect(s.companions).not.toContain(MERC_A); // the wage was unaffordable — the merc walked
    expect(liveAgentsOf(engine).has(MERC_A)).toBe(false); // …and their agent went with them
  });

  test("a PAID merc's agent survives the settle", async () => {
    const engine = await engineWith(
      upkeepState({ coins: 100, mercWages: { [MERC_A]: 5 } }),
      CAMP_END_DAY,
      upkeepPlaysetWithMercTemplate(),
    );
    await crossOneDay(engine);

    expect(engine.getState().companions).toContain(MERC_A);
    expect(liveAgentsOf(engine).has(MERC_A)).toBe(true);
  });
});

describe("UpkeepModule — a partially-fed settle keeps accrued hunger", () => {
  // The slice documents hunger as "days unfed since last threshold bite" — a fed day is not an
  // erasure of EARLIER unfed days. Before the fix, ANY consumed ration zeroed the counter before
  // the hungry branch accrued, so scraping one ration together over a two-day settle wiped a prior
  // day's hunger and dodged the exhaustion bite.
  test("one ration across a two-day settle covers one day; the prior unfed day still counts", async () => {
    const engine = await engineWith(
      upkeepState({
        inventory: ["item.rations"], // one ration for the whole party
        clock: 480 + 2 * 1440, // the clock sits on day 2…
        upkeepSeed: { lastDay: 0, hunger: { [PC]: 1 } }, // …with the cursor two days behind and 1 unfed day accrued
      }),
      [planOf({})],
    );
    // The FIRST player tick settles both days at once: 1 ration consumed, 1 day unfed.
    await engine.submitPlayerInput("take stock of the packs");

    const s = engine.getState();
    expect(s.actors[PC]?.inventory).toEqual([]); // the ration was consumed
    // Cumulative unfed days: 1 (prior) + 1 (this settle) = 2 → the threshold bites exactly once.
    // (Fed relief −1 and the bite +1 net to +1 from the zero floor.)
    expect(s.actors[PC]?.exhaustion).toBe(1);
    expect(upkeepSliceOf(engine).hunger[PC]).toBe(0); // spent by the bite — not erased by the ration
  });
});
