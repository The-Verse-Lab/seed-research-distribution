/**
 * replay — fold the durable delta history back into a WorldModel.
 *
 * Deltas are the authoritative, structured record of every mutation the reducer made (Decision
 * D3): the snapshot is a load-time cache, the deltas are the truth. `reduceDeltas` replays them
 * onto a seed model so that `fold(deltas)` reconstructs the same state the live reducer reached
 * — the invariant `snapshot == fold(deltas)` (asserted in tests/replay.test.ts). `applyDelta`
 * is the inverse of one reducer step: it consumes the post-state the reducer recorded (absolute
 * values like `clockAdvanced.to` / `hpChanged.to`), so it is itself idempotent-safe.
 *
 * Promoted from tests/support/ (2026-07-12): the fold is now PRODUCTION code — the engine's
 * bounded rewind (`rewindTo`) folds a delta prefix to reconstruct "state just before turn N".
 * The replay-invariant test re-exports from here, so it now proves the shipped fold.
 *
 * @author Runkai Zhang
 */
import type { DeltaEvent, DeltaEventKind } from "../events/deltas.ts";
import type { GameEvent } from "../events/types.ts";
import type { Entity } from "./entity.ts";
import { cloneEntry } from "../rules/npc-memory.ts";
import { cloneLearned } from "../rules/npc-knowledge.ts";
import type { WorldModel } from "./model.ts";
import { applyExitStateKey, applyExpansion, applyLink, applyNpcEnrichment } from "./reducer.ts";
import {
  moduleSlice,
  npcKnowledgeSlice,
  npcMemorySlice,
  overwriteCombatSlice,
  overwritePartySlice,
} from "./module-slices.ts";

/**
 * Every DeltaEvent kind, as a set. `satisfies Record<DeltaEventKind, true>` makes this EXHAUSTIVE
 * at compile time: adding a delta kind to `DeltaEvent` without listing it here is a type error, and
 * so is listing a name that is not a delta kind. `isDelta` reads it to split the durable log's
 * delta rows from the story-facing events — the filter the fold depends on.
 */
const DELTA_KINDS = {
  entityMoved: true,
  entitySpawned: true,
  entityDespawned: true,
  tierChanged: true,
  hpChanged: true,
  conditionChanged: true,
  itemTransferred: true,
  coinsChanged: true,
  equipmentChanged: true,
  exitStateChanged: true,
  energyChanged: true,
  exhaustionChanged: true,
  relationshipChanged: true,
  factionStandingChanged: true,
  questStateChanged: true,
  objectiveChanged: true,
  clockAdvanced: true,
  flagSet: true,
  modulePatched: true,
  npcMemoryRecorded: true,
  npcMemoryCleared: true,
  npcFactLearned: true,
  partyMembershipChanged: true,
  partyLeaderChanged: true,
  partyLeaveDenied: true,
  npcEnriched: true,
  combatStarted: true,
  combatTurnAdvanced: true,
  combatJoined: true,
  combatEnded: true,
  worldExpanded: true,
  exitLinked: true,
} as const satisfies Record<DeltaEventKind, true>;

/** True for every durable event that is a replayable delta (the fold's read filter). */
export function isDelta(e: GameEvent): e is DeltaEvent {
  return Object.hasOwn(DELTA_KINDS, e.kind);
}

/** Apply one recorded delta forward, mutating the model in place. The inverse of a reducer step. */
export function applyDelta(model: WorldModel, delta: DeltaEvent): void {
  switch (delta.kind) {
    case "entityMoved": {
      const e = model.entities.get(delta.entityId);
      if (e) e.locationId = delta.to;
      return;
    }

    case "entitySpawned": {
      const entity: Entity = {
        id: delta.entityId,
        kind: delta.entityKind,
        tier: delta.tier,
        name: delta.name,
        locationId: delta.locationId,
        templateId: delta.templateId,
        stats: delta.stats
          ? {
              currentHp: delta.stats.currentHp,
              maxHp: delta.stats.maxHp,
              conditions: [...delta.stats.conditions],
              inventory: [...delta.stats.inventory],
              // Spread-in so an absent purse/loadout stays an absent key (reducer lockstep).
              ...(delta.stats.coins !== undefined ? { coins: delta.stats.coins } : {}),
              ...(delta.stats.equipped ? { equipped: { ...delta.stats.equipped } } : {}),
              ...(delta.stats.energy !== undefined ? { energy: delta.stats.energy } : {}),
              ...(delta.stats.maxEnergy !== undefined ? { maxEnergy: delta.stats.maxEnergy } : {}),
              ...(delta.stats.exhaustion !== undefined ? { exhaustion: delta.stats.exhaustion } : {}),
            }
          : undefined,
        partyMember: false,
        flags: {},
      };
      model.entities.set(delta.entityId, entity);
      return;
    }

    case "entityDespawned":
      model.entities.delete(delta.entityId);
      return;

    case "tierChanged": {
      const e = model.entities.get(delta.entityId);
      if (e) e.tier = delta.tier;
      return;
    }

    case "hpChanged": {
      const e = model.entities.get(delta.entityId);
      if (e?.stats) e.stats.currentHp = delta.to;
      return;
    }

    case "conditionChanged": {
      const e = model.entities.get(delta.entityId);
      if (!e?.stats) return;
      const has = e.stats.conditions.includes(delta.condition);
      if (delta.active && !has) e.stats.conditions = [...e.stats.conditions, delta.condition];
      else if (!delta.active && has) e.stats.conditions = e.stats.conditions.filter((c) => c !== delta.condition);
      return;
    }

    case "itemTransferred": {
      if (delta.from) {
        const fe = model.entities.get(delta.from);
        if (fe?.stats) {
          // Multiset lockstep with the reducer: exactly ONE instance leaves the source. Any slot
          // the last copy vacated arrives as its own equipmentChanged delta — not re-derived here.
          const idx = fe.stats.inventory.indexOf(delta.itemId);
          if (idx !== -1) {
            const remaining = [...fe.stats.inventory];
            remaining.splice(idx, 1);
            fe.stats.inventory = remaining;
          }
        }
      }
      if (delta.to) {
        const te = model.entities.get(delta.to);
        // Duplicate ids are allowed on the receiving side — that IS the stack.
        if (te?.stats) te.stats.inventory = [...te.stats.inventory, delta.itemId];
      }
      return;
    }

    case "coinsChanged": {
      // Absolute post-adjust balance the reducer recorded — overwrite verbatim.
      const e = model.entities.get(delta.entityId);
      if (e?.stats) e.stats.coins = delta.coins;
      return;
    }

    case "equipmentChanged": {
      // Pure OVERWRITE with the absolute post-change slot record — idempotent.
      const e = model.entities.get(delta.entityId);
      if (e?.stats) e.stats.equipped = { ...delta.equipped };
      return;
    }

    case "exitStateChanged":
      // The same shared per-key write the reducer used — absolute post-state, idempotent. A
      // mirrored reverse-exit change arrives as its own delta, so no pairing logic lives here.
      applyExitStateKey(model, delta.locationId, delta.to, delta.state);
      return;

    case "energyChanged": {
      // Absolute post-adjust energy the reducer recorded — overwrite verbatim.
      const e = model.entities.get(delta.entityId);
      if (e?.stats) e.stats.energy = delta.energy;
      return;
    }

    case "exhaustionChanged": {
      // Absolute post-adjust level the reducer recorded — overwrite verbatim.
      const e = model.entities.get(delta.entityId);
      if (e?.stats) e.stats.exhaustion = delta.exhaustion;
      return;
    }

    case "relationshipChanged": {
      let row = model.relationships.get(delta.actorId);
      if (!row) {
        row = new Map();
        model.relationships.set(delta.actorId, row);
      }
      row.set(delta.targetId, delta.value);
      return;
    }

    case "factionStandingChanged": {
      const slice = moduleSlice(model, "factionStanding") as { byPc?: Record<string, Record<string, number>> };
      const byPc = (slice.byPc ??= {});
      (byPc[delta.pcId] ??= {})[delta.factionId] = delta.value;
      return;
    }

    case "questStateChanged":
      model.quests.set(delta.questId, delta.state);
      return;

    case "objectiveChanged": {
      const slice = moduleSlice(model, "objectives") as Record<string, Record<string, boolean>>;
      const quest = (slice[delta.questId] ??= {});
      quest[delta.objectiveId] = delta.done;
      return;
    }

    case "clockAdvanced":
      // Absolute post-value the reducer recorded — robust against a divergent seed clock.
      model.clock = delta.to;
      return;

    case "flagSet": {
      if (delta.scope === "entity") {
        const e = delta.entityId ? model.entities.get(delta.entityId) : undefined;
        if (e) e.flags[delta.key] = delta.value;
      } else {
        model.flags[delta.key] = delta.value;
      }
      return;
    }

    case "modulePatched": {
      const slice = moduleSlice(model, delta.module);
      Object.assign(slice, delta.patch);
      return;
    }

    case "npcMemoryRecorded": {
      // Pure OVERWRITE with the absolute post-cap journal the reducer recorded — idempotent, and the
      // cap logic stays in the reducer alone (replay never re-derives it).
      npcMemorySlice(model).entries[delta.npcId] = delta.entries.map(cloneEntry);
      return;
    }

    case "npcMemoryCleared": {
      delete npcMemorySlice(model).entries[delta.npcId];
      return;
    }

    case "npcFactLearned": {
      // Pure OVERWRITE with the absolute post-cap learned map the reducer recorded — idempotent;
      // the upgrade/cap logic stays in the reducer alone (replay never re-derives it).
      npcKnowledgeSlice(model).learned[delta.npcId] = Object.fromEntries(
        Object.entries(delta.learned).map(([id, f]) => [id, cloneLearned(f)]),
      );
      return;
    }

    case "partyMembershipChanged": {
      // The flag lands on the entity; the slice is a pure OVERWRITE with the absolute post-state
      // the reducer recorded (leader reset + cleared pendingLeave already folded in) — idempotent.
      const e = model.entities.get(delta.entityId);
      if (e) e.partyMember = delta.member;
      overwritePartySlice(model, delta.party);
      return;
    }

    case "partyLeaderChanged":
    case "partyLeaveDenied": {
      // Pure OVERWRITE with the absolute post-state slice the reducer recorded — idempotent.
      overwritePartySlice(model, delta.party);
      return;
    }

    case "npcEnriched":
      // The same shared mutation the reducer used — templateId (if unset) + the durable slice
      // record, verbatim from the delta's FULL template. The tier promotion arrives as its own
      // tierChanged delta (the reducer emits both), so the fold stays in lockstep.
      applyNpcEnrichment(model, delta.npcId, delta.template);
      return;

    case "combatStarted":
    case "combatTurnAdvanced":
    case "combatJoined":
    case "combatEnded": {
      // Pure OVERWRITE with the absolute post-state encounter the reducer recorded — idempotent.
      overwriteCombatSlice(model, delta.encounter);
      return;
    }

    case "worldExpanded":
      // The same shared mutation the reducer used — map growth + frontier retarget/append + slice
      // record (including the Phase-4 gazetteer realization link, when the delta carries one).
      applyExpansion(
        model,
        delta.fromLocationId,
        delta.viaExitTo,
        delta.locations,
        delta.realizedGazetteerId,
        delta.emergentTown,
      );
      return;

    case "exitLinked":
      // Open-world reuse: the same shared `applyLink` the reducer used — append the discovered
      // `to <name>` edge + record it in the durable `links` slice (idempotent).
      applyLink(model, delta.fromLocationId, delta.to, delta.name);
      return;

    default: {
      // Exhaustiveness: a new DeltaEvent kind that lands without a case above is a compile error
      // here — the fold must never silently drop a mutation (the drift that bit isDelta before).
      const _exhaustive: never = delta;
      void _exhaustive;
      return;
    }
  }
}

/** Fold a recorded delta sequence onto a seed model, returning it (mutated in place). */
export function reduceDeltas(seed: WorldModel, deltas: DeltaEvent[]): WorldModel {
  for (const d of deltas) applyDelta(seed, d);
  return seed;
}
