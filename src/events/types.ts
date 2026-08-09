/**
 * GameEvent — the append-only record of everything that happens.
 *
 * The event log is two things at once: the client's render stream and the GM's memory.
 * Events are produced by the engine and consumed by clients; they are intentionally
 * serializable so the same stream can feed the CLI, logs, and research harnesses.
 *
 * @author Runkai Zhang
 */
import type { DeltaEvent, EmittedDelta } from "./deltas.ts";

/** Fields shared by every event. */
export interface BaseEvent {
  /** Unique event id (assigned by the bus). */
  id: string;
  /** Epoch milliseconds; assigned at emit time (never inside pure logic). */
  at: number;
  /** Monotonic per-session sequence number. */
  seq: number;
  /** Bookkeeping events are durable for replay, but hidden from live/player-facing streams. */
  silent?: boolean;
}

/** GM prose describing the scene or the outcome of something. */
export interface NarrationEvent extends BaseEvent {
  kind: "narration";
  text: string;
  sceneId?: string;
  /**
   * Entity ids at the party's location when this event fired (r4 witness scoping). NPC reply/decide
   * briefs use it to drop scene rows the NPC never witnessed from their `# RECENT` — an absent NPC
   * must not quote a scene from across the city. Absent (legacy events, non-scene emits) ⇒ the row
   * is treated as witnessed by everyone (fail-open: exactly the pre-field behavior). Player-facing
   * rendering and the GM brief ignore it entirely.
   */
  presentIds?: string[];
  /**
   * The streaming beat this settled prose finalizes. A turn can emit several narration beats (main
   * GM prose plus a combat module beat), each streamed via its own `beatId`; the client keys
   * its live token buffer by this id so concurrent beats never collide (the "first-word stub" bug).
   * Absent on non-streamed/legacy events — the client then renders the full text directly.
   */
  beatId?: number;
}

/** In-character speech from a player, NPC, or the GM voicing a minor character. */
export interface DialogueEvent extends BaseEvent {
  kind: "dialogue";
  actorId: string;
  text: string;
  toId?: string;
  /**
   * Line audibility (Phase 6 — click-to-chat). Absent ⇒ public (the table hears it), exactly as
   * every line was before the field existed. `"private"` ⇒ an aside between `actorId` and `toId`
   * only: excluded from bystander NPCs' perception/reply arbitration, from the narrator brief's
   * `# RECENT` on later public turns, and from the rolling campaign summary. Additive — a
   * zero-private campaign's event stream is byte-identical.
   */
  channel?: "private";
  /** Witness scoping — see `NarrationEvent.presentIds`. */
  presentIds?: string[];
}

/** A deterministic dice resolution from the rules engine. */
export interface DiceRolledEvent extends BaseEvent {
  kind: "diceRolled";
  actorId?: string;
  notation: string;
  rolls: number[];
  total: number;
  /** Why the roll happened, e.g. "Stealth check (DC 14)". */
  purpose?: string;
  success?: boolean;
}

/** A summarized mutation of game state (inventory, hp, quest flags, position…). */
export interface StateChangedEvent extends BaseEvent {
  kind: "stateChanged";
  summary: string;
  /** Optional structured diff for clients that want detail. */
  changes?: Record<string, unknown>;
  /** Witness scoping — see `NarrationEvent.presentIds`. */
  presentIds?: string[];
  /**
   * When true, the event is metadata for state consumers only and is NOT rendered as a transcript
   * `·` line — used where the same tick already shows the identical receipt as a deterministic
   * narration line (r6 P2: every trade printed the same sentence twice).
   */
  quiet?: boolean;
}

/**
 * A 'leader' NPC's party-level proposal awaiting the table's reaction. The client
 * surfaces this distinctly; silence past `expiresInMs` is tacit consent (if the NPC
 * may lead), a player response (priority A) overrides it immediately.
 */
export interface NpcProposalEvent extends BaseEvent {
  kind: "npcProposal";
  actorId: string;
  proposal: string;
  options: string[];
  expiresInMs: number;
}

/**
 * A quest has just come ON OFFER through an in-fiction channel — a notice-board posting, an NPC's
 * words, or an opened letter. The client surfaces this INLINE at the delivery beat: an Accept/
 * Dismiss affordance anchored in the transcript, replacing the old floating quest banner. Ephemeral
 * like a system notice (broadcast, never persisted — see `emit`): the DURABLE surface is the quest's
 * "offered" state, quietly listed in the right-panel QUESTS card. Accept/decline still flows through
 * the questAction path — the card's buttons submit the same input the player could type.
 */
export interface QuestOfferedEvent extends BaseEvent {
  kind: "questOffered";
  questId: string;
  name: string;
  /** The quest's own player-facing pitch (world-blurb stripped); may be empty (render name alone). */
  description: string;
}

/** Engine/system-level notice (errors, saves, connection, debug). */
export interface SystemEvent extends BaseEvent {
  kind: "system";
  level: "info" | "warn" | "error";
  message: string;
  /**
   * Optional machine-readable tag for notices a client wants to route, not just print.
   * Additive: untagged notices render exactly as before, and system events are never persisted.
   */
  code?:
    | "private-undelivered"
    | "narrator-empty"
    | "narrator-truncated";
}

export type GameEvent =
  | NarrationEvent
  | DialogueEvent
  | DiceRolledEvent
  | StateChangedEvent
  | NpcProposalEvent
  | QuestOfferedEvent
  | SystemEvent
  | DeltaEvent;

export type GameEventKind = GameEvent["kind"];

/** Shape of an event before the bus assigns `id`/`at`/`seq`. */
export type EmittedEvent =
  | (Omit<NarrationEvent, keyof BaseEvent> )
  | (Omit<DialogueEvent, keyof BaseEvent>)
  | (Omit<DiceRolledEvent, keyof BaseEvent>)
  | (Omit<StateChangedEvent, keyof BaseEvent>)
  | (Omit<NpcProposalEvent, keyof BaseEvent>)
  | (Omit<QuestOfferedEvent, keyof BaseEvent>)
  | (Omit<SystemEvent, keyof BaseEvent>)
  | EmittedDelta;
