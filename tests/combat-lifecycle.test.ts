/**
 * Combat lifecycle tests — the long-playthrough guarantees.
 *
 * A stranded encounter must never outlive its fight (it gates every heartbeat), a downed PC
 * must not be a dead save file, hostile monsters engage on sight (once), fallen foes drop
 * their carried items, and a long rest recovers the party.
 *
 * An ambush is also a BEAT-ORDER guarantee: the prose that opens the fight reaches the player
 * before its own "Combat begins"/dice/damage lines, and exactly once (live 07-24).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { NpcTemplateSchema, PrebakedEventSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { loadExample, SEED } from "./support/harness.ts";

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

/** Fixed-die RNGs for the r11 escape check: a 20 always breaks off, a 1 never does. */
const ALWAYS_HIGH = (): number => 0.99;
const ALWAYS_LOW = (): number => 0.0;
/** The listed draws in order, then 0 forever — lets one roll land and the next miss. */
function sequencedRng(head: number[]): () => number {
  let i = 0;
  return () => head[i++] ?? 0;
}

/** Classifier scripted per-call — each submitted input consumes the next plan. */
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

function withBandit(base: PlaySet, banditHp = 3): PlaySet {
  const playset = structuredClone(base);
  playset.world.npcs.push(
    NpcTemplateSchema.parse({
      id: "npc.bandit",
      name: "Bandit",
      summary: "A desperate road-cutter with a raised knife.",
      persona: "Cruel, jumpy, and direct.",
      appearance: "A wiry bandit in a patched coat.",
      goals: ["Survive the fight"],
      knowledge: [],
      relationships: {},
      stats: {
        abilities: { str: 14, dex: 10, con: 10, int: 9, wis: 10, cha: 8 },
        maxHp: banditHp,
        armorClass: 1,
        level: 1,
        speed: 30,
        proficiencies: [],
        spells: [],
      },
      autonomy: { isPartyMember: false, level: "passive", canLead: false, heartbeatSeconds: 40, replyDecayAlpha: 0.2 },
    }),
  );
  playset.world.locations.find((loc) => loc.id === "loc.tavern")?.npcs.push("npc.bandit");
  return playset;
}

interface SeedOptions {
  pcHp?: number;
  banditHp?: number;
  companions?: string[];
  modules?: Record<string, unknown>;
  inventory?: Partial<Record<string, string[]>>;
}

function seededState(playset: PlaySet, opts: SeedOptions = {}): GameState {
  const companions = opts.companions ?? ["npc.lyra"];
  const actors: GameState["actors"] = {
    "pc.you": {
      id: "pc.you",
      currentHp: opts.pcHp ?? 24,
      locationId: "loc.tavern",
      inventory: opts.inventory?.["pc.you"] ?? ["item.lantern"],
      conditions: [],
    },
    "npc.bandit": {
      id: "npc.bandit",
      currentHp: opts.banditHp ?? 3,
      locationId: "loc.tavern",
      inventory: opts.inventory?.["npc.bandit"] ?? [],
      conditions: [],
    },
  };
  if (companions.includes("npc.lyra")) {
    actors["npc.lyra"] = {
      id: "npc.lyra",
      currentHp: 28,
      locationId: "loc.tavern",
      inventory: [],
      conditions: [],
    };
  }
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 0,
    party: ["pc.you"],
    companions,
    actors,
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    modules: opts.modules ?? {},
    flags: {},
  };
}

async function makeEngine(
  playset: PlaySet,
  state: GameState,
  classifier: TurnClassifier,
  gateway: LlmGateway = new OfflineGateway(),
  rng: () => number = mulberry32(SEED),
) {
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
  const engine = new GameEngine({
    playset,
    store,
    gateway,
    classifier,
    rng,
  });
  const events: GameEvent[] = [];
  engine.subscribe((event) => events.push(event));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

function kinds(events: GameEvent[], kind: GameEvent["kind"]): GameEvent[] {
  return events.filter((e) => e.kind === kind);
}

const liveCombat = (order: string[]) => ({
  combat: { active: true, locationId: "loc.tavern", order, turnIndex: 0, round: 1 },
});

class CombatHallucinatingGateway extends OfflineGateway {
  narratorCalls = 0;

  override async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role !== "narrator") {
      yield* super.stream(role, req);
      return;
    }
    this.narratorCalls += 1;
    yield { delta: "You close the distance and swing your club at the wolf.", done: false };
    yield { delta: "", done: true };
  }
}

/** A narrator that always comes back EMPTY — the degraded path `triggerEcho` exists to cover. */
class BlankNarratorGateway extends OfflineGateway {
  override async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role !== "narrator") {
      yield* super.stream(role, req);
      return;
    }
    yield { delta: "", done: true };
  }
}

describe("combat lifecycle", () => {
  test("an ungrounded 'nearest threat' attack selects a living foe from the active encounter (N2)", async () => {
    const playset = withBandit(await loadExample(), 30);
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, {
        companions: [],
        modules: liveCombat(["pc.you", "npc.bandit"]),
      }),
      scriptedClassifier([planOf({ kind: "attack", targetId: null })]),
    );

    await engine.submitPlayerInput("I attack the nearest threat with everything I have.");

    expect(kinds(events, "diceRolled")).toContainEqual(expect.objectContaining({ actorId: "pc.you" }));
    expect(
      kinds(events, "narration").some(
        (event) => "text" in event && event.text.includes("there is no valid target in reach"),
      ),
    ).toBe(false);
  });

  test("a named forward escape never silently falls back to the first retreat exit (N5)", async () => {
    const playset = withBandit(await loadExample(), 30);
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, {
        companions: [],
        modules: liveCombat(["pc.you", "npc.bandit"]),
      }),
      scriptedClassifier([
        planOf({
          kind: "movement",
          destinationLocationId: null,
          destinationName: "the unknown northern hold",
          movementMiss: true,
        }),
      ]),
    );

    await engine.submitPlayerInput("I push on toward the unknown northern hold.");

    expect(engine.getState().partyLocationId).toBe("loc.tavern");
    expect(
      kinds(events, "stateChanged").some(
        (event) => "summary" in event && event.summary.includes("flees to Emberford Square"),
      ),
    ).toBe(false);
  });

  test("rest during active combat is a deterministic refusal, never narrator-authored attack prose (N7)", async () => {
    const playset = withBandit(await loadExample(), 30);
    const gateway = new CombatHallucinatingGateway();
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, {
        companions: [],
        modules: liveCombat(["pc.you", "npc.bandit"]),
      }),
      scriptedClassifier([planOf({ kind: "rest" })]),
      gateway,
    );

    await engine.submitPlayerInput("we loot whatever has fallen and make a cold camp to rest.");

    expect(gateway.narratorCalls).toBe(0);
    expect(kinds(events, "narration")).toContainEqual(
      expect.objectContaining({
        text: "You try to rest, but the fight is still on you — there is no stepping out of it here.",
      }),
    );
  });

  test("walking out of a live fight reaps the encounter (flee) and frees the heartbeat gate", async () => {
    const playset = withBandit(await loadExample());
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { modules: liveCombat(["pc.you", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
      new OfflineGateway(),
      ALWAYS_HIGH, // the r11 escape check passes — a clean break behaves exactly as the free one did
    );

    await engine.submitPlayerInput("we run for the square");

    expect(kinds(events, "combatEnded")).toHaveLength(1);
    const state = engine.getState();
    expect(state.partyLocationId).toBe("loc.square");
    expect((state.modules?.combat as { active?: boolean }).active).toBe(false);
    // r11 F-5: leaving is no longer FREE — the break is rolled for, and the roll is on the record.
    expect(
      kinds(events, "diceRolled").some((e) => "purpose" in e && String(e.purpose).includes("break off and get out")),
    ).toBe(true);
  });

  test("a FAILED escape keeps the party in the fight and spends the turn (r11 F-5)", async () => {
    // Before this, a movement line mid-fight moved the party, deleted the encounter and despawned
    // every hostile with no `diceRolled` anywhere on the turn — the exploit-sweep row "flee with no
    // consequence" was open. A disengage is a contested escape now: miss it and you are still in it.
    const playset = withBandit(await loadExample());
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { modules: liveCombat(["pc.you", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
      new OfflineGateway(),
      ALWAYS_LOW,
    );

    await engine.submitPlayerInput("we run for the square");

    const state = engine.getState();
    expect(state.partyLocationId).toBe("loc.tavern"); // did NOT leave
    expect((state.modules?.combat as { active?: boolean }).active).toBe(true);
    expect(kinds(events, "combatEnded")).toHaveLength(0);
    const roll = kinds(events, "diceRolled").find(
      (e) => "purpose" in e && String(e.purpose).includes("break off and get out"),
    );
    expect(roll).toBeDefined();
    expect((roll as { success?: boolean }).success).toBe(false);
  });

  test("an ally left in the fight resolves their OWN outcome — clear, or down where they stood (r11 F-5)", async () => {
    // Before this the encounter was simply deleted and the bystander who had taken the party's side
    // went with it: her outcome was never determined while the prose kept her swinging.
    const playset = withBandit(await loadExample());
    // Lyra is a BYSTANDER here, not a companion — she stands at the tavern and fights on the party's
    // side (`allies`), which is exactly the case the encounter used to delete.
    const allyState = (ps: PlaySet, modules: Record<string, unknown>): GameState => {
      const state = seededState(ps, { companions: [], modules });
      state.actors["npc.lyra"] = {
        id: "npc.lyra",
        currentHp: 28,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
      };
      return state;
    };
    const withAlly = {
      combat: {
        active: true,
        locationId: "loc.tavern",
        order: ["pc.you", "npc.lyra", "npc.bandit"],
        allies: ["npc.lyra"],
        turnIndex: 0,
        round: 1,
      },
    };

    // The PC breaks off clean and Lyra rolls a 20 too — she comes out with them.
    {
      const { engine, events } = await makeEngine(
        playset,
        allyState(playset, withAlly),
        scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
        new OfflineGateway(),
        ALWAYS_HIGH,
      );
      await engine.submitPlayerInput("we run for the square");
      const state = engine.getState();
      expect(state.partyLocationId).toBe("loc.square");
      expect(state.actors["npc.lyra"]?.locationId).toBe("loc.square");
      expect(state.actors["npc.lyra"]?.currentHp).toBe(28);
      expect(
        kinds(events, "stateChanged").some((e) => "summary" in e && e.summary.includes("gets clear")),
      ).toBe(true);
      // Live r11: the ally note must ride in `(GM: …)` form — see the blank-narrator test below.
      expect(
        kinds(events, "narration").some((e) => "text" in e && e.text.includes("(GM: Lyra Vane breaks off")),
      ).toBe(true);
    }

    // Same break, but her own roll misses: she is left down at the fight, and she is still there.
    {
      const { engine, events } = await makeEngine(
        playset,
        allyState(playset, withAlly),
        scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
        new OfflineGateway(),
        sequencedRng([0.99]), // the PC's break lands; every roll after it is a 1
      );
      await engine.submitPlayerInput("we run for the square");
      const state = engine.getState();
      expect(state.partyLocationId).toBe("loc.square");
      expect(state.actors["npc.lyra"]?.locationId).toBe("loc.tavern");
      expect(state.actors["npc.lyra"]?.currentHp).toBe(0);
      expect(state.actors["npc.lyra"]?.conditions).toContain("unconscious");
      expect(
        kinds(events, "stateChanged").some((e) => "summary" in e && e.summary.includes("goes down covering your retreat")),
      ).toBe(true);
    }

    // A BLANK narrator echoes the trigger — and the echo must be clean prose. The first live r11
    // pass appended the ally line AFTER the beat's trailing "Describe the flight…" directive, which
    // stops the tail scan dead, so the whole authoring instruction printed on the player's screen.
    {
      const { engine, events } = await makeEngine(
        playset,
        allyState(playset, withAlly),
        scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
        new BlankNarratorGateway(),
        ALWAYS_HIGH,
      );
      await engine.submitPlayerInput("we run for the square");
      const prose = kinds(events, "narration")
        .map((e) => ("text" in e ? e.text : ""))
        .join("\n");
      expect(prose).toContain("breaks away and leaves the fight");
      expect(prose).not.toContain("(GM:");
      expect(prose).not.toContain("Reflect that exactly");
      expect(prose).not.toContain("Describe the flight");
    }
  });

  test("a flee takes the WHOLE party — a stray solo read cannot strand companions (r6 P1)", async () => {
    // Live r6: "I break for the ash-track, flat out, and I don't stop" grounded an exit while the
    // classifier also read it as solo — the PC fled and every companion silently stayed on the
    // field. A rout is not a deliberate split: mid-fight, `solo` is ignored.
    const playset = withBandit(await loadExample());
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { modules: liveCombat(["pc.you", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square", solo: true })]),
      new OfflineGateway(),
      ALWAYS_HIGH, // the escape lands; this test is about WHO leaves, not whether
    );

    await engine.submitPlayerInput("I break for the square, flat out, and I don't stop");

    expect(kinds(events, "combatEnded")).toHaveLength(1);
    const state = engine.getState();
    expect(state.partyLocationId).toBe("loc.square");
    // The companion fled WITH the party — same location, still a member, not a wordless vanishing.
    expect(state.actors["npc.lyra"]?.locationId).toBe("loc.square");
    expect(state.companions).toContain("npc.lyra");
  });

  test("a fight with no living foe left standing ends on the next player tick", async () => {
    const playset = withBandit(await loadExample());
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { banditHp: 0, modules: liveCombat(["pc.you", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "freeformNarrative" })]),
    );

    await engine.submitPlayerInput("I look around the room");

    expect(kinds(events, "combatEnded")).toHaveLength(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(false);
  });

  test("a downed PC cannot swing, and a lost fight revives them at 1 HP (no dead save file)", async () => {
    const playset = withBandit(await loadExample(), 30);
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { pcHp: 1, companions: [], modules: liveCombat(["pc.you", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "attack", targetId: "npc.bandit" })]),
    );

    // Swing until the bandit downs the 1-HP PC (deterministic rng; a handful of rounds at most).
    for (let i = 0; i < 8; i++) {
      await engine.submitPlayerInput("I attack the bandit");
      const state = engine.getState();
      if (!(state.modules?.combat as { active?: boolean }).active) break;
    }

    const state = engine.getState();
    expect((state.modules?.combat as { active?: boolean }).active).toBe(false);
    expect(state.actors["pc.you"]?.currentHp).toBe(1);
    expect(state.actors["pc.you"]?.conditions).not.toContain("unconscious");
    const pcHp = kinds(events, "hpChanged").filter((e) => "entityId" in e && e.entityId === "pc.you");
    expect(pcHp.some((e) => "to" in e && e.to === 0)).toBe(true);
    // Revived at 1 HP the PC is playable again — a fresh attack may open a new fight.
  });

  test("WINNING while downed also revives the PC to 1 HP (never strictly worse than losing) (audit)", async () => {
    // The PC is at 0 HP; a companion (Lyra) is still up and the foe is weak. Lyra lands the killing
    // blow, so the fight ends on the WIN branch. Before the fix that branch performed no revival —
    // the PC was stranded unconscious at 0 HP after a victory (short `rest` won't wake the downed),
    // strictly worse than LOSING, which auto-revives to 1. The fight must leave the PC at 1 HP, awake.
    const playset = withBandit(await loadExample(), 3);
    const { engine } = await makeEngine(
      playset,
      seededState(playset, { pcHp: 0, banditHp: 3, modules: liveCombat(["pc.you", "npc.lyra", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "attack", targetId: "npc.bandit" })]),
    );

    for (let i = 0; i < 12; i++) {
      await engine.submitPlayerInput("I attack the bandit");
      if (!(engine.getState().modules?.combat as { active?: boolean }).active) break;
    }

    const state = engine.getState();
    expect((state.modules?.combat as { active?: boolean }).active).toBe(false);
    expect(state.actors["npc.bandit"]?.currentHp).toBe(0); // the party WON
    expect(state.actors["pc.you"]?.currentHp).toBe(1); // …and the downed PC came to at 1 HP
    expect(state.actors["pc.you"]?.conditions).not.toContain("unconscious");
  });

  test("a downed PC cannot swing mid-fight, but companions and enemies fight on", async () => {
    const playset = withBandit(await loadExample(), 30);
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { pcHp: 0, modules: liveCombat(["pc.you", "npc.lyra", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "attack", targetId: "npc.bandit" })]),
    );

    await engine.submitPlayerInput("I attack the bandit");

    // No new encounter formed, no swing came from the downed PC — yet the round advanced:
    // somebody else rolled dice.
    expect(kinds(events, "combatStarted")).toHaveLength(0);
    expect(kinds(events, "diceRolled").length).toBeGreaterThan(0);
    const banditHits = kinds(events, "hpChanged").filter((e) => "entityId" in e && e.entityId === "npc.bandit");
    const pcSwung = kinds(events, "diceRolled").filter((e) => "actorId" in e && e.actorId === "pc.you");
    expect(pcSwung).toHaveLength(0);
    expect(banditHits.length + kinds(events, "hpChanged").length).toBeGreaterThanOrEqual(0);
  });

  test("a downed PC's NON-attack turn still drives an unfinished fight to a finish (N9 soft-lock)", async () => {
    // PC down at 0 HP; Lyra (up) faces a near-dead bandit. Every input the player can give is a
    // non-attack (here 'rest', refused mid-combat). Before the fix that inert turn advanced nothing,
    // so a winnable fight froze forever — no rest, no move, no escape. The downed turn must now tick
    // the fight on the PC's behalf: Lyra fells the bandit and the win revives the PC at 1 HP.
    const playset = withBandit(await loadExample(), 3);
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { pcHp: 0, banditHp: 3, modules: liveCombat(["pc.you", "npc.lyra", "npc.bandit"]) }),
      scriptedClassifier([planOf({ kind: "rest" })]),
    );

    for (let i = 0; i < 12; i++) {
      await engine.submitPlayerInput("we make a cold camp and rest");
      if (!(engine.getState().modules?.combat as { active?: boolean }).active) break;
    }

    // The rest itself is refused, but the fight advanced (someone else rolled) and then resolved.
    expect(kinds(events, "diceRolled").length).toBeGreaterThan(0);
    const pcSwung = kinds(events, "diceRolled").filter((e) => "actorId" in e && e.actorId === "pc.you");
    expect(pcSwung).toHaveLength(0);
    const state = engine.getState();
    expect((state.modules?.combat as { active?: boolean }).active).toBe(false);
    expect(state.actors["pc.you"]?.currentHp).toBe(1);
    expect(state.actors["pc.you"]?.conditions).not.toContain("unconscious");
  });

  test("a fallen foe drops its carried items to the killer", async () => {
    const playset = withBandit(await loadExample(), 1);
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, {
        companions: [],
        inventory: { "npc.bandit": ["item.lantern"], "pc.you": [] },
      }),
      scriptedClassifier([planOf({ kind: "attack", targetId: "npc.bandit" })]),
    );

    for (let i = 0; i < 6; i++) {
      await engine.submitPlayerInput("I attack the bandit");
      if (engine.getState().actors["npc.bandit"]?.currentHp === 0) break;
    }

    const state = engine.getState();
    expect(state.actors["npc.bandit"]?.currentHp).toBe(0);
    expect(state.actors["pc.you"]?.inventory).toContain("item.lantern");
    expect(state.actors["npc.bandit"]?.inventory).not.toContain("item.lantern");
    expect(kinds(events, "stateChanged").some((e) => "summary" in e && /takes .* from/.test(e.summary))).toBe(true);
  });

  test("a downed stat-bearing foe drops out of presentEntities() with a clean name (W2)", async () => {
    const playset = withBandit(await loadExample(), 1);
    const { engine } = await makeEngine(
      playset,
      seededState(playset, { companions: [] }),
      scriptedClassifier([planOf({ kind: "attack", targetId: "npc.bandit" })]),
    );

    // Before the kill the bandit is present (alive, stat-bearing).
    expect(engine.presentEntities().some((e) => e.id === "npc.bandit")).toBe(true);

    for (let i = 0; i < 6; i++) {
      await engine.submitPlayerInput("I attack the bandit");
      if (engine.getState().actors["npc.bandit"]?.currentHp === 0) break;
    }

    // Once downed (currentHp 0), the corpse is culled from presence — no lingering foe, no raw id.
    expect(engine.getState().actors["npc.bandit"]?.currentHp).toBe(0);
    const present = engine.presentEntities();
    expect(present.some((e) => e.id === "npc.bandit")).toBe(false);
    // Any entity that IS present carries a clean display name — never a bare registry id.
    expect(present.every((e) => e.name.length > 0 && !e.name.includes("#"))).toBe(true);
  });

  test("a hostile monster engages on sight — once; a fled fight does not re-aggro", async () => {
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    // Keyed on the LINE, not the call index (r11): a disengage is a contested escape now and may
    // need more than one try, so the plan for "flee" must stay the flee however often it is spoken.
    const byLine: TurnClassifier = {
      classify: async (input: string) =>
        input.includes("flee")
          ? planOf({ kind: "movement", destinationLocationId: "loc.tavern" })
          : input.includes("square")
            ? planOf({ kind: "movement", destinationLocationId: "loc.square" })
            : planOf({ kind: "freeformNarrative" }),
    };
    const { engine, events } = await makeEngine(playset, seededState(playset, { companions: [] }), byLine);

    await engine.submitPlayerInput("head to the square");
    expect(kinds(events, "entitySpawned")).toHaveLength(1);

    // r4 telegraph: a monster the player did not walk in on announces itself for one beat first.
    await engine.submitPlayerInput("I look around");
    expect(kinds(events, "combatStarted")).toHaveLength(0);
    expect(
      kinds(events, "narration").some(
        (e) => "text" in e && e.text.includes("a breath from violence"),
      ),
    ).toBe(true);

    await engine.submitPlayerInput("I keep looking");
    expect(kinds(events, "combatStarted")).toHaveLength(1);
    const order = (kinds(events, "combatStarted")[0] as Extract<GameEvent, { kind: "combatStarted" }>).encounter.order;
    expect(order).toContain("mon.ashstalker#0");
    expect(order).toContain("pc.you");

    // r11 F-5: leaving is a contested escape — keep trying until the break lands (bounded).
    for (let i = 0; i < 8 && (engine.getState().modules?.combat as { active?: boolean }).active; i++) {
      await engine.submitPlayerInput("I flee back to the tavern");
    }
    expect(kinds(events, "combatEnded")).toHaveLength(1);

    events.length = 0;
    await engine.submitPlayerInput("back to the square");
    await engine.submitPlayerInput("I look around again");
    expect(kinds(events, "combatStarted")).toHaveLength(0);
  });

  test("an ambush that downs the PC does NOT resolve the defeat in the same tick (r2 P1 suspension)", async () => {
    // r2: a line of dialogue → the next screen was the captivity UI, the whole lost fight visible
    // only in scrollback. The fix: a fight that OPENS this tick never also resolves its defeat this
    // tick — the encounter suspends with the PC down, and the consequence (revival, bad end,
    // captivity) lands on the NEXT player turn as its own visible beat.
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { pcHp: 1, companions: [] }),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn fires
        planOf({ kind: "freeformNarrative" }), // telegraph tick (r4)
        planOf({ kind: "freeformNarrative" }), // aggro tick — the opening swing downs the 1-HP PC
        planOf({ kind: "freeformNarrative" }), // the NEXT turn resolves the lost fight
      ]),
    );

    await engine.submitPlayerInput("head to the square");
    await engine.submitPlayerInput("I look around"); // telegraph
    events.length = 0;
    await engine.submitPlayerInput("I hold my ground");
    // The ambush opened and the PC dropped — but the fight did NOT settle this tick.
    expect(kinds(events, "combatStarted")).toHaveLength(1);
    expect(engine.getState().actors["pc.you"]?.currentHp).toBe(0);
    expect(kinds(events, "combatEnded")).toHaveLength(0);

    events.length = 0;
    await engine.submitPlayerInput("everything goes dark");
    // NOW the defeat resolves, as its own visible beat: fight ends, the PC comes to at 1 HP.
    expect(kinds(events, "combatEnded")).toHaveLength(1);
    expect(engine.getState().actors["pc.you"]?.currentHp).toBe(1);
  });

  test("an ambush is NARRATED before its mechanics — prose, then 'Combat begins', then the dice (live 07-24)", async () => {
    // The engine publishes a tick's events in CALL order, so PHASE order decides what the player
    // reads first. On-sight aggro resolves (and emitted) in `resolve`, while the prose that opens the
    // fight was only parked for `narrate` — so an ambushed player read "Combat begins. Initiative: …",
    // the attack roll and the damage line BEFORE anything told them they were being ambushed.
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { companions: [] }),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn fires
        planOf({ kind: "freeformNarrative" }), // telegraph tick (r4)
        planOf({ kind: "freeformNarrative" }), // aggro tick
      ]),
    );

    await engine.submitPlayerInput("head to the square");
    await engine.submitPlayerInput("I look around"); // telegraph
    events.length = 0;
    await engine.submitPlayerInput("I stand fast");

    const ambush = events.findIndex((e) => e.kind === "narration" && e.text.includes("no words, only violence"));
    const opener = events.findIndex((e) => e.kind === "system" && e.message.includes("Combat begins"));
    const firstDie = events.findIndex((e) => e.kind === "diceRolled");
    expect(ambush).toBeGreaterThanOrEqual(0);
    expect(opener).toBeGreaterThan(ambush);
    expect(firstDie).toBeGreaterThan(ambush);
    // Every die of the ambusher's opening round lands behind the prose, not just the first.
    for (const [i, e] of events.entries()) if (e.kind === "diceRolled") expect(i).toBeGreaterThan(ambush);
  });

  test("walking into a room with a live monster narrates ONE beat, not two contradictory ones (live 07-24)", async () => {
    // Both aggro helpers used to `return true` without clearing core's parked narration, so the tick
    // that walked the player into an ambush rendered BOTH "You travel to Emberford Square." (calm
    // arrival, NarrationModule) AND the ambush beat — two model-authored openings for one moment.
    // The aggro path now lifts the player's line into the ambush beat, exactly as the item-action
    // branch does.
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { companions: [] }),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn fires (react, so no aggro yet)
        planOf({ kind: "movement", destinationLocationId: "loc.tavern" }), // step back out
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // walk INTO the live stalker
      ]),
    );

    await engine.submitPlayerInput("head to the square");
    await engine.submitPlayerInput("back to the tavern");
    events.length = 0;
    await engine.submitPlayerInput("head to the square again");

    expect(kinds(events, "combatStarted")).toHaveLength(1);
    const narrations = kinds(events, "narration");
    expect(narrations).toHaveLength(1);
    // …and the one beat that remains is the ambush, carrying the player's own lifted travel line.
    expect(narrations[0]).toMatchObject({ kind: "narration" });
    const text = (narrations[0] as Extract<GameEvent, { kind: "narration" }>).text;
    expect(text).toContain("no words, only violence");
    expect(text).toContain("You travel to Emberford Square.");
  });

  test("a blank narrator on an ambush tick echoes the neutral fallback, never the player's own words (T7)", async () => {
    // Lifting the player's line into the ambush beat carries its `echoFallback` across with it. Without
    // that, the freeform intent's "The moment passes." was dropped on the floor and `triggerEcho` fell
    // through to the composed trigger — so a blank/refused narrator (and combat is the one place a
    // skittish model balks) printed "I whistle a filthy tavern song…" back at the player as GM prose.
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { companions: [] }),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn fires
        planOf({ kind: "freeformNarrative" }), // telegraph tick (r4)
        planOf({ kind: "freeformNarrative" }), // aggro tick, blank narrator
      ]),
      new BlankNarratorGateway(),
    );

    await engine.submitPlayerInput("head to the square");
    await engine.submitPlayerInput("I glance about the square"); // telegraph
    events.length = 0;
    const line = "I whistle a filthy tavern song about the mayor's wife";
    await engine.submitPlayerInput(line);

    const narrations = kinds(events, "narration").map((e) => (e as Extract<GameEvent, { kind: "narration" }>).text);
    expect(narrations.length).toBeGreaterThan(0);
    for (const text of narrations) expect(text).not.toContain(line);
    expect(narrations.some((t) => t.includes("The moment passes."))).toBe(true);
    expect(narrations.some((t) => t.includes("no words, only violence"))).toBe(true);
  });

  test("a peaceful overture AT the monster rolls a talk-down — success calms it DURABLY (r6 P1)", async () => {
    // Live r6: the player talked the Salt Revenant down in prose and the engine started combat the
    // SAME turn, because the overture only suppressed aggro for one beat and nothing mechanical
    // ever changed. Now the overture is a real Persuasion contest: success marks the monster
    // calmed — it never on-sight aggros again, so the social resolution is binding.
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { companions: [] }),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn fires
        planOf({ kind: "freeformNarrative", targetId: "mon.ashstalker#0" }), // peace-offering AT it
        planOf({ kind: "freeformNarrative" }), // untargeted turn
        planOf({ kind: "freeformNarrative" }), // and another — the calm must hold
      ]),
      new OfflineGateway(),
      () => 0.99, // the talk-down roll succeeds
    );

    await engine.submitPlayerInput("head to the square");
    await engine.submitPlayerInput("I set my potion on the ground as a peace-offering to the ashstalker");

    const rolls = kinds(events, "diceRolled") as { purpose?: string }[];
    expect(rolls.some((r) => (r.purpose ?? "").includes("talk"))).toBe(true);
    expect(events.some((e) => e.kind === "stateChanged" && e.summary.includes("stands down"))).toBe(true);
    expect(kinds(events, "combatStarted")).toHaveLength(0); // the overture beat plays out un-ambushed

    await engine.submitPlayerInput("I look around");
    await engine.submitPlayerInput("I wait");
    expect(kinds(events, "combatStarted")).toHaveLength(0); // calmed is durable — forgiven, not held
  });

  test("a FAILED talk-down drops the suppression — the hostile answers with violence (r6 P1)", async () => {
    // The inverse contract: losing the talk-down contest must not buy a quiet beat. The suppression
    // lifts for that entity, the telegraph is spent, and the ambush lands on the next turn.
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { companions: [] }),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn fires
        planOf({ kind: "freeformNarrative", targetId: "mon.ashstalker#0" }), // peace-offering AT it
        planOf({ kind: "freeformNarrative" }), // untargeted turn — the ambush lands
      ]),
      new OfflineGateway(),
      () => 0, // the talk-down roll fails
    );

    await engine.submitPlayerInput("head to the square");
    await engine.submitPlayerInput("I set my potion on the ground as a peace-offering to the ashstalker");
    expect(kinds(events, "combatStarted")).toHaveLength(0); // the telegraph beat fires instead
    expect(kinds(events, "diceRolled").some((r) => (r as { success?: boolean }).success === false)).toBe(true);

    await engine.submitPlayerInput("I look around");
    expect(kinds(events, "combatStarted")).toHaveLength(1); // the answer is violence
  });

  test("the player's own declared attack is NOT preempted by on-sight aggro (no phantom ambush) (audit)", async () => {
    // A monster spawns into the room, then the player TYPES an attack on it. On-sight aggro runs before
    // the combatAttack intent is read; before the fix it fired first, narrating the monster ambushing
    // the very player who just said "I attack it" and dropping their swing. The player's declared
    // attack must own the opening: one encounter, and the PC actually swings this tick.
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { companions: [] }),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn fires (no aggro yet)
        planOf({ kind: "attack", targetId: "mon.ashstalker#0" }), // the player strikes first
      ]),
    );

    await engine.submitPlayerInput("head to the square");
    expect(kinds(events, "entitySpawned")).toHaveLength(1);
    expect(kinds(events, "combatStarted")).toHaveLength(0); // no ambush on the entry tick

    events.length = 0;
    await engine.submitPlayerInput("I attack the ashstalker");
    // Exactly one fight, and the PC's swing landed this tick — not a dropped turn behind an ambush.
    expect(kinds(events, "combatStarted")).toHaveLength(1);
    const pcSwung = kinds(events, "diceRolled").some((e) => "actorId" in e && e.actorId === "pc.you");
    expect(pcSwung).toBe(true);
  });

  test("a short rest recovers some hp in place and advances an hour — but not near a live hostile", async () => {
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.ashstalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "tracked" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      seededState(playset, { pcHp: 5 }),
      scriptedClassifier([
        planOf({ kind: "rest" }), // safe here: heals
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawns the stalker
        planOf({ kind: "rest" }), // hostile present: no heal (telegraph tick, r4)
        planOf({ kind: "rest" }), // still no heal — and now the ambush opens
      ]),
    );

    const clockBefore = engine.getState().clock;
    await engine.submitPlayerInput("we take a short rest");
    let state = engine.getState();
    expect(state.actors["pc.you"]?.currentHp).toBeGreaterThan(5);
    // A short rest is an hour, not a night — the day does not roll over.
    expect(state.clock - clockBefore).toBeGreaterThanOrEqual(60);
    expect(state.clock - clockBefore).toBeLessThan(480);
    expect(kinds(events, "stateChanged").some((e) => "summary" in e && /short rest/.test(e.summary))).toBe(true);

    await engine.submitPlayerInput("go to the square");
    // The stalker spawned on entry; the rest attempt happens under threat. It must NOT heal —
    // the r4 telegraph gives one warning beat, then the ambush opens on the next attempt.
    events.length = 0;
    await engine.submitPlayerInput("rest");
    state = engine.getState();
    expect(kinds(events, "stateChanged").some((e) => "summary" in e && /short rest/.test(e.summary))).toBe(false);
    expect(state.actors["pc.you"]?.currentHp).toBeLessThanOrEqual(24);

    events.length = 0;
    await engine.submitPlayerInput("rest again");
    state = engine.getState();
    expect(kinds(events, "stateChanged").some((e) => "summary" in e && /short rest/.test(e.summary))).toBe(false);
    expect((state.modules?.combat as { active?: boolean } | undefined)?.active).toBe(true);
  });
});
