/**
 * In-memory GameStateStore — default for M0 scaffolding and tests.
 *
 * Holds snapshots and event logs in process. Nothing persists across restarts; the
 * SQLite adapter (M1) replaces this without changing callers.
 *
 * @author Runkai Zhang
 */
import type { GameEvent } from "../../src/events/types.ts";
import type { GameState } from "../../src/state/types.ts";
import type { CommittedSnapshot, EventQuery, GameStateStore, SaveKey } from "../../src/state/store.ts";

export class InMemoryGameStateStore implements GameStateStore {
  private snapshots = new Map<string, GameState>();
  private logs = new Map<string, GameEvent[]>();
  private snapshotSeq = new Map<string, number>();
  private replayable = new Map<string, boolean>();

  private keyId(key: SaveKey): string {
    return `${key.campaignId}\u0000${key.characterId}`;
  }

  load(key: SaveKey): Promise<GameState | null> {
    return Promise.resolve(this.snapshots.get(this.keyId(key)) ?? null);
  }

  save(key: SaveKey, state: GameState): Promise<void> {
    // Structured-clone to avoid callers mutating stored state by reference.
    this.snapshots.set(this.keyId(key), structuredClone(state));
    const log = this.logs.get(this.keyId(key)) ?? [];
    this.snapshotSeq.set(this.keyId(key), log.reduce((max, event) => Math.max(max, event.seq), -1));
    if (!this.replayable.has(this.keyId(key))) this.replayable.set(this.keyId(key), false);
    return Promise.resolve();
  }

  appendEvent(key: SaveKey, event: GameEvent): Promise<void> {
    const id = this.keyId(key);
    const log = this.logs.get(id) ?? [];
    if (log.some((existing) => existing.seq === event.seq)) {
      return Promise.reject(new Error(`duplicate event seq ${event.seq} for ${key.campaignId}/${key.characterId}`));
    }
    log.push(structuredClone(event));
    log.sort((a, b) => a.seq - b.seq);
    this.logs.set(id, log);
    return Promise.resolve();
  }

  loadCommitted(key: SaveKey): Promise<CommittedSnapshot | null> {
    const id = this.keyId(key);
    const state = this.snapshots.get(id);
    if (!state) return Promise.resolve(null);
    return Promise.resolve({
      state: structuredClone(state),
      eventSeq: this.snapshotSeq.get(id) ?? -1,
      replayableFromOrigin: this.replayable.get(id) === true,
    });
  }

  commitTurn(key: SaveKey, state: GameState, events: readonly GameEvent[]): Promise<void> {
    const id = this.keyId(key);
    const prior = this.logs.get(id) ?? [];
    const seen = new Set(prior.map((event) => event.seq));
    for (const event of events) {
      if (seen.has(event.seq)) {
        return Promise.reject(new Error(`duplicate event seq ${event.seq} for ${key.campaignId}/${key.characterId}`));
      }
      seen.add(event.seq);
    }
    const next = [...prior.map((event) => structuredClone(event)), ...events.map((event) => structuredClone(event))].sort(
      (a, b) => a.seq - b.seq,
    );
    this.logs.set(id, next);
    this.snapshots.set(id, structuredClone(state));
    this.snapshotSeq.set(id, next.reduce((max, event) => Math.max(max, event.seq), -1));
    if (!this.replayable.has(id)) this.replayable.set(id, false);
    return Promise.resolve();
  }

  rewindSave(key: SaveKey, seq: number, state: GameState): Promise<void> {
    const id = this.keyId(key);
    const next = (this.logs.get(id) ?? []).filter((event) => event.seq < seq).map((event) => structuredClone(event));
    this.logs.set(id, next);
    this.snapshots.set(id, structuredClone(state));
    this.snapshotSeq.set(id, next.reduce((max, event) => Math.max(max, event.seq), -1));
    return Promise.resolve();
  }

  replaceSave(
    key: SaveKey,
    state: GameState,
    events: readonly GameEvent[] = [],
    options: { replayableFromOrigin?: boolean } = {},
  ): Promise<void> {
    const seen = new Set<number>();
    for (const event of events) {
      if (seen.has(event.seq)) return Promise.reject(new Error(`duplicate replacement event seq ${event.seq}`));
      seen.add(event.seq);
    }
    const id = this.keyId(key);
    const next = events.map((event) => structuredClone(event)).sort((a, b) => a.seq - b.seq);
    this.logs.set(id, next);
    this.snapshots.set(id, structuredClone(state));
    this.snapshotSeq.set(id, next.reduce((max, event) => Math.max(max, event.seq), -1));
    this.replayable.set(id, options.replayableFromOrigin === true);
    return Promise.resolve();
  }

  readEvents(key: SaveKey, query: EventQuery = {}): Promise<GameEvent[]> {
    let events = this.logs.get(this.keyId(key)) ?? [];
    if (query.sinceSeq !== undefined) {
      events = events.filter((e) => e.seq >= query.sinceSeq!);
    }
    if (query.beforeSeq !== undefined) {
      events = events.filter((e) => e.seq < query.beforeSeq!);
    }
    if (query.includeSilent === false) {
      events = events.filter((e) => e.silent !== true);
    }
    if (query.limit !== undefined) events = events.slice(-query.limit); // most recent N
    return Promise.resolve(events);
  }

  getMaxSeq(key: SaveKey): Promise<number> {
    const log = this.logs.get(this.keyId(key)) ?? [];
    return Promise.resolve(log.reduce((max, e) => Math.max(max, e.seq), -1));
  }

  /** Save keys holding a snapshot for one campaign (the world editor's save-safety enumeration). */
  listSaves(campaignId: string): SaveKey[] {
    const keys: SaveKey[] = [];
    for (const id of this.snapshots.keys()) {
      const sep = id.indexOf("\u0000");
      if (id.slice(0, sep) === campaignId) keys.push({ campaignId, characterId: id.slice(sep + 1) });
    }
    return keys;
  }

  clearSave(key: SaveKey): void {
    const id = this.keyId(key);
    this.snapshots.delete(id);
    this.logs.delete(id);
    this.snapshotSeq.delete(id);
    this.replayable.delete(id);
  }

  /** Truncate the durable log at `seq` (drop every event `seq >= seq`) — mirrors the SQLite store,
   *  backing the engine's rewind. The snapshot is left intact; the caller re-saves the folded state. */
  deleteEventsAfter(key: SaveKey, seq: number): void {
    const id = this.keyId(key);
    const log = this.logs.get(id);
    if (log) this.logs.set(id, log.filter((e) => e.seq < seq));
  }
}
