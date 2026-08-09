/**
 * Mid-fight non-attack turns still move the fight — engine-level regressions from playtest r14
 * (fixture-combat t15–t17, the frozen-hound stretch).
 *
 * t15/t17: "I break for the road…" classified `attemptRequiringCheck`, rolled, FAILED — and the
 * hound simply waited: no answering swing, no `combatTurnAdvanced`, the fight clock frozen. The
 * disengage resolver already knew the contract ("the foes answer the attempt in the same tick");
 * the generic check resolver never spent the combat turn.
 *
 * t16: "I'm not running. What do you want?" at the hound — `dialogueToNpc`, target mon.ash-hound#0
 * — answered "There is no sign of Ash Hound here." while that hound was actively mauling the
 * player: the absent-addressee stub fired on a PRESENT monster because the reply machinery is
 * NPC-only, and the guard that keeps present names out of it is skipped when a grounded target is
 * passed.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { MonsterSchema, PrebakedEventSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { loadExample } from "./support/harness.ts";

const baseCheck = { warranted: false as const, ability: null, skill: null, dc: null, reason: "" };

function byKind<K extends GameEvent["kind"]>(events: GameEvent[], kind: K): Extract<GameEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<GameEvent, { kind: K }> => e.kind === kind);
}

/** A tanky, weaponless monster spawned by a prebaked event — the only path that stamps kind:"monster". */
function withHuskMonster(base: PlaySet): PlaySet {
  const playset = structuredClone(base);
  playset.world.monsters.push(
    MonsterSchema.parse({
      id: "mon.husk",
      name: "Withered Husk",
      description: "A dried, shambling thing with empty hands.",
      stats: {
        abilities: { str: 10, dex: 10, con: 10, int: 3, wis: 10, cha: 3 },
        maxHp: 40,
        armorClass: 8,
        level: 1,
        speed: 20,
        proficiencies: [],
        spells: [],
      },
      inventory: [],
    }),
  );
  playset.campaign.events.push(
    PrebakedEventSchema.parse({
      id: "ev.husk",
      when: "onEnterLocation",
      trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
      effects: [{ kind: "spawn", templateId: "mon.husk", locationId: "loc.square", tier: "tracked" }],
      once: "campaign",
    }),
  );
  return playset;
}

function soloState(playset: PlaySet): GameState {
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
        currentHp: 200,
        locationId: "loc.tavern",
        inventory: ["item.lantern"],
        conditions: [],
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    flags: {},
  };
}

/** Walk into the square (spawn), look around (on-sight aggro), then run the plan under test. */
async function engageHusk(
  thirdPlan: Partial<TurnPlan> & { kind: TurnPlan["kind"] },
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = withHuskMonster(await loadExample());
  const store = new InMemoryGameStateStore();
  const state = soloState(playset);
  delete state.actors["npc.lyra"];
  await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
  let call = 0;
  const plans: (Partial<TurnPlan> & { kind: TurnPlan["kind"] })[] = [
    { kind: "movement", destinationLocationId: "loc.square" },
    // A DECLARED attack opens the fight deterministically (a mere look leaves the husk a
    // suppressed hostile, and a spoken line at it runs the PRE-combat tryDeescalate contest —
    // a different, working machine; these tests are about a fight already live).
    { kind: "attack", targetId: "mon.husk#0" },
    thirdPlan,
  ];
  const classifier: TurnClassifier = {
    classify: async () => {
      const p = plans[Math.min(call, plans.length - 1)]!;
      call += 1;
      return {
        targetId: null,
        destinationLocationId: null,
        check: baseCheck,
        confidence: 1,
        ...p,
      } as TurnPlan;
    },
  };
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    classifier,
    rng: mulberry32(13),
    summary: false,
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  await engine.submitPlayerInput("head to the square"); // spawn fires
  await engine.submitPlayerInput("I attack the husk"); // combat opens, initiative runs to the player
  // The fight must already be LIVE before the turn under test — otherwise an aggro/ambush opening
  // on that turn could satisfy the answered-turn assertions vacuously (skeptic pass, r14).
  if ((engine.getState().modules?.combat as { active?: boolean } | undefined)?.active !== true) {
    throw new Error("fixture: combat did not open on the declared attack");
  }
  events.length = 0; // the turn under test records alone
  return { engine, events };
}

const combatActive = (engine: GameEngine): boolean =>
  (engine.getState().modules?.combat as { active?: boolean } | undefined)?.active === true;

describe("r14 — a mid-fight turn is never free", () => {
  test("a FAILED generic check spends the combat turn: the foe answers the same tick", async () => {
    const { engine, events } = await engageHusk({
      kind: "attemptRequiringCheck",
      targetId: "mon.husk#0",
      check: { warranted: true, ability: "str", skill: "Athletics", dc: 30, reason: "break away", purpose: "other" },
    });
    await engine.submitPlayerInput("I break for the road, swinging wide to keep it off me");
    // The player's own roll happened…
    const playerRolls = byKind(events, "diceRolled").filter((e) => e.actorId === "pc.you");
    expect(playerRolls.length).toBeGreaterThan(0);
    expect(playerRolls[0]?.success).toBe(false); // DC 30 — the attempt fails
    // …and the fight ANSWERED it: initiative passed on, the husk took its swing.
    expect(byKind(events, "combatTurnAdvanced").length).toBeGreaterThan(0);
    expect(byKind(events, "diceRolled").some((e) => e.actorId === "mon.husk#0")).toBe(true);
    expect(combatActive(engine)).toBe(true);
  });

  test("speaking at the foe draws no absence line, and the fight answers", async () => {
    const { engine, events } = await engageHusk({
      kind: "dialogueToNpc",
      targetId: "mon.husk#0",
    });
    await engine.submitPlayerInput("I'm not running. What do you want?");
    const prose = byKind(events, "narration")
      .map((e) => e.text)
      .join("\n");
    expect(prose).not.toContain("There is no sign of");
    // The words were spoken and spent the round — the husk answers in the same tick.
    expect(byKind(events, "combatTurnAdvanced").length).toBeGreaterThan(0);
    expect(byKind(events, "diceRolled").some((e) => e.actorId === "mon.husk#0")).toBe(true);
    expect(combatActive(engine)).toBe(true);
  });

  test("a DE-ESCALATION line at the foe runs the parley contest, not the spent-turn rail", async () => {
    // The r6 P1 parley owns a talk-it-down attempt and prices the turn itself — the r14 spent-turn
    // rail must stand aside for it (a de-escalation both spent AND parleyed would double-answer).
    const { engine, events } = await engageHusk({
      kind: "dialogueToNpc",
      targetId: "mon.husk#0",
    });
    await engine.submitPlayerInput("Enough of this — stop! Stand down!");
    const prose = byKind(events, "narration")
      .map((e) => e.text)
      .join("\n");
    expect(prose).not.toContain("There is no sign of");
    expect(
      byKind(events, "diceRolled").some((e) => (e.purpose ?? "").includes("stop the fight")),
    ).toBe(true);
  });

  test("a PASSED disengage-purpose check still ends the fight (the r7 evasion-calm is untouched)", async () => {
    const { engine, events } = await engageHusk({
      kind: "attemptRequiringCheck",
      targetId: "mon.husk#0",
      check: { warranted: true, ability: "dex", skill: "Stealth", dc: 2, reason: "slip away", purpose: "disengage" },
    });
    await engine.submitPlayerInput("I duck behind the cart and slip away");
    expect(byKind(events, "combatEnded").length).toBeGreaterThan(0);
    expect(combatActive(engine)).toBe(false);
  });
});
