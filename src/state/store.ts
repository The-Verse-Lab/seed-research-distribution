/**
 * GameStateStore — persistence boundary.
 *
 * Keeping persistence behind this interface is what makes the runtime swappable: an
 * in-memory store for tests, a Bun-SQLite store for real play, or another local
 * persistence adapter without touching the engine.
 *
 * @author Runkai Zhang
 */
import type { GameEvent } from "../events/types.ts";
import type { GameState } from "./types.ts";

export interface SaveKey {
  campaignId: string;
  characterId: string;
}

export const LEGACY_CHARACTER_ID = "";

export function makeSaveKey(campaignId: string, characterId: string | undefined): SaveKey {
  return { campaignId, characterId: characterId ?? LEGACY_CHARACTER_ID };
}

export interface EventQuery {
  /** Return events at or after this sequence number. */
  sinceSeq?: number;
  /** Return events strictly BEFORE this sequence number (exclusive upper bound). The rewind fold
   *  reads the prefix `seq < anchor` to reconstruct the state just before a turn. */
  beforeSeq?: number;
  /** Cap to the most recent N events (still returned oldest-first). */
  limit?: number;
  /** Include durable bookkeeping events. Defaults to true for replay-complete reads. */
  includeSilent?: boolean;
}

/** A snapshot plus the highest durable event sequence already reflected in it. */
export interface CommittedSnapshot {
  state: GameState;
  eventSeq: number;
  /** True only when the retained durable log is known to replay from the authored campaign origin. */
  replayableFromOrigin?: boolean;
}

/**
 * A snapshot row existed but its JSON failed authoritative validation. Stores may attach a cursor
 * and a replay-completeness marker so the engine can recover from the durable delta log without ever
 * treating corruption as a missing/new game.
 */
export class CorruptSnapshotError extends Error {
  override readonly name = "CorruptSnapshotError";

  constructor(
    message: string,
    readonly eventSeq: number,
    readonly replayableFromOrigin: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GameStateStore {
  /** Load the latest snapshot for a campaign+character save, or null if none saved. */
  load(key: SaveKey): Promise<GameState | null>;
  /** Persist a snapshot (overwrites the latest). */
  save(key: SaveKey, state: GameState): Promise<void>;
  /** Append an event to the save's durable log. */
  appendEvent(key: SaveKey, event: GameEvent): Promise<void>;
  /** Read back the event log (the GM's memory / replay source). */
  readEvents(key: SaveKey, query?: EventQuery): Promise<GameEvent[]>;
  /**
   * Load the committed snapshot and its event cursor. Optional for third-party stores; bundled stores
   * implement it so the engine can reconcile an authoritative delta tail without guessing whether the
   * snapshot already includes it. Read/parse failures MUST reject; only a genuinely absent save is null.
   */
  loadCommitted?(key: SaveKey): Promise<CommittedSnapshot | null>;
  /** Atomically append every event and advance the snapshot/cursor, or reject with no writes. */
  commitTurn?(key: SaveKey, state: GameState, events: readonly GameEvent[]): Promise<void>;
  /** Atomically truncate events/traces at `seq` and install the folded prefix snapshot. */
  rewindSave?(key: SaveKey, seq: number, state: GameState): Promise<void>;
  /** Atomically replace one save with a snapshot and optional complete event history. */
  replaceSave?(
    key: SaveKey,
    state: GameState,
    events?: readonly GameEvent[],
    options?: { replayableFromOrigin?: boolean },
  ): Promise<void>;
  /**
   * Enumerate the save keys holding a snapshot for one campaign. OPTIONAL capability: the world
   * editor's save-safety check reads every save through it to refuse content removals that would
   * strand an existing save. Both bundled stores implement it; when a store cannot enumerate, the
   * editor fails CLOSED for structural removals (prose edits and pure additions stay allowed).
   */
  listSaves?(campaignId: string): SaveKey[] | Promise<SaveKey[]>;
}
