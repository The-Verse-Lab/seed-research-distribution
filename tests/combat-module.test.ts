/**
 * CombatModule end-to-end tests — M3 Phase 3 wiring.
 *
 * Exercises the tick module through GameEngine: attack intent starts combat, deterministic swings
 * enqueue reducer commands, HP/down/end deltas commit, replay remains covered elsewhere.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { MonsterSchema, NpcTemplateSchema, PrebakedEventSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionRequest, CompletionResult, EmbeddingResult, LlmRole } from "../src/llm/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { NATURAL_WEAPON, IMPROVISED_WEAPON } from "../src/rules/srd/index.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { looksLikeRefusal } from "../src/modules/narrate.ts";
import { loadExample } from "./support/harness.ts";

function scriptedRng(values: number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error(`scripted rng exhausted at roll ${index}`);
    return value;
  };
}

class RecordingGateway implements LlmGateway {
  readonly narratorPrompts: string[] = [];
  private readonly offline = new OfflineGateway();

  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    return this.offline.complete(role, req);
  }

  async *stream(role: LlmRole, req: CompletionRequest) {
    if (role === "narrator") this.narratorPrompts.push(req.messages.at(-1)?.content ?? "");
    yield* this.offline.stream(role, req);
  }

  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return this.offline.embed(role, texts);
  }
}

const attackBandit: TurnClassifier = {
  classify: async () => ({
    kind: "attack",
    targetId: "npc.bandit",
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
  }),
};

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
      maxHp: 3,
      armorClass: 1,
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

function seededState(playset: PlaySet, modules: Record<string, unknown> = {}): GameState {
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
        currentHp: 24,
        locationId: "loc.tavern",
        inventory: ["item.lantern"],
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
        currentHp: 3,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: { "npc.lyra": { "pc.you": 20 } },
    autonomy: { "npc.lyra": { talking: false, replyDepth: 0, lastActedAt: 0 } },
    modules,
    flags: {},
  };
}

function saveKey(playset: PlaySet) {
  return makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]);
}

function byKind<K extends GameEvent["kind"]>(events: GameEvent[], kind: K): Extract<GameEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<GameEvent, { kind: K }> => event.kind === kind);
}

describe("CombatModule", () => {
  test("a seeded attack starts combat, drives code-default turns, downs the foe, and ends", async () => {
    const playset = hostilePlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    await store.save(saveKey(playset), seededState(playset));
    const gateway = new RecordingGateway();
    const engine = new GameEngine({
      playset,
      store,
      gateway,
      classifier: attackBandit,
      rng: scriptedRng([0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0.5, 0]),
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    events.length = 0;

    await engine.submitPlayerInput("attack the bandit");

    expect(byKind(events, "combatStarted")[0]?.encounter).toMatchObject({
      active: true,
      locationId: "loc.tavern",
      order: ["npc.lyra", "pc.you", "npc.bandit"],
      turnIndex: 1,
      round: 1,
    });
    expect(byKind(events, "diceRolled")).toHaveLength(3);
    expect(byKind(events, "hpChanged").map((event) => [event.entityId, event.to])).toEqual([
      ["npc.bandit", 1],
      ["pc.you", 21],
      ["npc.bandit", 0],
    ]);
    expect(byKind(events, "conditionChanged")[0]).toMatchObject({
      entityId: "npc.bandit",
      condition: "unconscious",
      active: true,
    });
    expect(byKind(events, "combatEnded")[0]?.encounter.active).toBe(false);

    const state = engine.getState();
    expect(state.actors["npc.bandit"]?.currentHp).toBe(0);
    expect(state.actors["npc.bandit"]?.conditions).toContain("unconscious");
    expect((state.modules?.combat as { active?: boolean } | undefined)?.active).toBe(false);
    // Per-swing prose is gone: each landed hit resolves as a deterministic mechanical tracker line
    // (a compact stateChanged beat), and the narrator is invoked only for the start scene + end
    // aftermath — this fight does both in one turn. No prompt carries a per-swing RESOLVED MECHANICS.
    const damageLines = byKind(events, "stateChanged").filter((e) => /: \d+ \w+/.test(e.summary));
    expect(damageLines).toHaveLength(3);
    expect(damageLines.some((e) => /\(down\)/.test(e.summary))).toBe(true);
    expect(gateway.narratorPrompts.length).toBeGreaterThanOrEqual(1);
    expect(gateway.narratorPrompts.some((prompt) => prompt.includes("=== RESOLVED MECHANICS"))).toBe(false);
    // The aftermath beat NAMES the fallen foe and states it is out of the fight (live r3 #1: an
    // unnamed "the last foe falls" let the narrator describe the just-killed foe as still up).
    const aftermath = [...gateway.narratorPrompts]
      .reverse()
      .find((prompt) => prompt.includes("defeated — down, unmoving, out of the fight"));
    expect(aftermath).toBeDefined();
    expect(aftermath).toContain("Bandit is defeated");
    const presentLine = aftermath?.split("\n").find((line) => line.startsWith("Present:"));
    expect(presentLine).not.toContain("Bandit");
  });

  test("a mid-fight round narrates one short beat over the round's tracker lines (r3 #3)", async () => {
    // A round that neither opens nor closes the fight used to render as bare dice — no prose at all.
    // The fight below outlasts one turn (30 HP bandit), so turn 2 is a pure mid-round: it must carry
    // exactly the "Blows are traded" beat, grounded on the deterministic swing outcomes.
    const playset = hostilePlayset(await loadExample());
    const bandit = playset.world.npcs.find((n) => n.id === "npc.bandit")!;
    bandit.stats!.maxHp = 30;
    bandit.stats!.armorClass = 10;
    const store = new InMemoryGameStateStore();
    const state = seededState(playset);
    state.actors["npc.bandit"]!.currentHp = 30;
    await store.save(saveKey(playset), state);
    const gateway = new RecordingGateway();
    const engine = new GameEngine({
      playset,
      store,
      gateway,
      classifier: attackBandit,
      rng: mulberry32(9),
      summary: false,
    });
    await engine.start();

    await engine.submitPlayerInput("attack the bandit");
    // Opening turn: the start beat narrates the scene; no round beat rides the same tick.
    expect(gateway.narratorPrompts.some((p) => p.includes("Blows are traded"))).toBe(false);

    await engine.submitPlayerInput("I press the attack");
    const round = gateway.narratorPrompts.find((p) => p.includes("Blows are traded —"));
    expect(round).toBeDefined();
    // The beat grounds on the tracker outcomes, never inviting new mechanics.
    expect(round).toContain("keeping every outcome exactly as stated");
  });

  test("an item action during combat renders ONE beat — no stale peaceful second block (07-18 #3)", async () => {
    // The attack path always cleared the parked narration; the itemTurn path left it set, so the
    // drop turn rendered BOTH the combat round beat AND a combat-blind NarrationModule scene that
    // re-established the peaceful inn (verbatim re-greeting included) mid-fight. The lift makes a
    // second block structurally impossible: the player's line rides the round beat itself.
    const playset = hostilePlayset(await loadExample());
    const bandit = playset.world.npcs.find((n) => n.id === "npc.bandit")!;
    bandit.stats!.maxHp = 30;
    bandit.stats!.armorClass = 10;
    const store = new InMemoryGameStateStore();
    const state = seededState(playset);
    state.actors["npc.bandit"]!.currentHp = 30;
    await store.save(saveKey(playset), state);
    const gateway = new RecordingGateway();
    const dropOrAttack: TurnClassifier = {
      classify: async (input: string) =>
        input.startsWith("attack")
          ? {
              kind: "attack" as const,
              targetId: "npc.bandit",
              destinationLocationId: null,
              check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
              confidence: 1,
            }
          : {
              kind: "itemAction" as const,
              targetId: null,
              destinationLocationId: null,
              item: { verb: "drop" as const, itemId: "item.lantern", targetId: null },
              check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
              confidence: 1,
            },
    };
    const engine = new GameEngine({
      playset,
      store,
      gateway,
      classifier: dropOrAttack,
      rng: mulberry32(9),
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();

    await engine.submitPlayerInput("attack the bandit");
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("I set my lantern down on the floor");

    // The item genuinely left the sheet AND the combat round still advanced (turn spent).
    expect(byKind(events, "itemTransferred")).toEqual([
      expect.objectContaining({ itemId: "item.lantern", from: "pc.you", to: null }),
    ]);
    // Exactly ONE narration block this turn — the combat beat. The stale peaceful scene is gone.
    expect(byKind(events, "narration")).toHaveLength(1);
    // That one beat carries the player's own action, so the drop is still narrated (in combat).
    const round = gateway.narratorPrompts.find((p) => p.includes("Blows are traded"));
    expect(round).toBeDefined();
    expect(round).toContain("You set the Warded Lantern down");
    // The brief also carries the drop as an authoritative TURN FACT and states the real armament.
    expect(round).toContain("=== TURN FACTS");
    expect(round).toContain("You set down the Warded Lantern");
    expect(round).toContain("UNARMED this round");
    // Exactly one narrator call fired (no second, combat-blind brief).
    expect(gateway.narratorPrompts).toHaveLength(1);
  });

  test("a successful check turn mid-combat kills NOTHING — no damage path exists (07-18 #5 repro)", async () => {
    // The live "grapple kill": "pin it for Oda to finish" → STR SUCCESS → the narrator described a
    // coup and the tester read the missing "+XP" as a bug. Ground truth: attemptRequiringCheck and
    // the consequence binder never touch an enemy's HP/conditions — the foe is untouched, combat
    // stays ACTIVE, and no XP line is CORRECT (nothing died). The phantom-kill PROSE is the judge's
    // combat escalation's job, not a missing XP award.
    const playset = hostilePlayset(await loadExample());
    const bandit = playset.world.npcs.find((n) => n.id === "npc.bandit")!;
    bandit.stats!.maxHp = 30;
    const store = new InMemoryGameStateStore();
    const state = seededState(playset);
    state.actors["npc.bandit"]!.currentHp = 20;
    await store.save(saveKey(playset), state);
    const gateway = new RecordingGateway();
    const pinOrAttack: TurnClassifier = {
      classify: async (input: string) =>
        input.startsWith("attack")
          ? {
              kind: "attack" as const,
              targetId: "npc.bandit",
              destinationLocationId: null,
              check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
              confidence: 1,
            }
          : {
              kind: "attemptRequiringCheck" as const,
              targetId: "npc.bandit",
              destinationLocationId: null,
              check: { warranted: true, ability: "str" as const, skill: "Athletics", dc: 2, reason: "pin the foe" },
              impact: { domain: "violence" as const, severity: "serious" as const, victimId: "npc.bandit" },
              confidence: 1,
            },
    };
    const engine = new GameEngine({
      playset,
      store,
      gateway,
      classifier: pinOrAttack,
      rng: mulberry32(9),
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();

    await engine.submitPlayerInput("attack the bandit");
    const hpAfterOpen = engine.getState().actors["npc.bandit"]?.currentHp ?? 0;
    expect(hpAfterOpen).toBeGreaterThan(0); // fight persists past the opener
    events.length = 0;

    await engine.submitPlayerInput("pin it down so Lyra can finish it");

    // The check ITSELF still touches nothing: before initiative passes (the first
    // combatTurnAdvanced), no HP moved and no condition landed — a successful grapple deals no
    // phantom damage and awards no XP. What r14 CHANGED: the spent turn now passes initiative on,
    // so the round answers — Lyra ("so Lyra can finish it") and the bandit take their real,
    // dice-rolled swings. Any HP movement on this tick comes from those rolls, never the check.
    const firstAdvance = events.findIndex((e) => e.kind === "combatTurnAdvanced");
    expect(firstAdvance).toBeGreaterThan(-1); // the turn was SPENT, not free (r14)
    expect(byKind(events.slice(0, firstAdvance), "hpChanged")).toHaveLength(0);
    // Every HP movement rides an attack roll in the answering round — none precedes it.
    const hpMoves = events.map((e, i) => (e.kind === "hpChanged" ? i : -1)).filter((i) => i >= 0);
    expect(hpMoves.every((i) => i > firstAdvance)).toBe(true);
    expect(engine.getState().actors["npc.bandit"]?.conditions).not.toContain("unconscious");
    expect((engine.getState().modules?.combat as { active?: boolean } | undefined)?.active).toBe(true);
    expect(byKind(events, "stateChanged").some((e) => /\(\+\d+ XP\)/.test(e.summary))).toBe(false);
    expect(byKind(events, "combatEnded")).toHaveLength(0);
  });

  test("a non-swing down still earns kill XP when combat ends (the reap chokepoint, 07-18 #5)", async () => {
    // The latent class the live finding pointed at: XP was welded to the damage site (afterSwing/
    // spell), so an enemy downed by anything else — an authored event's adjustHp, a DoT — reaped
    // the fight with a "defeated" beat and NO XP. The end chokepoints now award through the same
    // once-per-victim credit ledger the swing path stamps.
    const playset = hostilePlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    const state = seededState(playset, {
      combat: { active: true, locationId: "loc.tavern", order: ["npc.lyra", "pc.you", "npc.bandit"], turnIndex: 1, round: 2 },
    });
    state.actors["npc.bandit"]!.currentHp = 0;
    state.actors["npc.bandit"]!.conditions = ["unconscious"];
    await store.save(saveKey(playset), state);
    const gateway = new RecordingGateway();
    const engine = new GameEngine({
      playset,
      store,
      gateway,
      classifier: {
        classify: async () => ({
          kind: "freeformNarrative" as const,
          targetId: null,
          destinationLocationId: null,
          check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
          confidence: 1,
        }),
      },
      rng: mulberry32(9),
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();

    await engine.submitPlayerInput("I look around the room");

    expect(byKind(events, "combatEnded")).toHaveLength(1);
    const xpLines = byKind(events, "stateChanged").filter((e) => /Bandit is defeated\. \(\+\d+ XP\)/.test(e.summary));
    expect(xpLines).toHaveLength(1);

    // Idempotent across ticks: the credit ledger persists, so a re-run world with the credit
    // already stamped awards nothing (id-reuse hazard bounded exactly like the aggro flag).
    const store2 = new InMemoryGameStateStore();
    const state2 = seededState(playset, {
      combat: { active: true, locationId: "loc.tavern", order: ["npc.lyra", "pc.you", "npc.bandit"], turnIndex: 1, round: 2 },
      combatXpCredit: { "npc.bandit": true },
    });
    state2.actors["npc.bandit"]!.currentHp = 0;
    state2.actors["npc.bandit"]!.conditions = ["unconscious"];
    await store2.save(saveKey(playset), state2);
    const engine2 = new GameEngine({
      playset,
      store: store2,
      gateway: new RecordingGateway(),
      classifier: {
        classify: async () => ({
          kind: "freeformNarrative" as const,
          targetId: null,
          destinationLocationId: null,
          check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
          confidence: 1,
        }),
      },
      rng: mulberry32(9),
      summary: false,
    });
    const events2: GameEvent[] = [];
    engine2.subscribe((event) => events2.push(event));
    await engine2.start();
    await engine2.submitPlayerInput("I look around the room");
    expect(byKind(events2, "combatEnded")).toHaveLength(1);
    expect(byKind(events2, "stateChanged").some((e) => /\(\+\d+ XP\)/.test(e.summary))).toBe(false);
  });

  test("active combat suppresses heartbeat autonomy", async () => {
    const playset = hostilePlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    await store.save(
      saveKey(playset),
      seededState(playset, {
        combat: { active: true, locationId: "loc.tavern", order: ["pc.you", "npc.lyra"], turnIndex: 0, round: 1 },
      }),
    );
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: scriptedRng([0.5]),
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    events.length = 0;

    await engine.tickHeartbeat("npc.lyra");

    expect(events).toHaveLength(0);
  });

  test("a player attack resolved to a party member is refused (friendly-fire guard), not fought", async () => {
    const playset = hostilePlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    await store.save(saveKey(playset), seededState(playset));
    // The classifier mis-targets the companion (the real heuristic bug: a name mentioned anywhere
    // in an attack line wins). The guard must refuse rather than swing at an ally.
    const attackCompanion: TurnClassifier = {
      classify: async () => ({
        kind: "attack",
        targetId: "npc.lyra",
        destinationLocationId: null,
        check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
        confidence: 1,
      }),
    };
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: attackCompanion,
      rng: scriptedRng([0.5, 0.5, 0.5, 0.5]),
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    events.length = 0;

    await engine.submitPlayerInput("strike the wight before it reaches Lyra");

    // No combat starts, no swing rolled, the ally takes no damage.
    expect(byKind(events, "combatStarted")).toHaveLength(0);
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "hpChanged")).toHaveLength(0);
    expect(engine.getState().actors["npc.lyra"]?.currentHp).toBe(28);
    expect((engine.getState().modules?.combat as { active?: boolean } | undefined)?.active ?? false).toBe(false);
  });

  test("a narrator that refuses to describe violence degrades to offline narration, never leaking the refusal", async () => {
    const playset = hostilePlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    await store.save(saveKey(playset), seededState(playset));

    // The exact failure that parked combat originally — now possible at runtime if the operator
    // points SEED_NARRATOR_* at a safety-tuned model: a non-empty, non-blocked refusal for narration.
    class RefusingNarrator implements LlmGateway {
      private readonly offline = new OfflineGateway();
      complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
        return this.offline.complete(role, req);
      }
      async *stream(role: LlmRole, req: CompletionRequest) {
        if (role === "narrator") {
          yield { delta: "I can't depict graphic violence.", done: true };
          return;
        }
        yield* this.offline.stream(role, req);
      }
      embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
        return this.offline.embed(role, texts);
      }
    }
    const engine = new GameEngine({
      playset,
      store,
      gateway: new RefusingNarrator(),
      classifier: attackBandit,
      rng: scriptedRng([0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0.5, 0]),
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    events.length = 0;

    await engine.submitPlayerInput("attack the bandit");

    // The fight still resolves mechanically...
    expect(byKind(events, "combatEnded")[0]?.encounter.active).toBe(false);
    // ...and no combat narration emits the model's refusal to the player — it fell back to offline.
    const narrations = byKind(events, "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    expect(narrations.every((n) => n.text.trim().length > 0)).toBe(true);
    expect(narrations.some((n) => looksLikeRefusal(n.text))).toBe(false);
  });
});

describe("weaponFor fallbacks (W5)", () => {
  test("the bundled SRD data arms a natural (1d6) and an improvised (1d4) weapon", () => {
    // The data floor W5 relies on: a monster's teeth are 1d6 (real teeth, not a 1d1 pillow) and a
    // grabbed object is a 1d4 improvised bludgeon. Both are separate from the 1d1 unarmed strike.
    expect(NATURAL_WEAPON).toMatchObject({ id: "weapon.natural", damage: "1d6" });
    expect(IMPROVISED_WEAPON).toMatchObject({ id: "weapon.improvised", damage: "1d4", damageType: "bludgeoning" });
    expect(NATURAL_WEAPON.damage).not.toBe("1d1");
  });

  // A weaponless MONSTER template (STR 10 → +0): under the old code its empty hands resolved to a
  // 1d1 unarmed strike (a FLAT 1 damage), so a frontier lurker was a pillow. The natural-weapon
  // fallback arms every monster with a 1d6 slashing bite, which can deal more than 1. Spawned via a
  // prebaked `spawn` event (the only path that stamps `kind: "monster"`; a raw GameState.actors row
  // is inferred as an NPC), then on-sight aggro opens the fight so the husk swings unprompted.
  function withHuskMonster(base: PlaySet): PlaySet {
    const playset = structuredClone(base);
    playset.world.monsters.push(
      MonsterSchema.parse({
        id: "mon.husk",
        name: "Withered Husk",
        description: "A dried, shambling thing with empty hands.",
        stats: {
          abilities: { str: 10, dex: 10, con: 10, int: 3, wis: 10, cha: 3 },
          maxHp: 40, // tanky, so the fight trades several rounds and the husk lands blows
          armorClass: 8,
          level: 1,
          speed: 20,
          proficiencies: [],
          spells: [],
        },
        inventory: [], // EMPTY — no carried weapon; the natural-weapon fallback must arm it.
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

  test("a weaponless monster swings with a natural weapon (1d6 slashing), so a landed hit exceeds 1", async () => {
    const playset = withHuskMonster(await loadExample());
    const store = new InMemoryGameStateStore();
    const state = seededState(playset);
    // Solo PC with a big HP pool so the fight survives several husk swings; the PC carries only a
    // lantern (no weapon) so its own swings would be a STR-12 unarmed strike, never a 1d6 slash.
    state.companions = [];
    delete state.actors["npc.lyra"];
    state.actors["pc.you"]!.currentHp = 200;
    state.actors["pc.you"]!.locationId = "loc.tavern";
    await store.save(saveKey(playset), state);

    let call = 0;
    const plans = [
      { kind: "movement" as const, destinationLocationId: "loc.square" }, // spawn fires
      { kind: "freeformNarrative" as const, destinationLocationId: null }, // on-sight aggro
      { kind: "attack" as const, targetId: "mon.husk#0", destinationLocationId: null },
    ];
    const driveHusk: TurnClassifier = {
      classify: async () => {
        const p = plans[Math.min(call, plans.length - 1)]!;
        call += 1;
        return { targetId: null, check: { warranted: false, ability: null, skill: null, dc: null, reason: "" }, confidence: 1, ...p };
      },
    };
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: driveHusk,
      rng: mulberry32(13), // a seed where the husk lands multiple 1d6 hits above 1
      summary: false,
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    events.length = 0;

    await engine.submitPlayerInput("head to the square"); // spawn
    await engine.submitPlayerInput("I look around"); // aggro → husk swings
    for (let i = 0; i < 6; i++) await engine.submitPlayerInput("attack the husk");

    const damageLines = byKind(events, "stateChanged").filter((e) => /: \d+ \w+/.test(e.summary));
    expect(damageLines.length).toBeGreaterThan(0);
    // The husk is the only enemy, so every hit landed on the PC ("You: N …") is a husk swing. It is
    // STR 10 (+0): a 1d1 unarmed strike is EXACTLY 1 every time, so a husk-dealt hit above 1 can
    // only come from the natural 1d6 fallback — and the type reads "slashing" (natural), not the
    // "bludgeoning" of the 1d1 unarmed strike.
    const parseDmg = (s: string): number => Number(/: (\d+) /.exec(s)?.[1] ?? 0);
    const huskSwings = damageLines.filter((e) => /^You: \d+ slashing/.test(e.summary));
    expect(huskSwings.length).toBeGreaterThan(0); // the husk landed at least one natural-weapon blow
    expect(Math.max(0, ...huskSwings.map((e) => parseDmg(e.summary)))).toBeGreaterThan(1);
    // The line-shape contract (combat-module.test.ts:182) still holds for every tracker line.
    expect(damageLines.every((e) => /: \d+ \w+/.test(e.summary))).toBe(true);
  });

  test("the improvised profile is a distinct 1d4 bludgeon (the named-non-weapon fallback in weaponFor)", () => {
    // weaponFor's improvised branch: when the attack intent names a thing that resolves to NO
    // carried/SRD weapon (a grabbed chair/bottle), the swing lands as the 1d4 improvised bludgeon —
    // not bare hands (1d1) and not the 1d6 natural bite. This locks the data those branches return.
    expect(IMPROVISED_WEAPON.damage).toBe("1d4");
    expect(IMPROVISED_WEAPON.damageType).toBe("bludgeoning");
    expect(IMPROVISED_WEAPON.damage).not.toBe(NATURAL_WEAPON.damage); // improvised ≠ natural
    expect(IMPROVISED_WEAPON.damage).not.toBe("1d1"); // improvised ≠ unarmed
  });
});

describe("looksLikeRefusal", () => {
  test("matches assistant-voice refusals", () => {
    for (const refusal of [
      "I can't depict that.",
      "I cannot continue this scene.",
      "I'm sorry, but I won't narrate this.",
      "As an AI, I must decline.",
      "I'm not comfortable describing this.",
    ]) {
      expect(looksLikeRefusal(refusal)).toBe(true);
    }
  });

  test("does not false-positive on second/third-person GM prose", () => {
    for (const prose of [
      "You can't tell whether the wight still breathes.",
      "The blade bites deep; the bandit staggers and falls.",
      "Steel rings as the fight is joined.",
      "Sorrow flickers across her face, but she says nothing.", // starts with a word containing "sorr"
    ]) {
      expect(looksLikeRefusal(prose)).toBe(false);
    }
  });

  // This export is now a RE-EXPORT of `src/llm/refusal.ts` (regex audit §8e). The copy that used to
  // live in narrate.ts was a `startsWith` scan over a lowercase prefix list, and it failed in both
  // directions — reproduced against the shipped function before the deletion.
  test("a refusal behind a markdown fence or a blockquote is caught (position 0 is not the refusal)", () => {
    expect(looksLikeRefusal("**I'm sorry, I can't continue this scene.**")).toBe(true);
    expect(looksLikeRefusal("> I'm sorry, I can't continue this scene.")).toBe(true);
    expect(looksLikeRefusal("I'm sorry, I can't continue this scene.")).toBe(true);
  });

  test("an NPC line opening with 'Sorry' is NOT thrown away for the trigger echo", () => {
    // The old prefix list carried a bare "sorry," / "sorry." entry, so this returned true and the
    // combat module degraded a perfectly good beat to deterministic engine prose.
    expect(looksLikeRefusal("Sorry, love. The price is the price.")).toBe(false);
  });
});

describe("evasion-calm keys on the classifier's purpose, not on prose (r8 audit)", () => {
  // The calm ends the encounter AND writes a durable `combatCalmed` patch so on-sight aggro never
  // re-fires — an irreversible delta. It used to fire on a keyword match over `check.reason` (model
  // free text) plus the player's raw line, so a PASSED ATTACK check whose prose merely contained
  // throw/feed/dump/hide ended the fight and pacified every foe. Executed against the shipped
  // regex, all six of these read as evasion:
  //   "I throw the table over onto the wight" · "I dump the burning oil down the stairs onto them"
  //   "I feed the poisoned meat to the hound" · "I hide behind the pillar, reload, and shoot again"
  // The model now NAMES the purpose from a closed enum; code still owns the consequence.
  const checkPlanWith = (purpose: "disengage" | "harm" | "other" | null): TurnClassifier => ({
    classify: async (input: string) =>
      input.startsWith("attack")
        ? {
            kind: "attack" as const,
            targetId: "npc.bandit",
            destinationLocationId: null,
            check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
            confidence: 1,
          }
        : {
            kind: "attemptRequiringCheck" as const,
            targetId: "npc.bandit",
            destinationLocationId: null,
            // A DC of 2 makes the roll a near-certain PASS, so the branch under test is reached.
            check: { warranted: true, ability: "dex" as const, skill: "Stealth", dc: 2, reason: "throw the table onto the bandit", purpose },
            confidence: 1,
          },
  });

  const runCheckTurn = async (purpose: "disengage" | "harm" | "other" | null) => {
    const playset = hostilePlayset(await loadExample());
    // Fat enough to survive the opening swing, so the check turn lands while the fight is still live.
    playset.world.npcs.find((n) => n.id === "npc.bandit")!.stats!.maxHp = 30;
    const store = new InMemoryGameStateStore();
    const state = seededState(playset);
    state.actors["npc.bandit"]!.currentHp = 20;
    await store.save(saveKey(playset), state);
    const engine = new GameEngine({
      playset,
      store,
      gateway: new RecordingGateway(),
      classifier: checkPlanWith(purpose),
      rng: mulberry32(9),
      summary: false,
    });
    await engine.start();
    await engine.submitPlayerInput("attack the bandit");
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.submitPlayerInput("I throw the table over onto the bandit");
    const combat = engine.getState().modules?.combat as { active?: boolean } | undefined;
    return { stillFighting: combat?.active === true, ended: byKind(events, "combatEnded").length > 0 };
  };

  test("purpose 'harm' does NOT end the fight, however the prose reads", async () => {
    const { stillFighting, ended } = await runCheckTurn("harm");
    expect(ended).toBe(false);
    expect(stillFighting).toBe(true);
  });

  test("purpose 'other' and a missing purpose do not end the fight either", async () => {
    // A classifier that omits the field (or an older persisted plan) must degrade to "no calm" —
    // the safe direction, since the fight merely continues.
    for (const purpose of ["other", null] as const) {
      const { stillFighting, ended } = await runCheckTurn(purpose);
      expect(ended, String(purpose)).toBe(false);
      expect(stillFighting, String(purpose)).toBe(true);
    }
  });

  test("purpose 'disengage' still ends the fight — the r7 P0 behavior is preserved", async () => {
    const { ended } = await runCheckTurn("disengage");
    expect(ended).toBe(true);
  });
});
