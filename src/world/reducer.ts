/**
 * reducer — the single mutation chokepoint.
 *
 * `applyCommand` is the ONLY function that writes the WorldModel. It is pure with respect to
 * IO and wall-clock time (the bus stamps id/at/seq; any timestamp a command needs is passed
 * in), so it is fully unit-testable and replayable. It mutates the model in place and returns
 * the typed deltas describing what changed (the engine stamps + emits + persists them). An
 * invalid command mutates nothing and reports a `rejected` reason — the LLM-grounding guard.
 *
 * @author Runkai Zhang
 */
import type { EmittedDelta } from "../events/deltas.ts";
import type { Location, NpcTemplate } from "../content/schema.ts";
import type { Command, EmergentTown } from "./commands.ts";
import type { Entity, EntityTier, EquipSlot } from "./entity.ts";
import {
  cloneCombatEncounter,
  combatEncounterEqual,
  defaultCombatEncounter,
  type CombatEncounter,
} from "../rules/combat-state.ts";
import { maxEnergyOf } from "../rules/costs.ts";
import { EXHAUSTION_MAX } from "../rules/exhaustion.ts";
import type { ExitRuntimeState } from "../rules/exit-state.ts";
import { exitKey } from "../rules/exit-state.ts";
import { capJournal, cloneEntry, NPC_MEMORY_CAP } from "../rules/npc-memory.ts";
import { capLearned, certaintyUpgrades, cloneLearned, NPC_LEARNED_CAP } from "../rules/npc-knowledge.ts";
import { clonePartySlice } from "../rules/party.ts";
import { cloneStatusEffect, cloneStatusEffectSlice } from "../rules/status-effects.ts";
import { gazetteerArrivedFlag, gazetteerEntryRealizedAt, isFrontierId, visitedFlag } from "./expansion.ts";
import { exitsFrom } from "./map.ts";
import { partyLocationOf, playerEntity, type WorldModel } from "./model.ts";
import {
  escalateCoverageRow,
  isWardrobeSlotState,
  WARDROBE_MODULE,
  type WardrobeSlice,
  type WardrobeSlotId,
} from "../rules/wardrobe.ts";
import { CAPTIVITY_CONFIG, defaultCaptivitySlice, type CaptivitySlice } from "../rules/captivity.ts";
import { JOURNEY_LOG_CAP, JOURNEY_MODULE, readJourneySlice } from "../rules/journey.ts";
import { applyXpGain, progressionOf, PROGRESSION_MODULE, type ProgressionSlice } from "../rules/progression.ts";
import { CAPTIVITY_LOCATION_ID, readCaptivitySlice } from "./captivity.ts";
import { effectiveExitState, exitVerdict } from "./traversal.ts";
import {
  casesSlice,
  combatSlice,
  dealsSlice,
  exchangesSlice,
  exitStateSlice,
  moduleSlice,
  npcKnowledgeSlice,
  npcMemorySlice,
  overwriteCombatSlice,
  partySlice,
  servicesSlice,
  statusEffectSlice,
} from "./module-slices.ts";
import {
  DEALS_CAP,
  DEALS_MODULE,
  cloneDealsSlice,
  hasEquivalentOpenDeal,
  normalizeTerms,
  type Deal,
} from "../rules/deals.ts";
import {
  EXCHANGE_CAP,
  EXCHANGES_MODULE,
  SERVICES_MODULE,
  cloneExchangesSlice,
  cloneServicesSlice,
  type ExchangeRecord,
} from "../rules/exchange.ts";
import {
  CASES_MODULE,
  WITHHELD_CAP,
  clampCredibility,
  defaultCaseRuntime,
  npcCaseStateOf,
  pushClaim,
  unionStable,
  type NpcCaseState,
} from "../rules/cases.ts";

export interface CommandResult {
  deltas: EmittedDelta[];
  mutated: boolean;
  rejected?: { command: Command; reason: string };
}

const ok = (deltas: EmittedDelta[]): CommandResult => ({ deltas, mutated: deltas.length > 0 });
const noop: CommandResult = { deltas: [], mutated: false };
const reject = (command: Command, reason: string): CommandResult => ({
  deltas: [],
  mutated: false,
  rejected: { command, reason },
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function relScore(model: WorldModel, a: string, b: string): number {
  return model.relationships.get(a)?.get(b) ?? 0;
}

/**
 * Apply a SEQUENCE of sub-commands and concatenate their deltas — the spine of the compound captivity
 * commands (`beginCaptivity`/`endCaptivity`). Each sub-command is an ordinary reducer command emitting
 * its own existing delta, so the compound emits ONLY existing deltas (replay folds them one-by-one, no
 * new delta kind). The caller front-validates every precondition first (the PC/captor exist, gear is
 * snapshotted from live inventory), so no sub-command can reject mid-way and leave a half-mutation — a
 * noop sub-command simply contributes nothing. Not atomic-with-rollback by itself; the defeat
 * transaction's clone-preflight (`resolveDefeatOutcome`) validates the whole compound before applying.
 */
function applySequence(model: WorldModel, cmds: Command[]): EmittedDelta[] {
  const deltas: EmittedDelta[] = [];
  for (const c of cmds) deltas.push(...applyCommandUnchecked(model, c).deltas);
  return deltas;
}

/** Return the path of the first non-finite number in a runtime command, if any. */
function nonFinitePath(value: unknown, path = "command", seen = new WeakSet<object>()): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = nonFinitePath(value[i], `${path}[${i}]`, seen);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const found = nonFinitePath(child, `${path}.${key}`, seen);
    if (found) return found;
  }
  return null;
}

/**
 * Apply one command through a clone preflight. Rejections and no-ops never touch the live model,
 * including helper accessors that materialize a default module slice while inspecting it. Accepted
 * commands are then run once against the live object, preserving entity/map identity for callers.
 */
export function applyCommand(model: WorldModel, cmd: Command): CommandResult {
  const badNumber = nonFinitePath(cmd);
  if (badNumber) return reject(cmd, `command contains a non-finite number at ${badNumber}`);
  const trial = applyCommandUnchecked(structuredClone(model), cmd);
  if (!trial.mutated) return trial;
  return applyCommandUnchecked(model, cmd);
}

/** Mutating implementation; public callers must enter through the clone-preflight wrapper above. */
function applyCommandUnchecked(model: WorldModel, cmd: Command): CommandResult {
  switch (cmd.type) {
    case "moveEntity": {
      const e = model.entities.get(cmd.entityId);
      if (!e) return reject(cmd, `unknown entity ${cmd.entityId}`);
      if (e.locationId === cmd.to) return noop;
      // `teleport` is the engine-only Camp path (End Day return): Camp has no exit, so the ordinary
      // barrier check would reject the move. Never reachable from a GroundedAction.
      if (e.locationId && !cmd.teleport) {
        if (isFrontierId(cmd.to) || !model.map.exits.has(cmd.to))
          return reject(cmd, `cannot move entity to unrealized/non-location ${cmd.to}`);
        const barred = traversalRejection(model, e.locationId, cmd.to);
        if (barred) return reject(cmd, barred);
      }
      const from = e.locationId;
      e.locationId = cmd.to;
      return ok([{ kind: "entityMoved", entityId: e.id, from, to: cmd.to }]);
    }

    case "moveParty": {
      const from = partyLocationOf(model);
      if (from === cmd.to) return noop;
      if (!from) return reject(cmd, `no path from nowhere to ${cmd.to}`);
      // `teleport` is the engine-only Camp path (long rest / End Day): Camp has no authored exit, so
      // the ordinary barrier check would reject the move "no path". Never reachable from a
      // GroundedAction — enqueued only by the two camp resolvers.
      if (!cmd.teleport) {
        // The party may only ever stand in a REAL, realized map location. A `frontier:*` id is a
        // sentinel for an UNexpanded pocket — crossed only via `expandWorld`, which realizes the pocket
        // and retargets the sentinel onto its entrance. Letting a raw frontier (or any id absent from
        // the map) through moveParty strands the whole party at a non-location with no exits: a
        // campaign soft-lock. Fail closed here — the one writer — so the player path, AI proposals,
        // and scripted travel all obey it. (Invariant: partyLocation never begins with `frontier:`.)
        if (isFrontierId(cmd.to) || !model.map.exits.has(cmd.to))
          return reject(cmd, `cannot move party to unrealized/non-location ${cmd.to}`);
        const barred = traversalRejection(model, from, cmd.to);
        if (barred) return reject(cmd, barred);
      }
      const deltas: EmittedDelta[] = [];
      // Solo ("I go alone"): only the player travels; companions stay put — a deliberate party split
      // (partyLocationOf re-anchors on the moved PC). Otherwise the whole co-located party moves.
      const soloId = cmd.solo ? playerEntity(model)?.id : undefined;
      for (const e of model.entities.values()) {
        if (cmd.solo && e.id !== soloId) continue;
        if (e.partyMember && e.locationId === from) {
          deltas.push({ kind: "entityMoved", entityId: e.id, from, to: cmd.to });
          e.locationId = cmd.to;
        }
      }
      // Gazetteer arrival (Phase 4): stepping into the terminal room that realized an entry
      // marks the entry ARRIVED via a world flag (an ordinary `flagSet` delta — replay-safe,
      // set once). `applyExpansion` stays the only writer of the realization LINK; this flag is
      // what lets the surfaces render ", known" only for places the party has actually stood
      // in, not merely charted a pocket toward.
      const arrivedId = gazetteerEntryRealizedAt(model.modules, cmd.to);
      if (arrivedId !== undefined) {
        const key = gazetteerArrivedFlag(arrivedId);
        if (model.flags[key] !== true) {
          model.flags[key] = true;
          deltas.push({ kind: "flagSet", scope: "world", key, value: true });
        }
      }
      // Fog-of-war (map system): record BOTH endpoints as visited via set-once world flags
      // (same replay-safe `flagSet` path as arrival). Marking `from` durably captures the room
      // just left — including the start room the moment the party first departs it — and `to`
      // captures every arrival, so the map reveals only where the party has actually been.
      for (const id of [from, cmd.to]) {
        const key = visitedFlag(id);
        if (model.flags[key] !== true) {
          model.flags[key] = true;
          deltas.push({ kind: "flagSet", scope: "world", key, value: true });
        }
      }
      // Journey memory (2026-07-25): every REAL party movement enters the bounded journey log —
      // the ledger half of "an NPC can never again deny a road the party actually walked".
      // Teleports (camp/room/captivity scene framing) are excluded; the patch carries the
      // ABSOLUTE post-append log so the generic `modulePatched` fold replays byte-identically.
      if (!cmd.teleport) {
        const slice = moduleSlice(model, JOURNEY_MODULE);
        const prior = readJourneySlice(model.modules).log;
        const log = [...prior, { fromId: from, toId: cmd.to, atClock: model.clock }].slice(-JOURNEY_LOG_CAP);
        slice.log = log;
        deltas.push({ kind: "modulePatched", module: JOURNEY_MODULE, patch: { log } });
      }
      return ok(deltas);
    }

    case "spawnEntity": {
      const s = cmd.entity;
      if (model.entities.has(s.id)) return reject(cmd, `entity ${s.id} already exists`);
      const entity: Entity = {
        id: s.id,
        kind: s.kind,
        tier: s.tier,
        name: s.name,
        locationId: s.locationId,
        templateId: s.templateId,
        stats: s.stats
          ? {
              currentHp: s.stats.currentHp,
              maxHp: s.stats.maxHp,
              conditions: [...(s.stats.conditions ?? [])],
              inventory: [...(s.stats.inventory ?? [])],
              // Spread-in so an absent purse stays an absent key (JSON round-trips byte-stable).
              ...(s.stats.coins !== undefined ? { coins: s.stats.coins } : {}),
              ...(s.stats.energy !== undefined ? { energy: s.stats.energy } : {}),
              ...(s.stats.maxEnergy !== undefined ? { maxEnergy: s.stats.maxEnergy } : {}),
              ...(s.stats.exhaustion !== undefined ? { exhaustion: s.stats.exhaustion } : {}),
            }
          : undefined,
        partyMember: false,
        flags: {},
      };
      model.entities.set(s.id, entity);
      return ok([
        {
          kind: "entitySpawned",
          entityId: s.id,
          entityKind: s.kind,
          name: s.name,
          templateId: s.templateId,
          locationId: s.locationId,
          tier: s.tier,
          // Snapshot the resolved stats (with defaulted conditions/inventory) so replay
          // recreates the entity byte-for-byte — the spawn delta is no longer lossy.
          stats: entity.stats ? { ...entity.stats } : undefined,
        },
      ]);
    }

    case "despawnEntity": {
      if (!model.entities.has(cmd.entityId)) return noop;
      model.entities.delete(cmd.entityId);
      return ok([{ kind: "entityDespawned", entityId: cmd.entityId }]);
    }

    case "setEntityTier": {
      const e = model.entities.get(cmd.entityId);
      if (!e) return reject(cmd, `unknown entity ${cmd.entityId}`);
      if (e.tier === cmd.tier) return noop;
      e.tier = cmd.tier;
      return ok([{ kind: "tierChanged", entityId: e.id, tier: cmd.tier }]);
    }

    case "adjustHp": {
      const e = model.entities.get(cmd.entityId);
      if (!e?.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      const from = e.stats.currentHp;
      const to = clamp(from + cmd.by, 0, e.stats.maxHp);
      if (to === from) return noop;
      e.stats.currentHp = to;
      return ok([{ kind: "hpChanged", entityId: e.id, from, to }]);
    }

    case "setCondition": {
      const e = model.entities.get(cmd.entityId);
      if (!e?.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      const has = e.stats.conditions.includes(cmd.condition);
      if (cmd.active === has) return noop;
      e.stats.conditions = cmd.active
        ? [...e.stats.conditions, cmd.condition]
        : e.stats.conditions.filter((c) => c !== cmd.condition);
      return ok([{ kind: "conditionChanged", entityId: e.id, condition: cmd.condition, active: cmd.active }]);
    }

    case "transferItem": {
      const fe = cmd.from ? model.entities.get(cmd.from) : undefined;
      const te = cmd.to ? model.entities.get(cmd.to) : undefined;
      // Validate BOTH ends before mutating either, so a rejected transfer is atomic. Previously
      // `from` was emptied first and then a statless/unknown `to` rejected — the item vanished from
      // `from` with no delta emitted (state mutated, snapshot != fold(deltas)).
      if (cmd.from && !fe?.stats?.inventory.includes(cmd.itemId)) {
        return reject(cmd, `${cmd.from} does not hold ${cmd.itemId}`);
      }
      if (cmd.to && !te?.stats) {
        return reject(cmd, `entity ${cmd.to} cannot hold items`);
      }
      const deltas: EmittedDelta[] = [{ kind: "itemTransferred", itemId: cmd.itemId, from: cmd.from, to: cmd.to }];
      if (fe?.stats) {
        // Multiset semantics: repeated ids are stacks, so exactly ONE instance leaves the source.
        const remaining = [...fe.stats.inventory];
        remaining.splice(remaining.indexOf(cmd.itemId), 1);
        fe.stats.inventory = remaining;
        // The LAST copy leaving also vacates any slot it occupied — nothing stays equipped unheld.
        if (fe.stats.equipped && !remaining.includes(cmd.itemId)) {
          const vacated = (Object.keys(fe.stats.equipped) as EquipSlot[]).filter(
            (slot) => fe.stats?.equipped?.[slot] === cmd.itemId,
          );
          if (vacated.length > 0) {
            const equipped = { ...fe.stats.equipped };
            for (const slot of vacated) delete equipped[slot];
            fe.stats.equipped = equipped;
            deltas.push({ kind: "equipmentChanged", entityId: fe.id, equipped: { ...equipped } });
          }
        }
      }
      // Duplicate ids are allowed on the receiving side — that IS the stack.
      if (te?.stats) te.stats.inventory = [...te.stats.inventory, cmd.itemId];
      return ok(deltas);
    }

    case "adjustCoins": {
      const e = model.entities.get(cmd.entityId);
      if (!e?.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      if (!Number.isInteger(cmd.by)) return reject(cmd, `coin adjustment must be an integer, got ${cmd.by}`);
      const from = e.stats.coins ?? 0;
      const to = Math.max(0, from + cmd.by);
      if (to === from) return noop;
      e.stats.coins = to;
      return ok([{ kind: "coinsChanged", entityId: e.id, coins: to }]);
    }

    case "equipItem": {
      const e = model.entities.get(cmd.entityId);
      if (!e?.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      // Possession is the reducer's whole check — content (World.items/masterlist) is out of its
      // reach, so slot FIT is the enqueuer's gate (itemFitsSlot in src/rules/items.ts).
      if (cmd.itemId !== null && !e.stats.inventory.includes(cmd.itemId)) {
        return reject(cmd, `${cmd.entityId} does not hold ${cmd.itemId}`);
      }
      if ((e.stats.equipped?.[cmd.slot] ?? null) === cmd.itemId) return noop;
      const equipped = { ...e.stats.equipped };
      if (cmd.itemId === null) delete equipped[cmd.slot];
      else equipped[cmd.slot] = cmd.itemId;
      e.stats.equipped = equipped;
      return ok([{ kind: "equipmentChanged", entityId: e.id, equipped: { ...equipped } }]);
    }

    case "tradeWith": {
      // ONE atomic vendor exchange (buy: coins−price, item vendor→PC; sell: coins+price, item
      // PC→vendor). Validate BOTH the transfer end AND affordability before mutating either, so a
      // rejected trade leaves coins and stock exactly as they were (the atomic-or-nothing rule the
      // engine's narration-only path relied on, now enforced by the one writer). The price is passed
      // in (content is out of the reducer's reach); the reducer owns possession + affordability.
      const pc = model.entities.get(cmd.pcId);
      const vendor = model.entities.get(cmd.vendorId);
      if (!pc?.stats) return reject(cmd, `entity ${cmd.pcId} has no stats`);
      if (!vendor?.stats) return reject(cmd, `entity ${cmd.vendorId} cannot hold items`);
      if (!Number.isInteger(cmd.priceCp) || cmd.priceCp < 0) {
        return reject(cmd, `trade price must be a non-negative integer, got ${cmd.priceCp}`);
      }
      const buying = cmd.direction === "buy";
      const seller = buying ? vendor : pc;
      const buyer = buying ? pc : vendor;
      if (!seller.stats!.inventory.includes(cmd.itemId)) {
        return reject(cmd, `${seller.id} does not hold ${cmd.itemId}`);
      }
      if (buying && (pc.stats.coins ?? 0) < cmd.priceCp) {
        return reject(cmd, `${cmd.pcId} cannot afford ${cmd.itemId} (needs ${cmd.priceCp})`);
      }
      // Move ONE instance (multiset stacks — the transferItem precedent), vacating a slot the last
      // copy occupied on the source side so nothing stays equipped-but-unheld.
      const deltas: EmittedDelta[] = [{ kind: "itemTransferred", itemId: cmd.itemId, from: seller.id, to: buyer.id }];
      const remaining = [...seller.stats!.inventory];
      remaining.splice(remaining.indexOf(cmd.itemId), 1);
      seller.stats!.inventory = remaining;
      if (seller.stats!.equipped && !remaining.includes(cmd.itemId)) {
        const vacated = (Object.keys(seller.stats!.equipped) as EquipSlot[]).filter(
          (slot) => seller.stats!.equipped?.[slot] === cmd.itemId,
        );
        if (vacated.length > 0) {
          const equipped = { ...seller.stats!.equipped };
          for (const slot of vacated) delete equipped[slot];
          seller.stats!.equipped = equipped;
          deltas.push({ kind: "equipmentChanged", entityId: seller.id, equipped: { ...equipped } });
        }
      }
      buyer.stats!.inventory = [...buyer.stats!.inventory, cmd.itemId];
      // Coin flow is the PC's only — the vendor's purse is bottomless by design. Emit the ABSOLUTE
      // post-balance so replay folds idempotently (the adjustCoins precedent).
      const before = pc.stats.coins ?? 0;
      const after = Math.max(0, buying ? before - cmd.priceCp : before + cmd.priceCp);
      if (after !== before) {
        pc.stats.coins = after;
        deltas.push({ kind: "coinsChanged", entityId: pc.id, coins: after });
      }
      return ok(deltas);
    }

    case "setExitState": {
      const verdict = exitVerdict(model, cmd.locationId, cmd.to);
      if (!verdict) return reject(cmd, `no exit from ${cmd.locationId} to ${cmd.to}`);
      const deltas: EmittedDelta[] = [];
      if (verdict.state !== cmd.state) {
        applyExitStateKey(model, cmd.locationId, cmd.to, cmd.state);
        deltas.push({ kind: "exitStateChanged", locationId: cmd.locationId, to: cmd.to, state: cmd.state });
      }
      // Mirror onto the reverse exit when one exists: a door is ONE object seen from two sides,
      // so unlocking it never strands the party behind a still-locked far side. Each changed
      // direction rides its own absolute delta (replay folds them independently, in lockstep).
      const reverse = exitsFrom(model.map, cmd.to).find((e) => e.to === cmd.locationId);
      if (reverse && effectiveExitState(model, cmd.to, reverse) !== cmd.state) {
        applyExitStateKey(model, cmd.to, cmd.locationId, cmd.state);
        deltas.push({ kind: "exitStateChanged", locationId: cmd.to, to: cmd.locationId, state: cmd.state });
      }
      if (deltas.length === 0) return noop;
      return ok(deltas);
    }

    case "adjustEnergy": {
      const e = model.entities.get(cmd.entityId);
      if (!e?.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      if (!Number.isInteger(cmd.by)) return reject(cmd, `energy adjustment must be an integer, got ${cmd.by}`);
      const max = maxEnergyOf(e.stats);
      const from = e.stats.energy ?? max; // absent = full (pre-energy saves wake rested)
      const to = clamp(from + cmd.by, 0, max);
      // No-op when nothing changes — including a raise while the field is absent (absent = full):
      // the key stays absent, so a pre-energy save is never materialized by a no-op command.
      if (to === from) return noop;
      e.stats.energy = to;
      return ok([{ kind: "energyChanged", entityId: e.id, energy: to }]);
    }

    case "adjustExhaustion": {
      const e = model.entities.get(cmd.entityId);
      if (!e?.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      if (!Number.isInteger(cmd.by)) {
        return reject(cmd, `exhaustion adjustment must be an integer, got ${cmd.by}`);
      }
      const from = e.stats.exhaustion ?? 0; // absent = fresh (pre-exhaustion saves)
      const to = clamp(from + cmd.by, 0, EXHAUSTION_MAX);
      // No-op at absent 0 stays absent, matching adjustEnergy's old-save materialization rule.
      if (to === from) return noop;
      e.stats.exhaustion = to;
      return ok([{ kind: "exhaustionChanged", entityId: e.id, exhaustion: to }]);
    }

    case "adjustRelationship": {
      const prev = relScore(model, cmd.actorId, cmd.targetId);
      const value = clamp(prev + cmd.by, -100, 100);
      if (value === prev) return noop;
      let row = model.relationships.get(cmd.actorId);
      if (!row) {
        row = new Map();
        model.relationships.set(cmd.actorId, row);
      }
      row.set(cmd.targetId, value);
      return ok([
        { kind: "relationshipChanged", actorId: cmd.actorId, targetId: cmd.targetId, value, by: value - prev },
      ]);
    }

    case "adjustFactionStanding": {
      if (!Number.isFinite(cmd.by)) return reject(cmd, `faction standing adjustment must be finite, got ${cmd.by}`);
      const slice = moduleSlice(model, "factionStanding") as { byPc?: Record<string, Record<string, number>> };
      const byPc = (slice.byPc ??= {});
      const row = (byPc[cmd.pcId] ??= {});
      const prev = row[cmd.factionId] ?? 0;
      const value = clamp(prev + cmd.by, -100, 100);
      if (value === prev) return noop;
      row[cmd.factionId] = value;
      return ok([
        { kind: "factionStandingChanged", pcId: cmd.pcId, factionId: cmd.factionId, value, by: value - prev },
      ]);
    }

    case "grantXp": {
      if (!Number.isFinite(cmd.by) || cmd.by <= 0) return noop;
      const slice = moduleSlice(model, PROGRESSION_MODULE) as ProgressionSlice;
      const before = progressionOf(model.modules, cmd.entityId, cmd.baseLevel);
      const result = applyXpGain(before, cmd.by);
      slice[cmd.entityId] = result.next;
      const deltas: EmittedDelta[] = [
        { kind: "modulePatched", module: PROGRESSION_MODULE, patch: { [cmd.entityId]: result.next } },
      ];
      // A level-up raises maxHp (a real, live stat) and heals the same amount, so the freshly-earned
      // hit points are immediately usable. maxHp is re-derived from this slice in `fromGameState`, so
      // the bump survives reload; currentHp persists in GameState.actors.
      if (result.hpGain > 0) {
        const e = model.entities.get(cmd.entityId);
        if (e?.stats) {
          const from = e.stats.currentHp;
          e.stats.maxHp += result.hpGain;
          e.stats.currentHp = clamp(from + result.hpGain, 0, e.stats.maxHp);
          if (e.stats.currentHp !== from) deltas.push({ kind: "hpChanged", entityId: e.id, from, to: e.stats.currentHp });
        }
      }
      return ok(deltas);
    }

    case "learnSpell": {
      const slice = moduleSlice(model, PROGRESSION_MODULE) as ProgressionSlice;
      const before = progressionOf(model.modules, cmd.entityId, cmd.baseLevel);
      if (before.learned.includes(cmd.spellId)) return noop;
      // A study-credit acquisition MUST have a real, unspent credit — never mint the spell for free
      // by clamping a negative balance back to zero. Without a credit the command is a no-op (the
      // engine only sets `spendCredit` for the study surface, which it gates on `credits > 0`).
      if (cmd.spendCredit && before.credits < 1) return noop;
      const credits = cmd.spendCredit ? before.credits - 1 : before.credits;
      const next = { ...before, learned: [...before.learned, cmd.spellId], credits };
      slice[cmd.entityId] = next;
      return ok([{ kind: "modulePatched", module: PROGRESSION_MODULE, patch: { [cmd.entityId]: next } }]);
    }

    // --- Cases layer (mystery / collaborative deduction). Every writer replaces the whole per-case
    //     runtime with a fresh object and emits the generic `modulePatched` delta carrying that
    //     ABSOLUTE runtime, so replay folds verbatim; each is idempotent (a no-op when nothing moves)
    //     and clamped where a value has a band. The reducer stays content-free — the fact TEXT and the
    //     witness list are resolved by the enqueuer (`effectToCommand`, which holds the campaign). ---
    case "revealCaseFact": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const knownAlready = runtime.playerKnown.includes(cmd.factId);
      const npcState = { ...runtime.npcState };
      let witnessChanged = false;
      for (const witnessId of cmd.witnesses) {
        const s = npcCaseStateOf(runtime, witnessId);
        if (!s.learned.includes(cmd.factId)) {
          npcState[witnessId] = { ...s, learned: [...s.learned, cmd.factId] };
          witnessChanged = true;
        }
      }
      if (knownAlready && !witnessChanged) return noop;
      const next = {
        ...runtime,
        playerKnown: knownAlready ? runtime.playerKnown : [...runtime.playerKnown, cmd.factId],
        npcState,
      };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "npcLearnCaseFact": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const s = npcCaseStateOf(runtime, cmd.npcId);
      // Showing this NPC anything clears the whole hold-out: the grudge is about disclosure posture,
      // not one page. So a learn that only clears `withheld` still MUTATES — hence the widened
      // no-op guard. Invariant: `withheld ∩ learned = ∅`. (`revealCaseFact`'s witness path
      // deliberately does NOT clear it — the player did not choose to show them.)
      const held = (s.withheld ?? []).length > 0;
      if (s.learned.includes(cmd.factId) && !held) return noop;
      const nextNpc: NpcCaseState = {
        ...s,
        learned: s.learned.includes(cmd.factId) ? s.learned : [...s.learned, cmd.factId],
      };
      delete nextNpc.withheld;
      const next = { ...runtime, npcState: { ...runtime.npcState, [cmd.npcId]: nextNpc } };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "recordCaseWithhold": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const s = npcCaseStateOf(runtime, cmd.npcId);
      // Nothing to withhold from someone who has already been shown it.
      const shown = new Set(s.learned);
      const merged = unionStable(
        s.withheld ?? [],
        cmd.factIds.filter((id) => !shown.has(id)),
      ).slice(-WITHHELD_CAP);
      if (merged.length === (s.withheld ?? []).length) return noop;
      const next = {
        ...runtime,
        npcState: { ...runtime.npcState, [cmd.npcId]: { ...s, withheld: merged } },
      };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    // --- Exchanges & services (r8, the dealings ledger). ---
    case "recordExchange": {
      const slice = exchangesSlice(model);
      const record: ExchangeRecord = {
        ...cmd.record,
        lines: cmd.record.lines.map((l) => ({ ...l })),
        id: slice.nextId,
      };
      slice.nextId += 1;
      slice.records = [...slice.records, record].slice(-EXCHANGE_CAP);
      return ok([
        { kind: "modulePatched", module: EXCHANGES_MODULE, patch: { ...cloneExchangesSlice(slice) } },
      ]);
    }

    case "serviceBegin": {
      // ONE atomic strike of a service deal: fee leaves the purse, the serviced item (when the work
      // keeps it) moves into the NPC's custody, and the agreement is appended — all or nothing, so
      // no fee-without-agreement or item-without-record half-state can exist. This is the typed
      // answer to the r7 exploit where "sharpen it and name your price" resolved as a half-price
      // SALE of the item: a service NEVER pays the player.
      const a = cmd.agreement;
      const pc = model.entities.get(cmd.pcId);
      const npc = model.entities.get(a.npcId);
      if (!pc?.stats) return reject(cmd, `entity ${cmd.pcId} has no stats`);
      if (!Number.isInteger(a.feeCp) || a.feeCp < 0) {
        return reject(cmd, `service fee must be a non-negative integer, got ${a.feeCp}`);
      }
      if ((pc.stats.coins ?? 0) < a.feeCp) {
        return reject(cmd, `${cmd.pcId} cannot afford the ${a.feeCp}cp fee`);
      }
      if (a.custody) {
        if (!a.itemId) return reject(cmd, `custody agreement without an itemId`);
        if (!npc?.stats) return reject(cmd, `entity ${a.npcId} cannot hold items`);
        if (!pc.stats.inventory.includes(a.itemId)) {
          return reject(cmd, `${cmd.pcId} does not hold ${a.itemId}`);
        }
      }
      const slice = servicesSlice(model);
      if (slice.agreements.some((x) => x.id === a.id)) return reject(cmd, `duplicate agreement ${a.id}`);
      const deltas: EmittedDelta[] = [];
      if (a.feeCp > 0) {
        const after = (pc.stats.coins ?? 0) - a.feeCp;
        pc.stats.coins = after;
        deltas.push({ kind: "coinsChanged", entityId: pc.id, coins: after });
      }
      if (a.custody && a.itemId && npc?.stats) {
        // Move ONE instance into custody (multiset stacks — the transferItem precedent), vacating
        // any slot the last copy occupied so nothing stays equipped-but-unheld.
        deltas.push({ kind: "itemTransferred", itemId: a.itemId, from: pc.id, to: npc.id });
        const remaining = [...pc.stats.inventory];
        remaining.splice(remaining.indexOf(a.itemId), 1);
        pc.stats.inventory = remaining;
        if (pc.stats.equipped && !remaining.includes(a.itemId)) {
          const vacated = (Object.keys(pc.stats.equipped) as EquipSlot[]).filter(
            (slot) => pc.stats?.equipped?.[slot] === a.itemId,
          );
          if (vacated.length > 0) {
            const equipped = { ...pc.stats.equipped };
            for (const slot of vacated) delete equipped[slot];
            pc.stats.equipped = equipped;
            deltas.push({ kind: "equipmentChanged", entityId: pc.id, equipped: { ...equipped } });
          }
        }
        npc.stats.inventory = [...npc.stats.inventory, a.itemId];
      }
      slice.agreements = [...slice.agreements, { ...a, state: "active" }];
      deltas.push({ kind: "modulePatched", module: SERVICES_MODULE, patch: { ...cloneServicesSlice(slice) } });
      return ok(deltas);
    }

    case "serviceComplete": {
      const slice = servicesSlice(model);
      const a = slice.agreements.find((x) => x.id === cmd.agreementId);
      if (!a) return reject(cmd, `no agreement ${cmd.agreementId}`);
      if (a.state === "done") return noop;
      const deltas: EmittedDelta[] = [];
      if (a.custody && a.itemId) {
        const npc = model.entities.get(a.npcId);
        const pc = [...model.entities.values()].find((e) => e.kind === "pc");
        // The NPC may have lost the item (despawn/loot edge) — the agreement still closes; the
        // enqueuer narrates honestly from the deltas that DID happen.
        if (npc?.stats?.inventory.includes(a.itemId) && pc?.stats) {
          deltas.push({ kind: "itemTransferred", itemId: a.itemId, from: npc.id, to: pc.id });
          const remaining = [...npc.stats.inventory];
          remaining.splice(remaining.indexOf(a.itemId), 1);
          npc.stats.inventory = remaining;
          pc.stats.inventory = [...pc.stats.inventory, a.itemId];
        }
      }
      slice.agreements = slice.agreements.map((x) => (x.id === cmd.agreementId ? { ...x, state: "done" as const } : x));
      deltas.push({ kind: "modulePatched", module: SERVICES_MODULE, patch: { ...cloneServicesSlice(slice) } });
      return ok(deltas);
    }

    case "recordDeal": {
      // §2.2 — one struck agreement becomes a row. The terms are normalized (collapsed, capped) so
      // the dedup key is stable, and an equivalent OPEN deal between the same parties is a NO-OP:
      // a haggle that takes three turns to settle is one bargain, and the classifier reports what
      // each LINE settles. Capture only — the reducer never judges whether terms were met.
      const slice = dealsSlice(model);
      const terms = normalizeTerms(cmd.deal.terms);
      if (!terms) return reject(cmd, "a deal needs terms");
      if (hasEquivalentOpenDeal(slice, cmd.deal.parties, terms)) return noop;
      const deal: Deal = {
        ...cmd.deal,
        terms,
        parties: [...cmd.deal.parties],
        partyNames: [...cmd.deal.partyNames],
        id: slice.nextId,
      };
      slice.nextId += 1;
      slice.records = [...slice.records, deal].slice(-DEALS_CAP);
      return ok([{ kind: "modulePatched", module: DEALS_MODULE, patch: { ...cloneDealsSlice(slice) } }]);
    }

    case "setDealState": {
      const slice = dealsSlice(model);
      const deal = slice.records.find((d) => d.id === cmd.dealId);
      if (!deal) return reject(cmd, `no deal ${cmd.dealId}`);
      if (deal.state === cmd.state) return noop;
      slice.records = slice.records.map((d) =>
        d.id === cmd.dealId
          ? { ...d, state: cmd.state, closedAtClock: cmd.state === "open" ? null : cmd.atClock }
          : d,
      );
      return ok([{ kind: "modulePatched", module: DEALS_MODULE, patch: { ...cloneDealsSlice(slice) } }]);
    }

    case "npcDropCaseBelief": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const s = npcCaseStateOf(runtime, cmd.npcId);
      if (s.dropped.includes(cmd.beliefId)) return noop;
      const next = {
        ...runtime,
        npcState: { ...runtime.npcState, [cmd.npcId]: { ...s, dropped: [...s.dropped, cmd.beliefId] } },
      };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "markCaseFactShared": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const s = npcCaseStateOf(runtime, cmd.npcId);
      const alreadyTold = s.toldPlayer.includes(cmd.factId);
      // Advance the share clock even when re-voicing a known fact (it is the cooldown clock), but
      // stay a no-op when neither the ledger nor the clock would actually move.
      if (alreadyTold && s.lastShareClock === model.clock) return noop;
      const next = {
        ...runtime,
        npcState: {
          ...runtime.npcState,
          [cmd.npcId]: {
            ...s,
            toldPlayer: alreadyTold ? s.toldPlayer : [...s.toldPlayer, cmd.factId],
            lastShareClock: model.clock,
          },
        },
      };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "recordCaseClaim": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const next = { ...runtime, claims: pushClaim(runtime.claims, cmd.claim) };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "adjustCaseCredibility": {
      if (cmd.by === 0) return noop;
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const s = npcCaseStateOf(runtime, cmd.npcId);
      const credibility = clampCredibility(s.credibility + cmd.by);
      if (credibility === s.credibility) return noop;
      const next = {
        ...runtime,
        npcState: { ...runtime.npcState, [cmd.npcId]: { ...s, credibility } },
      };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "resolveCase": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      if (runtime.status === cmd.status) return noop;
      const next = { ...runtime, status: cmd.status };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "recordWrongAccusation": {
      const slice = casesSlice(model);
      const runtime = slice[cmd.caseId] ?? defaultCaseRuntime();
      const next = { ...runtime, wrongAccusations: runtime.wrongAccusations + 1 };
      slice[cmd.caseId] = next;
      return ok([{ kind: "modulePatched", module: CASES_MODULE, patch: { [cmd.caseId]: next } }]);
    }

    case "setQuestState": {
      const prev = model.quests.get(cmd.questId);
      if (prev === cmd.state) return noop;
      // A quest the player has TAKEN can never be un-taken by a later write (playtest 07-24 P0: a
      // re-entry beat lacking a questState guard re-offered an accepted quest, and everything derived
      // from quest state — the read-only quest view, the leader's goal hint, every NPC brief — followed it
      // back to day one). The guard is deliberately NARROW so the real backward edges survive:
      // declining an offer (offered→hidden, engine.resolveQuestAction), failing a taken quest
      // (active→failed, quest-flow fail beats + case loss). Only "already taken/settled → back on the
      // table" is refused, with `complete` fully terminal.
      const TAKEN = new Set(["active", "complete", "failed"]);
      const UNTAKEN = new Set(["offered", "hidden"]);
      if (prev && (TAKEN.has(prev) && UNTAKEN.has(cmd.state))) {
        return reject(cmd, `quest ${cmd.questId} is ${prev}; it cannot regress to ${cmd.state}`);
      }
      if (prev === "complete") return reject(cmd, `quest ${cmd.questId} is complete; that is terminal`);
      model.quests.set(cmd.questId, cmd.state);
      return ok([{ kind: "questStateChanged", questId: cmd.questId, state: cmd.state }]);
    }

    case "setObjectiveDone": {
      const slice = moduleSlice(model, "objectives") as Record<string, Record<string, boolean>>;
      const quest = (slice[cmd.questId] ??= {});
      if (quest[cmd.objectiveId] === cmd.done) return noop;
      quest[cmd.objectiveId] = cmd.done;
      return ok([
        { kind: "objectiveChanged", questId: cmd.questId, objectiveId: cmd.objectiveId, done: cmd.done },
      ]);
    }

    case "advanceClock": {
      if (cmd.by === 0) return noop;
      model.clock += cmd.by;
      return ok([{ kind: "clockAdvanced", by: cmd.by, to: model.clock }]);
    }

    case "setFlag": {
      if (cmd.scope === "entity") {
        const e = cmd.entityId ? model.entities.get(cmd.entityId) : undefined;
        if (!e) return reject(cmd, `unknown entity ${cmd.entityId ?? "(none)"}`);
        e.flags[cmd.key] = cmd.value;
      } else {
        model.flags[cmd.key] = cmd.value;
      }
      return ok([{ kind: "flagSet", scope: cmd.scope, entityId: cmd.entityId, key: cmd.key, value: cmd.value }]);
    }

    case "modulePatch": {
      const slice = moduleSlice(model, cmd.module);
      Object.assign(slice, cmd.patch);
      return ok([{ kind: "modulePatched", module: cmd.module, patch: cmd.patch }]);
    }

    case "escalateWardrobeCoverage": {
      if (!model.entities.has(cmd.entityId)) return reject(cmd, `unknown entity ${cmd.entityId}`);
      if (!isWardrobeSlotState(cmd.state)) return reject(cmd, `invalid wardrobe slot state ${String(cmd.state)}`);
      const wardrobe = (model.modules[WARDROBE_MODULE] as WardrobeSlice | undefined) ?? {};
      const current = wardrobe[cmd.entityId] ?? {};
      const escalated = escalateCoverageRow(current, cmd.state);
      const changed = (Object.keys(escalated) as WardrobeSlotId[]).some(
        (slotId) => current[slotId] !== escalated[slotId],
      );
      if (!changed) return noop;
      // Keep accessory slots verbatim while the coverage band is monotone-merged. Reuse the generic
      // module delta so replay remains unchanged and carries the absolute post-state row.
      return applyCommandUnchecked(model, {
        type: "modulePatch",
        module: WARDROBE_MODULE,
        patch: { [cmd.entityId]: { ...current, ...escalated } },
      });
    }

    case "applyStatusEffect": {
      const e = model.entities.get(cmd.entityId);
      if (!e?.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      if (cmd.effect.kind.trim().length === 0) return reject(cmd, "status effect kind is required");
      if (!Number.isInteger(cmd.effect.turnsRemaining) || cmd.effect.turnsRemaining <= 0) {
        return reject(cmd, `status effect duration must be a positive integer, got ${cmd.effect.turnsRemaining}`);
      }
      const mods = cmd.effect.mods;
      if (mods.check !== undefined && typeof mods.check !== "number") return reject(cmd, `status effect mods.check must be a number, got ${typeof mods.check}`);
      if (mods.attack !== undefined && typeof mods.attack !== "number") return reject(cmd, `status effect mods.attack must be a number, got ${typeof mods.attack}`);
      if (mods.ac !== undefined && typeof mods.ac !== "number") return reject(cmd, `status effect mods.ac must be a number, got ${typeof mods.ac}`);
      if (mods.energy !== undefined && typeof mods.energy !== "number") return reject(cmd, `status effect mods.energy must be a number, got ${typeof mods.energy}`);
      if (mods.disadvantage !== undefined && typeof mods.disadvantage !== "boolean") return reject(cmd, `status effect mods.disadvantage must be a boolean, got ${typeof mods.disadvantage}`);
      const slice = statusEffectSlice(model);
      const next = cloneStatusEffectSlice(slice);
      const effects = next.active[cmd.entityId] ?? [];
      effects.push(cloneStatusEffect(cmd.effect));
      next.active[cmd.entityId] = effects;
      return ok(
        applySequence(model, [
          { type: "setCondition", entityId: cmd.entityId, condition: cmd.effect.kind, active: true },
          { type: "modulePatch", module: "statusEffects", patch: { active: cloneStatusEffectSlice(next).active } },
        ]),
      );
    }

    case "recordNpcMemory": {
      // Append one beat, then cap to NPC_MEMORY_CAP keeping the highest-salience (ties → more recent),
      // in chronological order — the cap lives ONLY here, so the matching delta carries the resulting
      // ABSOLUTE journal and replay just overwrites it (no replay re-derivation).
      const slice = npcMemorySlice(model);
      const journal = [...(slice.entries[cmd.npcId] ?? []), cloneEntry(cmd.entry)];
      const capped = capJournal(journal, NPC_MEMORY_CAP);
      slice.entries[cmd.npcId] = capped;
      return ok([{ kind: "npcMemoryRecorded", npcId: cmd.npcId, entries: capped.map(cloneEntry) }]);
    }

    case "clearNpcMemory": {
      const slice = npcMemorySlice(model);
      if (slice.entries[cmd.npcId] === undefined) return noop;
      delete slice.entries[cmd.npcId];
      return ok([{ kind: "npcMemoryCleared", npcId: cmd.npcId }]);
    }

    case "learnFact": {
      // Record one learned canonical fact for one NPC. Re-learning only ever RAISES certainty
      // (a rumor confirmed firsthand upgrades; hearing a rumor about a thing you saw is a noop),
      // and the per-NPC cap lives ONLY here — the delta carries the absolute post-cap map so
      // replay just overwrites it. `learnedAt` is model.clock: deterministic, replay-safe.
      const slice = npcKnowledgeSlice(model);
      const own = slice.learned[cmd.npcId] ?? {};
      const prev = own[cmd.factId];
      if (prev && !certaintyUpgrades(prev.certainty, cmd.certainty)) return noop;
      const next = {
        ...own,
        [cmd.factId]: {
          factId: cmd.factId,
          certainty: cmd.certainty,
          sourceKind: cmd.sourceKind,
          ...(cmd.sourceId !== undefined ? { sourceId: cmd.sourceId } : {}),
          // An upgrade keeps the ORIGINAL learning moment; only a brand-new fact stamps now.
          learnedAt: prev?.learnedAt ?? model.clock,
        },
      };
      const capped = capLearned(next, NPC_LEARNED_CAP);
      slice.learned[cmd.npcId] = capped;
      return ok([
        {
          kind: "npcFactLearned",
          npcId: cmd.npcId,
          learned: Object.fromEntries(Object.entries(capped).map(([id, f]) => [id, cloneLearned(f)])),
        },
      ]);
    }

    case "setPartyMembership": {
      // Membership is mechanically neutral: the flag flips, with no disposition, relationship, or
      // personality rewrite. Agenda logic treats the entity exactly like any other NPC.
      const e = model.entities.get(cmd.entityId);
      if (!e) return reject(cmd, `unknown entity ${cmd.entityId}`);
      if (e.kind !== "npc" && e.kind !== "pc") {
        return reject(cmd, `entity ${cmd.entityId} is a ${e.kind} — only NPCs and PCs hold party membership`);
      }
      if (!e.stats) return reject(cmd, `entity ${cmd.entityId} has no stats`);
      const slice = partySlice(model);
      // Leaving also clears the member's denied-leave bookkeeping and, if they led, resets the
      // leadership to the default (null ⇒ the PC leads) — one atomic, replayable unit.
      const clearsPending = !cmd.member && slice.pendingLeave[cmd.entityId] !== undefined;
      const dropsLeader = !cmd.member && slice.leaderId === cmd.entityId;
      if (e.partyMember === cmd.member && !clearsPending && !dropsLeader) return noop;
      e.partyMember = cmd.member;
      if (clearsPending) delete slice.pendingLeave[cmd.entityId];
      if (dropsLeader) slice.leaderId = null;
      return ok([
        { kind: "partyMembershipChanged", entityId: e.id, member: cmd.member, party: clonePartySlice(slice) },
      ]);
    }

    case "setPartyLeader": {
      const slice = partySlice(model);
      if (cmd.entityId !== null) {
        const e = model.entities.get(cmd.entityId);
        if (!e) return reject(cmd, `unknown entity ${cmd.entityId}`);
        // Any current member may lead; the PC may also (re)take the reins explicitly — null
        // already means "the PC leads by default", so this is the named-PC equivalent.
        if (!e.partyMember && e.kind !== "pc") {
          return reject(cmd, `entity ${cmd.entityId} is not a party member`);
        }
      }
      if (slice.leaderId === cmd.entityId) return noop;
      slice.leaderId = cmd.entityId;
      return ok([{ kind: "partyLeaderChanged", party: clonePartySlice(slice) }]);
    }

    case "beginCaptivity": {
      // The bad-end MATERIALIZES here: the player is really taken. Reads live state a static effect
      // list can't (the gear to confiscate, the party to scatter), so it is ONE compound command.
      const pc = model.entities.get(cmd.pcId);
      if (!pc?.stats) return reject(cmd, `captive ${cmd.pcId} has no stats`);
      if (readCaptivitySlice(model).active) return reject(cmd, "already captive"); // never nest a capture
      const cfg = CAPTIVITY_CONFIG[cmd.kind];
      const captor = cmd.captorId ? model.entities.get(cmd.captorId) : undefined;
      const returnLocationId = pc.locationId;
      // Snapshot gear + party BEFORE any mutation, so the slice records exactly what to give back.
      const strippedItems = [...pc.stats.inventory];
      const droppedMemberIds = [...model.entities.values()]
        .filter((e) => e.partyMember && e.id !== pc.id)
        .map((e) => e.id);
      const sub: Command[] = [];
      // Confiscate every carried item to nowhere (held in the slice, given back on release). transferItem
      // auto-vacates any slot the last copy occupied — the PC is disarmed as well as emptied.
      for (const itemId of strippedItems) sub.push({ type: "transferItem", itemId, from: pc.id, to: null });
      // Isolate: the scattered party leaves (re-admitted on release) — a captive is taken ALONE.
      for (const id of droppedMemberIds) sub.push({ type: "setPartyMembership", entityId: id, member: false });
      sub.push({ type: "setCondition", entityId: pc.id, condition: "captive", active: true });
      // Into the locked, exit-less hold (teleport past its missing exit, like Camp).
      sub.push({ type: "moveEntity", entityId: pc.id, to: CAPTIVITY_LOCATION_ID, teleport: true });
      // Pin the captor: move them into the hold and promote them so the whole arc has a live,
      // co-located keeper the culling maintenance will not reap.
      let captorOriginLoc: string | null = null;
      let captorWasTier: string | null = null;
      if (captor) {
        captorOriginLoc = captor.locationId;
        captorWasTier = captor.tier;
        if (captor.tier !== "significant") sub.push({ type: "setEntityTier", entityId: captor.id, tier: "significant" });
        sub.push({ type: "moveEntity", entityId: captor.id, to: CAPTIVITY_LOCATION_ID, teleport: true });
        sub.push({ type: "adjustRelationship", actorId: pc.id, targetId: captor.id, by: -30 });
      }
      const slice: CaptivitySlice = {
        active: true,
        kind: cmd.kind,
        captorId: cmd.captorId,
        captorName: captor?.name ?? cfg.keeper,
        captorOriginLoc,
        captorWasTier,
        returnLocationId,
        strippedItems,
        droppedMemberIds,
        escapeDc: cfg.escapeDc,
        progress: 0,
        goal: cfg.goal,
        day: 1,
        enteredClock: model.clock,
      };
      sub.push({ type: "modulePatch", module: "captivity", patch: { ...slice } });
      // The strip is TOTAL (every carried garment confiscated), so the attire truth follows. The
      // dedicated command preserves accessory slots and enforces the automatic-writer invariant:
      // every coverage slot can only stay put or become more undressed.
      sub.push({ type: "escalateWardrobeCoverage", entityId: pc.id, state: "removed" });
      return ok(applySequence(model, sub));
    }

    case "endCaptivity": {
      const slice = readCaptivitySlice(model);
      if (!slice.active) return noop;
      const pc = playerEntity(model);
      const sub: Command[] = [];
      // Return the player to where they were taken (teleport past the hold's missing exit).
      if (pc && slice.returnLocationId) {
        sub.push({ type: "moveEntity", entityId: pc.id, to: slice.returnLocationId, teleport: true });
      }
      if (pc) sub.push({ type: "setCondition", entityId: pc.id, condition: "captive", active: false });
      // Give back the confiscated gear (into the pack — the player re-equips). Served/freed/escaped all
      // return it for now; forfeiting a tithe on a run is a future refinement.
      if (pc) for (const itemId of slice.strippedItems) sub.push({ type: "transferItem", itemId, from: null, to: pc.id });
      // Redress with the returned garments (a fresh default row = everything worn) — release never
      // walks the player out still reading bare; getting dressed is the assumed off-screen beat.
      if (pc) sub.push({ type: "modulePatch", module: WARDROBE_MODULE, patch: { [pc.id]: {} } });
      // Re-admit the scattered party (those still in the world).
      for (const id of slice.droppedMemberIds) {
        if (model.entities.has(id)) sub.push({ type: "setPartyMembership", entityId: id, member: true });
      }
      // Send the captor back to their post + restore their tier (they were promoted for the arc).
      if (slice.captorId) {
        const captor = model.entities.get(slice.captorId);
        if (captor) {
          if (slice.captorOriginLoc) {
            sub.push({ type: "moveEntity", entityId: captor.id, to: slice.captorOriginLoc, teleport: true });
          }
          if (slice.captorWasTier && captor.tier !== slice.captorWasTier) {
            sub.push({ type: "setEntityTier", entityId: captor.id, tier: slice.captorWasTier as EntityTier });
          }
        }
      }
      if (cmd.outcome === "escaped" || cmd.outcome === "served") {
        sub.push({ type: "setFlag", scope: "world", key: `endured-${slice.kind}`, value: true });
      }
      // Reset the slice to the inactive default (explicit falsy keys so Object.assign clears everything).
      sub.push({ type: "modulePatch", module: "captivity", patch: { ...defaultCaptivitySlice() } });
      return ok(applySequence(model, sub));
    }

    case "recordLeaveDenied": {
      const e = model.entities.get(cmd.entityId);
      if (!e) return reject(cmd, `unknown entity ${cmd.entityId}`);
      if (!e.partyMember) return reject(cmd, `entity ${cmd.entityId} is not a party member`);
      const slice = partySlice(model);
      const prev = slice.pendingLeave[cmd.entityId];
      if (prev !== undefined && prev.deniedAtSeq === cmd.deniedAtSeq) return noop;
      // `deniedAtSeq` is recorded verbatim from the command (the enqueuer knows the turn seq) —
      // the reducer derives nothing, so replay reproduces the slice byte-for-byte.
      slice.pendingLeave[cmd.entityId] =
        cmd.deniedAtSeq !== undefined ? { deniedAtSeq: cmd.deniedAtSeq } : {};
      return ok([{ kind: "partyLeaveDenied", entityId: e.id, party: clonePartySlice(slice) }]);
    }

    case "enrichNpc": {
      // Transient→permanent promotion (Phase 2 Stage B). The command carries the FINISHED
      // template (composed module-side; any LLM prose already merged) so this stays pure and the
      // delta replays verbatim. Composition guarantees the pillar upstream: personality/morality
      // come from what the NPC already appears to be — the reducer just records.
      const e = model.entities.get(cmd.npcId);
      if (!e) return reject(cmd, `unknown entity ${cmd.npcId}`);
      if (e.kind !== "npc") {
        return reject(cmd, `entity ${cmd.npcId} is a ${e.kind} — only NPCs take enrichment templates`);
      }
      // The enriched template names THIS individual, so its id must be the ENTITY id (which then
      // becomes its templateId). Recording it under a shared authored template id would let one
      // spawned instance's enrichment overwrite the template every sibling entity — and every
      // reload — resolves from.
      if (cmd.template.id !== cmd.npcId) {
        return reject(cmd, `template id "${cmd.template.id}" must be "${cmd.npcId}" for ${cmd.npcId}`);
      }
      const recorded = enrichmentSlice(model).npcs[cmd.npcId];
      // Deep-equality via JSON: templates are plain zod-parsed data and repeats come from the
      // same deterministic composer (or the recorded slice itself), so key order is stable.
      const sameTemplate = recorded !== undefined && JSON.stringify(recorded) === JSON.stringify(cmd.template);
      // `promote: false` (the first-observation profile) records identity WITHOUT the tier bump.
      const promotes = cmd.promote !== false && e.tier !== "significant";
      if (sameTemplate && e.templateId === cmd.npcId && !promotes) return noop;
      const deltas: EmittedDelta[] = [];
      applyNpcEnrichment(model, cmd.npcId, cmd.template);
      deltas.push({ kind: "npcEnriched", npcId: cmd.npcId, template: structuredClone(cmd.template) });
      if (promotes) {
        // Significant ⇒ always simulated, never culled — the promotion half of the command. The
        // fold stays in lockstep because this rides its own tierChanged delta, emitted alongside.
        e.tier = "significant";
        deltas.push({ kind: "tierChanged", entityId: e.id, tier: "significant" });
      }
      return ok(deltas);
    }

    case "startCombat": {
      if (cmd.locationId.trim().length === 0) return reject(cmd, "combat locationId is required");
      if (cmd.order.length === 0) return reject(cmd, "combat order must include at least one combatant");
      const turnIndex = cmd.turnIndex ?? 0;
      const round = cmd.round ?? 1;
      if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= cmd.order.length) {
        return reject(cmd, `combat turnIndex ${turnIndex} is outside order`);
      }
      if (!Number.isInteger(round) || round < 1) return reject(cmd, `combat round must be >= 1, got ${round}`);

      const next: CombatEncounter = {
        active: true,
        locationId: cmd.locationId,
        order: [...cmd.order],
        allies: [...(cmd.allies ?? [])],
        turnIndex,
        round,
      };
      const current = combatSlice(model);
      if (current.active) {
        return combatEncounterEqual(current, next) ? noop : reject(cmd, "combat is already active");
      }
      const slice = overwriteCombatSlice(model, next);
      return ok([{ kind: "combatStarted", encounter: cloneCombatEncounter(slice) }]);
    }

    case "joinCombat": {
      const slice = combatSlice(model);
      if (!slice.active) return reject(cmd, "no live encounter to join");
      if (slice.order.includes(cmd.entityId)) return noop;
      const entity = model.entities.get(cmd.entityId);
      if (!entity) return reject(cmd, `unknown combatant ${cmd.entityId}`);
      // A body is required: an entity with no stats reads as 0 HP to the turn loop, so it would
      // stand in the initiative order and never swing — the reported defect, with mechanical
      // backing. Refusing here keeps the fence's combatant list honest.
      if (!entity.stats) return reject(cmd, `${cmd.entityId} has no stats and cannot fight`);
      // Splice in AFTER the current turn: inserting at or before `turnIndex` would silently grant
      // or skip someone a turn, since the index is positional.
      const order = [...slice.order];
      order.splice(slice.turnIndex + 1, 0, cmd.entityId);
      const next: CombatEncounter = {
        ...cloneCombatEncounter(slice),
        order,
        allies: cmd.ally && !slice.allies.includes(cmd.entityId) ? [...slice.allies, cmd.entityId] : slice.allies,
      };
      const written = overwriteCombatSlice(model, next);
      return ok([{ kind: "combatJoined", encounter: cloneCombatEncounter(written) }]);
    }

    case "advanceTurn": {
      const slice = combatSlice(model);
      if (!slice.active || slice.order.length === 0) return noop;
      const nextIndex = slice.turnIndex + 1 >= slice.order.length ? 0 : slice.turnIndex + 1;
      slice.turnIndex = nextIndex;
      if (nextIndex === 0) slice.round += 1;
      return ok([{ kind: "combatTurnAdvanced", encounter: cloneCombatEncounter(slice) }]);
    }

    case "endCombat": {
      const current = combatSlice(model);
      const next = defaultCombatEncounter();
      if (combatEncounterEqual(current, next)) return noop;
      const slice = overwriteCombatSlice(model, next);
      return ok([{ kind: "combatEnded", encounter: cloneCombatEncounter(slice) }]);
    }

    case "expandWorld": {
      if (cmd.locations.length === 0) return reject(cmd, "expansion carries no locations");
      if (!cmd.viaExitTo.startsWith("frontier:")) {
        return reject(cmd, `viaExitTo "${cmd.viaExitTo}" is not a frontier id`);
      }
      const holder = model.map.exits.get(cmd.fromLocationId);
      if (!holder) return reject(cmd, `unknown expansion origin ${cmd.fromLocationId}`);
      // A pre-existing frontier exit is NO LONGER required. An authored frontier is RETARGETED to the
      // entrance; an open-world REACH (the origin named no frontier) has `applyExpansion` APPEND a
      // discovered origin→entrance edge. The origin must merely exist.
      const slice = moduleSlice(model, "expansion") as { pockets?: Record<string, unknown> };
      if (slice.pockets?.[cmd.viaExitTo]) return noop; // already expanded — idempotent
      const ids = new Set<string>();
      for (const loc of cmd.locations) {
        if (model.map.exits.has(loc.id) || ids.has(loc.id)) {
          return reject(cmd, `expansion location id "${loc.id}" collides`);
        }
        ids.add(loc.id);
      }
      const entrance = cmd.locations[0]?.id;
      if (!entrance) return reject(cmd, "expansion carries no entrance");
      applyExpansion(
        model,
        cmd.fromLocationId,
        cmd.viaExitTo,
        cmd.locations,
        cmd.realizedGazetteerId,
        cmd.emergentTown,
      );
      return ok([
        {
          kind: "worldExpanded",
          fromLocationId: cmd.fromLocationId,
          viaExitTo: cmd.viaExitTo,
          locations: structuredClone(cmd.locations),
          ...(cmd.realizedGazetteerId !== undefined ? { realizedGazetteerId: cmd.realizedGazetteerId } : {}),
          ...(cmd.emergentTown !== undefined ? { emergentTown: cmd.emergentTown } : {}),
        },
      ]);
    }

    case "linkExit": {
      const holder = model.map.exits.get(cmd.fromLocationId);
      if (!holder) return reject(cmd, `unknown link origin ${cmd.fromLocationId}`);
      if (!model.map.exits.has(cmd.to)) return reject(cmd, `unknown link target ${cmd.to}`);
      if (cmd.fromLocationId === cmd.to) return reject(cmd, "cannot link a location to itself");
      if (holder.some((e) => e.to === cmd.to)) return noop; // already reachable — idempotent
      applyLink(model, cmd.fromLocationId, cmd.to, cmd.name);
      return ok([{ kind: "exitLinked", fromLocationId: cmd.fromLocationId, to: cmd.to, name: cmd.name }]);
    }

    default:
      // The `Command` union makes `cmd` `never` here, so this arm is unreachable for well-typed
      // callers. It is the RUNTIME armor for data-driven effects (authored defeat-outcome tables) that
      // can carry a typo/unknown `type` the union never saw: without it the switch falls through and
      // returns `undefined`, and the engine crashes iterating `res.deltas`. Report it as a rejection
      // (mutates nothing) so a malformed effect degrades gracefully instead of killing the tick.
      return reject(cmd as Command, `unknown command type: ${String((cmd as { type?: unknown }).type)}`);
  }
}

/**
 * Why a body cannot pass from → to right now, or null when traversal is legal. Distinguishes a
 * missing exit ("no path") from a barred one ("locked"/"blocked") so the engine can narrate the
 * obstacle instead of pretending the way doesn't exist. Enforced here in the reducer, so the
 * player, NPCs, and the Director all obey the same physics.
 */
function traversalRejection(model: WorldModel, from: string, to: string): string | null {
  const verdict = exitVerdict(model, from, to);
  if (!verdict) return `no path from ${from} to ${to}`;
  if (verdict.state === "locked") return `the exit from ${from} to ${to} is locked`;
  if (verdict.state === "blocked") return `the exit from ${from} to ${to} is blocked`;
  return null;
}

/**
 * The one shared exit-state overlay write (reducer + replay call this, so they cannot drift):
 * record the ABSOLUTE runtime state for one directed exit key. The reverse-exit mirror is the
 * REDUCER's decision (it emits one delta per changed direction); replay just folds each delta
 * through here verbatim.
 */
export function applyExitStateKey(
  model: WorldModel,
  locationId: string,
  to: string,
  state: ExitRuntimeState,
): void {
  exitStateSlice(model).states[exitKey(locationId, to)] = state;
}

/**
 * The one shared expansion mutation (reducer + replay call this, so they cannot drift): install
 * each generated location's exits into the map, retarget the consumed frontier exit at the
 * pocket's entrance, and record the pocket — including which gazetteer entry its terminal room
 * realized, if any (Phase 4) — in the durable `expansion` module slice.
 */
export function applyExpansion(
  model: WorldModel,
  fromLocationId: string,
  viaExitTo: string,
  locations: Location[],
  realizedGazetteerId?: string,
  emergentTown?: EmergentTown,
): void {
  const entrance = locations[0]?.id;
  for (const loc of locations) {
    model.map.exits.set(loc.id, structuredClone(loc.exits));
  }
  if (entrance) {
    const originExits = model.map.exits.get(fromLocationId) ?? [];
    // Authored frontier: RETARGET the consumed `frontier:` exit onto the entrance. Open-world REACH:
    // the origin owned no such exit, so APPEND a discovered origin→entrance edge (name from the
    // entrance's own display name — deterministic, so replay derives it identically). Idempotent: a
    // second fold finds the exit already pointing at the entrance and appends nothing.
    let retargeted = false;
    for (const exit of originExits) {
      if (exit.to === viaExitTo) {
        exit.to = entrance;
        retargeted = true;
      }
    }
    if (!retargeted && !originExits.some((e) => e.to === entrance)) {
      originExits.push({
        to: entrance,
        name: `to ${locations[0]?.name ?? entrance}`,
        locked: false,
        hidden: false,
      });
      model.map.exits.set(fromLocationId, originExits);
    }
    // Migrate any exit-state overlay recorded against the consumed frontier id (a barred
    // frontier exit unlocked before expansion) onto the retargeted destination — shared by
    // reducer AND replay, so the fold cannot orphan the key. Only a retarget could have carried a
    // key under the old frontier id; an appended reach never had one.
    if (retargeted) {
      const overlay = model.modules.exitState as { states?: Record<string, string> } | undefined;
      const oldKey = exitKey(fromLocationId, viaExitTo);
      const carried = overlay?.states?.[oldKey];
      if (carried !== undefined && overlay?.states) {
        delete overlay.states[oldKey];
        overlay.states[exitKey(fromLocationId, entrance)] = carried;
      }
    }
  }
  const slice = moduleSlice(model, "expansion") as {
    pockets?: Record<
      string,
      {
        fromLocationId: string;
        locations: Location[];
        realizedGazetteerId?: string;
        emergentTown?: EmergentTown;
      }
    >;
  };
  const pockets = (slice.pockets ??= {});
  pockets[viaExitTo] = {
    fromLocationId,
    locations: structuredClone(locations),
    ...(realizedGazetteerId !== undefined ? { realizedGazetteerId } : {}),
    ...(emergentTown !== undefined ? { emergentTown } : {}),
  };
}

/**
 * The one shared reuse-link mutation (reducer + replay call this, so they cannot drift): append a
 * discovered `to <name>` exit from `fromLocationId` into the EXISTING location `to`, and record the
 * edge in the durable `expansion` slice (`links`) so a reload's `hydrateExpansions` rebuilds the same
 * edge from the target's name. Idempotent — a pre-existing edge to `to` is left untouched. `name` is
 * the target's display name (the reducer has no world content to look it up), carried on the delta so
 * replay reconstructs the label verbatim.
 */
export function applyLink(model: WorldModel, fromLocationId: string, to: string, name: string): void {
  const exits = model.map.exits.get(fromLocationId);
  if (exits && !exits.some((e) => e.to === to)) {
    exits.push({ to, name: `to ${name}`, locked: false, hidden: false });
  }
  const slice = moduleSlice(model, "expansion") as {
    links?: Array<{ fromLocationId: string; to: string }>;
  };
  const links = (slice.links ??= []);
  if (!links.some((l) => l.fromLocationId === fromLocationId && l.to === to)) {
    links.push({ fromLocationId, to });
  }
}

/** The durable enrichment slice (src/world/enrichment.ts EnrichmentSlice), defaulted on first touch. */
function enrichmentSlice(model: WorldModel): { npcs: Record<string, NpcTemplate> } {
  const slice = moduleSlice(model, "enrichment") as { npcs?: Record<string, NpcTemplate> };
  slice.npcs ??= {};
  return slice as { npcs: Record<string, NpcTemplate> };
}

/**
 * The one shared enrichment mutation (reducer + replay call this, so they cannot drift): the
 * enriched template BACKS this entity from now on, so its templateId is retargeted at the
 * template's id (the entity's own id — the reducer validated it), and the FULL template is
 * recorded in the durable `enrichment` module slice — the record `hydrateEnrichments()`
 * (src/world/enrichment.ts) rebuilds the `world.npcs` content mirror from on load. Every content
 * lookup (`templateId ?? id`) then resolves the enriched template, never the shared authored one
 * a spawned instance came from. The tier promotion is NOT here: it rides its own `tierChanged`
 * delta, which the reducer emits alongside `npcEnriched`.
 */
export function applyNpcEnrichment(model: WorldModel, npcId: string, template: NpcTemplate): void {
  const e = model.entities.get(npcId);
  if (e) e.templateId = template.id;
  enrichmentSlice(model).npcs[npcId] = structuredClone(template);
}
