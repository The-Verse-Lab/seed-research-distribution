/**
 * Authoritative runtime state of a play session.
 *
 * This is the source of truth the engine mutates and persists. It is distinct from
 * World/Campaign *content* (which is static, authored data): GameState is what changes
 * as you play — positions, HP, quest progress, and how NPCs currently *feel*.
 *
 * @author Runkai Zhang
 */
import type { Command } from "../world/commands.ts";
import type { EntityKind, EntityTier } from "../world/entity.ts";

/** Live state of a single actor (PC or companion NPC) in a session. */
export interface ActorRuntime {
  id: string;
  currentHp: number;
  locationId: string;
  /** Item ids currently held (a multiset — repeated ids are stacks). */
  inventory: string[];
  /** Active conditions (poisoned, prone, …). Free-form until M3. */
  conditions: string[];
  /** Copper pieces carried. Optional so pre-economy saves parse unchanged (absent = 0). */
  coins?: number;
  /** Equipped slot → held item id. Optional so pre-economy saves parse unchanged. */
  equipped?: { weapon?: string; armor?: string; shield?: string };
  /** Waking stamina. Optional so pre-energy saves parse unchanged (absent = FULL). */
  energy?: number;
  /** Energy ceiling. Optional; absent = the DEFAULT_MAX_ENERGY constant (src/rules/costs.ts). */
  maxEnergy?: number;
  /** Persistent exhaustion ladder. Optional so pre-exhaustion saves parse unchanged (absent = 0). */
  exhaustion?: number;
  /** Entity-scoped narrative flags. Optional so legacy/flagless actor rows remain byte-stable. */
  flags?: Record<string, unknown>;
  /**
   * Persisted identity for a runtime-CONJURED spawn (id `template#n`, a monster, or an object) that
   * has NO authored content row for `fromGameState` to re-derive from. Absent on content-backed
   * actors (PC / authored NPC, where identity re-derives from World/Campaign as before) and on legacy
   * saves — so old snapshots and ordinary actors stay byte-identical. Persisting these lets an
   * ambush/threat/frontier spawn survive save/reload/rewind with its display name, monster-vs-npc
   * kind (statBlock lookup), cull tier, and persona/lore template link intact (audit #1).
   */
  name?: string;
  kind?: EntityKind;
  tier?: EntityTier;
  templateId?: string;
  /**
   * HP ceiling of a conjured spawn. Persisted ALONGSIDE the identity above because a conjured monster
   * has no content row to re-derive it from: `fromGameState` looks up `world.npcs` by id (which never
   * matches a monster / `template#n` instance) and would otherwise fall back to `currentHp` — silently
   * healing-capping a wounded foe to its damaged value on reload ("Fen Stalker 5/20" → "5/5"). Absent on
   * content-backed actors (re-derived from the template) and legacy saves, so those stay byte-identical.
   */
  maxHp?: number;
}

/** Mutable runtime for authored NPCs that have no stats-bearing actor row. */
export interface AuthoredNpcRuntime {
  locationId: string;
  flags: Record<string, unknown>;
  /**
   * Persisted cull tier for a runtime-spawned stat-less NPC (an ambient extra). Absent for authored
   * location NPCs — their tier re-derives from content, so their projection stays byte-identical. Only
   * written for a `transient` spawn: without it, `seedStatlessNpc` re-derives such an extra as `tracked`
   * on reload, so a one-scene ambient body would survive as a PERMANENT fixture (and duplicate on the
   * next visit). Persisting the tier lets maintenance cull it on reload exactly as it would live (audit #13).
   */
  tier?: EntityTier;
}

/** Per-NPC autonomy runtime the Director reads/writes (see docs/PROACTIVE-NPCS.md). */
export interface AutonomyRuntime {
  /** True while an autonomous output is in flight (talk-lock). */
  talking: boolean;
  /** Current reply-chain depth for decay; reset to 0 on player/world events. */
  replyDepth: number;
  /** Epoch ms of this NPC's last autonomous action (heartbeat pacing + dedup). */
  lastActedAt: number;
  /**
   * Epoch ms of this leader's last emitted proposal (proposal cooldown: within a few beats of
   * one, the next spontaneous line is demoted to plain dialogue instead of re-arming the
   * machinery). Optional and additive: old saves parse unchanged, absent ⇒ 0 ⇒ the first
   * proposal always fires. Written only via the reducer's `modulePatch` (replay-safe).
   */
  lastProposedAt?: number;
  /**
   * In-world CLOCK reading (minutes) of this leader's last emitted proposal — the cooldown the
   * engine actually enforces. `lastProposedAt` above is wall-clock, and wall-clock pacing inverts
   * under a slow model: at 60-120s per narrated turn the old 3×40s window expired inside a single
   * turn, so the 2026-07-24 playtest got a proposal card on nearly every beat. The campaign clock
   * only advances on PLAYER turns (heartbeats are never taxed), so counting in in-world minutes
   * makes the cooldown a real conversational pause regardless of how fast the model is.
   * Optional/additive: absent ⇒ 0 ⇒ the first proposal always fires, and old saves parse unchanged.
   */
  lastProposedClock?: number;
  /**
   * Epoch ms of this NPC's last ARMED demand/pressure agenda action (agenda-pressure pacing:
   * within a few beats of one, planAgendaAction skips demand/pressure kinds so the beat is plain
   * dialogue — a companion can no longer eat every player turn re-pressing the same ask).
   * Optional and additive: old saves parse unchanged, absent ⇒ 0 ⇒ the first press always fires.
   * Written only via the reducer's `modulePatch` (replay-safe), mirroring `lastProposedAt`.
   */
  lastPressedAt?: number;
  /**
   * A leader NPC's outstanding party-level proposal: the grounded commands to run on tacit
   * consent, and when consent is assumed (epoch ms). Cleared on player input (priority A
   * override) or once acted on. Optional so existing readers stay unaffected. `text` is the
   * spoken proposal line, kept so an explicit player "yes" can be narrated against the plan it
   * accepts (optional/additive — pre-existing saves without it still consume fine).
   * `originLocationId` is the party's location when the plan was GROUNDED: the commands bake an
   * absolute destination, so a plan armed at one door must never execute after the party has
   * walked elsewhere (2026-07-25 playtest: a stale "after you" AGREE teleported the party a full
   * day's road backwards). Absent ⇒ pre-fix save ⇒ no origin check (fail-open for compat).
   */
  pendingProposal?: { commands: Command[]; expiresAt: number; text?: string; originLocationId?: string };
  /**
   * Feature 3 — a leader's accumulated "grievance" against the player: bumped when the PC crosses
   * the leader (declines/overrides a proposal, resists a demand), decayed over quiet beats. It
   * raises the odds + severity of the leader's disciplinary response (chooseLeaderDiscipline). A
   * non-leader may carry a harmless counter (only the leader path ever reads it). `grievanceAt` is
   * the epoch ms of the last bump, for time-decay. Optional/additive: absent ⇒ 0 (never aggrieved).
   * Written only via the reducer's `modulePatch` (replay-safe), mirroring `lastPressedAt`.
   */
  grievance?: number;
  grievanceAt?: number;
}

export interface GameState {
  campaignId: string;
  worldId: string;

  /** Where the party currently is. */
  partyLocationId: string;
  /** Simple in-game clock: minutes elapsed since the campaign began. */
  clock: number;

  /** PC ids in the party. */
  party: string[];
  /** Companion NPC ids traveling with the party (autonomy candidates). */
  companions: string[];

  /** Live state for every present actor, keyed by id. */
  actors: Record<string, ActorRuntime>;

  /**
   * Runtime state for authored, statless NPCs that are present in the entity registry but do not
   * have ActorRuntime rows. Optional so older snapshots fall back to content-derived placement.
   */
  authoredNpcs?: Record<string, AuthoredNpcRuntime>;

  /** Quest progress, keyed by quest id. */
  quests: Record<string, "hidden" | "offered" | "active" | "complete" | "failed">;

  /**
   * Runtime relationship scores: actorId → (targetId → score in −100..100). Seeded from
   * content, then mutated by play. Feeds reply-focus arbitration.
   * This is the Friendship axis of the broader relationship profile.
   */
  relationships: Record<string, Record<string, number>>;

  /** Director bookkeeping per companion NPC id. */
  autonomy: Record<string, AutonomyRuntime>;

  /**
   * Persisted per-module runtime (autonomy, events `once` cursor, objective progress) —
   * mirrors WorldModel.modules so scripted-beat state survives a reload. Optional for
   * backward compatibility with pre-Phase-5 snapshots.
   */
  modules?: Record<string, unknown>;

  /** Arbitrary narrative flags set during play. */
  flags: Record<string, unknown>;
}
