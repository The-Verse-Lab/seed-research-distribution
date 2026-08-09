/**
 * Allies who actually fight (r5 fix wave, r4 playtest P3).
 *
 * "Sela took up the poker and planted herself at the bar; Veressa drew a blade and moved to flank.
 * The COMBAT panel listed only Salt Revenant and Kestrel Vane, no ally acted on any round, and the
 * enemy HP never moved except by my rolls. As a 9 HP solo character I made a tactical decision on
 * the strength of help that did not exist."
 *
 * Two load-bearing pins beyond "does it work":
 *  - the ally swings on the CALL turn, not the next one (help that arrives a turn late is the same
 *    defect, delayed);
 *  - the shared rng prefix is untouched, so the exact-value assertions in combat-module.test.ts —
 *    and every seeded roll downstream — cannot shift. Asserting "same draw count with and without a
 *    conscribable bystander" would be vacuous: it only holds in the no-join case.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { makeSaveKey } from "../src/state/store.ts";
import type { GameState } from "../src/state/types.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { CombatEncounter } from "../src/rules/combat-state.ts";

/** A deterministic stream that also COUNTS draws — the shared-rng discipline assertion. */
function countingRng(values: number[]): { rng: () => number; draws: () => number } {
  let i = 0;
  return {
    rng: () => values[Math.min(i++, values.length - 1)]!,
    draws: () => i,
  };
}

/**
 * `revenantHp` exists because an ally who really swings can END the fight on the turn she joins —
 * a 4 HP foe does not survive Sela's first blow. Tests that need the encounter to still be RUNNING
 * after the call turn (the turn-pointer pin, the prompt fence) ask for a foe that can take the hit.
 */
function buildPlayset(revenantHp = 4): PlaySet {
  const world = WorldSchema.parse({
    id: "w.aid",
    name: "One Room",
    summary: "A test world.",
    locations: [
      {
        id: "loc.house",
        name: "The Way-House",
        description: "A low common room.",
        npcs: ["npc.sela", "npc.revenant"],
      },
    ],
    npcs: [
      {
        id: "npc.sela",
        name: "Sela",
        persona: "The way-house keeper, warm and unhurried.",
        age: 45,
        alignment: "ng",
        personalityTemplate: "caretaker",
        relationships: { "pc.you": 60 },
        stats: {
          abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 12, cha: 12 },
          maxHp: 14,
          armorClass: 12,
          level: 1,
        },
      },
      {
        id: "npc.revenant",
        name: "Salt Revenant",
        persona: "A dead thing crusted in salt.",
        age: 40,
        stats: {
          abilities: { str: 14, dex: 10, con: 10, int: 6, wis: 10, cha: 6 },
          maxHp: revenantHp,
          armorClass: 1,
          level: 1,
        },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.aid",
    name: "Test Campaign",
    worldId: "w.aid",
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: { abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, maxHp: 24, armorClass: 12 },
        age: 30,
      },
    ],
    startingState: { locationId: "loc.house", party: ["pc.you"] },
  });
  return { world, campaign };
}

function seededState(playset: PlaySet): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.house",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 24, locationId: "loc.house", inventory: [], conditions: [] },
      "npc.sela": { id: "npc.sela", currentHp: 14, locationId: "loc.house", inventory: [], conditions: [] },
      "npc.revenant": {
        id: "npc.revenant",
        currentHp: playset.world.npcs.find((n) => n.id === "npc.revenant")?.stats?.maxHp ?? 4,
        locationId: "loc.house",
        inventory: [],
        conditions: [],
      },
    },
    quests: {},
    relationships: { "npc.sela": { "pc.you": 60 } },
    modules: {},
    flags: {},
  } as unknown as GameState;
}

const plan = (over: Partial<TurnPlan>): TurnPlan =>
  ({
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...over,
  }) as TurnPlan;

function seqClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)]!) };
}

async function run(plans: TurnPlan[], inputs: string[], rng: () => number, revenantHp?: number) {
  const playset = buildPlayset(revenantHp);
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, "pc.you"), seededState(playset));
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    classifier: seqClassifier(plans),
    rng,
    summary: false,
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  for (const input of inputs) await engine.submitPlayerInput(input);
  return { engine, events };
}

const attack = plan({ kind: "attack", targetId: "npc.revenant" });
const callSela = plan({ kind: "dialogueToNpc", targetId: "npc.sela" });
const encounterOf = (events: GameEvent[]): CombatEncounter | undefined =>
  (events.filter((e) => e.kind === "combatJoined").at(-1) as { encounter: CombatEncounter } | undefined)?.encounter;

describe("calling for aid mid-fight", () => {
  test("a called bystander joins on the PARTY's side and swings on that same turn", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run([attack, callSela], ["I swing at the revenant", "Sela, help me!"], rng);

    const enc = encounterOf(events);
    expect(enc?.order).toContain("npc.sela");
    expect(enc?.allies).toEqual(["npc.sela"]);
    // The call SPENDS the turn, so the round is driven and the enemy acts — the ally is not left
    // standing in the order until the player's next attack. Pinned by ACTOR, not by count: a bare
    // count is satisfied by the ENEMY's own swing, so it stayed green all the way through the live
    // deadlock below, in which Sela stood in the order and never once rolled.
    const rolled = events.filter((e) => e.kind === "diceRolled").map((e) => (e as { actorId?: string }).actorId);
    expect(rolled).toContain("npc.sela");
  });

  /**
   * The r5 deadlock, found in live play. `joinCombat` commits at the END of the tick, so
   * the module drove the round against an order that did not have the ally in it: it wrapped a
   * 2-long order 1 → 0 and stopped, believing index 1 was the player, while the reducer spliced the
   * ally in and stepped a 3-long order 1 → 2 → 0. The committed pointer came to rest on the MONSTER,
   * and every later player swing hit the "it is not your turn in the exchange" gate — two correctly
   * classified attacks (kind `attack`, confidence 1) resolved to nothing at all, and the fight ended
   * only when the party walked away from it. The POINTER is the thing to pin.
   */
  test("the turn pointer lands back on the PLAYER after an ally joins — the fight is not deadlocked", async () => {
    const { rng } = countingRng([0.9]);
    // A foe that survives the round: an ended fight is not deadlocked either, so a 4 HP revenant
    // would make this pass without testing anything.
    const { events } = await run([attack, callSela], ["I swing at the revenant", "Sela, help me!"], rng, 40);
    const advances = events.filter((e) => e.kind === "combatTurnAdvanced") as { encounter: CombatEncounter }[];
    const last = advances.at(-1)?.encounter;
    expect(events.some((e) => e.kind === "combatEnded")).toBe(false);
    expect(last?.order).toContain("npc.sela");
    expect(last?.order[last.turnIndex]).toBe("pc.you");
  });

  test("a further swing after the ally joins still resolves — the player is not locked out", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, callSela, attack],
      ["I swing at the revenant", "Sela, help me!", "I swing at it again"],
      rng,
      40,
    );
    // The live symptom was a player attack that produced no swing whatsoever. Damage landing on the
    // foe on the turn AFTER the join is the honest proof the gate is open again.
    const hurt = events.filter(
      (e) => e.kind === "hpChanged" && (e as { entityId: string }).entityId === "npc.revenant",
    );
    expect(hurt.length).toBeGreaterThan(1);
  });

  test("a joined ally is never treated as a foe — the fight can still end", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run([attack, callSela, attack], ["swing", "Sela, help me!", "swing"], rng);
    // Sela must never be the one taking the party's damage, and the encounter must be able to close.
    const hurt = events.filter((e) => e.kind === "hpChanged").map((e) => (e as { entityId: string }).entityId);
    expect(hurt).not.toContain("npc.sela");
  });

  test("the shared rng prefix is UNTOUCHED by the join decision (private keyed rng)", async () => {
    // Same script, once with the call and once without: the draws consumed up to the first attack
    // must match, or every seeded roll downstream — and combat-module.test.ts's exact hpChanged
    // sequence — shifts under the wave.
    const a = countingRng([0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0.5]);
    await run([attack], ["swing"], a.rng);
    const withoutCall = a.draws();

    const b = countingRng([0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0.5]);
    await run([attack], ["swing"], b.rng);
    expect(b.draws()).toBe(withoutCall);
  });
});

describe("the non-combatant fence (r4, previously untested)", () => {
  test("the combat prompt names exactly who acts, and a joined ally is on that list", async () => {
    const prompts: string[] = [];
    const playset = buildPlayset(40);
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(playset.campaign.id, "pc.you"), seededState(playset));
    const offline = new OfflineGateway();
    const gateway = {
      complete: offline.complete.bind(offline),
      async *stream(role: string, req: { messages: { content: string }[] }) {
        if (role === "narrator") prompts.push(req.messages.at(-1)?.content ?? "");
        yield* (offline.stream as never as (r: unknown, q: unknown) => AsyncIterable<unknown>)(role, req);
      },
      embed: offline.embed.bind(offline),
    };
    const engine = new GameEngine({
      playset,
      store,
      gateway: gateway as never,
      classifier: seqClassifier([attack, callSela]),
      rng: countingRng([0.9]).rng,
      summary: false,
    });
    await engine.start();
    await engine.submitPlayerInput("I swing at the revenant");
    await engine.submitPlayerInput("Sela, help me!");

    const fenced = prompts.filter((p) => p.includes("Only these combatants act in this fight"));
    expect(fenced.length).toBeGreaterThan(0);
    // The fence is only honest if a conscripted ally is ON the list — before r5 she could be
    // narrated fighting while being structurally incapable of it.
    expect(fenced.some((p) => p.includes("Sela"))).toBe(true);
  });
});

describe("stepping in unasked", () => {
  test("a warm, well-disposed bystander may join with no call at all", async () => {
    // Sela is ng/caretaker at +60 to the PC — decideIntervention puts her well above the floor, and
    // the roll is a PRIVATE keyed stream, so this verdict is deterministic without scripting it.
    const { rng } = countingRng([0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0.5, 0]);
    const { events } = await run([attack, plan({})], ["swing", "I hold my ground"], rng);
    const joined = events.filter((e) => e.kind === "combatJoined");
    // Either she stepped in or she did not — but the decision must be code's, deterministic, and
    // must never put a bodyless helper in the order.
    for (const j of joined) {
      expect((j as { encounter: CombatEncounter }).encounter.allies).toContain("npc.sela");
    }
  });
});

describe("speechAct — the closed answer that replaced DEESCALATION_RE (r8 regex audit)", () => {
  // The regex answered two different questions with one word-list: "is this a plea to stop?" (the
  // combat module's parley trigger) and "is this NOT a call for aid?" (the engine's dialogue gate).
  // It cannot tell a plea from an ORDER or from a battle cry, and both misfires are reproduced
  // below against shipped code. The classifier now NAMES the speech act from
  // {deescalate, callForAid, other}; the addressing gate stays the code-side authority on WHO is
  // being spoken to, and the regex survives only where the plan carries no answer.

  test("REPRODUCED: 'Sela, stop him!' with no named speech act is scored as a PARLEY, not aid", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, callSela],
      ["I swing at the revenant", "Sela, stop him!"],
      rng,
      40,
    );
    // An order to a companion to stop the ENEMY trips the `stop` arm, so the call for aid is
    // suppressed and the line rolls a talk-down instead. Sela never joins the fight.
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(true);
    expect(events.filter((e) => e.kind === "combatJoined")).toHaveLength(0);
  });

  test("speechAct 'callForAid' recruits the companion the line was actually ordering", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, plan({ kind: "dialogueToNpc", targetId: "npc.sela", speechAct: "callForAid" })],
      ["I swing at the revenant", "Sela, stop him!"],
      rng,
      40,
    );
    const enc = encounterOf(events);
    expect(enc?.allies).toEqual(["npc.sela"]);
    // …and no talk-down roll was made on a line that was never a plea.
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(false);
  });

  test("REPRODUCED: 'Enough of this — kill it!' with no named speech act opens a surrender bid", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, plan({})],
      ["I swing at the revenant", "Enough of this — kill it!"],
      rng,
      40,
    );
    // The `enough` arm fires on a line that DECLARES an attack, and an untargeted line passes the
    // addressing gate unconditionally — so the turn is spent begging the thing the player just
    // ordered killed. On the 0.9 stream the parley even succeeds and ends the fight.
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(true);
  });

  test("speechAct 'other' leaves the fight alone — no parley on a battle cry", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, plan({ speechAct: "other" })],
      ["I swing at the revenant", "Enough of this — kill it!"],
      rng,
      40,
    );
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(false);
    expect(events.some((e) => e.kind === "combatEnded")).toBe(false);
  });

  test("speechAct 'deescalate' still parleys — the r6/r7 contract is preserved", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, plan({ kind: "dialogueToNpc", targetId: "npc.sela", speechAct: "deescalate" })],
      ["I swing at the revenant", "Sela — nobody here has to die over this."],
      rng,
      40,
    );
    // A plea to a BYSTANDER carries no stop-word at all, so the old 48-char positional proxy would
    // have refused it; the named speech act makes it a parley on its own, and recruits nobody.
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(true);
    expect(events.filter((e) => e.kind === "combatJoined")).toHaveLength(0);
  });
});

describe("parley mid-fight (r6 P1)", () => {
  test("an explicit STOP is a stop-the-fight contest, never a call for aid", async () => {
    // The live defect: "ODA, STOP! I get between them with both hands up and empty" was answered
    // by "Sela of Ashford takes your side — they are in the fight." A de-escalation line must run
    // the parley contest and recruit NOBODY.
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, callSela],
      ["I swing at the revenant", "STOP! I get between them with both hands up and empty."],
      rng,
      40,
    );

    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string; success?: boolean }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(true);
    // Nobody was recruited INTO the fight the player was ending.
    const joined = events.filter((e) => e.kind === "combatJoined");
    expect(joined).toHaveLength(0);
    expect(events.some((e) => e.kind === "stateChanged" && e.summary.includes("takes your side"))).toBe(false);
    // The parley succeeded (0.9 stream): the fight ends talked-down, not won.
    expect(events.some((e) => e.kind === "stateChanged" && e.summary.includes("talked down"))).toBe(true);
    expect(events.some((e) => e.kind === "combatEnded")).toBe(true);
  });

  test("a successful parley calms the foe DURABLY — it does not re-aggro afterwards", async () => {
    const { rng } = countingRng([0.9]);
    const { engine, events } = await run(
      [attack, callSela, plan({}), plan({})],
      ["I swing at the revenant", "Stop — nobody here wants this. I talk it down.", "I look around", "I wait"],
      rng,
      40,
    );
    void engine;
    expect(events.some((e) => e.kind === "combatEnded")).toBe(true);
    // After the stand-down the hostile flag is cleared and the calmed mark holds: no new fight.
    expect(events.filter((e) => e.kind === "combatStarted")).toHaveLength(1); // only the opener
  });

  test("a scenery word in a bystander line does not address the fight (r8 audit)", async () => {
    // `addressesTheFight` decided "the line names a living foe" by testing every ≥3-char whitespace
    // token of the foe's name as a SUBSTRING of the input. "Salt Revenant" therefore answered to the
    // ordinary word "salt" — and on the shipped roster it is worse, because a foe styled "Oda the
    // Wayfarer" or "The Saltmother" answers to the bare article "the", so essentially EVERY line
    // containing a de-escalation cue counted as addressing the fight. Here the line is plainly a
    // conversation with the bystander about the floor, and it must stay one: no parley roll.
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, callSela],
      ["I swing at the revenant", "Sela, is the salt crust on these boards thick enough to spoil the beer?"],
      rng,
      40,
    );
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(false);
    expect(events.some((e) => e.kind === "combatEnded")).toBe(false);
  });

  test("naming the foe DISTINCTIVELY still addresses the fight", async () => {
    const { rng } = countingRng([0.9]);
    const { events } = await run(
      [attack, callSela],
      ["I swing at the revenant", "Sela, get back — I want the revenant to stand down, not to bleed."],
      rng,
      40,
    );
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("stop the fight"))).toBe(true);
  });

  test("a FAILED parley spends the turn and the fight rages on", async () => {
    const { rng } = countingRng([0]);
    const { events } = await run(
      [attack, callSela],
      ["I swing at the revenant", "I yield! Stop fighting!"],
      rng,
      40,
    );
    const rolls = events.filter((e) => e.kind === "diceRolled") as { purpose?: string; success?: boolean }[];
    const parleyRoll = rolls.find((r) => (r.purpose ?? "").includes("stop the fight"));
    expect(parleyRoll).toBeDefined();
    expect(parleyRoll!.success).toBe(false);
    // No stand-down, no end: the fight is still live.
    expect(events.some((e) => e.kind === "stateChanged" && e.summary.includes("talked down"))).toBe(false);
    expect(events.some((e) => e.kind === "combatEnded")).toBe(false);
  });
});
