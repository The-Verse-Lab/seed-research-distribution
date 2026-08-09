/**
 * NpcMemoryModule (M4 Part B) — beat observation end-to-end through a real engine turn (offline,
 * deterministic). Asserts: addressing a companion records the deterministic "addressed" beat; a
 * quest resolving records the "questResolved" beat for present companions; the per-NPC cap bounds
 * the journal across many turns; and the module-issued `npcMemoryRecorded` delta is absolute-post-
 * state so it folds back onto a seed (the `snapshot == fold(deltas)` discipline, module-issued).
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import { NPC_MEMORY_CAP, type NpcMemorySlice } from "../src/rules/npc-memory.ts";
import { applyDelta } from "./support/replay.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import { makeEngine, loadExample } from "./support/harness.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";

const memSlice = (engine: GameEngine): NpcMemorySlice =>
  (engine.getState().modules?.npcMemory as NpcMemorySlice) ?? { entries: {} };

describe("NpcMemoryModule — addressing beat", () => {
  test("addressing a companion records a deterministic 'Spoke with …' entry", async () => {
    const { engine } = await makeEngine();
    await engine.submitPlayerInput("Lyra, any word on the road ahead?");

    const journal = memSlice(engine).entries["npc.lyra"] ?? [];
    expect(journal.length).toBeGreaterThanOrEqual(1);
    const last = journal.at(-1);
    expect(last?.kind).toBe("addressed");
    expect(last?.summary).toBe("Spoke with You."); // engine-templated, deterministic
    expect(typeof last?.at).toBe("number"); // entry.at = model.clock
  });

  test("an NPC the player never addressed has no journal (inert ⇒ byte-identical prompt later)", async () => {
    const { engine } = await makeEngine();
    await engine.submitPlayerInput("I look around the tavern.");
    expect(memSlice(engine).entries["npc.lyra"]).toBeUndefined();
  });
});

describe("NpcMemoryModule — the journal is bounded by NPC_MEMORY_CAP through real turns", () => {
  test("addressing a companion many times keeps only the most recent NPC_MEMORY_CAP beats", async () => {
    const { engine } = await makeEngine();
    for (let i = 0; i < NPC_MEMORY_CAP + 6; i++) {
      await engine.submitPlayerInput(`Lyra, status check ${i}?`);
    }
    const journal = memSlice(engine).entries["npc.lyra"] ?? [];
    expect(journal.length).toBe(NPC_MEMORY_CAP); // bounded — never grows without limit
    expect(journal.every((e) => e.summary === "Spoke with You.")).toBe(true);
  });
});

/** A minimal world+campaign where entering the gate resolves the quest (deterministic event beat). */
function questPlayset(): PlaySet {
  const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
  const world = WorldSchema.parse({
    id: "w.q",
    name: "Questhold",
    summary: "A small hold.",
    locations: [
      { id: "loc.start", name: "The Yard", description: "A muddy yard.", exits: [{ to: "loc.gate" }] },
      { id: "loc.gate", name: "The Gate", description: "An old gate." },
    ],
    npcs: [
      {
        id: "npc.ally",
        name: "Ally",
        persona: "Loyal.",
        age: 30,
        autonomy: { isPartyMember: true, level: "reactive" },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.q",
    name: "Quest Campaign",
    worldId: "w.q",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    quests: [{ id: "quest.errand", name: "The Errand", description: "Reach the gate.", state: "active" }],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: ["npc.ally"] },
    events: [
      {
        id: "ev.reach-gate",
        when: "onEnterLocation",
        once: "campaign",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.gate" }] },
        effects: [{ kind: "setQuestState", questId: "quest.errand", state: "complete" }],
      },
    ],
  });
  return { world, campaign };
}

/**
 * A world+campaign where entering the gate enqueues an `adjustRelationship` from `npc.ally` toward
 * the player (the events module maps the effect to the command in `react`, before npc-memory). `by`
 * is parameterized so one fixture drives the warmed / cooled / no-op (skip) cases.
 */
function relationshipPlayset(by: number): PlaySet {
  const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
  const world = WorldSchema.parse({
    id: "w.r",
    name: "Regardhold",
    summary: "A small hold.",
    locations: [
      { id: "loc.start", name: "The Yard", description: "A muddy yard.", exits: [{ to: "loc.gate" }] },
      { id: "loc.gate", name: "The Gate", description: "An old gate." },
    ],
    npcs: [
      { id: "npc.ally", name: "Ally", persona: "Loyal.", age: 30, autonomy: { isPartyMember: true, level: "reactive" } },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.r",
    name: "Regard Campaign",
    worldId: "w.r",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    quests: [],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: ["npc.ally"] },
    events: [
      {
        id: "ev.gate",
        when: "onEnterLocation",
        once: "campaign",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.gate" }] },
        effects: [{ kind: "adjustRelationship", actorId: "npc.ally", targetId: "pc.you", by }],
      },
    ],
  });
  return { world, campaign };
}

const engineFor = (playset: PlaySet): GameEngine =>
  new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });

describe("NpcMemoryModule — relationship-shift beat", () => {
  test("an NPC's positive relationship nudge records 'My regard for … warmed.'", async () => {
    const engine = engineFor(relationshipPlayset(2));
    await engine.start();
    await engine.submitPlayerInput("go to the gate"); // entry fires the event → adjustRelationship queued

    const journal = ((engine.getState().modules?.npcMemory as NpcMemorySlice) ?? { entries: {} }).entries["npc.ally"] ?? [];
    const rel = journal.find((e) => e.kind === "relationship");
    expect(rel).toBeDefined();
    expect(rel?.summary).toBe("My regard for You warmed.");
    expect(typeof rel?.at).toBe("number");
  });

  test("a negative relationship nudge records 'My regard for … cooled.'", async () => {
    const engine = engineFor(relationshipPlayset(-3));
    await engine.start();
    await engine.submitPlayerInput("go to the gate");

    const journal = ((engine.getState().modules?.npcMemory as NpcMemorySlice) ?? { entries: {} }).entries["npc.ally"] ?? [];
    const rel = journal.find((e) => e.kind === "relationship");
    expect(rel?.summary).toBe("My regard for You cooled.");
  });

  test("a zero-magnitude nudge (by === 0) records no relationship beat (no noise)", async () => {
    const engine = engineFor(relationshipPlayset(0));
    await engine.start();
    await engine.submitPlayerInput("go to the gate");

    const journal = ((engine.getState().modules?.npcMemory as NpcMemorySlice) ?? { entries: {} }).entries["npc.ally"] ?? [];
    expect(journal.some((e) => e.kind === "relationship")).toBe(false);
  });
});

describe("NpcMemoryModule — movement beat", () => {
  test("travelling records 'Traveled to …' for the companion who came along", async () => {
    const engine = engineFor(questPlayset()); // has loc.gate + companion npc.ally
    await engine.start();
    await engine.submitPlayerInput("go to the gate"); // moveParty (applied in resolve) relocates the party

    const journal = ((engine.getState().modules?.npcMemory as NpcMemorySlice) ?? { entries: {} }).entries["npc.ally"] ?? [];
    const moved = journal.find((e) => e.kind === "traveled");
    expect(moved).toBeDefined();
    expect(moved?.summary).toBe("Traveled to The Gate."); // resolves the destination's display name
    expect(typeof moved?.at).toBe("number");
  });

  test("a turn with no movement records no 'traveled' beat", async () => {
    const engine = engineFor(questPlayset());
    await engine.start();
    await engine.submitPlayerInput("I look around the yard."); // freeform — party stays put

    const journal = ((engine.getState().modules?.npcMemory as NpcMemorySlice) ?? { entries: {} }).entries["npc.ally"] ?? [];
    expect(journal.some((e) => e.kind === "traveled")).toBe(false);
  });
});

describe("NpcMemoryModule — quest-resolution beat", () => {
  test("a quest completing records 'Quest \"…\" was resolved.' for present companions", async () => {
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: questPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await engine.start();
    await engine.submitPlayerInput("go to the gate"); // entry fires the event → quest completes this tick

    const slice = (engine.getState().modules?.npcMemory as NpcMemorySlice) ?? { entries: {} };
    const journal = slice.entries["npc.ally"] ?? [];
    const resolved = journal.find((e) => e.kind === "questResolved");
    expect(resolved).toBeDefined();
    expect(resolved?.summary).toBe('Quest "The Errand" was resolved.'); // deterministic, uses the quest's name
  });
});

describe("NpcMemoryModule — module-issued delta is absolute-post-state (folds onto a seed)", () => {
  test("the npcMemoryRecorded delta from a real turn reconstructs the slice on replay", async () => {
    const playset = await (await import("./support/harness.ts")).loadExample();
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    // Seed = the model BEFORE the addressing turn (a fresh projection of the started state).
    const seed: WorldModel = fromGameState(engine.getState(), playset.world, playset.campaign);

    await engine.submitPlayerInput("Lyra, hello.");

    // Fold the emitted memory deltas onto the seed; they carry the absolute journal, so the seed's
    // slice ends up identical to the live engine's slice (the per-NPC fold idempotency).
    const memoryDeltas = events.filter(
      (e): e is DeltaEvent => e.kind === "npcMemoryRecorded" || e.kind === "npcMemoryCleared",
    );
    expect(memoryDeltas.length).toBeGreaterThanOrEqual(1);
    for (const d of memoryDeltas) applyDelta(seed, d);

    const folded = (seed.modules.npcMemory as NpcMemorySlice).entries["npc.lyra"];
    const live = (engine.getState().modules?.npcMemory as NpcMemorySlice).entries["npc.lyra"];
    expect(folded).toBeDefined();
    expect(folded).toEqual(live);
  });
});

// ---------------------------------------------------------------------------
// Attire beat ("attireObserved") — a co-located NPC witnesses the PC's attire transition to
// bare/disheveled, driven by the real typed "clothing" turn (paperdoll wave P2). Mirrors the
// scripted-plan precedent in tests/clothing-action.test.ts.
// ---------------------------------------------------------------------------

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

function clothingPlan(slot: string, state: "worn" | "displaced" | "removed"): TurnPlan {
  return planOf({ kind: "clothing", clothing: { slot, state } });
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

const ATTIRE_STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** No NPCs anywhere — the "nothing to witness" control. */
function soloPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.solo",
    name: "Solo",
    summary: "A place alone.",
    locations: [{ id: "loc.start", name: "Empty Room", description: "Just you." }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.solo",
    name: "Solo Campaign",
    worldId: "w.solo",
    characters: [{ id: "pc.you", name: "You", stats: ATTIRE_STATS }],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

/** A location-rostered NPC present but NOT a party member — proves bystanders witness it too. */
function bystanderPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.bystander",
    name: "Bystander Hold",
    summary: "A place with a stranger.",
    locations: [{ id: "loc.start", name: "The Square", description: "A public square.", npcs: ["npc.stranger"] }],
    npcs: [{ id: "npc.stranger", name: "Stranger", persona: "A passerby.", age: 30 }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.bystander",
    name: "Bystander Campaign",
    worldId: "w.bystander",
    characters: [{ id: "pc.you", name: "You", stats: ATTIRE_STATS, age: 30 }],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function attireEngine(playset: PlaySet, plans: TurnPlan[]): GameEngine {
  return new GameEngine({
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    classifier: scriptedClassifier(plans),
    rng: mulberry32(7),
  });
}

describe("NpcMemoryModule — attire beat ('attireObserved')", () => {
  test("stripping bare near a companion records a witnessed beat", async () => {
    const engine = attireEngine(await loadExample(), [clothingPlan("all", "removed")]);
    await engine.start();

    await engine.submitPlayerInput("I strip off my clothes");

    const journal = memSlice(engine).entries["npc.lyra"] ?? [];
    const seen = journal.find((e) => e.kind === "attireObserved");
    expect(seen).toBeDefined();
    expect(seen?.summary).toContain("wore no clothing at");
    expect(typeof seen?.at).toBe("number");
  });

  test("a displaced (not fully bare) change records the disheveled phrasing", async () => {
    const engine = attireEngine(await loadExample(), [clothingPlan("upper", "displaced")]);
    await engine.start();

    await engine.submitPlayerInput("I tug my top loose");

    const journal = memSlice(engine).entries["npc.lyra"] ?? [];
    const seen = journal.find((e) => e.kind === "attireObserved");
    expect(seen?.summary).toContain("was not fully dressed at");
  });

  test("lingering bare across further turns does not repeat the beat (no spam)", async () => {
    const engine = attireEngine(await loadExample(), [clothingPlan("all", "removed")]);
    await engine.start();

    await engine.submitPlayerInput("I strip off my clothes");
    await engine.submitPlayerInput("I look around the tavern.");
    await engine.submitPlayerInput("I look around some more.");

    const beats = (memSlice(engine).entries["npc.lyra"] ?? []).filter((e) => e.kind === "attireObserved");
    expect(beats.length).toBe(1);
  });

  test("redressing then stripping again records a SECOND transition beat", async () => {
    const engine = attireEngine(await loadExample(), [
      clothingPlan("all", "removed"),
      clothingPlan("all", "worn"),
      clothingPlan("all", "removed"),
    ]);
    await engine.start();

    await engine.submitPlayerInput("I strip off my clothes");
    await engine.submitPlayerInput("I get dressed again");
    await engine.submitPlayerInput("I strip off my clothes again");

    const beats = (memSlice(engine).entries["npc.lyra"] ?? []).filter((e) => e.kind === "attireObserved");
    expect(beats.length).toBe(2);
  });

  test("no co-located NPC ⇒ no beat is recorded anywhere", async () => {
    const engine = attireEngine(soloPlayset(), [clothingPlan("all", "removed")]);
    await engine.start();

    await engine.submitPlayerInput("I strip off my clothes");

    expect(Object.keys(memSlice(engine).entries).length).toBe(0);
  });

  test("a bystander (not a party member) witnesses and remembers exposure too", async () => {
    const engine = attireEngine(bystanderPlayset(), [clothingPlan("all", "removed")]);
    await engine.start();

    await engine.submitPlayerInput("I strip off my clothes");

    const journal = memSlice(engine).entries["npc.stranger"] ?? [];
    expect(journal.some((e) => e.kind === "attireObserved")).toBe(true);
  });
});
