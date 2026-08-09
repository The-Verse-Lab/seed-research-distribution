/**
 * Camp-events — the filtered long-rest slice of the random-event roller. `isCampSafe` classifies an
 * event: a courier/messenger (giveItem/narrate/quest) can find you at camp, but a hostile spawn
 * or ambush cannot. Engine-wired: at camp the CampEventsModule rolls each camp turn over
 * the camp-safe subset only — the courier fires, the ambush never does. `travelEventChance: 1` + private
 * keyed rng makes each roll deterministic (the shared engine rng is irrelevant, pinned anyway).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, TravelEventSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { isCampSafe } from "../src/rules/travel-events.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";

const PC = "pc.you";
const LETTER = "item.camp-letter";
const BANDIT = "mon.bandit";
const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 12, armorClass: 10 };

describe("isCampSafe — the camp filter", () => {
  const ev = (effects: unknown[], campSafe?: boolean) =>
    TravelEventSchema.parse({ id: "tev.x", effects, ...(campSafe === undefined ? {} : { campSafe }) });

  test("an explicit campSafe overrides the derivation either way", () => {
    // Force an otherwise-unsafe spawn to be camp-eligible (a scripted, safe visitor).
    expect(isCampSafe(ev([{ kind: "spawn", templateId: BANDIT, locationId: "loc.hub", tier: "tracked" }], true))).toBe(true);
    // Force an otherwise-safe courier OUT of camp.
    expect(isCampSafe(ev([{ kind: "giveItem", itemId: LETTER }], false))).toBe(false);
  });
});

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

/** A one-room world with a camp-safe courier + a camp-UNSAFE ambush, both always-eligible. */
function campEventsPlayset(travelEvents?: unknown[]): PlaySet {
  const world = WorldSchema.parse({
    id: "w.camp",
    name: "Campworld",
    summary: "A test hub.",
    locations: [{ id: "loc.hub", name: "The Hub", description: "A quiet clearing.", connections: [] }],
    items: [{ id: LETTER, name: "Sealed Note", description: "A note.", kind: "quest", properties: { body: "hi" } }],
    monsters: [{ id: BANDIT, name: "Bandit", description: "A road bandit.", stats: pcStats }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.camp",
    name: "Camp Campaign",
    worldId: "w.camp",
    characters: [{ id: PC, name: "You", stats: pcStats, age: 30 }],
    travelEventChance: 1,
    travelEvents: travelEvents ?? [
      {
        id: "tev.courier",
        once: "campaign",
        effects: [
          { kind: "narrate", text: "A runner slips into camp and presses a sealed note into your hand." },
          { kind: "giveItem", itemId: LETTER },
        ],
      },
      {
        id: "tev.ambush",
        effects: [{ kind: "spawn", templateId: BANDIT, locationId: "loc.hub", tier: "tracked" }],
      },
    ],
    startingState: { locationId: "loc.hub", party: [PC], companions: [] },
  });
  return { world, campaign };
}

describe("camp events — engine wired", () => {
  test("at camp the courier CAN find you, but the ambush NEVER spawns", async () => {
    const engine = new GameEngine({
      classifier: scriptedClassifier([planOf({ kind: "freeformNarrative" })]),
      playset: campEventsPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await engine.start();

    // Make camp (long rest), then take a couple of camp turns.
    await engine.submitAction({ kind: "enterCamp" });
    await engine.submitPlayerInput("I sit by the fire.");
    await engine.submitPlayerInput("I check my gear.");

    const s = engine.getState();
    // The camp-safe courier delivered its letter…
    expect(s.actors[PC]?.inventory).toContain(LETTER);
    // …but the camp-UNSAFE ambush never materialized a bandit (no spawn effect at camp).
    const anyBandit = Object.values(s.actors).some((a) => a.id.startsWith(BANDIT));
    expect(anyBandit).toBe(false);
  });

  test("an explicit campSafe ambush is still neutralized at camp", async () => {
    const engine = new GameEngine({
      classifier: scriptedClassifier([planOf({ kind: "freeformNarrative" })]),
      playset: campEventsPlayset([
        {
          id: "tev.forced-ambush",
          campSafe: true,
          effects: [
            { kind: "narrate", text: "Something tests the edge of camp, then backs away." },
            { kind: "ambush", templateId: "foe.camp-raider", name: "Camp Raider", hp: 9 },
          ],
        },
      ]),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await engine.start();

    await engine.submitAction({ kind: "enterCamp" });
    await engine.submitPlayerInput("I bank the fire.");

    const s = engine.getState();
    expect(Object.values(s.actors).some((a) => a.id.startsWith("foe.camp-raider"))).toBe(false);
    expect((s.modules?.combat as { active?: boolean } | undefined)?.active ?? false).toBe(false);
  });

  test("a camp-safe check resolves and applies its branch at camp", async () => {
    const engine = new GameEngine({
      classifier: scriptedClassifier([planOf({ kind: "freeformNarrative" })]),
      playset: campEventsPlayset([
        {
          id: "tev.camp-check",
          once: "campaign",
          effects: [
            {
              kind: "check",
              ability: "int",
              dc: 1,
              onSuccess: [{ kind: "adjustCoins", by: 7 }],
              onFail: [{ kind: "adjustCoins", by: -7 }],
            },
          ],
        },
      ]),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await engine.start();

    await engine.submitAction({ kind: "enterCamp" });
    await engine.submitPlayerInput("I study the old map.");

    expect(engine.getState().actors[PC]?.coins).toBe(7);
  });
});
