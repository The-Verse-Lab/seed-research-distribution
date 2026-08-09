/**
 * Betrayal regressions: a companion can turn from inside the party, and combat distinguishes
 * deliberate betrayal from accidental friendly-fire targeting.
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { partyHostileFlag } from "../src/rules/betrayal.ts";
import type { Rng } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import type { GameEvent } from "../src/events/types.ts";
import { byKind } from "./support/harness.ts";

const pcStats = {
  abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  maxHp: 24,
  armorClass: 8,
  level: 1,
  speed: 30,
  proficiencies: [],
  spells: [],
};

const infiltratorStats = {
  abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 8 },
  maxHp: 24,
  armorClass: 8,
  level: 1,
  speed: 30,
  proficiencies: [],
  spells: [],
};

function scripted(values: number[], fallback = 0.5): Rng {
  let index = 0;
  return () => values[index++] ?? fallback;
}

/**
 * `companionName` matters: the default fixture name "Infiltrator" is a single made-up word with no
 * stop-word in it, so the friendly-fire guard's own bug was invisible here. A SHIPPED name is the
 * only way to pin it — see "an accidental friendly-fire target named like a real roster NPC".
 */
function buildPlayset(companionName = "Infiltrator"): PlaySet {
  const world = WorldSchema.parse({
    id: "w.betrayal",
    name: "Betrayal Fixture",
    summary: "A focused betrayal test world.",
    locations: [{ id: "loc.room", name: "Room", description: "A bare room.", npcs: ["npc.infiltrator"] }],
    npcs: [
      {
        id: "npc.infiltrator",
        name: companionName,
        summary: "A companion whose loyalty is false.",
        persona: "Cold, opportunistic, and ready to turn.",
        age: 30,
        alignment: "ce",
        personalityTemplate: "brute",
        stats: infiltratorStats,
        inventory: ["weapon.dagger"],
        relationships: { "pc.you": -90 },
        autonomy: { isPartyMember: true, level: "passive", canLead: false, heartbeatSeconds: 30, replyDecayAlpha: 0.2 },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.betrayal",
    name: "Betrayal Campaign",
    worldId: world.id,
    characters: [
      {
        id: "pc.you",
        name: "You",
        age: 30,
        stats: pcStats,
        inventory: ["weapon.dagger"],
      },
    ],
    startingState: { locationId: "loc.room", party: ["pc.you"], companions: ["npc.infiltrator"] },
  });
  return { world, campaign };
}

async function startEngine({
  playset,
  rng = scripted([]),
  classifier = heuristicClassifier,
}: {
  playset: PlaySet;
  rng?: Rng;
  classifier?: TurnClassifier;
}): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const engine = new GameEngine({
    classifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng,
  });
  const events: GameEvent[] = [];
  engine.subscribe((event) => events.push(event));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("betrayal", () => {

  test("an explicit player attack on a party member is treated as deliberate betrayal", async () => {
    const { engine, events } = await startEngine({
      playset: buildPlayset(),
      rng: scripted([0.5, 0.5, 0.99, 0.5, 0.5]),
    });

    await engine.submitPlayerInput("I attack Infiltrator.");

    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect(byKind(events, "diceRolled")).toContainEqual(
      expect.objectContaining({ actorId: "pc.you", success: true }),
    );
    expect(engine.getState().actors["npc.infiltrator"]?.currentHp).toBeLessThan(infiltratorStats.maxHp);
    // Betrayal has mechanical teeth now (2026-07-05): the struck companion LEAVES the roster and
    // their regard for the PC craters — no longer a companion, now an enemy.
    expect(engine.getState().companions).not.toContain("npc.infiltrator");
    expect(byKind(events, "partyMembershipChanged").length).toBeGreaterThanOrEqual(1);
    expect(engine.getState().relationships?.["npc.infiltrator"]?.["pc.you"] ?? 0).toBeLessThan(0);
  });

  test("a weapon-verb attack on a named party member is deliberate betrayal (live #4)", async () => {
    const { engine, events } = await startEngine({
      playset: buildPlayset(),
      rng: scripted([0.5, 0.5, 0.99, 0.5, 0.5]),
      // The live classifier already grounded this exact shape as attack -> Oda (1.00). Script that
      // classified plan here: the retired test-only regex DSL intentionally does not grow new verbs.
      classifier: {
        classify: async () => ({
          kind: "attack",
          targetId: "npc.infiltrator",
          destinationLocationId: null,
          check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
          confidence: 1,
        }),
      },
    });

    await engine.submitPlayerInput(
      "without a word of warning I draw my club and crack Infiltrator across the back of the skull — I want his purse.",
    );

    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect(byKind(events, "diceRolled")).toContainEqual(
      expect.objectContaining({ actorId: "pc.you", success: true }),
    );
    expect(engine.getState().actors["npc.infiltrator"]?.currentHp).toBeLessThan(infiltratorStats.maxHp);
    expect(engine.getState().companions).not.toContain("npc.infiltrator");
  });

  test("an accidental friendly-fire target is still blocked", async () => {
    const { engine, events } = await startEngine({ playset: buildPlayset() });

    await engine.submitPlayerInput("I strike the wight before it reaches Infiltrator.");

    expect(byKind(events, "combatStarted")).toHaveLength(0);
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "hpChanged")).toHaveLength(0);
    expect(engine.getState().actors["npc.infiltrator"]?.currentHp).toBe(infiltratorStats.maxHp);
    expect(engine.getState().companions).toContain("npc.infiltrator");
  });

  test("an accidental friendly-fire target named like a real roster NPC is blocked (r8 audit)", async () => {
    // REPRODUCED end-to-end before the fix. `targetForms("Oda the Wayfarer")` yielded
    // ["oda the wayfarer","npc.oda","oda","the","wayfarer"] — including the bare ARTICLE — so
    // `attack the` matched, and the exact sentence the guard's comment says it exists to catch
    // ("strike the wight before it reaches <companion>") was read as deliberate betrayal: the
    // flagship companion left the party, both relationships cratered by 100, and the swing landed.
    // 12 of the 66 names in the original regression corpus carry a stop-word token like this.
    //
    // The fixture above uses the one-word name "Infiltrator", which has no stop-word, so it could
    // never have caught this. Only a shipped-shape name inverts the assertion.
    const { engine, events } = await startEngine({ playset: buildPlayset("Oda the Wayfarer") });

    await engine.submitPlayerInput("I attack the wight before it reaches Oda.");

    expect(byKind(events, "combatStarted")).toHaveLength(0);
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "hpChanged")).toHaveLength(0);
    expect(byKind(events, "partyMembershipChanged")).toHaveLength(0);
    expect(engine.getState().actors["npc.infiltrator"]?.currentHp).toBe(infiltratorStats.maxHp);
    expect(engine.getState().companions).toContain("npc.infiltrator");
    expect(engine.getState().relationships?.["npc.infiltrator"]?.["pc.you"] ?? 0).toBeGreaterThanOrEqual(-90);
  });

  test("…and the SAME roster name is still betrayable — the >=3 floor stays at 3", async () => {
    // The audit's first suggested fix (raise the bare-word floor to length >= 4) drops "oda"
    // entirely, which makes deliberate betrayal of the flagship companion impossible to express.
    // Dropping the stop-words alone fixes every false positive and costs no true one.
    const { engine, events } = await startEngine({
      playset: buildPlayset("Oda the Wayfarer"),
      rng: scripted([0.5, 0.5, 0.99, 0.5, 0.5]),
    });

    await engine.submitPlayerInput("I attack Oda.");

    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect(engine.getState().actors["npc.infiltrator"]?.currentHp).toBeLessThan(infiltratorStats.maxHp);
    expect(engine.getState().companions).not.toContain("npc.infiltrator");
  });

  test("a companion name carrying regex metacharacters splices literally, never as a replacement pattern", async () => {
    // `escapeRegExp` escapes the dollar sign for the PATTERN, but `` $` `` (and `$&`, `$'`) stay
    // special on the RIGHT of `String.replace`. Splicing the escaped name in as a replacement
    // STRING therefore compiled `…(?:the\s+)?K\` + THE WHOLE PRECEDING SOURCE + `` `z\b `` — it did
    // not throw, it just silently matched something else, so the guard stopped recognising this
    // companion's name at all and a deliberate betrayal of them could not be expressed.
    // `PUT /api/worlds/:campaignId` takes `name` as unrestricted text, so the name is reachable.
    //
    // "K$`z" has no token of its own (both letters are 1 char), so the FULL-NAME form is the only
    // handle — which is exactly the form the corrupted splice destroyed.
    const { engine, events } = await startEngine({
      playset: buildPlayset("K$`z"),
      rng: scripted([0.5, 0.5, 0.99, 0.5, 0.5]),
      classifier: {
        classify: async () => ({
          kind: "attack",
          targetId: "npc.infiltrator",
          destinationLocationId: null,
          check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
          confidence: 1,
        }),
      },
    });

    await engine.submitPlayerInput("I attack K$`z.");

    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect(engine.getState().companions).not.toContain("npc.infiltrator");
  });
});
