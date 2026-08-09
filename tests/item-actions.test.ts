/**
 * Item-action tests — Phase 1 use/equip/give wired end-to-end through the engine.
 *
 * Exercises the heuristic classifier's itemAction detection, code-only resolution (seeded heal
 * dice, reducer equip/transfer), the equipped-weapon preference in combat, derived AC at the
 * resolver, and the combat-turn cost of using an item mid-fight. Offline gateway throughout —
 * every assertion is deterministic.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { freeformPlan, TurnItemVerbSchema } from "../src/engine/turn-plan.ts";
import { groundItemsAt } from "../src/rules/ground-items.ts";
import { describe, expect, test } from "bun:test";
import { NpcTemplateSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { byKind, loadExample } from "./support/harness.ts";

/** The example tavern plus a hostile bandit tough enough that a fight spans several turns. */
function hostilePlayset(base: PlaySet): PlaySet {
  const playset = structuredClone(base);
  playset.world.npcs.push(NpcTemplateSchema.parse({
    id: "npc.bandit",
    name: "Bandit",
    summary: "A desperate road-cutter with a raised knife.",
    persona: "Cruel, jumpy, and direct.",
    appearance: "A wiry bandit in a patched coat, knuckles white around a knife.",
    goals: ["Survive the fight"],
    knowledge: [],
    relationships: {},
    stats: {
      abilities: { str: 14, dex: 10, con: 10, int: 9, wis: 10, cha: 8 },
      maxHp: 30,
      armorClass: 10,
      level: 1,
      speed: 30,
      proficiencies: [],
      spells: [],
    },
    autonomy: { isPartyMember: false, level: "passive", canLead: false, heartbeatSeconds: 40, replyDecayAlpha: 0.2 },
  }));
  playset.world.locations.find((loc) => loc.id === "loc.tavern")?.npcs.push("npc.bandit");
  return playset;
}

/** A hurt PC carrying a stacked pair of potions, sidearms, and armor (masterlist ids). */
function seededState(playset: PlaySet): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.lyra"],
    actors: {
      "pc.you": {
        id: "pc.you",
        currentHp: 10,
        locationId: "loc.tavern",
        coins: 750,
        inventory: [
          "item.potion-healing",
          "item.potion-healing",
          "weapon.dagger",
          "weapon.longsword",
          "armor.leather",
          "armor.shield",
          "item.lantern",
        ],
        conditions: [],
      },
      "npc.lyra": {
        id: "npc.lyra",
        currentHp: 28,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
      },
      "npc.bandit": {
        id: "npc.bandit",
        currentHp: 30,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: { "npc.lyra": { "pc.you": 20 } },
    autonomy: { "npc.lyra": { talking: false, replyDepth: 0, lastActedAt: 0 } },
    flags: {},
  };
}

async function makeItemEngine(
  seed = 99,
  classifier: TurnClassifier = heuristicClassifier,
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = hostilePlayset(await loadExample());
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), seededState(playset));
  const engine = new GameEngine({ classifier, playset, store, gateway: new OfflineGateway(), rng: mulberry32(seed) });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("item use (consume)", () => {
  test("drinking a stacked potion rolls its heal dice, heals, and consumes exactly one instance", async () => {
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput("I drink the potion of healing");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ actorId: "pc.you", notation: "2d4+2" });
    expect(rolls[0]!.rolls).toHaveLength(2);
    expect(rolls[0]!.total).toBeGreaterThanOrEqual(4);
    expect(rolls[0]!.total).toBeLessThanOrEqual(10);
    expect(rolls[0]!.purpose).toContain("Potion of Healing");

    const hp = byKind(events, "hpChanged");
    expect(hp).toHaveLength(1);
    expect(hp[0]).toMatchObject({ entityId: "pc.you", from: 10, to: 10 + rolls[0]!.total });

    // Exactly ONE instance of the stacked pair is consumed (transfer to nowhere).
    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "item.potion-healing", from: "pc.you", to: null }),
    ]);
    const inventory = engine.getState().actors["pc.you"]?.inventory ?? [];
    expect(inventory.filter((id) => id === "item.potion-healing")).toHaveLength(1);

    // The offline narrator restates the resolved beat (templated, deterministic).
    const narrations = byKind(events, "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    expect(narrations[0]!.text).toContain("Potion of Healing");
  });

  test("the heal is seeded-RNG deterministic: same seed, same total", async () => {
    const a = await makeItemEngine(41);
    const b = await makeItemEngine(41);
    await a.engine.submitPlayerInput("I drink the potion of healing");
    await b.engine.submitPlayerInput("I drink the potion of healing");
    expect(byKind(a.events, "diceRolled")[0]!.total).toBe(byKind(b.events, "diceRolled")[0]!.total);
    expect(a.engine.getState().actors["pc.you"]?.currentHp).toBe(
      b.engine.getState().actors["pc.you"]?.currentHp,
    );
  });

  test("using an item with no coded effect narrates it as context and consumes nothing", async () => {
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput("I use the warded lantern");

    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "hpChanged")).toHaveLength(0);
    const narrations = byKind(events, "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    expect(narrations[0]!.text).toContain("Warded Lantern");
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.lantern");
  });
});

describe("the starting kit is WORN from turn one (r5 P3)", () => {
  test("a fresh character opens with their own armour, shield and weapon on", async () => {
    // The r5 review sheet promised AC 16; play opened at AC 11 with the chain shirt and shield in
    // the bag, nothing said so, and equipping the three of them by hand cost ~7 energy.
    const { engine } = await makeItemEngine();
    const equipped = engine.getState().actors["pc.you"]?.equipped ?? {};
    // The FIRST fitting item in the character's own kit order — the author's ordering, not a
    // "best item" opinion the engine has no business having.
    expect(equipped.weapon).toBe("weapon.dagger");
    expect(equipped.shield).toBe("armor.shield");
  });

  test("but never something that makes the character WORSE", async () => {
    // This fixture's authored armorClass (14) beats what its leather (11 + dex) would derive, so
    // the leather stays in the pack: auto-equip may only ever help.
    const { engine } = await makeItemEngine();
    expect(engine.getState().actors["pc.you"]?.equipped?.armor).toBeUndefined();
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("armor.leather");
  });
});

describe("equip / unequip / give", () => {
  test("an explicit ambient gift of 'a few coins' deducts three copper (N6)", async () => {
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput(
      "I kneel by the worst-off soul I can find, press a few coins into their hand, and ask their name.",
    );

    expect(byKind(events, "coinsChanged")).toContainEqual(
      expect.objectContaining({ entityId: "pc.you", coins: 747 }),
    );
    expect(engine.getState().actors["pc.you"]?.coins).toBe(747);
    expect(byKind(events, "narration").some((event) => event.text.includes("3 copper"))).toBe(true);
  });

  test("declining pay — 'a steady hand, no coin required' — moves no coin (N12)", async () => {
    const { engine, events } = await makeItemEngine();

    // The body part "hand" plus the phrase "no coin" must NOT read as a 1-copper gift: the player is
    // OFFERING to work for free, not handing money away. The purse stays exactly full.
    await engine.submitPlayerInput(
      "I ask the guard for honest trouble that wants a steady hand, no coin required.",
    );

    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(750);
  });

  test("one compound equip command readies every explicitly named compatible item (N4)", async () => {
    const { engine, events } = await makeItemEngine();
    // A fresh character now walks in wearing their own kit (r5 P3), so strip it first: this spec is
    // about the compound COMMAND, not the opening state.
    await engine.submitPlayerInput("I stow the leather armor");
    await engine.submitPlayerInput("I stow the longsword");
    events.length = 0;

    // Neither "buckle" nor a bare "take" is guaranteed to classify as itemAction. The explicit
    // two-item command is grounded before classification, matching the exact live report wording.
    await engine.submitPlayerInput(
      "I buckle on the leather armor and take the longsword in hand before we go anywhere.",
    );

    expect(byKind(events, "equipmentChanged")).toHaveLength(2);
    expect(engine.getState().actors["pc.you"]?.equipped).toEqual(
      expect.objectContaining({ armor: "armor.leather", weapon: "weapon.longsword" }),
    );
  });

  test("equipping the longsword lands in the weapon slot; stowing clears it", async () => {
    const { engine, events } = await makeItemEngine();
    await engine.submitPlayerInput("I stow the longsword"); // the kit starts worn (r5 P3)
    events.length = 0;

    await engine.submitPlayerInput("I equip the longsword");
    expect(byKind(events, "equipmentChanged")).toEqual([
      expect.objectContaining({
        entityId: "pc.you",
        equipped: expect.objectContaining({ weapon: "weapon.longsword" }),
      }),
    ]);
    expect(engine.getState().actors["pc.you"]?.equipped?.weapon).toBe("weapon.longsword");

    events.length = 0;
    await engine.submitPlayerInput("I stow the longsword");
    expect(byKind(events, "equipmentChanged")).toHaveLength(1);
    expect(engine.getState().actors["pc.you"]?.equipped?.weapon).toBeUndefined();
  });

  test("a shield equips into the shield slot and raises the defender's AC at the resolver", async () => {
    const { engine, events } = await makeItemEngine();
    // The character starts with their own shield ON (r5 P3: it used to sit in the bag, unmentioned,
    // and the first ambush was fought at the unarmoured number).
    expect(engine.getState().actors["pc.you"]?.equipped?.shield).toBe("armor.shield");

    events.length = 0;
    await engine.submitPlayerInput("attack the bandit");
    // The bandit's counter-swing targets the PC's derived AC: authored 14 + shield 2 = 16.
    const counter = byKind(events, "diceRolled").filter((e) => e.purpose?.startsWith("Bandit →"));
    expect(counter.length).toBeGreaterThanOrEqual(1);
    expect(counter[0]!.purpose).toContain("vs AC 16");
  });

  test("giving the dagger hands one instance to a present companion", async () => {
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput("I give Lyra the dagger");

    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "weapon.dagger", from: "pc.you", to: "npc.lyra" }),
    ]);
    expect(engine.getState().actors["npc.lyra"]?.inventory).toContain("weapon.dagger");
    expect(engine.getState().actors["pc.you"]?.inventory).not.toContain("weapon.dagger");
  });

  test("freeform drop — 'I lay my dagger on the flagstones' — genuinely leaves the sheet (r3 #2)", async () => {
    // The consequence floor for a freeform surrender/discard: the LLM classifier (stubbed here — the
    // frozen test DSL never grows) reads the line as itemAction;drop, and the resolver mints the same
    // authoritative transferItem the give path does. Pre-fix the item stayed carried ×1 and was
    // immediately swingable while the narration described it lying on the floor.
    const layDownClassifier: TurnClassifier = {
      classify: (text, ctx) =>
        /lay my dagger/i.test(text)
          ? Promise.resolve({
              ...freeformPlan(),
              kind: "itemAction" as const,
              item: { verb: "drop" as const, itemId: "weapon.dagger", targetId: null },
            })
          : heuristicClassifier.classify(text, ctx),
    };
    const { engine, events } = await makeItemEngine(99, layDownClassifier);

    await engine.submitPlayerInput("I kneel and lay my dagger on the flagstones between us");

    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "weapon.dagger", from: "pc.you", to: null }),
    ]);
    expect(engine.getState().actors["pc.you"]?.inventory).not.toContain("weapon.dagger");
    expect(byKind(events, "stateChanged").some((e) => e.summary.includes("You set down the Dagger"))).toBe(true);
    expect(byKind(events, "narration").some((e) => e.text.includes("Dagger"))).toBe(true);
  });

  test("drop → pickup roundtrip: the floor remembers, the inverse restores (07-18 #2)", async () => {
    // Verb symmetry: every destructive item verb must have a working inverse. Drop writes the
    // groundItems slice (WHERE it landed); pickup grounds against that slice and restores the
    // sheet — a freeform-dropped club is no longer lost for good.
    const roundtrip: TurnClassifier = {
      classify: (text, ctx) =>
        /lay my dagger/i.test(text)
          ? Promise.resolve({
              ...freeformPlan(),
              kind: "itemAction" as const,
              item: { verb: "drop" as const, itemId: "weapon.dagger", targetId: null },
            })
          : /snatch my dagger/i.test(text)
            ? Promise.resolve({
                ...freeformPlan(),
                kind: "itemAction" as const,
                item: { verb: "pickup" as const, itemId: "weapon.dagger", targetId: null },
              })
            : heuristicClassifier.classify(text, ctx),
    };
    const { engine, events } = await makeItemEngine(99, roundtrip);

    await engine.submitPlayerInput("I kneel and lay my dagger on the flagstones");
    expect(groundItemsAt(engine.getState().modules, "loc.tavern")).toEqual(["weapon.dagger"]);
    expect(engine.getState().actors["pc.you"]?.inventory).not.toContain("weapon.dagger");

    await engine.submitPlayerInput("I snatch my dagger back up off the floor");
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("weapon.dagger");
    expect(groundItemsAt(engine.getState().modules, "loc.tavern")).toEqual([]);
    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "weapon.dagger", from: "pc.you", to: null }),
      expect.objectContaining({ itemId: "weapon.dagger", from: null, to: "pc.you" }),
    ]);
    expect(byKind(events, "stateChanged").some((e) => e.summary.includes("You pick up the Dagger"))).toBe(true);
    // The verb enum itself stays symmetric (a static guard for the next destructive verb).
    expect(TurnItemVerbSchema.options).toContain("drop");
    expect(TurnItemVerbSchema.options).toContain("pickup");
  });

  test("pickup of something not on this floor refuses honestly — nothing is minted", async () => {
    const phantomPickup: TurnClassifier = {
      classify: (text, ctx) =>
        /grab the club/i.test(text)
          ? Promise.resolve({
              ...freeformPlan(),
              kind: "itemAction" as const,
              item: { verb: "pickup" as const, itemId: "weapon.club", targetId: null },
            })
          : heuristicClassifier.classify(text, ctx),
    };
    const { engine, events } = await makeItemEngine(99, phantomPickup);

    await engine.submitPlayerInput("I grab the club from the floor");

    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.inventory).not.toContain("weapon.club");
    expect(byKind(events, "narration").some((e) => e.text.includes("not here to take"))).toBe(true);
  });
});

describe("weaponFor preference", () => {
  test("unequipped, the first carried weapon (the dagger) swings", async () => {
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput("attack the bandit");

    const swing = byKind(events, "diceRolled").find((e) => e.purpose?.includes("→ Bandit"));
    expect(swing?.purpose).toContain("· Dagger vs AC");
  });

  test("the equipped weapon beats inventory order", async () => {
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput("I equip the longsword");
    events.length = 0;
    await engine.submitPlayerInput("attack the bandit");

    const swing = byKind(events, "diceRolled").find((e) => e.purpose?.includes("→ Bandit"));
    expect(swing?.purpose).toContain("· Longsword vs AC");
  });
});

describe("item use in combat", () => {
  test("drinking a potion mid-fight spends the player's turn and the fight goes on", async () => {
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput("attack the bandit");
    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);

    events.length = 0;
    await engine.submitPlayerInput("I drink the potion of healing");

    // The potion resolved (heal + consume)...
    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "item.potion-healing", from: "pc.you", to: null }),
    ]);
    // ...and it cost the turn: initiative advanced and the enemy side acted.
    expect(byKind(events, "combatTurnAdvanced").length).toBeGreaterThanOrEqual(1);
    const banditSwings = byKind(events, "diceRolled").filter((e) => e.purpose?.startsWith("Bandit →"));
    expect(banditSwings.length).toBeGreaterThanOrEqual(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);
  });

  test("equipping mid-fight still resolves the round — the deterministic line does not stall combat", async () => {
    // Guards the deliberate consequence of marking equip `deterministic` (live 07-24, so a typed equip
    // costs no narrator round-trip): CombatModule.liftPlayerLine refuses to FOLD a deterministic
    // intent into the round beat, so the equip line now stands on its own beside the combat beat.
    // What must NOT change is the mechanics — the equip still spends the player's turn and the
    // enemy side still acts. (This is not a return of live 07-18 #3: that was a second MODEL beat on
    // a combat-blind brief; this line costs no model call and re-establishes nothing.)
    const { engine, events } = await makeItemEngine();

    await engine.submitPlayerInput("attack the bandit");
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);

    events.length = 0;
    await engine.submitPlayerInput("I equip the longsword");

    expect(engine.getState().actors["pc.you"]?.equipped?.weapon).toBe("weapon.longsword");
    expect(byKind(events, "combatTurnAdvanced").length).toBeGreaterThanOrEqual(1);
    const banditSwings = byKind(events, "diceRolled").filter((e) => e.purpose?.startsWith("Bandit →"));
    expect(banditSwings.length).toBeGreaterThanOrEqual(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);
    // The player is still told what they did, verbatim, on its own line.
    expect(byKind(events, "narration").map((e) => e.text)).toContain("You ready the Longsword for use.");
  });
});
