/** Relationship helpers for the signed Friendship score. */
import type { World } from "../content/schema.ts";
import { entitiesAt, type WorldModel } from "../world/model.ts";

export interface RelationshipProfile {
  /** The signed relationship score, exposed as Friendship. */
  friendship: number;
}

export const FRIENDSHIP_MIN = -100;
export const FRIENDSHIP_MAX = 100;

export function clampFriendship(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(FRIENDSHIP_MIN, Math.min(FRIENDSHIP_MAX, n));
}

export function relationshipProfile(model: WorldModel, actorId: string, targetId: string): RelationshipProfile {
  const friendship = clampFriendship(model.relationships.get(actorId)?.get(targetId) ?? 0);
  return { friendship };
}

export function relationshipProfileFromState(
  state: {
    relationships: Record<string, Record<string, number>>;
  },
  actorId: string,
  targetId: string,
): RelationshipProfile {
  const friendship = clampFriendship(state.relationships[actorId]?.[targetId] ?? 0);
  return { friendship };
}

export function renderRelationshipProfile(profile: RelationshipProfile): string {
  return `Friendship ${profile.friendship}/100`;
}

// ---------------------------------------------------------------------------
// Living relationships (proactive-NPC wave): organic warmth, conversation
// nudges, personality-baseline decay, and co-located faction propagation.
// All magnitudes are small and the reducer clamps −100..100 on apply.
// ---------------------------------------------------------------------------

/** Friendship a quest-giver gains toward the PC on completion. */
export const QUEST_GIVER_WARMTH = 8;
/** Friendship a surviving party-side NPC gains when the PC downs its enemy (per kill). */
export const COMBAT_ASSIST_WARMTH = 4;
/** Bounds on the warmth a gifted item earns the recipient. */
export const GIFT_WARMTH_MIN = 1;
export const GIFT_WARMTH_MAX = 5;
/** How much a co-located faction-mate cools toward the PC when the PC attacks one of them. */
export const FACTION_MATE_CHILL = 15;

/** Hard clamp on a single conversation-driven nudge the NPC's agent may propose. */
export const CONVO_NUDGE_MAX = 2;
/** Ceiling on cumulative friendship a PC may earn from ONE NPC through conversation alone. */
export const CHAT_FRIENDSHIP_CAP = 40;

/** Max step a relationship drifts toward its baseline per in-world day. */
export const DECAY_STEP = 2;
/** An NPC interacted-with within this many days is exempt from decay. */
export const DECAY_RECENT_DAYS = 2;

/** Clamp + round an agent-proposed conversation nudge to `[−MAX, +MAX]`; non-finite ⇒ 0. */
export function clampConvoNudge(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-CONVO_NUDGE_MAX, Math.min(CONVO_NUDGE_MAX, Math.round(n)));
}

/** Warmth a gifted item of the given copper value earns (~1 point / 25cp, clamped small). */
export function giftWarmth(valueCp: number): number {
  if (!Number.isFinite(valueCp) || valueCp <= 0) return GIFT_WARMTH_MIN;
  return Math.max(GIFT_WARMTH_MIN, Math.min(GIFT_WARMTH_MAX, Math.round(valueCp / 25)));
}

/** Move `current` toward `baseline` by at most `step`, never overshooting. Integer-preserving. */
export function driftToward(current: number, baseline: number, step: number): number {
  if (current === baseline) return current;
  const gap = baseline - current;
  const move = Math.sign(gap) * Math.min(Math.abs(gap), Math.max(0, step));
  return current + move;
}

/**
 * Persisted living-relationship runtime (`WorldModel.modules.relationshipMeta`). Written only
 * through the reducer's generic `modulePatch` (mirrors the routines slice); never `Entity.flags`.
 */
export interface RelationshipMetaSlice {
  /** npcId → pcId → cumulative friendship earned through conversation (cap enforcement). */
  chatEarned: Record<string, Record<string, number>>;
  /** npcId → pcId → last in-world day an interaction was logged (decay exemption). */
  lastInteractDay: Record<string, Record<string, number>>;
}

/**
 * Defaulting COPY-reader for the relationshipMeta slice (the `readRoutinesSlice` idiom). Never
 * stores the default back — a world that never touches it must serialize byte-identically.
 */
export function readRelationshipMeta(modules: Record<string, unknown> | undefined): RelationshipMetaSlice {
  const slice = modules?.relationshipMeta as Partial<RelationshipMetaSlice> | undefined;
  return {
    chatEarned: structuredClone(slice?.chatEarned ?? {}),
    lastInteractDay: structuredClone(slice?.lastInteractDay ?? {}),
  };
}

/** Base template id behind a spawn instance id (`tpl#3` → `tpl`). */
function baseTemplateId(id: string): string {
  return id.replace(/#\d+$/, "");
}

/**
 * The NPCs sharing the victim's faction who are present at the victim's location — the blast radius
 * for faction propagation when the PC attacks one of their own. Excludes the victim, the PC, and any
 * party member. Empty when the victim has no faction. Faction is read from the authored template
 * (matched by id, then by spawn base-id), never the runtime Entity.
 */
export function factionMatesPresent(
  model: WorldModel,
  world: World,
  victimId: string,
  pcId: string,
): string[] {
  const factionOf = (id: string): string | undefined =>
    world.npcs.find((n) => n.id === id)?.factionId ?? world.npcs.find((n) => n.id === baseTemplateId(id))?.factionId;
  const victimFaction = factionOf(victimId);
  if (!victimFaction) return [];
  const victim = model.entities.get(victimId);
  if (!victim?.locationId) return [];
  const out: string[] = [];
  for (const e of entitiesAt(model, victim.locationId)) {
    if (e.id === victimId || e.id === pcId || e.partyMember) continue;
    if (factionOf(e.id) === victimFaction) out.push(e.id);
  }
  return out;
}
