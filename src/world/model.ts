/**
 * WorldModel — the single source of truth.
 *
 * One in-memory object owns all mutable truth; content (World/Campaign JSON) is seed +
 * immutable descriptive data only. The keystone is one entity registry. The model is mutated
 * exclusively by the reducer (src/world/reducer.ts).
 *
 * During the migration the engine still persists and hands the legacy `GameState` shape to
 * not-yet-ported consumers (viewer, narrator/classifier context). `fromGameState` seeds the
 * model; `toGameState` projects it back. The projection is pure and derived — never an
 * independent mutable copy — so there is exactly one writer. Phase 5 cuts persistence to the
 * model shape and deletes the legacy fields.
 *
 * @author Runkai Zhang
 */
import type { Campaign, World } from "../content/schema.ts";
import type { ActorRuntime, AuthoredNpcRuntime, AutonomyRuntime, GameState } from "../state/types.ts";
import type { Entity, EntityId, EntityKind, EntityTier } from "./entity.ts";
import type { WorldMap } from "./map.ts";
import { mapFromWorld } from "./map.ts";
import { progressionBonusHp, readProgressionSlice } from "../rules/progression.ts";

export type QuestState = "hidden" | "offered" | "active" | "complete" | "failed";

export interface WorldModel {
  campaignId: string;
  worldId: string;
  /** Minutes elapsed since the campaign began (becomes GameClock in Phase 4). */
  clock: number;
  entities: Map<EntityId, Entity>;
  map: WorldMap;
  quests: Map<string, QuestState>;
  /** Friendship: actorId → targetId → signed score. */
  relationships: Map<EntityId, Map<EntityId, number>>;
  /** Namespaced per-module runtime (autonomy bookkeeping, events cursor, …). */
  modules: Record<string, unknown>;
  flags: Record<string, unknown>;
}

/** The player character's entity (party-member PC, first by registry order), if any. */
export function playerEntity(model: WorldModel): Entity | undefined {
  for (const e of model.entities.values()) {
    if (e.kind === "pc" && e.partyMember) return e;
  }
  return undefined;
}

/** Every entity currently at a location — the presence query (replaces the hardcoded roster). */
export function entitiesAt(model: WorldModel, locId: string): Entity[] {
  const out: Entity[] = [];
  for (const e of model.entities.values()) if (e.locationId === locId) out.push(e);
  return out;
}

/** Where the party is — derived from the player's own position. */
export function partyLocationOf(model: WorldModel): string | null {
  const p = playerEntity(model);
  if (p) return p.locationId;
  // Fallback: any party member's location.
  for (const e of model.entities.values()) if (e.partyMember) return e.locationId;
  return null;
}

/** Seed a WorldModel from a legacy GameState + content (descriptive lookups). */
export function fromGameState(gs: GameState, world: World, campaign: Campaign): WorldModel {
  const entities = new Map<EntityId, Entity>();
  const partySet = new Set(gs.party);
  const companionSet = new Set(gs.companions);

  // Insert party PCs first (so registry order yields a player-first party), then companions,
  // then any remaining actors.
  const order = [
    ...gs.party,
    ...gs.companions,
    ...Object.keys(gs.actors).filter((id) => !partySet.has(id) && !companionSet.has(id)),
  ];
  // Earned advancement (persisted absolutely) re-derives the level-up HP bonus onto maxHp here, so a
  // reload restores the grown pool; currentHp itself is loaded verbatim from GameState.actors below.
  const progression = readProgressionSlice(gs.modules);
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const actor = gs.actors[id];
    if (!actor) continue;
    const pc = campaign.characters.find((c) => c.id === id);
    const npc = world.npcs.find((n) => n.id === id);
    // Prefer identity persisted for a runtime-conjured spawn (no content row to look up); fall back to
    // content re-derivation for content-backed actors and legacy saves that predate it (audit #1).
    const kind: EntityKind = actor.kind ?? (pc ? "pc" : "npc");
    const partyMember = partySet.has(id) || companionSet.has(id);
    const tier: EntityTier = actor.tier ?? (partyMember ? "significant" : "tracked");
    // Prefer maxHp persisted for a conjured spawn (no content row); fall back to the content template
    // for content-backed actors, then to currentHp for legacy saves that predate the field (audit #1).
    const baseMaxHp = pc ? pc.stats.maxHp : actor.maxHp ?? npc?.stats?.maxHp ?? actor.currentHp;
    const baseLevel = pc?.stats.level ?? npc?.stats?.level ?? 1;
    const maxHp = baseMaxHp + progressionBonusHp(progression[id], baseLevel);
    entities.set(id, {
      id,
      kind,
      tier,
      name: actor.name ?? pc?.name ?? npc?.name ?? id,
      locationId: actor.locationId,
      templateId: actor.templateId ?? (npc ? npc.id : undefined),
      stats: {
        currentHp: actor.currentHp,
        maxHp,
        conditions: [...actor.conditions],
        inventory: [...actor.inventory],
        // Spread-in so pre-economy saves (no coins/equipped keys) seed byte-identical stats.
        ...(actor.coins !== undefined ? { coins: actor.coins } : {}),
        ...(actor.equipped ? { equipped: { ...actor.equipped } } : {}),
        // Same for pre-energy saves: an absent key reads as FULL (src/rules/costs.ts).
        ...(actor.energy !== undefined ? { energy: actor.energy } : {}),
        ...(actor.maxEnergy !== undefined ? { maxEnergy: actor.maxEnergy } : {}),
        ...(actor.exhaustion !== undefined ? { exhaustion: actor.exhaustion } : {}),
      },
      partyMember,
      flags: structuredClone(actor.flags ?? {}),
    });
  }

  const authoredNpcRuntime = gs.authoredNpcs;
  const seedStatlessNpc = (
    npcId: string,
    locationId: string,
    flags: Record<string, unknown>,
    tierOverride?: EntityTier,
  ) => {
    const npc = world.npcs.find((n) => n.id === npcId);
    // A template that carries goods (a vendor's stock, an armed NPC's sidearm) needs a body to
    // hold them: seed stats so the inventory lives on the registry row (transferItem rejects a
    // statless holder). Everyone else stays statless, exactly as before — pre-economy worlds
    // (no vendor/inventory fields) seed byte-identically. Once statted, the NPC persists via
    // GameState.actors, so a reload restores the LIVE stock (a bought item stays bought).
    const carriesGoods = !!npc && (npc.vendor !== undefined || npc.inventory.length > 0);
    entities.set(npcId, {
      id: npcId,
      kind: "npc",
      // Prefer the persisted tier of a runtime-spawned extra (a `transient` ambient body); fall back to
      // the content-derived tier for authored location NPCs and legacy saves (audit #13).
      tier: tierOverride ?? (npc?.autonomy.isPartyMember ? "significant" : "tracked"),
      name: npc?.name ?? npcId,
      locationId,
      templateId: npc?.id,
      ...(carriesGoods
        ? {
            stats: {
              currentHp: npc.stats?.maxHp ?? 10,
              maxHp: npc.stats?.maxHp ?? 10,
              conditions: [],
              inventory: [...npc.inventory],
            },
          }
        : {}),
      partyMember: false,
      flags: structuredClone(flags),
    });
  };

  // Seed authored location NPCs as registry rows at their location (so presence becomes a
  // position query, not a hardcoded roster). If the snapshot carries statless authored-NPC runtime,
  // prefer that over the content default; older snapshots omit it and keep the original fallback.
  for (const loc of world.locations) {
    for (const npcId of loc.npcs) {
      if (entities.has(npcId)) continue;
      const runtime = authoredNpcRuntime?.[npcId];
      seedStatlessNpc(npcId, runtime?.locationId ?? loc.id, runtime?.flags ?? {}, runtime?.tier);
    }
  }

  if (authoredNpcRuntime) {
    for (const [npcId, runtime] of Object.entries(authoredNpcRuntime)) {
      if (entities.has(npcId)) continue;
      seedStatlessNpc(npcId, runtime.locationId, runtime.flags, runtime.tier);
    }
  }

  const relationships = new Map<string, Map<string, number>>();
  for (const [a, m] of Object.entries(gs.relationships)) {
    relationships.set(a, new Map(Object.entries(m)));
  }
  return {
    campaignId: gs.campaignId,
    worldId: gs.worldId,
    clock: gs.clock,
    entities,
    map: mapFromWorld(world),
    quests: new Map(Object.entries(gs.quests)),
    relationships,
    // Phase-5 snapshots persist the full module runtime; older ones carry only autonomy.
    modules: gs.modules ? structuredClone(gs.modules) : { autonomy: structuredClone(gs.autonomy) },
    flags: structuredClone(gs.flags),
  };
}

/** Project the model back to the legacy GameState shape (pure; persistence + legacy reads). */
export function toGameState(model: WorldModel): GameState {
  const actors: Record<string, ActorRuntime> = {};
  const authoredNpcs: Record<string, AuthoredNpcRuntime> = {};
  const party: string[] = [];
  const companions: string[] = [];
  for (const e of model.entities.values()) {
    if (e.stats) {
      // A runtime-conjured spawn (id `template#n`, a monster, or an object) has no authored content
      // row for `fromGameState` to re-derive identity from — persist name/kind/tier/templateId so it
      // survives save/reload/rewind (audit #1). Content-backed PC/NPC rows (bare id, pc/npc kind)
      // re-derive as before and their projection stays byte-identical (no new keys).
      const conjured = e.kind === "monster" || e.kind === "object" || /#\d+$/.test(e.id);
      actors[e.id] = {
        id: e.id,
        currentHp: e.stats.currentHp,
        locationId: e.locationId ?? "",
        inventory: [...e.stats.inventory],
        conditions: [...e.stats.conditions],
        ...(conjured
          ? {
              name: e.name,
              kind: e.kind,
              tier: e.tier,
              maxHp: e.stats.maxHp,
              ...(e.templateId !== undefined ? { templateId: e.templateId } : {}),
            }
          : {}),
        // Spread-in so absent coins/equipped stay absent keys (JSON snapshots stay stable).
        ...(e.stats.coins !== undefined ? { coins: e.stats.coins } : {}),
        ...(e.stats.equipped ? { equipped: { ...e.stats.equipped } } : {}),
        ...(e.stats.energy !== undefined ? { energy: e.stats.energy } : {}),
        ...(e.stats.maxEnergy !== undefined ? { maxEnergy: e.stats.maxEnergy } : {}),
        ...(e.stats.exhaustion !== undefined ? { exhaustion: e.stats.exhaustion } : {}),
        ...(Object.keys(e.flags).length > 0 ? { flags: structuredClone(e.flags) } : {}),
      };
    } else if (e.kind === "npc") {
      authoredNpcs[e.id] = {
        locationId: e.locationId ?? "",
        flags: structuredClone(e.flags),
        // Persist the tier ONLY for a runtime-spawned transient extra so reload re-seeds it as transient
        // (culled by maintenance) instead of a permanent `tracked` fixture. Authored NPCs (tracked/
        // significant) omit it and stay byte-identical (audit #13).
        ...(e.tier === "transient" ? { tier: e.tier } : {}),
      };
    }
    if (e.partyMember) (e.kind === "pc" ? party : companions).push(e.id);
  }

  const relationships: Record<string, Record<string, number>> = {};
  for (const [a, m] of model.relationships) relationships[a] = Object.fromEntries(m);

  const autonomy = (model.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};

  return {
    campaignId: model.campaignId,
    worldId: model.worldId,
    partyLocationId: partyLocationOf(model) ?? "",
    clock: model.clock,
    party,
    companions,
    actors,
    authoredNpcs,
    quests: Object.fromEntries(model.quests) as GameState["quests"],
    relationships,
    autonomy: structuredClone(autonomy),
    modules: structuredClone(model.modules),
    flags: structuredClone(model.flags),
  };
}
