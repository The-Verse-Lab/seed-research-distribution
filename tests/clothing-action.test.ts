/**
 * Typed clothing-action tests — P2 of the paperdoll wave: "I strip off my clothes" TYPED as input
 * runs a real classified turn (kind "clothing") that patches `modules.wardrobe` through the
 * reducer AND produces the narration trigger in the SAME tick, so the narrator and reactive NPCs
 * respond immediately. The paper-doll's per-slot buttons stay the silent no-turn path by design.
 *
 * Like itemAction's equip/unequip, a clothing change is deterministic and check-free: the intent
 * carries a plain authoritative trigger and never a `=== RESOLVED MECHANICS` block (that shape is
 * dice-verdict-only) — asserted against the captured narrator brief below. Scripted classifier
 * stubs drive the intent (the LLM classifier is the product classifier; tests never regex-guess).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { NpcTemplateSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import type { CompletionRequest, CompletionResult, LlmRole } from "../src/llm/types.ts";
import { reconcilePlan, type TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import { WARDROBE_MODULE, type WardrobeSlice } from "../src/rules/wardrobe.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { reduceDeltas } from "./support/replay.ts";
import { byKind, loadExample } from "./support/harness.ts";

const PC = "pc.you";

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

/** Captures every narrator brief, so specs can assert what the GM actually saw this tick. */
class RecordingGateway extends OfflineGateway {
  readonly briefs: string[] = [];

  override complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    if (role === "narrator") {
      const user = req.messages.filter((m) => m.role === "user").at(-1);
      if (user) this.briefs.push(user.content);
    }
    return super.complete(role, req);
  }
}

/** The example world with a PC whose appearance prose names a cloak (over-upper) and boots (feet) —
 *  prose-only garments beyond the paper-doll's baseline pair, so "all" must reach them too. */
function dressedPlayset(base: PlaySet): PlaySet {
  const playset = structuredClone(base);
  const pc = playset.campaign.characters.find((c) => c.id === PC);
  if (pc) pc.description = "A road-worn wanderer wrapped in a heavy cloak, sturdy boots laced to the knee.";
  return playset;
}

async function makeClothingEngine(plans: TurnPlan[], gateway = new RecordingGateway()) {
  const playset = dressedPlayset(await loadExample());
  const engine = new GameEngine({
    playset,
    store: new InMemoryGameStateStore(),
    gateway,
    classifier: scriptedClassifier(plans),
    rng: mulberry32(11),
    // The rolling summary's rewrite prompt is also a "user" message, and it lands AFTER the
    // narrator brief — with it on, `gateway.briefs.at(-1)` reads the summarizer's prompt and the
    // Attire assertion below misses the brief it means to check.
    summary: false,
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events, gateway, playset };
}

function wardrobeRow(engine: GameEngine): Partial<Record<string, string>> {
  return ((engine.getState().modules?.[WARDROBE_MODULE] as WardrobeSlice | undefined)?.[PC] ?? {}) as Partial<
    Record<string, string>
  >;
}

describe("reconcilePlan — clothing payload grounding", () => {
  const ctx: ClassifierContext = {
    playerActorId: PC,
    locationId: "loc.tavern",
    locationName: "The Tavern",
    exits: [],
    presentEntities: [],
    companionIds: [],
  };

  function raw(partial: Record<string, unknown>): Record<string, unknown> {
    return {
      kind: "freeformNarrative",
      targetId: null,
      destinationLocationId: null,
      check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
      confidence: 0.9,
      ...partial,
    };
  }

  test("a real slot id and 'all' both ground and keep the kind", () => {
    const single = reconcilePlan(raw({ kind: "clothing", clothing: { slot: "head", state: "worn" } }), ctx);
    expect(single.kind).toBe("clothing");
    expect(single.clothing).toEqual({ slot: "head", state: "worn" });

    const all = reconcilePlan(raw({ kind: "clothing", clothing: { slot: "all", state: "removed" } }), ctx);
    expect(all.kind).toBe("clothing");
    expect(all.clothing).toEqual({ slot: "all", state: "removed" });
  });

  test("an unrecognized slot degrades the WHOLE plan to freeformNarrative", () => {
    const plan = reconcilePlan(raw({ kind: "clothing", clothing: { slot: "torso", state: "removed" } }), ctx);
    expect(plan.kind).toBe("freeformNarrative");
    expect(plan.clothing).toBeUndefined();
  });

  test("kind 'clothing' with no payload degrades to freeformNarrative", () => {
    const plan = reconcilePlan(raw({ kind: "clothing", clothing: null }), ctx);
    expect(plan.kind).toBe("freeformNarrative");
    expect(plan.clothing).toBeUndefined();
  });
});

describe("typed clothing turn — single slot", () => {
  test("removing one named slot patches exactly that slot and narrates it in the same tick", async () => {
    const { engine, events } = await makeClothingEngine([clothingPlan("feet", "removed")]);

    await engine.submitPlayerInput("I kick off my boots");

    expect(wardrobeRow(engine)).toEqual({ feet: "removed" });
    expect(byKind(events, "stateChanged")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ changes: { wardrobe: { slots: ["feet"], state: "removed" } } }),
      ]),
    );
    const narrations = byKind(events, "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    expect(narrations[0]!.text).toContain("You strip off your footwear.");
  });

  test("putting a slot back on writes 'worn' and narrates the redress", async () => {
    const { engine, events } = await makeClothingEngine([
      clothingPlan("upper", "removed"),
      clothingPlan("upper", "worn"),
    ]);

    await engine.submitPlayerInput("I pull my tunic off");
    expect(wardrobeRow(engine)).toEqual({ upper: "removed" });

    events.length = 0;
    await engine.submitPlayerInput("I pull my tunic back on");
    expect(wardrobeRow(engine)).toEqual({ upper: "worn" });
    expect(byKind(events, "narration")[0]!.text).toContain("You put your top back in place.");
  });
});

describe("typed clothing turn — slot 'all'", () => {
  test("stripping everything reaches prose garments AND the baseline pair, and the brief reads bare this tick", async () => {
    const { engine, events, gateway } = await makeClothingEngine([clothingPlan("all", "removed")]);

    await engine.submitPlayerInput("I strip off my clothes");

    // Prose cloak (over-upper) + boots (feet) + the doll's guaranteed upper/lower pair — and
    // nothing else: no headwear write for a hatless PC.
    expect(wardrobeRow(engine)).toEqual({
      "over-upper": "removed",
      upper: "removed",
      lower: "removed",
      feet: "removed",
    });

    const narrations = byKind(events, "narration");
    expect(narrations[0]!.text).toContain("You strip off your outer top, top, bottoms and footwear.");

    // The SAME tick's narrator brief already carries the flipped attire state (occupancy-narrowed
    // bare), and — deterministic, check-free — no resolved-mechanics block.
    const brief = gateway.briefs.at(-1) ?? "";
    expect(brief).toContain("Attire: bare — no clothing worn");
    expect(brief).not.toContain("=== RESOLVED MECHANICS");
  });

  test("a repeat strip is a graceful no-op: an 'already' line and no wardrobe delta", async () => {
    const { engine, events } = await makeClothingEngine([clothingPlan("all", "removed")]);

    await engine.submitPlayerInput("I strip off my clothes");
    const rowAfterStrip = wardrobeRow(engine);

    events.length = 0;
    await engine.submitPlayerInput("I take everything off");

    expect(wardrobeRow(engine)).toEqual(rowAfterStrip);
    const patches = byKind(events, "modulePatched").filter((e) => e.module === WARDROBE_MODULE);
    expect(patches).toHaveLength(0);
    expect(byKind(events, "narration")[0]!.text).toContain("You have already stripped off your");
  });
});

// --- replay invariant: snapshot == fold(deltas) across typed clothing turns -----------------

function isDelta(e: GameEvent): e is DeltaEvent {
  switch (e.kind) {
    case "entityMoved":
    case "entitySpawned":
    case "entityDespawned":
    case "tierChanged":
    case "hpChanged":
    case "conditionChanged":
    case "itemTransferred":
    case "coinsChanged":
    case "equipmentChanged":
    case "relationshipChanged":
    case "questStateChanged":
    case "objectiveChanged":
    case "clockAdvanced":
    case "flagSet":
    case "modulePatched":
    case "npcMemoryRecorded":
    case "npcMemoryCleared":
    case "partyMembershipChanged":
    case "partyLeaderChanged":
    case "partyLeaveDenied":
    case "npcEnriched":
    case "combatStarted":
    case "combatTurnAdvanced":
    case "combatEnded":
    case "worldExpanded":
    case "exitStateChanged":
    case "energyChanged":
    case "exhaustionChanged":
      return true;
    default:
      return false;
  }
}

describe("delta replay", () => {
  test("snapshot == fold(deltas) after strip-all, redress, and a displaced slot", async () => {
    const playset = dressedPlayset(await loadExample());
    const plans = [clothingPlan("all", "removed"), clothingPlan("upper", "worn"), clothingPlan("lower", "displaced")];

    const seedEngine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: scriptedClassifier(plans),
      rng: mulberry32(23),
    });
    await seedEngine.start();
    const seed = fromGameState(seedEngine.getState(), playset.world, playset.campaign);

    // Fold from the DURABLE event log, not the broadcast: silent bookkeeping deltas (clock,
    // travel-events cursor) are persisted but never broadcast, and the invariant covers them too.
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: scriptedClassifier(plans),
      rng: mulberry32(23),
    });
    await engine.start();

    await engine.submitPlayerInput("I strip off my clothes");
    await engine.submitPlayerInput("I pull my tunic back on");
    await engine.submitPlayerInput("I hitch my skirt loose");

    const key = makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]);
    const durable = await store.readEvents(key);
    const deltas = durable.filter(isDelta);
    expect(deltas.some((e) => e.kind === "modulePatched" && e.module === WARDROBE_MODULE)).toBe(true);

    reduceDeltas(seed, deltas);
    expect(toGameState(seed)).toEqual(engine.getState());
  });
});

// --- clothing in combat ----------------------------------------------------------

describe("typed clothing in combat", () => {
  /** The dressed example world plus a hostile bandit sturdy enough to survive the opening swing. */
  function combatPlayset(base: PlaySet): PlaySet {
    const playset = dressedPlayset(base);
    playset.world.npcs.push(
      NpcTemplateSchema.parse({
        id: "npc.bandit",
        name: "Bandit",
        summary: "A desperate road-cutter with a raised knife.",
        persona: "Cruel, jumpy, and direct.",
        appearance: "A wiry bandit in a patched coat, knuckles white around a knife.",
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
      }),
    );
    playset.world.locations.find((loc) => loc.id === "loc.tavern")?.npcs.push("npc.bandit");
    return playset;
  }

  test("a typed clothing change mid-fight spends the combat turn — wardrobe fiddling cannot stall the enemy", async () => {
    const playset = combatPlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), {
      campaignId: playset.campaign.id,
      worldId: playset.world.id,
      partyLocationId: "loc.tavern",
      clock: 0,
      party: [PC],
      companions: [],
      actors: {
        [PC]: { id: PC, currentHp: 20, locationId: "loc.tavern", inventory: [], conditions: [] },
        "npc.bandit": { id: "npc.bandit", currentHp: 30, locationId: "loc.tavern", inventory: [], conditions: [] },
      },
      quests: {},
      relationships: {},
      autonomy: {},
      flags: {},
    });
    const engine = new GameEngine({
      playset,
      store,
      gateway: new RecordingGateway(),
      classifier: scriptedClassifier([
        planOf({ kind: "attack", targetId: "npc.bandit" }),
        clothingPlan("upper", "displaced"),
      ]),
      rng: mulberry32(11),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("I attack the bandit");
    expect(byKind(events, "combatStarted")).toHaveLength(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);

    events.length = 0;
    await engine.submitPlayerInput("I tug my collar loose");

    // The wardrobe patch landed...
    const wardrobe = engine.getState().modules?.wardrobe as WardrobeSlice | undefined;
    expect(wardrobe?.[PC]?.upper).toBe("displaced");
    // ...and it cost the turn, exactly like an item action: initiative advanced, the enemy acted.
    expect(byKind(events, "combatTurnAdvanced").length).toBeGreaterThanOrEqual(1);
    const foeSwings = byKind(events, "diceRolled").filter((e) => e.purpose?.startsWith("Bandit"));
    expect(foeSwings.length).toBeGreaterThanOrEqual(1);
    expect((engine.getState().modules?.combat as { active?: boolean }).active).toBe(true);
  });
});
