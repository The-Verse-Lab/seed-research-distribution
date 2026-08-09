/**
 * Delta replay + the SSOT invariant — `snapshot == fold(deltas)` (Decision D3).
 *
 * The durable log of deltas is the authoritative history; the snapshot is a cache. This drives a
 * representative command sequence (every delta kind) through the reducer on a live model while
 * collecting the deltas it emits, then folds those deltas onto a fresh copy of the same seed and
 * asserts the folded model projects to the *same* GameState the live model does. Fully
 * deterministic: no RNG, no Date.now in asserted state (the only Date.now in the system is baked
 * by the dialogue module into an autonomy patch — and a `modulePatch` delta is replayed verbatim,
 * so even that would stay consistent; this test doesn't exercise it).
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { reduceDeltas, applyDelta, isDelta } from "./support/replay.ts";
import type { Command } from "../src/world/commands.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey, type EventQuery, type SaveKey } from "../src/state/store.ts";
import type { GameEvent } from "../src/events/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { NpcTemplateSchema } from "../src/content/schema.ts";
import { RECENT_EVENT_READ_LIMIT } from "../src/agents/context.ts";
import { loadExample, loadThistledown } from "./support/harness.ts";

/** A started engine's projected state → a fresh model seeded from the example world. */
async function exampleModel(): Promise<WorldModel> {
  const playset = await loadExample();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  return fromGameState(engine.getState(), playset.world, playset.campaign);
}

/** Stamp pre-deltas with the id/at/seq the bus would assign, yielding full DeltaEvents. */
function stamp(pre: EmittedDelta[], from: number): DeltaEvent[] {
  return pre.map((d, i) => ({ ...d, id: `d${from + i}`, at: 0, seq: from + i }) as DeltaEvent);
}

class RecordingStore extends InMemoryGameStateStore {
  readonly reads: EventQuery[] = [];

  override readEvents(key: SaveKey, query: EventQuery = {}) {
    this.reads.push({ ...query });
    return super.readEvents(key, query);
  }
}

describe("delta replay (fold)", () => {
  test("snapshot == fold(deltas): a representative sequence touching every delta kind", async () => {
    const live = await exampleModel();
    // A second quest, seeded HIDDEN, so the sequence below can walk the whole opt-in ladder
    // (hidden → offered → active → complete) and fold every `questStateChanged` value. Emberford's
    // own `quest.missing-caravan` starts ACTIVE, and the reducer now refuses to un-take a taken
    // quest (playtest 07-24 P0), so the offered edge needs a quest that has not been taken yet.
    live.quests.set("quest.side-errand", "hidden");
    // The fold target: a fresh, independent copy of the very same seed.
    const seed = structuredClone(live);

    const sequence: Command[] = [
      { type: "moveParty", to: "loc.square" }, // entityMoved × party
      { type: "moveEntity", entityId: "npc.brann", to: "loc.square" }, // entityMoved (statless authored NPC)
      {
        type: "spawnEntity",
        entity: {
          id: "mob.rat",
          kind: "monster",
          tier: "transient",
          name: "Rat",
          locationId: "loc.square",
          stats: { currentHp: 7, maxHp: 7, coins: 3 },
        },
      }, // entitySpawned (enriched: name + stats incl. a small purse)
      {
        type: "spawnEntity",
        entity: {
          id: "npc.sela",
          kind: "npc",
          tier: "tracked",
          name: "Sela",
          locationId: "loc.square",
          stats: { currentHp: 6, maxHp: 6 },
        },
      }, // entitySpawned (a bystander with a body, so she can be conscripted below)
      { type: "startCombat", locationId: "loc.square", order: ["pc.you", "npc.lyra", "mob.rat"], turnIndex: 0 }, // combatStarted
      { type: "advanceTurn" }, // combatTurnAdvanced
      // r5: a bystander takes the party's side mid-fight. The index must land AFTER turnIndex (now
      // 1) or the command rejects and the mutated-every-command assertion below fails first.
      { type: "joinCombat", entityId: "npc.sela", ally: true }, // combatJoined
      { type: "endCombat" }, // combatEnded (absolute inactive post-state)
      { type: "moveEntity", entityId: "mob.rat", to: "loc.tavern" }, // entityMoved (single)
      { type: "setEntityTier", entityId: "mob.rat", tier: "tracked" }, // tierChanged
      { type: "adjustHp", entityId: "mob.rat", by: -3 }, // hpChanged
      { type: "setCondition", entityId: "mob.rat", condition: "prone", active: true }, // conditionChanged
      { type: "transferItem", itemId: "item.lantern", from: "pc.you", to: "mob.rat" }, // itemTransferred
      // Coins + stacked equipment (Phase 1): earn/spend, grant TWO daggers (duplicate ids = a
      // stack), equip one, then drain the stack — the LAST copy leaving vacates the weapon slot.
      { type: "adjustCoins", entityId: "pc.you", by: 120 }, // coinsChanged (absolute post-balance)
      { type: "adjustCoins", entityId: "pc.you", by: -35 }, // coinsChanged (spend, still ≥ 0)
      { type: "transferItem", itemId: "weapon.dagger", from: null, to: "pc.you" }, // itemTransferred (world → entity)
      { type: "transferItem", itemId: "weapon.dagger", from: null, to: "pc.you" }, // itemTransferred (duplicate id — the stack)
      { type: "equipItem", entityId: "pc.you", slot: "weapon", itemId: "weapon.dagger" }, // equipmentChanged
      { type: "transferItem", itemId: "weapon.dagger", from: "pc.you", to: "mob.rat" }, // itemTransferred (one copy stays — slot holds)
      { type: "transferItem", itemId: "weapon.dagger", from: "pc.you", to: "mob.rat" }, // itemTransferred + equipmentChanged (last copy leaves)
      { type: "adjustRelationship", actorId: "npc.lyra", targetId: "pc.you", by: 7 }, // relationshipChanged
      { type: "setQuestState", questId: "quest.side-errand", state: "offered" }, // questStateChanged (Phase 3 opt-in state folds too)
      { type: "setQuestState", questId: "quest.side-errand", state: "active" }, // questStateChanged (accept)
      { type: "setQuestState", questId: "quest.missing-caravan", state: "complete" }, // questStateChanged
      { type: "setObjectiveDone", questId: "quest.missing-caravan", objectiveId: "obj.find-trail", done: true }, // objectiveChanged
      { type: "advanceClock", by: 5 }, // clockAdvanced
      // Traversal & energy (Workstream H): lock the square↔tavern door from the square side (the
      // reverse exit mirrors — TWO exitStateChanged deltas, each absolute per direction), then
      // spend and clamp energy — each energyChanged delta carries the absolute post-value.
      { type: "setExitState", locationId: "loc.square", to: "loc.tavern", state: "locked" }, // exitStateChanged ×2 (mirrored)
      { type: "setExitState", locationId: "loc.square", to: "loc.tavern", state: "broken" }, // exitStateChanged ×2 (state change really mutates)
      { type: "adjustEnergy", entityId: "pc.you", by: -30 }, // energyChanged (absolute post-value; absent = full)
      { type: "adjustEnergy", entityId: "pc.you", by: 10 }, // energyChanged (partial restore)
      { type: "adjustExhaustion", entityId: "pc.you", by: 2 }, // exhaustionChanged (absolute post-level; absent = 0)
      { type: "setFlag", scope: "world", key: "alarm", value: true }, // flagSet (world)
      { type: "setFlag", scope: "entity", entityId: "npc.brann", key: "movedByReplay", value: true }, // flagSet (statless NPC)
      { type: "setFlag", scope: "entity", entityId: "pc.you", key: "marked", value: 1 }, // flagSet (entity)
      { type: "modulePatch", module: "autonomy", patch: { "npc.lyra": { talking: true, replyDepth: 2, lastActedAt: 99 } } }, // modulePatched
      // Ground items (07-18 #2): drop then pickup as ABSOLUTE per-location arrays — the floor
      // slice folds by pure overwrite exactly like every other modulePatch.
      { type: "modulePatch", module: "groundItems", patch: { "loc.square": ["weapon.club"] } }, // modulePatched (floor add)
      { type: "modulePatch", module: "groundItems", patch: { "loc.square": [] } }, // modulePatched (floor cleared)
      // NPC memory (M4 Part B): record TWO beats (the second appends to the absolute journal), then
      // clear — so the delta's absolute-post-state overwrite AND the clear both fold cleanly.
      { type: "recordNpcMemory", npcId: "npc.lyra", entry: { at: 5, kind: "addressed", summary: "Spoke with You." } }, // npcMemoryRecorded
      { type: "recordNpcMemory", npcId: "npc.lyra", entry: { at: 5, kind: "questResolved", summary: 'Quest "The Missing Caravan" was resolved.' } }, // npcMemoryRecorded (append)
      { type: "clearNpcMemory", npcId: "npc.lyra" }, // npcMemoryCleared (the journal had entries, so this really mutates)
      // Party (Phase 2): hand lyra the reins, refuse her leave, let her go (one atomic command
      // clears her pendingLeave AND resets the leadership to null), then re-admit her — every
      // delta carries the ABSOLUTE post-state slice, so each folds by pure overwrite.
      { type: "setPartyLeader", entityId: "npc.lyra" }, // partyLeaderChanged
      { type: "recordLeaveDenied", entityId: "npc.lyra", deniedAtSeq: 7 }, // partyLeaveDenied
      { type: "setPartyMembership", entityId: "npc.lyra", member: false }, // partyMembershipChanged (leave: clears pendingLeave + leader)
      { type: "setPartyMembership", entityId: "npc.lyra", member: true }, // partyMembershipChanged (rejoin)
      // Enrichment (Phase 2 Stage B): the delta carries the FULL template (replayed verbatim) and
      // the promotion to significant rides its own tierChanged delta, emitted alongside.
      {
        type: "enrichNpc",
        npcId: "npc.brann",
        template: NpcTemplateSchema.parse({ id: "npc.brann", name: "Brann", persona: "Gruff, observant." }),
      }, // npcEnriched + tierChanged
      // First-observation profile (Workstream A): `promote: false` records the template WITHOUT
      // the tier bump (npcEnriched only), then the default promotion call adds the tierChanged —
      // the same delta kinds, split across two commands, both folding verbatim.
      {
        type: "spawnEntity",
        entity: { id: "npc.stray", kind: "npc", tier: "transient", name: "Stray", locationId: "loc.square", stats: { currentHp: 6, maxHp: 6 } },
      }, // entitySpawned
      {
        type: "enrichNpc",
        npcId: "npc.stray",
        template: NpcTemplateSchema.parse({ id: "npc.stray", name: "Stray", persona: "Wary, road-worn." }),
        promote: false,
      }, // npcEnriched (NO tierChanged — the entity stays transient)
      {
        type: "enrichNpc",
        npcId: "npc.stray",
        template: NpcTemplateSchema.parse({ id: "npc.stray", name: "Stray", persona: "Wary, road-worn." }),
      }, // tierChanged rides the promotion of the already-recorded profile (+ npcEnriched re-emit)
      { type: "despawnEntity", entityId: "mob.rat" }, // entityDespawned (note: also drops its stats/flags)
    ];

    const deltas: DeltaEvent[] = [];
    for (const cmd of sequence) {
      const res = applyCommand(live, cmd);
      expect(res.mutated).toBe(true); // every command in the sequence really changed something
      deltas.push(...stamp(res.deltas, deltas.length));
    }

    // Every recorded delta kind is exercised at least once (guards the fold's completeness).
    expect(new Set(deltas.map((d) => d.kind))).toEqual(
      new Set([
        "entityMoved",
        "entitySpawned",
        "tierChanged",
        "hpChanged",
        "conditionChanged",
        "itemTransferred",
        "coinsChanged",
        "equipmentChanged",
        "relationshipChanged",
        "questStateChanged",
        "objectiveChanged",
        "clockAdvanced",
        "exitStateChanged",
        "energyChanged",
        "exhaustionChanged",
        "flagSet",
        "modulePatched",
        "npcMemoryRecorded",
        "npcMemoryCleared",
        "partyMembershipChanged",
        "partyLeaderChanged",
        "partyLeaveDenied",
        "npcEnriched",
        "combatStarted",
        "combatTurnAdvanced",
        "combatJoined",
        "combatEnded",
        "entityDespawned",
      ]),
    );

    reduceDeltas(seed, deltas);

    // The invariant: the folded model projects to exactly the live model's projection.
    expect(toGameState(seed)).toEqual(toGameState(live));
  });

  test("a spawn delta carries enough to recreate the entity exactly (HP, conditions, inventory)", async () => {
    const live = await exampleModel();
    const res = applyCommand(live, {
      type: "spawnEntity",
      entity: {
        id: "mob.wolf",
        kind: "monster",
        tier: "tracked",
        name: "Dire Wolf",
        locationId: "loc.square",
        templateId: "mon.ashstalker",
        stats: { currentHp: 11, maxHp: 22, conditions: ["bloodied"], inventory: ["item.lantern"], coins: 12 },
      },
    });
    const spawned = res.deltas[0];
    expect(spawned?.kind).toBe("entitySpawned");

    // Replay that single delta onto a bare model and confirm the entity is reconstructed whole.
    const target = structuredClone(live);
    target.entities.delete("mob.wolf"); // remove so the delta has to recreate it
    applyDelta(target, { ...(spawned as EmittedDelta), id: "d0", at: 0, seq: 0 } as DeltaEvent);

    const e = target.entities.get("mob.wolf");
    expect(e).toBeDefined();
    expect(e?.name).toBe("Dire Wolf");
    expect(e?.tier).toBe("tracked");
    expect(e?.templateId).toBe("mon.ashstalker");
    expect(e?.stats).toEqual({ currentHp: 11, maxHp: 22, conditions: ["bloodied"], inventory: ["item.lantern"], coins: 12 });
  });
});

describe("delta replay (engine durable log)", () => {
  test("snapshot == fold(durable deltas), including silent clock/autonomy/events bookkeeping", async () => {
    const playset = await loadThistledown();
    const seedEngine = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await seedEngine.start();
    const seed = fromGameState(seedEngine.getState(), playset.world, playset.campaign);

    const store = new RecordingStore();
    const engine = new GameEngine({ classifier: heuristicClassifier, playset, store, gateway: new OfflineGateway(), rng: mulberry32(7) });
    const broadcast: GameEvent[] = [];
    engine.subscribe((e) => broadcast.push(e));
    await engine.start();
    broadcast.length = 0;

    // Turn 1: player dialogue advances the clock, enters the events cursor, and records companion
    // autonomy bookkeeping (lastActedAt) through applySilent.
    await engine.submitPlayerInput("Maelle, what should we do?");
    // Turn 2: location entry fires a once beat and advances the events cursor again.
    await engine.submitPlayerInput("go to the green");

    const key = makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]);
    const durable = await store.readEvents(key);
    const deltas = durable.filter(isDelta);
    expect(deltas.some((e) => e.kind === "clockAdvanced" && e.silent === true)).toBe(true);
    expect(deltas.some((e) => e.kind === "modulePatched" && e.module === "autonomy" && e.silent === true)).toBe(true);
    expect(deltas.some((e) => e.kind === "modulePatched" && e.module === "events" && e.silent === true)).toBe(true);

    reduceDeltas(seed, deltas);

    const persisted = await store.load(key);
    if (!persisted) throw new Error("expected persisted snapshot");
    expect(toGameState(seed)).toEqual(persisted);
    expect(toGameState(seed)).toEqual(engine.getState());

    // Quiet path: silent bookkeeping is durable but does not fan out to live subscribers.
    expect(broadcast.some((e) => e.kind === "clockAdvanced" || (e.kind === "modulePatched" && e.silent === true))).toBe(
      false,
    );

    // Quiet path: the narrator's RECENT read asks for a story-facing slice, and that slice contains
    // no silent bookkeeping rows even though the full durable log does.
    expect(
      store.reads.some((q) => q.limit === RECENT_EVENT_READ_LIMIT && q.includeSilent === false),
    ).toBe(true);
    const recent = await store.readEvents(key, {
      limit: RECENT_EVENT_READ_LIMIT,
      includeSilent: false,
    });
    expect(recent.every((e) => e.silent !== true)).toBe(true);
  });
});
