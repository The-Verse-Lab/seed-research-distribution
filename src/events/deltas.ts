/**
 * DeltaEvent — authoritative, replayable state mutations.
 *
 * Unlike StateChangedEvent (narration prose for humans), deltas are structured facts emitted
 * by the reducer — the single mutation chokepoint — and persisted through the same kind-
 * agnostic event log. Together they make the durable log a true replayable history while the
 * snapshot stays a load-time cache (Decision D3). They are part of the GameEvent /
 * EmittedEvent unions and flow through the bus untouched (it stamps id/at/seq generically).
 *
 * @author Runkai Zhang
 */
import type { BaseEvent } from "./types.ts";
import type { Location, NpcTemplate } from "../content/schema.ts";
import type { EntityKind, EntityStats, EntityTier, Equipped } from "../world/entity.ts";
import type { ExitRuntimeState } from "../rules/exit-state.ts";
import type { NpcMemoryEntry } from "../rules/npc-memory.ts";
import type { NpcLearnedFact } from "../rules/npc-knowledge.ts";
import type { EmergentTown } from "../world/commands.ts";
import type { PartySlice } from "../rules/party.ts";
import type { CombatEncounter } from "../rules/combat-state.ts";

export interface EntityMovedDelta extends BaseEvent {
  kind: "entityMoved";
  entityId: string;
  from: string | null;
  to: string | null;
}

export interface EntitySpawnedDelta extends BaseEvent {
  kind: "entitySpawned";
  entityId: string;
  entityKind: EntityKind;
  /** Carried in full so the entity can be recreated exactly on replay (Decision D3). */
  name: string;
  templateId?: string;
  locationId: string | null;
  tier: EntityTier;
  /** Present iff the spawned entity has a body; replay restores it verbatim. */
  stats?: EntityStats;
}

export interface EntityDespawnedDelta extends BaseEvent {
  kind: "entityDespawned";
  entityId: string;
}

export interface TierChangedDelta extends BaseEvent {
  kind: "tierChanged";
  entityId: string;
  tier: EntityTier;
}

export interface HpChangedDelta extends BaseEvent {
  kind: "hpChanged";
  entityId: string;
  from: number;
  to: number;
}

export interface ConditionChangedDelta extends BaseEvent {
  kind: "conditionChanged";
  entityId: string;
  condition: string;
  active: boolean;
}

export interface ItemTransferredDelta extends BaseEvent {
  kind: "itemTransferred";
  itemId: string;
  from: string | null;
  to: string | null;
}

export interface CoinsChangedDelta extends BaseEvent {
  kind: "coinsChanged";
  entityId: string;
  /** Absolute post-adjust balance in copper pieces (already clamped ≥ 0) — fold writes it verbatim. */
  coins: number;
}

export interface EquipmentChangedDelta extends BaseEvent {
  kind: "equipmentChanged";
  entityId: string;
  /** The FULL post-change slot record (absent slots are empty) — fold OVERWRITES with it. */
  equipped: Equipped;
}

/**
 * One directed exit's runtime state changed (Workstream H). ABSOLUTE post-state for that exit
 * key — fold writes `exitState.states["locationId->to"]` verbatim. A mirrored reverse-exit
 * change rides its own delta (the reducer emits one per changed direction).
 */
export interface ExitStateChangedDelta extends BaseEvent {
  kind: "exitStateChanged";
  locationId: string;
  to: string;
  state: ExitRuntimeState;
}

export interface EnergyChangedDelta extends BaseEvent {
  kind: "energyChanged";
  entityId: string;
  /** Absolute post-adjust energy (already clamped to [0, maxEnergy]) — fold writes it verbatim. */
  energy: number;
}

export interface ExhaustionChangedDelta extends BaseEvent {
  kind: "exhaustionChanged";
  entityId: string;
  /** Absolute post-adjust exhaustion level (already clamped to [0,6]) — fold writes it verbatim. */
  exhaustion: number;
}

export interface RelationshipChangedDelta extends BaseEvent {
  kind: "relationshipChanged";
  /** Whose feeling changed (the holder of the score). */
  actorId: string;
  /** Toward whom. */
  targetId: string;
  value: number;
  by: number;
}

export interface FactionStandingChangedDelta extends BaseEvent {
  kind: "factionStandingChanged";
  /** Whose standing changed (the PC holding the score). */
  pcId: string;
  /** Toward which faction. */
  factionId: string;
  /** Absolute post-adjust standing, clamped to −100..100 — fold writes it verbatim. */
  value: number;
  /** Effective applied delta after clamping. */
  by: number;
}

export interface QuestStateChangedDelta extends BaseEvent {
  kind: "questStateChanged";
  questId: string;
  state: "hidden" | "offered" | "active" | "complete" | "failed";
}

export interface ObjectiveChangedDelta extends BaseEvent {
  kind: "objectiveChanged";
  questId: string;
  objectiveId: string;
  done: boolean;
}

export interface ClockAdvancedDelta extends BaseEvent {
  kind: "clockAdvanced";
  by: number;
  to: number;
}

export interface FlagSetDelta extends BaseEvent {
  kind: "flagSet";
  scope: "world" | "entity";
  entityId?: string;
  key: string;
  value: unknown;
}

export interface ModulePatchedDelta extends BaseEvent {
  kind: "modulePatched";
  module: string;
  patch: Record<string, unknown>;
}

// --- NPC-memory deltas (M4 Part B). Carry ABSOLUTE post-state so `applyDelta` is idempotent-safe. ---

export interface NpcMemoryRecordedDelta extends BaseEvent {
  kind: "npcMemoryRecorded";
  npcId: string;
  /** The NPC's FULL journal AFTER the append + cap — fold OVERWRITES with it (not a per-beat append). */
  entries: NpcMemoryEntry[];
}

export interface NpcMemoryClearedDelta extends BaseEvent {
  kind: "npcMemoryCleared";
  /** Whose journal was cleared (absolute post-state: their entries become absent). */
  npcId: string;
}

/** Learned canonical knowledge (epistemic plan §7.6). Absolute post-cap map — fold OVERWRITES. */
export interface NpcFactLearnedDelta extends BaseEvent {
  kind: "npcFactLearned";
  npcId: string;
  /** The NPC's FULL learned map AFTER the write + cap (factId → record). */
  learned: Record<string, NpcLearnedFact>;
}

// --- Party deltas (Phase 2). Each carries the FULL absolute post-state slice. ---

export interface PartyMembershipChangedDelta extends BaseEvent {
  kind: "partyMembershipChanged";
  entityId: string;
  /** The entity's post-change `partyMember` flag — fold writes it verbatim. */
  member: boolean;
  /** The FULL post-change party slice (leader reset / cleared pendingLeave included) — fold OVERWRITES with it. */
  party: PartySlice;
}

export interface PartyLeaderChangedDelta extends BaseEvent {
  kind: "partyLeaderChanged";
  /** The FULL post-change party slice (`leaderId` null ⇒ the PC leads by default) — fold OVERWRITES with it. */
  party: PartySlice;
}

export interface PartyLeaveDeniedDelta extends BaseEvent {
  kind: "partyLeaveDenied";
  /** The member whose leave request was refused (clearing rides `partyMembershipChanged`). */
  entityId: string;
  /** The FULL post-change party slice — fold OVERWRITES with it. */
  party: PartySlice;
}

/**
 * A runtime NPC was promoted to a permanent, fully-templated fixture (Phase 2 Stage B). Carries
 * the FULL composed template — replay re-records it verbatim (LLM-free), and load-time
 * `hydrateEnrichments()` rebuilds the `world.npcs` content mirror from the recorded slice. The
 * accompanying tier promotion rides its own `tierChanged` delta (the reducer emits both).
 */
export interface NpcEnrichedDelta extends BaseEvent {
  kind: "npcEnriched";
  npcId: string;
  template: NpcTemplate;
}

// --- Combat deltas (M3). Each carries the FULL absolute post-state encounter. ---

export interface CombatStartedDelta extends BaseEvent {
  kind: "combatStarted";
  /** Active encounter after start — fold overwrites the combat slice verbatim. */
  encounter: CombatEncounter;
}

export interface CombatTurnAdvancedDelta extends BaseEvent {
  kind: "combatTurnAdvanced";
  /** Encounter after advancing turn/round — absolute, never an increment. */
  encounter: CombatEncounter;
}

export interface CombatJoinedDelta extends BaseEvent {
  kind: "combatJoined";
  /** Encounter after the joiner was spliced in — absolute, like every combat delta. */
  encounter: CombatEncounter;
}

export interface CombatEndedDelta extends BaseEvent {
  kind: "combatEnded";
  /** Inactive default encounter after cleanup — absolute post-state. */
  encounter: CombatEncounter;
}

/**
 * Explore-time map growth: a `frontier:` exit was consumed and a generated pocket of locations
 * now exists behind it. Carries the FULL generated content, so replay reconstructs the map (and
 * the expansion slice) verbatim with no re-generation.
 */
export interface WorldExpandedDelta extends BaseEvent {
  kind: "worldExpanded";
  fromLocationId: string;
  /** The consumed frontier id (the exit's former `to`). */
  viaExitTo: string;
  locations: Location[];
  /**
   * The gazetteer entry this pocket's TERMINAL room realizes (Phase 4, additive) — the rumored
   * place became a real location. Folded into the `expansion` slice by the same shared
   * `applyExpansion` the reducer used, so replay restores realization state verbatim.
   */
  realizedGazetteerId?: string;
  /**
   * A surprise EMERGENT town this pocket minted (map system, additive) — a settlement not in the
   * gazetteer. Same shared `applyExpansion` folds it into the expansion slice, so replay restores it
   * verbatim. Absent on every pre-map expansion, so the delta shape is byte-identical without it.
   */
  emergentTown?: EmergentTown;
}

/**
 * Explore-time REUSE: a discovered direct exit was wired from `fromLocationId` into an EXISTING
 * location `to` ("go back to the tavern"). Carries the target's display `name` (the reducer has no
 * world content to look it up), so replay reconstructs the `to <name>` edge verbatim (LLM-free) with
 * no new content and no duplicate place.
 */
export interface ExitLinkedDelta extends BaseEvent {
  kind: "exitLinked";
  fromLocationId: string;
  to: string;
  /** The target location's display name — the exit's label is `to <name>`. */
  name: string;
}

export type DeltaEvent =
  | EntityMovedDelta
  | EntitySpawnedDelta
  | EntityDespawnedDelta
  | TierChangedDelta
  | HpChangedDelta
  | ConditionChangedDelta
  | ItemTransferredDelta
  | CoinsChangedDelta
  | EquipmentChangedDelta
  | ExitStateChangedDelta
  | EnergyChangedDelta
  | ExhaustionChangedDelta
  | RelationshipChangedDelta
  | FactionStandingChangedDelta
  | QuestStateChangedDelta
  | ObjectiveChangedDelta
  | ClockAdvancedDelta
  | FlagSetDelta
  | ModulePatchedDelta
  | NpcMemoryRecordedDelta
  | NpcMemoryClearedDelta
  | NpcFactLearnedDelta
  | PartyMembershipChangedDelta
  | PartyLeaderChangedDelta
  | PartyLeaveDeniedDelta
  | NpcEnrichedDelta
  | CombatStartedDelta
  | CombatTurnAdvancedDelta
  | CombatJoinedDelta
  | CombatEndedDelta
  | WorldExpandedDelta
  | ExitLinkedDelta;

export type DeltaEventKind = DeltaEvent["kind"];

/** A delta before the bus assigns id/at/seq (what the pure reducer returns). */
type Pre<E extends BaseEvent> = Omit<E, keyof BaseEvent>;

export type EmittedDelta =
  | Pre<EntityMovedDelta>
  | Pre<EntitySpawnedDelta>
  | Pre<EntityDespawnedDelta>
  | Pre<TierChangedDelta>
  | Pre<HpChangedDelta>
  | Pre<ConditionChangedDelta>
  | Pre<ItemTransferredDelta>
  | Pre<CoinsChangedDelta>
  | Pre<EquipmentChangedDelta>
  | Pre<ExitStateChangedDelta>
  | Pre<EnergyChangedDelta>
  | Pre<ExhaustionChangedDelta>
  | Pre<RelationshipChangedDelta>
  | Pre<FactionStandingChangedDelta>
  | Pre<QuestStateChangedDelta>
  | Pre<ObjectiveChangedDelta>
  | Pre<ClockAdvancedDelta>
  | Pre<FlagSetDelta>
  | Pre<ModulePatchedDelta>
  | Pre<NpcMemoryRecordedDelta>
  | Pre<NpcMemoryClearedDelta>
  | Pre<NpcFactLearnedDelta>
  | Pre<PartyMembershipChangedDelta>
  | Pre<PartyLeaderChangedDelta>
  | Pre<PartyLeaveDeniedDelta>
  | Pre<NpcEnrichedDelta>
  | Pre<CombatStartedDelta>
  | Pre<CombatTurnAdvancedDelta>
  | Pre<CombatJoinedDelta>
  | Pre<CombatEndedDelta>
  | Pre<WorldExpandedDelta>
  | Pre<ExitLinkedDelta>;
