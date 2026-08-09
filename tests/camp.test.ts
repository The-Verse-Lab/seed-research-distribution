/**
 * Camp / long-rest tests — the BG3-style long rest wired end-to-end through the grounded-action
 * channel. A long rest is two actions: `enterCamp` (teleport the co-located party to the inaccessible
 * Camp location, freeze time + energy, no recovery) and `endDay` (full recovery + day rollover, then
 * return everyone to where they were). The in-place `rest` action is now a SHORT rest (partial, ~1h,
 * no day rollover). These specs assert the REDUCER effects (entities moved, slice flipped, clock
 * advanced/frozen, energy spent/free) — offline gateway + seeded rng, fully deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { GameState } from "../src/state/types.ts";
import type { PlaySet } from "../src/content/schema.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { PrebakedEventSchema } from "../src/content/schema.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { GameEngine, restAdvanceMinutes, SHORT_REST_MINUTES } from "../src/engine/engine.ts";
import { CAMP_LOCATION_ID } from "../src/world/camp.ts";
import { DEFAULT_MAX_ENERGY } from "../src/rules/costs.ts";
import { loadExample } from "./support/harness.ts";

const PC = "pc.you";
const LYRA = "npc.lyra";
const ORIGIN = "loc.tavern";

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

/** A PC + co-located companion at the tavern, mid-morning of day 1. Overridable per-spec. */
function campState(playset: PlaySet, overrides: Partial<GameState> = {}): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: ORIGIN,
    clock: 600, // day 1, 10:00
    party: [PC],
    companions: [LYRA],
    actors: {
      [PC]: { id: PC, currentHp: 5, locationId: ORIGIN, inventory: [], conditions: [], energy: 30 },
      [LYRA]: { id: LYRA, currentHp: 5, locationId: ORIGIN, inventory: [], conditions: [] },
    },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
    ...overrides,
  };
}

async function makeCampEngine(opts: {
  state?: (p: PlaySet) => GameState;
  classifier?: TurnClassifier;
  event?: boolean;
} = {}): Promise<{ engine: GameEngine; playset: PlaySet }> {
  const playset = structuredClone(await loadExample());
  playset.campaign.travelEventChance = 0;
  if (opts.event) {
    // A hostile spawns on entering the square — so a camp attempt there is under threat.
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.stalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
  }
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, PC), (opts.state ?? campState)(playset));
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

function campSlice(engine: GameEngine): { active?: boolean; returnLocationId?: string } {
  return (engine.getState().modules?.camp as { active?: boolean; returnLocationId?: string }) ?? {};
}

describe("camp — enter/End Day round trip", () => {
  test("enterCamp teleports the co-located party to Camp and records the origin; End Day returns them", async () => {
    const { engine } = await makeCampEngine();

    await engine.submitAction({ kind: "enterCamp" });
    let s = engine.getState();
    expect(s.actors[PC]?.locationId).toBe(CAMP_LOCATION_ID);
    expect(s.actors[LYRA]?.locationId).toBe(CAMP_LOCATION_ID); // the companion came too
    expect(s.partyLocationId).toBe(CAMP_LOCATION_ID);
    expect(campSlice(engine).active).toBe(true);
    expect(campSlice(engine).returnLocationId).toBe(ORIGIN);

    await engine.submitAction({ kind: "endDay" });
    s = engine.getState();
    expect(s.actors[PC]?.locationId).toBe(ORIGIN); // everyone back where they were
    expect(s.actors[LYRA]?.locationId).toBe(ORIGIN);
    expect(s.partyLocationId).toBe(ORIGIN);
    expect(campSlice(engine).active).toBe(false);
  });

  test("End Day heals the party to recovered, clears unconscious, and rolls the day over", async () => {
    const { engine } = await makeCampEngine({
      state: (p) => campState(p, { actors: {
        [PC]: { id: PC, currentHp: 1, locationId: ORIGIN, inventory: [], conditions: ["unconscious"], energy: 0 },
        [LYRA]: { id: LYRA, currentHp: 2, locationId: ORIGIN, inventory: [], conditions: [] },
      } }),
    });
    const clock0 = engine.getState().clock;

    await engine.submitAction({ kind: "enterCamp" });
    await engine.submitAction({ kind: "endDay" });
    const s = engine.getState();

    expect(s.actors[PC]?.currentHp).toBeGreaterThan(1); // healed
    expect(s.actors[PC]?.conditions).not.toContain("unconscious"); // revived
    expect(s.actors[PC]?.energy).toBe(DEFAULT_MAX_ENERGY); // energy to full
    // Day rollover: End Day advances to the next day's wake hour (enterCamp froze the clock).
    expect(s.clock - clock0).toBe(restAdvanceMinutes(clock0));
    expect(Math.floor(s.clock / 1440) + 1).toBe(2);
  });
});

describe("camp — time stopped and energy free", () => {
  test("a camp action advances neither the clock nor spends energy", async () => {
    const { engine } = await makeCampEngine({
      classifier: scriptedClassifier([planOf({ kind: "freeformNarrative" })]),
    });
    await engine.submitAction({ kind: "enterCamp" });
    const clockAtCamp = engine.getState().clock;
    const energyAtCamp = engine.getState().actors[PC]?.energy;

    // A freeform action at camp — normally {1 minute, 1 energy}; at camp it is free.
    await engine.submitPlayerInput("I sort through my pack by the fire.");
    const s = engine.getState();
    expect(s.clock).toBe(clockAtCamp); // time is stopped
    expect(s.actors[PC]?.energy).toBe(energyAtCamp); // energy is free
  });
});

describe("camp — you cannot leave", () => {
  test("a move at camp is refused: party stays, no world pocket is generated", async () => {
    const { engine, playset } = await makeCampEngine();
    await engine.submitAction({ kind: "enterCamp" });
    const locationCount = playset.world.locations.length;

    await engine.submitAction({ kind: "move", exitId: "loc.square" });
    expect(engine.getState().partyLocationId).toBe(CAMP_LOCATION_ID); // still camped
    expect(playset.world.locations.length).toBe(locationCount); // no reactive worldgen off Camp
  });

  test("a short rest at camp is a no-op (End Day is the rest here) — the clock stays frozen", async () => {
    const { engine } = await makeCampEngine();
    await engine.submitAction({ kind: "enterCamp" });
    const clockAtCamp = engine.getState().clock;

    await engine.submitAction({ kind: "rest" });
    expect(engine.getState().clock).toBe(clockAtCamp); // the short rest's own advance is suppressed
  });
});

describe("camp — gates and no-ops", () => {
  test("enterCamp is refused with a hostile present — the party stays put, uncamped", async () => {
    const { engine } = await makeCampEngine({ event: true });
    // Walk into the square; the stalker spawns on entry.
    await engine.submitAction({ kind: "move", exitId: "loc.square" });
    expect(engine.getState().partyLocationId).toBe("loc.square");

    await engine.submitAction({ kind: "enterCamp" });
    expect(engine.getState().partyLocationId).toBe("loc.square"); // not teleported to Camp
    expect(campSlice(engine).active).toBeFalsy();
  });

  test("endDay when not at camp CHAINS through enterCamp — one turn, one night, back at the origin", async () => {
    // r2 P1 (phantom night): "I sleep through the night" typed rough used to return a "narrate the
    // confusion" seed and the narrator delivered a dawn the clock refused. The intent is the NIGHT:
    // the engine now makes camp here (all enterCamp guards apply) and ends the day in the same turn.
    const { engine } = await makeCampEngine();
    const clock0 = engine.getState().clock;
    await engine.submitAction({ kind: "endDay" });
    expect(engine.getState().clock).toBeGreaterThan(clock0); // the day genuinely rolled
    expect(engine.getState().partyLocationId).toBe(ORIGIN); // slept and returned — never stranded at Camp
    expect(campSlice(engine).active).toBeFalsy();
  });

  test("entering camp twice keeps the ORIGINAL return location", async () => {
    const { engine } = await makeCampEngine();
    await engine.submitAction({ kind: "enterCamp" });
    expect(campSlice(engine).returnLocationId).toBe(ORIGIN);
    // A second enterCamp is a no-op — it must not overwrite returnLocationId with loc.__camp__.
    await engine.submitAction({ kind: "enterCamp" });
    expect(campSlice(engine).returnLocationId).toBe(ORIGIN);
  });
});

describe("camp — review-hardening regressions", () => {
  test("dismissing a companion AT camp does not strand them — End Day returns them to the origin", async () => {
    const { engine } = await makeCampEngine({
      classifier: scriptedClassifier([planOf({ kind: "partyAction", party: { verb: "leave", targetId: LYRA } })]),
    });
    await engine.submitAction({ kind: "enterCamp" });
    expect(engine.getState().actors[LYRA]?.locationId).toBe(CAMP_LOCATION_ID); // teleported in

    // Dismiss Lyra while at camp — she becomes a non-party NPC sitting at the exit-less Camp.
    await engine.submitPlayerInput("Lyra, you're free to go.");

    await engine.submitAction({ kind: "endDay" });
    const s = engine.getState();
    // Not stranded: End Day relocates EVERY camp entity (party or not) back to the origin.
    expect(s.actors[LYRA]?.locationId).toBe(ORIGIN);
    expect(s.actors[PC]?.locationId).toBe(ORIGIN);
    // Nobody is left behind at Camp.
    const anyoneAtCamp = Object.values(s.actors).some((a) => a.locationId === CAMP_LOCATION_ID);
    expect(anyoneAtCamp).toBe(false);
  });

  test("attacking at camp is refused — no combat opens and the clock stays frozen", async () => {
    const { engine } = await makeCampEngine();
    await engine.submitAction({ kind: "enterCamp" });
    const clockAtCamp = engine.getState().clock;

    await engine.submitAction({ kind: "attack", targetId: LYRA });
    const s = engine.getState();
    expect((s.modules?.combat as { active?: boolean } | undefined)?.active).toBeFalsy(); // no fight
    expect(s.partyLocationId).toBe(CAMP_LOCATION_ID); // still camped
    expect(s.clock).toBe(clockAtCamp); // freeze held (a combat defeat clock-advance can't fire)
  });

  test("End Day does NOT free-heal a companion who was split off and never came to camp", async () => {
    const { engine } = await makeCampEngine({
      state: (p) => campState(p, {
        actors: {
          [PC]: { id: PC, currentHp: 5, locationId: ORIGIN, inventory: [], conditions: [], energy: 30 },
          // Lyra is elsewhere (a prior solo move) — a party member, but NOT co-located with the PC.
          [LYRA]: { id: LYRA, currentHp: 3, locationId: "loc.square", inventory: [], conditions: [] },
        },
      }),
    });
    await engine.submitAction({ kind: "enterCamp" }); // only the PC camps
    expect(engine.getState().actors[LYRA]?.locationId).toBe("loc.square");

    await engine.submitAction({ kind: "endDay" });
    const s = engine.getState();
    expect(s.actors[LYRA]?.currentHp).toBe(3); // absent from camp → no free full-heal
    expect(s.actors[LYRA]?.locationId).toBe("loc.square"); // and not teleported
    expect(s.actors[PC]?.currentHp).toBeGreaterThan(5); // the PC who camped IS healed
  });
});

describe("short rest — partial, in place", () => {
  test("a short rest recovers a portion of hp/energy, advances an hour, and does NOT revive the downed", async () => {
    const { engine } = await makeCampEngine({
      state: (p) => campState(p, { actors: {
        [PC]: { id: PC, currentHp: 4, locationId: ORIGIN, inventory: [], conditions: [], energy: 10 },
        [LYRA]: { id: LYRA, currentHp: 2, locationId: ORIGIN, inventory: [], conditions: ["unconscious"] },
      } }),
    });
    const clock0 = engine.getState().clock;

    await engine.submitAction({ kind: "rest" });
    const s = engine.getState();

    expect(s.actors[PC]?.currentHp).toBeGreaterThan(4); // some hp back
    expect(s.actors[PC]?.energy).toBeGreaterThan(10); // some energy back
    // The downed companion is NOT revived by a short rest.
    expect(s.actors[LYRA]?.conditions).toContain("unconscious");
    // An hour passes — the day does NOT roll over.
    expect(s.clock - clock0).toBe(SHORT_REST_MINUTES);
    expect(Math.floor(s.clock / 1440) + 1).toBe(1);
  });
});
