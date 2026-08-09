/**
 * Lodging — guild-hall rented rooms (Phase A), wired end-to-end through the grounded-action channel.
 * Renting is two actions: `rentRoom` (charge the tier's nightly coin, teleport the PC ALONE into the
 * synthetic private room, companions stay in the hall) and `wakeInRoom` (the lodging counterpart to
 * End Day — full recovery for the WHOLE party, day rollover, everyone returns to the hall). These
 * specs assert the REDUCER effects (coins spent, entity moved, slice flipped, clock advanced, party
 * healed) — offline gateway + seeded rng, fully deterministic. Mirrors `tests/camp.test.ts`.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { GameState } from "../src/state/types.ts";
import type { PlaySet } from "../src/content/schema.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { GameEngine, restAdvanceMinutes } from "../src/engine/engine.ts";
import { LODGING_LOCATION_ID } from "../src/world/lodging.ts";
import { DEFAULT_MAX_ENERGY } from "../src/rules/costs.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { reduceDeltas } from "./support/replay.ts";
import type { Command } from "../src/world/commands.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import type { GameEvent } from "../src/events/types.ts";

const PC = "pc.you";
const LYRA = "npc.lyra";
const ORIGIN = "loc.hall";
const TIER_PRIVATE = "tier.private";
const TIER_BUNK = "tier.bunk";
const PRIVATE_CP = 20;
const BUNK_CP = 5;

const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 12, armorClass: 10 };
const lyraStats = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

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
  return {
    classify: async () => {
      const plan = plans[Math.min(i, plans.length - 1)] ?? planOf({});
      i += 1;
      return plan;
    },
  };
}

/** A guild hall with a private tier and a shared-bunk tier, plus a companion in the common room. */
function lodgingPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.lodge",
    name: "Lodgeworld",
    summary: "A test hall.",
    locations: [
      {
        id: ORIGIN,
        name: "The Broken Crown",
        description: "A guild hall with beds to let.",
        guild: {
          name: "The Broken Crown",
          lodging: {
            tiers: [
              { id: TIER_PRIVATE, label: "a private room", nightlyCp: PRIVATE_CP, private: true },
              { id: TIER_BUNK, label: "a bunk in the common loft", nightlyCp: BUNK_CP, private: false },
            ],
          },
        },
        npcs: [LYRA],
      },
    ],
    npcs: [{ id: LYRA, name: "Lyra", summary: "a companion", persona: "Loyal.", age: 28, stats: lyraStats }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.lodge",
    name: "Lodge Campaign",
    worldId: world.id,
    characters: [{ id: PC, name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: ORIGIN, party: [PC], companions: [LYRA] },
  });
  return { world, campaign };
}

/** A PC + co-located companion at the hall, mid-morning of day 1, PC carrying 30 cp. Overridable. */
function lodgeState(playset: PlaySet, overrides: Partial<GameState> = {}): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: ORIGIN,
    clock: 600, // day 1, 10:00
    party: [PC],
    companions: [LYRA],
    actors: {
      [PC]: { id: PC, currentHp: pcStats.maxHp, locationId: ORIGIN, inventory: [], conditions: [], coins: 30 },
      [LYRA]: { id: LYRA, currentHp: lyraStats.maxHp, locationId: ORIGIN, inventory: [], conditions: [] },
    },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
    ...overrides,
  };
}

async function makeLodgingEngine(opts: {
  state?: (p: PlaySet) => GameState;
  classifier?: TurnClassifier;
} = {}): Promise<{ engine: GameEngine; playset: PlaySet }> {
  const playset = lodgingPlayset();
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, PC), (opts.state ?? lodgeState)(playset));
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    classifier: opts.classifier ?? scriptedClassifier([planOf({ kind: "freeformNarrative" })]),
    rng: mulberry32(7),
  });
  await engine.start();
  return { engine, playset };
}

function lodgeSlice(engine: GameEngine): {
  active?: boolean;
  returnLocationId?: string | null;
  hallId?: string | null;
  tierId?: string | null;
  private?: boolean;
} {
  return (engine.getState().modules?.lodging as ReturnType<typeof lodgeSlice>) ?? {};
}

// ── rentRoom ─────────────────────────────────────────────────────────────────────────────────────

describe("rentRoom", () => {
  test("rents the private tier: charges nightlyCp, teleports the PC alone, companions stay at the hall", async () => {
    const { engine } = await makeLodgingEngine();

    await engine.submitAction({ kind: "rentRoom", tierId: TIER_PRIVATE });
    const s = engine.getState();

    expect(s.actors[PC]?.coins).toBe(30 - PRIVATE_CP);
    expect(s.actors[PC]?.locationId).toBe(LODGING_LOCATION_ID);
    expect(s.partyLocationId).toBe(LODGING_LOCATION_ID);
    expect(s.actors[LYRA]?.locationId).toBe(ORIGIN); // companion stays in the common hall

    const slice = lodgeSlice(engine);
    expect(slice.active).toBe(true);
    expect(slice.hallId).toBe(ORIGIN);
    expect(slice.tierId).toBe(TIER_PRIVATE);
    expect(slice.private).toBe(true);
    expect(slice.returnLocationId).toBe(ORIGIN);
  });

  test("rents the shared-bunk tier: cheaper, and the slice records private:false", async () => {
    const { engine } = await makeLodgingEngine();

    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    const s = engine.getState();

    expect(s.actors[PC]?.coins).toBe(30 - BUNK_CP);
    expect(s.actors[PC]?.locationId).toBe(LODGING_LOCATION_ID);
    expect(lodgeSlice(engine).tierId).toBe(TIER_BUNK);
    expect(lodgeSlice(engine).private).toBe(false);
  });

  test("affordability: too little coin is refused — no charge, no teleport", async () => {
    const { engine } = await makeLodgingEngine({
      state: (p) =>
        lodgeState(p, {
          actors: {
            [PC]: { id: PC, currentHp: pcStats.maxHp, locationId: ORIGIN, inventory: [], conditions: [], coins: 2 },
            [LYRA]: { id: LYRA, currentHp: lyraStats.maxHp, locationId: ORIGIN, inventory: [], conditions: [] },
          },
        }),
    });

    // The cheapest bed (the bunk) costs 5 cp; the PC carries 2.
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    const s = engine.getState();

    expect(s.actors[PC]?.coins).toBe(2); // unchanged
    expect(s.actors[PC]?.locationId).toBe(ORIGIN); // not teleported
    expect(s.partyLocationId).toBe(ORIGIN);
    expect(lodgeSlice(engine).active).toBeFalsy();
  });

  test("renting again while already lodging is refused — the original slice is unchanged", async () => {
    const { engine } = await makeLodgingEngine();

    await engine.submitAction({ kind: "rentRoom", tierId: TIER_PRIVATE });
    const coinsAfterFirst = engine.getState().actors[PC]?.coins;

    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    expect(engine.getState().actors[PC]?.coins).toBe(coinsAfterFirst); // no second charge
    expect(lodgeSlice(engine).tierId).toBe(TIER_PRIVATE); // still the original tier
  });
});

// ── wakeInRoom ───────────────────────────────────────────────────────────────────────────────────

describe("wakeInRoom", () => {
  test("full recovery for the WHOLE party, clock rolls to morning, PC returns to the hall, slice cleared", async () => {
    const { engine } = await makeLodgingEngine({
      state: (p) =>
        lodgeState(p, {
          clock: 1290, // 21:30 — bedding down for the NIGHT (in daylight, Wake means "get up")
          actors: {
            [PC]: { id: PC, currentHp: 3, locationId: ORIGIN, inventory: [], conditions: [], coins: 30, energy: 10 },
            [LYRA]: { id: LYRA, currentHp: 2, locationId: ORIGIN, inventory: [], conditions: ["unconscious"] },
          },
        }),
    });
    const clock0 = engine.getState().clock;

    await engine.submitAction({ kind: "rentRoom", tierId: TIER_PRIVATE });
    expect(engine.getState().actors[PC]?.locationId).toBe(LODGING_LOCATION_ID);

    await engine.submitAction({ kind: "wakeInRoom" });
    const s = engine.getState();

    expect(s.actors[PC]?.currentHp).toBe(pcStats.maxHp); // healed
    expect(s.actors[PC]?.energy).toBe(DEFAULT_MAX_ENERGY); // energy to full
    // Lyra never entered the room (companions stay behind), but wake heals the WHOLE party anyway.
    expect(s.actors[LYRA]?.currentHp).toBe(lyraStats.maxHp);
    expect(s.actors[LYRA]?.conditions).not.toContain("unconscious");
    expect(s.actors[PC]?.locationId).toBe(ORIGIN);
    expect(s.partyLocationId).toBe(ORIGIN);
    expect(lodgeSlice(engine).active).toBe(false);
    expect(s.clock - clock0).toBe(restAdvanceMinutes(clock0));
    expect(Math.floor(s.clock / 1440) + 1).toBe(2); // day rollover
  });

  test("in DAYLIGHT, Wake means get up — the day is not burned (r5 P1)", async () => {
    // The reporting run pressed the only visible way out of a bunk and landed on the next morning,
    // losing a whole in-world day and the quest deadline riding on it.
    const { engine } = await makeLodgingEngine(); // 10:00, day 1
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    const clock0 = engine.getState().clock;

    await engine.submitAction({ kind: "wakeInRoom" });
    const s = engine.getState();
    expect(s.partyLocationId).toBe(ORIGIN);
    expect(lodgeSlice(engine).active).toBe(false);
    expect(s.clock - clock0).toBeLessThan(60); // boots and a stair, not a night
    expect(Math.floor(s.clock / 1440) + 1).toBe(1); // still day 1
  });

  test("an EXPLICIT sleep intent sleeps whatever the clock says — dusk no longer rises the sleeper (r9 F-13)", async () => {
    // "I bar the door, lie down, and sleep" at 18:13 classified wakeInRoom, fell to the clock
    // fallback (dusk < NIGHT_START), and ROSE the player who asked to sleep. The plan now carries
    // wake.intent, and "sleep" forces the night through.
    const { engine } = await makeLodgingEngine({
      state: (p) =>
        lodgeState(p, {
          clock: 1093, // 18:13 — dusk, before the 20:00 night line
          actors: {
            [PC]: { id: PC, currentHp: 3, locationId: ORIGIN, inventory: [], conditions: [], coins: 30, energy: 10 },
          },
        }),
      // Typed-language path: the classifier states the intent the clock fallback used to override.
      classifier: scriptedClassifier([planOf({ kind: "wakeInRoom", wake: { intent: "sleep" } })]),
    });
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    const clock0 = engine.getState().clock;
    await engine.submitPlayerInput("I bar the door, lie down, and sleep.");
    const s = engine.getState();
    expect(s.actors[PC]?.currentHp).toBe(pcStats.maxHp); // slept: healed
    expect(s.clock - clock0).toBe(restAdvanceMinutes(clock0));
    expect(Math.floor(s.clock / 1440) + 1).toBe(2); // woke on day 2, as asked
  });

  test("wakeInRoom when not lodging is a harmless no-op — no clock advance", async () => {
    const { engine } = await makeLodgingEngine();
    const clock0 = engine.getState().clock;

    await engine.submitAction({ kind: "wakeInRoom" });
    expect(engine.getState().clock).toBe(clock0);
    expect(engine.getState().partyLocationId).toBe(ORIGIN);
  });

});

// ── replay — rent → room event → wake round trip ────────────────────────────────────────────────

describe("replay — rent → room event → wake round trip", () => {
  test("snapshot == fold(deltas), and lodging/roomEvents are the only new persisted module slices", () => {
    const playset = lodgingPlayset();
    const seedState = lodgeState(playset, {
      actors: {
        [PC]: { id: PC, currentHp: 3, locationId: ORIGIN, inventory: [], conditions: [], coins: 30, energy: 10 },
        [LYRA]: { id: LYRA, currentHp: 2, locationId: ORIGIN, inventory: [], conditions: ["unconscious"] },
      },
    });
    const model = fromGameState(seedState, playset.world, playset.campaign);
    const seed = structuredClone(model);

    const deltas: EmittedDelta[] = [];
    const drive = (cmd: Command): void => {
      deltas.push(...applyCommand(model, cmd).deltas);
    };

    // --- resolveRentRoom's command sequence (private tier) ---
    drive({ type: "adjustCoins", entityId: PC, by: -PRIVATE_CP });
    drive({ type: "moveEntity", entityId: PC, to: LODGING_LOCATION_ID, teleport: true });
    drive({
      type: "modulePatch",
      module: "lodging",
      patch: {
        active: true,
        returnLocationId: ORIGIN,
        hallId: ORIGIN,
        guildFactionId: null,
        tierId: TIER_PRIVATE,
        private: true,
        enteredClock: seedState.clock,
      },
    });

    // --- a benign room-events turn (the cursor bumps; no intrusion this roll) ---
    drive({
      type: "modulePatch",
      module: "roomEvents",
      patch: { turnCounter: 1, lastFiredAt: 0, firedCampaign: [], perEventLastFired: {} },
    });

    // --- resolveWakeInRoom's command sequence ---
    drive({ type: "setCondition", entityId: LYRA, condition: "unconscious", active: false });
    drive({ type: "adjustHp", entityId: PC, by: pcStats.maxHp - 3 });
    drive({ type: "adjustHp", entityId: LYRA, by: lyraStats.maxHp - 2 });
    drive({ type: "adjustEnergy", entityId: PC, by: DEFAULT_MAX_ENERGY - 10 });
    drive({ type: "advanceClock", by: restAdvanceMinutes(seedState.clock) });
    drive({ type: "moveEntity", entityId: PC, to: ORIGIN, teleport: true }); // only the PC was in the room
    drive({
      type: "modulePatch",
      module: "lodging",
      patch: {
        active: false,
        returnLocationId: null,
        hallId: null,
        guildFactionId: null,
        tierId: null,
        private: true,
        enteredClock: 0,
      },
    });

    expect(deltas.length).toBeGreaterThan(0);
    const stamped: DeltaEvent[] = deltas.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent);
    const folded = reduceDeltas(seed, stamped);
    expect(toGameState(folded)).toEqual(toGameState(model));

    // The round trip only ever writes the lodging + roomEvents slices (the seed had no modules at all).
    const newModuleKeys = Object.keys(toGameState(model).modules ?? {});
    expect(new Set(newModuleKeys)).toEqual(new Set(["lodging", "roomEvents"]));

    // And by the end of the round trip everyone is home, healed, and the room is vacated.
    const finalState = toGameState(model);
    expect(finalState.actors[PC]?.locationId).toBe(ORIGIN);
    expect(finalState.actors[PC]?.currentHp).toBe(pcStats.maxHp);
    expect(finalState.actors[LYRA]?.currentHp).toBe(lyraStats.maxHp);
    expect((finalState.modules?.lodging as { active?: boolean } | undefined)?.active).toBe(false);
  });
});

// ── Make Camp from a lodging hall (2026-07-25) ──────────────────────────────────────────────────

describe("enterCamp from a hall with beds", () => {
  test("camping where lodging exists asks first (r4), then a repeat names the departure out loud", async () => {
    const { engine } = await makeLodgingEngine();
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));

    // First ask: the choice is said out loud (beds for coin here), NOTHING moves — r4 P1: a
    // misread "cot in the loft" fired MAKE CAMP silently and the player lost the paid bed.
    await engine.submitAction({ kind: "enterCamp" });
    const quoted = events.find((e) => e.kind === "narration" && e.text.includes("beds for coin"));
    expect(quoted).toBeDefined();
    expect(events.some((e) => e.kind === "stateChanged" && e.summary.includes("make camp"))).toBe(false);

    // The repeat commits: the relocation happens and the beat SAYS so, naming the choice left
    // behind (the 2026-07-25 playtest read the silent interior→roadside move as a teleport bug).
    await engine.submitAction({ kind: "enterCamp" });
    const beat = events.find(
      (e): e is Extract<GameEvent, { kind: "stateChanged" }> =>
        e.kind === "stateChanged" && e.summary.includes("make camp"),
    );
    expect(beat).toBeDefined();
    expect(beat!.summary).toContain("leaves The Broken Crown");
  });

  test("ABED, the camp kinds bend to the bed already paid for — no roadside, no ration (r5 P2)", async () => {
    // The r5 transcript: 12 cp for a bunk in the hearth-loft, then "sleep until first light" ran the
    // whole MAKE CAMP machinery — "the party makes camp for the night", "returns to the road where
    // they left it", and one travel ration gone off the pack.
    const { engine } = await makeLodgingEngine({
      state: (p) => {
        const st = lodgeState(p);
        st.actors[PC]!.inventory = ["item.rations"];
        st.actors[PC]!.coins = 200;
        return st;
      },
    });
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.submitAction({ kind: "endDay" });

    expect(events.some((e) => e.kind === "narration" && /makes camp|breaks camp/i.test(e.text))).toBe(false);
    expect(events.some((e) => e.kind === "stateChanged" && /camp/i.test(e.summary))).toBe(false);
    const st = engine.getState();
    expect(st.partyLocationId).toBe(ORIGIN); // woken back into the hall, not onto a road
    expect(st.modules?.lodging).toMatchObject({ active: false });
    // The pack is untouched: the night's meal was bought at the hall's table instead.
    expect(st.actors[PC]?.inventory).toEqual(["item.rations"]);
  });

  test("the small hours do not cost a whole day: bedding down at 01:00 wakes at THIS dawn (r5 P1)", async () => {
    const { engine } = await makeLodgingEngine({
      state: (p) => lodgeState(p, { clock: 1440 + 60 }), // day 2, 01:00
    });
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    await engine.submitAction({ kind: "wakeInRoom" });
    expect(engine.getState().clock).toBe(1440 + 420); // day 2, 07:00 — the same night's sleep
  });

  test("reaching outside the room GETS YOU UP first — no more phantom day in bed (r5 P1)", async () => {
    // r5 lost a whole in-world day this way: five turns of crossing the village, sending an errand
    // and rolling checks, every one of them narrated from a bunk the party never left.
    const { engine } = await makeLodgingEngine();
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    expect(engine.getState().partyLocationId).toBe(LODGING_LOCATION_ID);
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const clock0 = engine.getState().clock;

    await engine.submitAction({ kind: "work", opportunityId: "work.anything" });

    // The body follows the intent: back in the hall, on the same day, at the cost of the stairs.
    expect(engine.getState().partyLocationId).toBe(ORIGIN);
    expect(engine.getState().modules?.lodging).toMatchObject({ active: false });
    expect(engine.getState().clock).toBeGreaterThan(clock0);
    expect(engine.getState().clock).toBeLessThan(clock0 + 240); // no night skipped
    const text = events.filter((e) => e.kind === "narration").map((e) => e.text).join(" ");
    expect(text).toContain("come back down into the hall");
  });

  test("the night stays paid: going back up to the same bed is free (r5)", async () => {
    const { engine } = await makeLodgingEngine();
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    const afterRent = engine.getState().actors[PC]?.coins ?? 0;
    await engine.submitAction({ kind: "work", opportunityId: "work.anything" }); // rises
    await engine.submitAction({ kind: "rentRoom", tierId: TIER_BUNK });
    expect(engine.getState().partyLocationId).toBe(LODGING_LOCATION_ID);
    expect(engine.getState().actors[PC]?.coins).toBe(afterRent); // charged once for one night
  });

  test("END DAY at a lodging hall still chains straight through camp (the gate never blocks a night)", async () => {
    const { engine } = await makeLodgingEngine();
    const clock0 = engine.getState().clock;
    await engine.submitAction({ kind: "endDay" });
    // The chain camped and slept in ONE action: the clock rolled to next-day morning and the
    // party is back home — no confirmation quote interposed on an explicit night.
    expect(engine.getState().clock).toBeGreaterThan(clock0 + 400);
    expect(engine.getState().partyLocationId).toBe(ORIGIN);
  });
});
