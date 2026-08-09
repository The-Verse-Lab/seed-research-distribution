/**
 * WorldView — a pure, read-only façade over the live session.
 *
 * Phase 0 of the world-model migration. The content↔state joins that answer "who / what /
 * where" — name lookups, presence filters, exit resolution, HP banding — were duplicated
 * across the narrator-context builder, the classifier-context builder, and the CLI. They are
 * unified here so there is exactly one place that resolves them, ahead of a WorldModel
 * becoming the single source of truth.
 *
 * This adapter reads today's GameState + content unchanged (no behavior change): every method
 * returns what the old inline join returned, byte-for-byte. Later phases repoint these
 * internals (e.g. partyLocationId() becomes derived in Phase 2) without touching call sites.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Location, World } from "../content/schema.ts";
import type { DisclosureStore } from "../memory/disclosure-store.ts";
import type { GameState } from "../state/types.ts";
import type { Entity, EntityStats } from "./entity.ts";
import { exitStateTag } from "../rules/exit-state.ts";
import { readRoutinesSlice } from "../rules/routine.ts";
import { activeStatusKinds } from "../rules/status-effects.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "./model.ts";
import { exitsFrom as mapExitsFrom } from "./map.ts";
import { frontierExpansionEnabled, isFrontierId } from "./expansion.ts";
import { effectiveExitState } from "./traversal.ts";
import type { CombatEncounter } from "../rules/combat-state.ts";
import type { Command } from "./commands.ts";
import type { PresentEntity } from "../agents/context.ts";
import type { SafetyCharacter } from "../safety/minor.ts";

/**
 * One resolved view of the party's current location. Narration builds several neighboring context
 * blocks from the same location; carrying this snapshot between them avoids repeating the registry
 * scans (and guarantees every block describes the same resolved place).
 */
export interface ModelLocationSnapshot {
  locationId: string | null;
  entities: Entity[];
}

export function modelLocationSnapshot(model: WorldModel): ModelLocationSnapshot {
  const locationId = partyLocationOf(model);
  return { locationId, entities: locationId === null ? [] : entitiesAt(model, locationId) };
}

/** Facts already voiced by NPCs present in a resolved location, deduplicated in encounter order. */
export function establishedFactsAt(
  model: WorldModel,
  disclosure: Pick<DisclosureStore, "get"> | undefined,
  snapshot: ModelLocationSnapshot = modelLocationSnapshot(model),
): string[] | undefined {
  if (!disclosure || snapshot.locationId === null) return undefined;
  const facts = snapshot.entities.filter((e) => e.kind === "npc").flatMap((e) => disclosure.get(e.id));
  return facts.length > 0 ? [...new Set(facts)] : undefined;
}

/**
 * Resolve the minor-safety facts (age / isMinor) for an entity id by joining the live model with
 * content: a PC's age comes from the campaign sheet, an NPC's from its world template (looked up by
 * the entity's templateId). The single home for this join — the engine's safety-context gatherer and
 * guarded generation paths call it, so the minor-protection input cannot drift between them.
 */
export function safetyCharacterOf(
  model: WorldModel,
  world: World,
  campaign: Campaign,
  id: string,
): SafetyCharacter {
  const ent = model.entities.get(id);
  const pc = campaign.characters.find((c) => c.id === id);
  const npc = world.npcs.find((n) => n.id === (ent?.templateId ?? id));
  return {
    id,
    name: ent?.name,
    age: pc?.age ?? npc?.age,
    isMinor: pc?.isMinor ?? npc?.isMinor,
    ageIsAdult: pc?.ageIsAdult ?? npc?.ageIsAdult,
  };
}

/** A resolved id → display-name pair (exits, present entities). */
export interface EntityRef {
  id: string;
  name: string;
}

/** Coarse HP band so the narrator never sees raw mechanical HP. "" when max is unknown. */
export function hpBandOf(stats: EntityStats | undefined): string {
  if (!stats || stats.maxHp <= 0) return "";
  if (stats.currentHp <= 0) return "down";
  const ratio = stats.currentHp / stats.maxHp;
  if (ratio > 0.75) return "unhurt";
  if (ratio > 0.25) return "wounded";
  return "bloodied";
}

/**
 * Coarse danger cue for a hostile creature measured against the PLAYER's ceiling — the difficulty
 * telegraph the r2 playtest asked for (a 50 HP / AC 17 wraith ambushed an 8 HP level-1 after a
 * maximally cautious approach, with nothing distinguishing it from scenery). Bands only, never
 * numbers: the narrator weaves it as menace, the client shows a chip. "" = no special cue.
 */
export function threatBandOf(foe: EntityStats | undefined, pc: EntityStats | undefined): string {
  if (!foe || !pc || pc.maxHp <= 0 || foe.maxHp <= 0) return "";
  const ratio = foe.maxHp / pc.maxHp;
  if (ratio >= 3) return "far beyond your strength";
  if (ratio >= 1.5) return "a dangerous foe";
  return "";
}

/**
 * Presence rows for the narrator, sourced from the WorldModel registry — the same set the
 * classifier sees: authored location NPCs, spawned transients, and moved tracked NPCs, minus
 * the player. Summary comes from the entity's template; the band from its live stats.
 */
export function modelPresence(
  model: WorldModel,
  world: World,
  snapshot: ModelLocationSnapshot = modelLocationSnapshot(model),
): PresentEntity[] {
  if (snapshot.locationId === null) return [];
  const playerId = playerEntity(model)?.id;
  // Routine activity annotation ("tending the bar") — a pure copy-read; absent slice ⇒ empty
  // records ⇒ no `activity` keys ⇒ schedule-less briefs render byte-identically.
  const routines = readRoutinesSlice(model.modules);
  const out: PresentEntity[] = [];
  for (const e of snapshot.entities) {
    if (e.id === playerId) continue;
    // A downed stat-bearing FOE is a corpse — keep it out of the brief's `Present:` line so the
    // narrator doesn't reintroduce the thing the party just felled. A downed PARTY MEMBER is NOT a
    // corpse: it lies unconscious at the party's feet and must stay present (band "down" + the
    // `unconscious` condition), or the brief mislabels a co-located ally "elsewhere" and reports the
    // player travelling ALONE (audit #7). Statless authored NPCs (no `stats`) are never "downed".
    if (e.stats && e.stats.currentHp <= 0 && !e.partyMember) continue;
    const tpl = world.npcs.find((n) => n.id === (e.templateId ?? e.id));
    // Danger telegraph — MONSTERS only (a exploitative NPC's menace is authored subtext; flagging it
    // would leak intent the player is meant to read socially). Omit-when-empty keeps monster-less
    // scenes byte-identical.
    const threat =
      e.kind === "monster" && !e.partyMember
        ? threatBandOf(e.stats, playerId ? model.entities.get(playerId)?.stats : undefined)
        : "";
    // Party vs scenery, carried through to the brief (the fact lives on the very row we're iterating,
    // it was simply never copied before). `local` = ambient background: a transient, non-exploitative
    // person spawned by ambient-life (culled on the next move). A foe/monster or an authored `tracked`/
    // `significant` NPC is never `local` — only party membership and true crowd get a marker.
    const local = !e.partyMember && e.tier === "transient" && e.kind === "npc" && tpl?.exploitative !== true;
    out.push({
      id: e.id,
      name: e.name,
      summary: tpl?.summary || undefined,
      band: hpBandOf(e.stats) || undefined,
      sex: tpl?.sex || undefined,
      activeConditions: activeStatusKinds(model, e.id),
      ...(routines.activity[e.id] ? { activity: routines.activity[e.id] } : {}),
      ...(e.partyMember ? { partyMember: true } : {}),
      ...(local ? { local: true } : {}),
      ...(threat ? { threat } : {}),
      // The held look (r6 P2): authored appearance/description, re-asserted every turn so the same
      // person keeps the same face. Appearance wins; an authored description is the fallback.
      ...((tpl?.appearance || tpl?.description) ? { looks: (tpl.appearance || tpl.description)!.trim() } : {}),
    });
  }
  return out;
}

/**
 * Exit display names for the narrator, sourced from the WorldModel map with hidden exits
 * filtered out (matching the classifier). `locationName` resolves an exit's destination id.
 * A barred exit carries its state tag (" (locked)" / " (blocked)" / " (broken open)") so the
 * narrator sees the obstacle; a world with no barriers renders byte-identically to before
 * (every tag is the empty string).
 */
export function modelExits(
  model: WorldModel,
  locationName: (id: string) => string,
  snapshot: ModelLocationSnapshot = modelLocationSnapshot(model),
  frontierEnabled = true,
): string[] {
  const locationId = snapshot.locationId;
  if (locationId === null) return [];
  return mapExitsFrom(model.map, locationId)
    .filter((e) => !e.hidden && (frontierEnabled || !isFrontierId(e.to)))
    .map((e) => `${e.name ?? locationName(e.to)}${exitStateTag(effectiveExitState(model, locationId, e))}`);
}

/**
 * Living companions (non-PC party members) co-located with the PC right now. The ONE definition of
 * "the PC is accompanied", shared by the `partyAlone` event condition (Phase 2) and the opportunity
 * amplifier's `unaccompanied` read (Phase 3) — a downed companion cannot deter or witness, so the
 * count is of the living only. Pure model read.
 */
export function livingCompanionsWithPc(model: WorldModel): number {
  // One registry pass per threat and turn: collect the PC and the living
  // companions' locations together, then count the co-located ones.
  let pcLoc: string | null | undefined;
  const companionLocs: (string | null)[] = [];
  for (const e of model.entities.values()) {
    if (!e.partyMember) continue;
    if (e.kind === "pc") {
      if (pcLoc === undefined) pcLoc = e.locationId;
      continue;
    }
    if (e.stats && e.stats.currentHp <= 0) continue;
    companionLocs.push(e.locationId);
  }
  if (pcLoc === undefined) return 0;
  let count = 0;
  for (const loc of companionLocs) if (loc === pcLoc) count++;
  return count;
}

/**
 * Whether the world ever introduces this NPC BY NAME — i.e. it stands on some location's roster.
 *
 * Ambient crowd and spawn-only templates ("Undercroft Shadow", "Coast Farmhand") are scenery the
 * player has never been told the name of. They can be neither an addressee, nor an errand subject,
 * nor a name the canon registry needs to protect — listing them would tell the narrator that a
 * generic label is an established person.
 *
 * ONE definition, shared: the engine's absent-addressee grounding and the brief's canon-name
 * registry both key on it, and two copies of "is this a real name" would drift.
 */
export function isRosteredNpc(world: Pick<World, "locations">, npc: { id: string; name?: string }): boolean {
  return !!npc.name && world.locations.some((l) => l.npcs.includes(npc.id));
}

/** Is a turn-based combat encounter active? Pure read over `model.modules.combat`. */
export function isCombatActive(model: WorldModel): boolean {
  const combat = model.modules.combat as Partial<CombatEncounter> | undefined;
  return combat?.active === true;
}

/**
 * A combat encounter is opening THIS tick — enqueued by an earlier react-phase module but not yet
 * committed. `isCombatActive` only sees committed state, so a react module that runs after a travel
 * ambush (or a prebaked event) would otherwise miss the fight forming in the same pass and spawn a
 * crowd / open a rival scene into it. Downstream react modules read this to honor the same
 * combat/scene mutual-exclusion they already honor against committed combat.
 */
export function combatPendingInQueue(queue: readonly Command[]): boolean {
  return queue.some((c) => c.type === "startCombat");
}

export class WorldView {
  constructor(
    private readonly world: World,
    private readonly campaign: Campaign,
    private readonly state: GameState,
  ) {}

  /** The controlling player character's id. */
  get playerId(): string {
    return this.state.party[0] ?? "pc.you";
  }

  /**
   * Where the party currently is. Phase 0 returns the stored field verbatim; Phase 2
   * switches this to derive from the player's own position once movement crosses the
   * reducer — so call sites repointed here will not need to change again.
   */
  partyLocationId(): string {
    return this.state.partyLocationId;
  }

  /** A location by id, or the party's current location when id is omitted. */
  location(id: string = this.partyLocationId()): Location | undefined {
    return this.world.locations.find((l) => l.id === id);
  }

  /** Display name for any entity id (PC, then world NPC, then the id itself). */
  name(id: string): string {
    const pc = this.campaign.characters.find((c) => c.id === id);
    if (pc) return pc.name;
    const npc = this.world.npcs.find((n) => n.id === id);
    if (npc) return npc.name;
    return id;
  }

  /** Display name for a location id (falls back to the id). */
  locationName(id: string): string {
    return this.world.locations.find((l) => l.id === id)?.name ?? id;
  }

  /** Short GM-facing summary for a world NPC, or "" if none / not an NPC. */
  npcSummary(id: string): string {
    return this.world.npcs.find((n) => n.id === id)?.summary ?? "";
  }

  /** Max HP for an entity (PC sheet, else NPC stat block), if known. */
  maxHp(id: string): number | undefined {
    const pc = this.campaign.characters.find((c) => c.id === id);
    if (pc) return pc.stats.maxHp;
    return this.world.npcs.find((n) => n.id === id)?.stats?.maxHp;
  }

  /** Coarse HP band so the narrator never sees raw mechanical HP. "" when max is unknown. */
  hpBand(id: string): string {
    const max = this.maxHp(id);
    const current = this.state.actors[id]?.currentHp ?? 0;
    if (max === undefined || max <= 0) return "";
    if (current <= 0) return "down";
    const ratio = current / max;
    if (ratio > 0.75) return "unhurt";
    if (ratio > 0.25) return "wounded";
    return "bloodied";
  }

  /** Exits reachable from a location (id + display name), preserving authored order.
   * Reads first-class `exits` (hidden filtered) and falls back to legacy `connections`
   * for worlds that only author the old graph — matching the map/narrator view. */
  exitsFrom(locId: string = this.partyLocationId()): EntityRef[] {
    const loc = this.location(locId);
    if (!loc) return [];
    // A `frontier:` edge is dropped when expansion is disabled for the world (latent content), so the
    // CLI brief + context fallback never offer a crossing the engine will refuse. Byte-identical when
    // enabled (absent/true).
    const frontierOk = frontierExpansionEnabled(this.world);
    if (loc.exits.length > 0) {
      return loc.exits
        .filter((e) => !e.hidden && (frontierOk || !isFrontierId(e.to)))
        .map((e) => ({ id: e.to, name: e.name ?? this.locationName(e.to) }));
    }
    return loc.connections.map((id) => ({ id, name: this.locationName(id) }));
  }

  /** Party PCs + companions whose actor position is at the given location. */
  actorsAt(locId: string = this.partyLocationId()): string[] {
    return [...this.state.party, ...this.state.companions].filter(
      (id) => this.state.actors[id]?.locationId === locId,
    );
  }

  /** Companions whose actor position is at the given location. */
  companionsAt(locId: string = this.partyLocationId()): string[] {
    return this.state.companions.filter((id) => this.state.actors[id]?.locationId === locId);
  }

  /** The authored static NPC roster for a location (M1 hardcoded presence). */
  locationNpcs(locId: string = this.partyLocationId()): string[] {
    return this.location(locId)?.npcs ?? [];
  }

  /** Runtime relationship score a → b, if any has been recorded. */
  relationship(a: string, b: string): number | undefined {
    return this.state.relationships[a]?.[b];
  }
}
