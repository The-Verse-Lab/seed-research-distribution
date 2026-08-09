/**
 * Entity — the unified registry row that replaces the four-way split of identity.
 *
 * PCs, companion NPCs, location NPCs, and transient extras are all `Entity` rows in the
 * WorldModel's one registry. Identity, position, party membership, and live stats are facts
 * ON the entity — not scattered across Campaign.characters / World.npcs / GameState.actors /
 * GameState.party. Descriptive data (persona, lore) stays in content, reached via templateId.
 *
 * @author Runkai Zhang
 */
export type EntityId = string;

export type EntityKind = "pc" | "npc" | "monster" | "object";

/**
 * The culling/persistence lever (docs/PROACTIVE-NPCS.md, the world-model revision):
 *  - transient   : spawned extras; never persisted; despawned when culled.
 *  - tracked     : named/important; position remembered; frozen (not simulated) when far.
 *  - significant : quest/party-critical; always simulated; never culled.
 */
export type EntityTier = "transient" | "tracked" | "significant";

/** The three equipment slots a body offers. */
export type EquipSlot = "weapon" | "armor" | "shield";

/** What's equipped, slot → held item id. Absent slots are empty. */
export type Equipped = Partial<Record<EquipSlot, string>>;

/** Live mechanical state for an entity that has a body (PCs, NPCs, monsters). */
export interface EntityStats {
  currentHp: number;
  maxHp: number;
  conditions: string[];
  /**
   * Item ids currently held (items stay template-id refs — Decision D4). A MULTISET: repeated
   * ids are stacks (two potions = the id twice), so transfers move exactly one instance.
   */
  inventory: string[];
  /** Copper pieces carried. Absent means 0 everywhere (older saves predate coins). */
  coins?: number;
  /** Equipped items (each must also be in `inventory`). Absent means nothing equipped. */
  equipped?: Equipped;
  /**
   * Waking stamina (Workstream H). Absent means FULL — older saves predate energy and must
   * wake rested, not exhausted (`energyOf` in src/rules/costs.ts folds the absence).
   */
  energy?: number;
  /** Energy ceiling. Absent means the DEFAULT_MAX_ENERGY constant (src/rules/costs.ts). */
  maxEnergy?: number;
  /** Persistent exhaustion ladder. Absent means 0 (fresh, pre-exhaustion saves). */
  exhaustion?: number;
}

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  tier: EntityTier;
  name: string;
  /** Single home for position — kills the partyLocationId/actors duplication. Null = nowhere. */
  locationId: string | null;
  /** Link to World.npcs / World.monsters for descriptive lookups. */
  templateId?: string;
  stats?: EntityStats;
  /** Party membership is a fact on the entity, not a separate array. */
  partyMember: boolean;
  flags: Record<string, unknown>;
}

/**
 * A clean player-facing label for an entity: its authored `name` with a trailing instance suffix
 * (`#\d+`, appended when several copies of the same template co-exist) stripped, never a raw id.
 * A statless/unnamed spawn with an empty name degrades to its id (also suffix-stripped) so the
 * player never sees a bare registry key like "npc.velvet-enforcer#0". Pure — no model access.
 */
export function displayName(entity: Pick<Entity, "id" | "name">): string {
  const stripSuffix = (s: string): string => s.replace(/#\d+$/, "");
  const named = entity.name.trim();
  return named.length > 0 ? stripSuffix(named) : stripSuffix(entity.id);
}

/**
 * Whether an entity is a CONJURED just-in-time spawn — a runtime INSTANCE (id `template#n`, minted by
 * `nextSpawnId`) rather than an authored, directly-placed entity (which carries a bare id). A
 * `significant` tier (party/quest-critical, even if it was once spawned) is never treated as "just
 * conjured". Used to decide whether a beaten transient threat is removed from the world model —
 * authored entities persist, while conjured ones may leave and vanish.
 * Pure — id + tier only, no model access.
 */
export function isConjuredSpawn(entity: Pick<Entity, "id" | "tier"> | undefined): boolean {
  return !!entity && entity.tier !== "significant" && /#\d+$/.test(entity.id);
}

/**
 * Whether an entity is awake enough to ACT on its own — the hard code gate for autonomy eligibility
 * (and mirrored by the direct-address reply paths), so a 0-HP / `unconscious` NPC that presence has
 * already dropped from the scene can never self-initiate dialogue, actions, or a leader proposal
 * (audit #5). A statless entity (no body) is always conscious. Pure — stats only, no model access.
 */
export function isConscious(entity: Pick<Entity, "stats"> | undefined): boolean {
  const s = entity?.stats;
  if (!s) return true;
  return s.currentHp > 0 && !s.conditions.includes("unconscious");
}
