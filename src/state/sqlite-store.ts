/**
 * BunSqliteGameStateStore — durable persistence via bun:sqlite.
 *
 * Holds the latest snapshot + append-only event log, the LLM-call log (for the
 * Observatory), and the playset meta (world+campaign) per campaign. JSON columns keep the
 * shapes migration-free. Writes self-heal: if the handle breaks or the data directory is
 * deleted out from under a live session, a write reopens (recreating the directory + file)
 * and retries once, so a play session survives its save directory vanishing.
 *
 * @author Runkai Zhang
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GameEvent } from "../events/types.ts";
import type { GameState } from "./types.ts";
import {
  CorruptSnapshotError,
  LEGACY_CHARACTER_ID,
  type CommittedSnapshot,
  type EventQuery,
  type GameStateStore,
  type SaveKey,
} from "./store.ts";
import type { SeedConfig } from "../config/env.ts";
import type {
  LlmCallQuery,
  LlmCallRecord,
  LogSink,
  StoredLlmCall,
  StoredTurnTrace,
  TraceSink,
  TurnTrace,
  TurnTraceQuery,
} from "../logging/types.ts";

type Stmt = ReturnType<Database["query"]>;

export interface CampaignSummary {
  campaignId: string;
  characterId: string;
  updatedAt: number;
}

/** Parse the authoritative snapshot boundary. A malformed row is an error, never a missing save. */
function parseGameStateJson(json: string): GameState {
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid save: expected an object.");
  const state = value as Record<string, unknown>;
  const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((item) => typeof item === "string");
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (typeof state.campaignId !== "string" || typeof state.worldId !== "string") {
    throw new Error("Invalid save: campaign/world identity is missing.");
  }
  if (typeof state.partyLocationId !== "string" || !Number.isFinite(state.clock)) {
    throw new Error("Invalid save: location/clock is malformed.");
  }
  if (!stringArray(state.party) || !stringArray(state.companions) || !record(state.actors)) {
    throw new Error("Invalid save: party or actors are malformed.");
  }
  for (const [id, raw] of Object.entries(state.actors)) {
    if (!record(raw)) throw new Error(`Invalid save: actor ${id} is malformed.`);
    if (
      raw.id !== id ||
      !Number.isFinite(raw.currentHp) ||
      typeof raw.locationId !== "string" ||
      !stringArray(raw.inventory) ||
      !stringArray(raw.conditions) ||
      (raw.flags !== undefined && !record(raw.flags))
    ) {
      throw new Error(`Invalid save: actor ${id} has malformed runtime fields.`);
    }
  }
  for (const key of ["quests", "relationships", "autonomy", "flags"] as const) {
    if (!record(state[key])) throw new Error(`Invalid save: ${key} is malformed.`);
  }
  if (state.modules !== undefined && !record(state.modules)) throw new Error("Invalid save: modules is malformed.");
  return value as GameState;
}

export class BunSqliteGameStateStore implements GameStateStore, LogSink, TraceSink {
  private readonly dbPath: string;
  private db!: Database;
  private insertSnapshot!: Stmt;
  private insertEvent!: Stmt;
  private selectSnapshot!: Stmt;
  private selectMaxSeq!: Stmt;
  private insertLlmCall!: Stmt;
  private insertTrace!: Stmt;
  private upsertMeta!: Stmt;
  private selectMeta!: Stmt;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.openDb();
  }

  /** Resolve the DB file under config.dataDir, creating the directory if needed. */
  static open(config: SeedConfig): BunSqliteGameStateStore {
    mkdirSync(config.dataDir, { recursive: true });
    const store = new BunSqliteGameStateStore(join(config.dataDir, "seed.db"));
    // Opt-in retention (`SEED_TELEMETRY_RETENTION_DAYS`): startup-only, off the turn path.
    if (config.telemetryRetentionDays > 0) store.pruneTelemetry(config.telemetryRetentionDays);
    return store;
  }

  /**
   * Prune TELEMETRY rows older than `retentionDays`: `llm_calls` + `turn_traces` only. The engine
   * never reads either table (they feed the Observatory), so the only cost is older history there.
   * The `events` table is deliberately NEVER pruned — its deltas are load-bearing for
   * `engine.rewindTo` and corrupt-snapshot recovery, which both fold from seq 0. Best-effort:
   * `atomic` reopens-and-retries transient handle/IO faults; anything else is swallowed so a
   * failure never blocks opening.
   */
  pruneTelemetry(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    try {
      this.atomic(() => {
        // Indexed cutoff scans (created lazily — only DBs that opt into retention pay for them).
        // DELETE frees pages for reuse (WAL), which bounds growth; no VACUUM — a full rebuild at
        // open would block a big DB for seconds to save disk the very next session re-fills.
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_llm_calls_at ON llm_calls(at)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_turn_traces_at_end ON turn_traces(at_end)`);
        this.db.query(`DELETE FROM llm_calls WHERE at < $cutoff`).run({ $cutoff: cutoff });
        this.db.query(`DELETE FROM turn_traces WHERE at_end < $cutoff`).run({ $cutoff: cutoff });
      });
    } catch {
      // best-effort
    }
  }

  /** (Re)create the parent directory, connection, schema, and prepared statements. */
  private openDb(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    // Run statements one at a time — Bun 1.0.0's exec only runs the first of a batch.
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA user_version = 6");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS snapshots (
         campaign_id TEXT NOT NULL, character_id TEXT NOT NULL DEFAULT '',
         json TEXT NOT NULL, updated_at INTEGER NOT NULL, event_seq INTEGER NOT NULL DEFAULT -1,
         replayable INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (campaign_id, character_id)
       )`,
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS events (
         campaign_id TEXT NOT NULL, character_id TEXT NOT NULL DEFAULT '',
         seq INTEGER NOT NULL, kind TEXT NOT NULL,
         json TEXT NOT NULL, at INTEGER NOT NULL, silent INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (campaign_id, character_id, seq)
       )`,
    );
    this.migrateSaveKeySchema();
    const snapshotColumns = this.tableColumns("snapshots");
    if (!snapshotColumns.some((c) => c.name === "event_seq")) {
      this.db.run(`ALTER TABLE snapshots ADD COLUMN event_seq INTEGER NOT NULL DEFAULT -1`);
      // Existing snapshots predate an explicit cursor. Treat their current log head as included: old
      // releases wrote events before the snapshot and offered no reliable way to distinguish a tail.
      this.db.run(
        `UPDATE snapshots SET event_seq = COALESCE((
           SELECT max(events.seq) FROM events
           WHERE events.campaign_id = snapshots.campaign_id
             AND events.character_id = snapshots.character_id
         ), -1)`,
      );
    }
    if (!this.tableColumns("snapshots").some((c) => c.name === "replayable")) {
      // Migrated saves are deliberately unmarked: their historic logs may not be complete enough to
      // reconstruct a corrupt snapshot. Only an atomic fresh replacement establishes that proof.
      this.db.run(`ALTER TABLE snapshots ADD COLUMN replayable INTEGER NOT NULL DEFAULT 0`);
    }
    let eventColumns = this.tableColumns("events");
    if (!eventColumns.some((c) => c.name === "silent")) {
      this.db.run(`ALTER TABLE events ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`);
      eventColumns = this.tableColumns("events");
    }
    this.db.run(
      `CREATE TABLE IF NOT EXISTS llm_calls (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         campaign_id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
         kind TEXT NOT NULL, request_json TEXT NOT NULL, response_text TEXT NOT NULL,
         reasoning_text TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
         latency_ms INTEGER NOT NULL, finish TEXT NOT NULL, error TEXT, turn_seq INTEGER,
         provider_finish TEXT
       )`,
    );
    // Turn traces (Workstream D): the per-turn decision skeleton, durable beside llm_calls. The
    // full record lives in `json`; the columns are indexed handles for querying/grouping.
    this.db.run(
      `CREATE TABLE IF NOT EXISTS turn_traces (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         campaign_id TEXT NOT NULL, character_id TEXT NOT NULL DEFAULT '',
         turn_seq INTEGER NOT NULL, seq_start INTEGER NOT NULL, seq_end INTEGER NOT NULL,
         at_start INTEGER NOT NULL, at_end INTEGER NOT NULL, trigger TEXT NOT NULL,
         json TEXT NOT NULL
       )`,
    );
    // Existing v3 DBs: the llm_calls table predates turn_seq — add it (nullable; old rows stay null).
    if (!this.tableColumns("llm_calls").some((c) => c.name === "turn_seq")) {
      this.db.run(`ALTER TABLE llm_calls ADD COLUMN turn_seq INTEGER`);
    }
    // Existing v4 DBs: predates provider_finish — add it (nullable; old rows stay null).
    if (!this.tableColumns("llm_calls").some((c) => c.name === "provider_finish")) {
      this.db.run(`ALTER TABLE llm_calls ADD COLUMN provider_finish TEXT`);
    }
    this.db.run(
      `CREATE TABLE IF NOT EXISTS meta (
         campaign_id TEXT PRIMARY KEY, playset_json TEXT NOT NULL, updated_at INTEGER NOT NULL
       )`,
    );

    this.insertSnapshot = this.db.query(
      `INSERT INTO snapshots (campaign_id, character_id, json, updated_at, event_seq, replayable)
       VALUES ($cid, $char, $json, $at, $eventSeq, $replayable)
       ON CONFLICT(campaign_id, character_id) DO UPDATE SET
         json = excluded.json, updated_at = excluded.updated_at, event_seq = excluded.event_seq,
         replayable = excluded.replayable`,
    );
    this.insertEvent = this.db.query(
      `INSERT INTO events (campaign_id, character_id, seq, kind, json, at, silent)
       VALUES ($cid, $char, $seq, $kind, $json, $at, $silent)`,
    );
    this.selectSnapshot = this.db.query(
      `SELECT json, event_seq AS eventSeq, replayable FROM snapshots
       WHERE campaign_id = $cid AND character_id = $char`,
    );
    this.selectMaxSeq = this.db.query(
      `SELECT COALESCE(max(seq), -1) AS m FROM events WHERE campaign_id = $cid AND character_id = $char`,
    );
    this.insertLlmCall = this.db.query(
      `INSERT INTO llm_calls (campaign_id, at, role, model, kind, request_json, response_text,
         reasoning_text, prompt_tokens, completion_tokens, latency_ms, finish, error, turn_seq, provider_finish)
       VALUES ($cid, $at, $role, $model, $kind, $req, $resp, $reason, $pt, $ct, $lat, $finish, $err, $ts, $pf)`,
    );
    this.insertTrace = this.db.query(
      `INSERT INTO turn_traces (campaign_id, character_id, turn_seq, seq_start, seq_end,
         at_start, at_end, trigger, json)
       VALUES ($cid, $char, $ts, $ss, $se, $as, $ae, $trig, $json)`,
    );
    this.upsertMeta = this.db.query(
      `INSERT INTO meta (campaign_id, playset_json, updated_at) VALUES ($cid, $json, $at)
       ON CONFLICT(campaign_id) DO UPDATE SET playset_json = excluded.playset_json, updated_at = excluded.updated_at`,
    );
    this.selectMeta = this.db.query(`SELECT playset_json FROM meta WHERE campaign_id = $cid`);
  }

  private tableColumns(table: string): { name: string; pk: number }[] {
    return this.db.query(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  }

  private hasCompositePk(table: "snapshots" | "events"): boolean {
    const pk = this.tableColumns(table)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    return table === "snapshots"
      ? pk.join(",") === "campaign_id,character_id"
      : pk.join(",") === "campaign_id,character_id,seq";
  }

  private migrateSaveKeySchema(): void {
    const snapshotColumns = this.tableColumns("snapshots");
    if (!snapshotColumns.some((c) => c.name === "character_id")) {
      this.db.run(`ALTER TABLE snapshots ADD COLUMN character_id TEXT NOT NULL DEFAULT ''`);
    }

    const eventColumns = this.tableColumns("events");
    if (!eventColumns.some((c) => c.name === "character_id")) {
      this.db.run(`ALTER TABLE events ADD COLUMN character_id TEXT NOT NULL DEFAULT ''`);
    }
    if (!eventColumns.some((c) => c.name === "silent")) {
      this.db.run(`ALTER TABLE events ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`);
    }

    // SQLite cannot ALTER a primary key in place. Legacy tables get the additive/defaulted
    // columns first, then are rebuilt with the composite key while copying every row forward.
    if (!this.hasCompositePk("snapshots")) {
      this.db.run(`ALTER TABLE snapshots RENAME TO snapshots_legacy_pk`);
      this.db.run(
        `CREATE TABLE snapshots (
           campaign_id TEXT NOT NULL, character_id TEXT NOT NULL DEFAULT '',
           json TEXT NOT NULL, updated_at INTEGER NOT NULL,
           PRIMARY KEY (campaign_id, character_id)
         )`,
      );
      this.db.run(
        `INSERT OR REPLACE INTO snapshots (campaign_id, character_id, json, updated_at)
         SELECT campaign_id, character_id, json, updated_at FROM snapshots_legacy_pk`,
      );
      this.db.run(`DROP TABLE snapshots_legacy_pk`);
    }

    if (!this.hasCompositePk("events")) {
      this.db.run(`ALTER TABLE events RENAME TO events_legacy_pk`);
      this.db.run(
        `CREATE TABLE events (
           campaign_id TEXT NOT NULL, character_id TEXT NOT NULL DEFAULT '',
           seq INTEGER NOT NULL, kind TEXT NOT NULL,
           json TEXT NOT NULL, at INTEGER NOT NULL, silent INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (campaign_id, character_id, seq)
         )`,
      );
      this.db.run(
        `INSERT OR REPLACE INTO events (campaign_id, character_id, seq, kind, json, at, silent)
         SELECT campaign_id, character_id, seq, kind, json, at, silent FROM events_legacy_pk`,
      );
      this.db.run(`DROP TABLE events_legacy_pk`);
    }
  }

  private params(key: SaveKey): { $cid: string; $char: string } {
    return { $cid: key.campaignId, $char: key.characterId };
  }

  private maxSeqSync(key: SaveKey): number {
    const row = this.selectMaxSeq.get(this.params(key)) as { m: number };
    return row.m;
  }

  private snapshotParams(key: SaveKey, state: GameState, eventSeq: number, replayable: boolean) {
    return {
      ...this.params(key),
      $json: JSON.stringify(state),
      $at: Date.now(),
      $eventSeq: eventSeq,
      $replayable: replayable ? 1 : 0,
    };
  }

  private snapshotReplayableSync(key: SaveKey): boolean {
    const row = this.selectSnapshot.get(this.params(key)) as { replayable: number } | null;
    return row?.replayable === 1;
  }

  private eventParams(key: SaveKey, event: GameEvent) {
    return {
      ...this.params(key),
      $seq: event.seq,
      $kind: event.kind,
      $json: JSON.stringify(event),
      $at: event.at,
      $silent: event.silent === true ? 1 : 0,
    };
  }

  /** Only transient handle/IO faults merit reopening; deterministic SQL/constraint failures do not. */
  private retryableDbError(err: unknown): boolean {
    return /closed|finalized|not open|ioerr|disk i\/o|unable to open|database is locked|database is busy|readonly/i.test(
      String(err),
    );
  }

  /** Execute one SQLite transaction, reopening and retrying the WHOLE unit once on handle/IO failure. */
  private atomic(run: () => void): void {
    const execute = (): void => {
      this.db.transaction(run)();
    };
    try {
      execute();
    } catch (err) {
      if (!this.retryableDbError(err) || !this.reopen()) throw err;
      execute();
    }
  }

  /** Move a legacy blank-character save exactly once after its embedded primary-PC id matches. */
  private adoptLegacySave(key: SaveKey): void {
    if (key.characterId === LEGACY_CHARACTER_ID) return;
    const params = this.params(key);
    this.atomic(() => {
      this.db
        .query(
          `INSERT INTO snapshots (campaign_id, character_id, json, updated_at, event_seq, replayable)
           SELECT campaign_id, $char, json, updated_at, event_seq, replayable
           FROM snapshots
           WHERE campaign_id = $cid AND character_id = ''`,
        )
        .run(params);
      this.db
        .query(
          `INSERT INTO events (campaign_id, character_id, seq, kind, json, at, silent)
           SELECT campaign_id, $char, seq, kind, json, at, silent
           FROM events
           WHERE campaign_id = $cid AND character_id = ''`,
        )
        .run(params);
      this.db
        .query(`DELETE FROM events WHERE campaign_id = $cid AND character_id = ''`)
        .run(params);
      this.db
        .query(`DELETE FROM snapshots WHERE campaign_id = $cid AND character_id = ''`)
        .run(params);
    });
  }

  /** Best-effort recovery: recreate the data dir + reopen. Returns false if it can't. */
  private reopen(): boolean {
    try {
      try {
        this.db.close();
      } catch {
        // Handle may already be broken; ignore.
      }
      this.openDb(); // openDb recreates the parent directory if it vanished
      return true;
    } catch {
      return false;
    }
  }

  // --- GameStateStore -------------------------------------------------------

  private readSnapshotRow(key: SaveKey): { json: string; eventSeq: number; replayable: number } | null {
    const read = () =>
      this.selectSnapshot.get(this.params(key)) as { json: string; eventSeq: number; replayable: number } | null;
    try {
      return read();
    } catch (err) {
      if (!this.retryableDbError(err) || !this.reopen()) throw err;
      return read();
    }
  }

  private committedFromRow(row: { json: string; eventSeq: number; replayable: number }): CommittedSnapshot {
    try {
      return {
        state: parseGameStateJson(row.json),
        eventSeq: row.eventSeq,
        replayableFromOrigin: row.replayable === 1,
      };
    } catch (err) {
      // Parsing happens outside the read retry. Reopening cannot repair malformed authoritative JSON,
      // and must never turn this existing row into a false "no save" result.
      throw new CorruptSnapshotError(
        err instanceof Error ? err.message : "Invalid save snapshot.",
        row.eventSeq,
        row.replayable === 1,
        { cause: err },
      );
    }
  }

  loadCommitted(key: SaveKey): Promise<CommittedSnapshot | null> {
    const row = this.readSnapshotRow(key);
    if (row) return Promise.resolve(this.committedFromRow(row));

    if (key.characterId !== LEGACY_CHARACTER_ID) {
      const legacyKey = { campaignId: key.campaignId, characterId: LEGACY_CHARACTER_ID };
      const legacy = this.readSnapshotRow(legacyKey);
      if (legacy) {
        const committed = this.committedFromRow(legacy);
        const state = committed.state;
        // A campaign-only save belongs to the primary PC embedded in its snapshot. Never clone that
        // history into an arbitrary newly-selected character; an unsafe mismatch is a genuine miss.
        if (state.party?.[0] !== key.characterId) return Promise.resolve(null);
        this.adoptLegacySave(key);
        return Promise.resolve(committed);
      }
    }
    return Promise.resolve(null);
  }

  async load(key: SaveKey): Promise<GameState | null> {
    return (await this.loadCommitted(key))?.state ?? null;
  }

  save(key: SaveKey, state: GameState): Promise<void> {
    const run = (): void => {
      this.insertSnapshot.run(
        this.snapshotParams(key, state, this.maxSeqSync(key), this.snapshotReplayableSync(key)),
      );
    };
    try {
      run();
    } catch (err) {
      if (this.retryableDbError(err) && this.reopen()) run();
      else throw err;
    }
    return Promise.resolve();
  }

  appendEvent(key: SaveKey, event: GameEvent): Promise<void> {
    const params = this.eventParams(key, event);
    try {
      this.insertEvent.run(params);
    } catch (err) {
      // A duplicate seq is a divergence signal, not a harmless retry: the snapshot must never advance
      // while a different delta was discarded. Reopen only for non-constraint handle/IO failures.
      if (!this.retryableDbError(err) || !this.reopen()) return Promise.reject(err);
      try {
        this.insertEvent.run(params);
      } catch (retryErr) {
        return Promise.reject(retryErr);
      }
    }
    return Promise.resolve();
  }

  commitTurn(key: SaveKey, state: GameState, events: readonly GameEvent[]): Promise<void> {
    try {
      this.atomic(() => {
        const replayable = this.snapshotReplayableSync(key);
        for (const event of events) this.insertEvent.run(this.eventParams(key, event));
        this.insertSnapshot.run(this.snapshotParams(key, state, this.maxSeqSync(key), replayable));
      });
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  rewindSave(key: SaveKey, seq: number, state: GameState): Promise<void> {
    try {
      this.atomic(() => {
        const replayable = this.snapshotReplayableSync(key);
        this.db
          .query(`DELETE FROM events WHERE campaign_id = $cid AND character_id = $char AND seq >= $seq`)
          .run({ ...this.params(key), $seq: seq });
        this.db
          .query(`DELETE FROM turn_traces WHERE campaign_id = $cid AND character_id = $char AND seq_end >= $seq`)
          .run({ ...this.params(key), $seq: seq });
        this.insertSnapshot.run(this.snapshotParams(key, state, this.maxSeqSync(key), replayable));
      });
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  replaceSave(
    key: SaveKey,
    state: GameState,
    events: readonly GameEvent[] = [],
    options: { replayableFromOrigin?: boolean } = {},
  ): Promise<void> {
    try {
      this.atomic(() => {
        this.db.query(`DELETE FROM snapshots WHERE campaign_id = $cid AND character_id = $char`).run(this.params(key));
        this.db.query(`DELETE FROM events WHERE campaign_id = $cid AND character_id = $char`).run(this.params(key));
        this.db.query(`DELETE FROM turn_traces WHERE campaign_id = $cid AND character_id = $char`).run(this.params(key));
        for (const event of events) this.insertEvent.run(this.eventParams(key, event));
        this.insertSnapshot.run(
          this.snapshotParams(key, state, this.maxSeqSync(key), options.replayableFromOrigin === true),
        );
      });
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  readEvents(key: SaveKey, query: EventQuery = {}): Promise<GameEvent[]> {
    const params: Record<string, string | number> = this.params(key);
    let where = `campaign_id = $cid AND character_id = $char`;
    if (query.sinceSeq !== undefined) {
      where += ` AND seq >= $since`;
      params.$since = query.sinceSeq;
    }
    if (query.beforeSeq !== undefined) {
      where += ` AND seq < $before`;
      params.$before = query.beforeSeq;
    }
    if (query.includeSilent === false) {
      where += ` AND silent = 0`;
    }
    let sql: string;
    if (query.limit !== undefined) {
      params.$limit = query.limit;
      sql = `SELECT json FROM (SELECT json, seq FROM events WHERE ${where} ORDER BY seq DESC LIMIT $limit) ORDER BY seq ASC`;
    } else {
      sql = `SELECT json FROM events WHERE ${where} ORDER BY seq ASC`;
    }
    const rows = this.db.query(sql).all(params) as { json: string }[];
    return Promise.resolve(rows.map((r) => JSON.parse(r.json) as GameEvent));
  }

  getMaxSeq(key: SaveKey): Promise<number> {
    return Promise.resolve(this.maxSeqSync(key));
  }

  /** Save keys holding a snapshot for one campaign (the world editor's save-safety enumeration). */
  listSaves(campaignId: string): SaveKey[] {
    const rows = this.db
      .query(`SELECT character_id AS char FROM snapshots WHERE campaign_id = $cid ORDER BY character_id ASC`)
      .all({ $cid: campaignId }) as { char: string }[];
    return rows.map((r) => ({ campaignId, characterId: r.char }));
  }

  // --- LogSink + observability reads ---------------------------------------

  recordLlmCall(r: LlmCallRecord): void {
    const params = {
      $cid: r.campaignId,
      $at: r.at,
      $role: r.role,
      $model: r.model,
      $kind: r.kind,
      $req: JSON.stringify(r.request),
      $resp: r.responseText,
      $reason: r.reasoningText,
      $pt: r.promptTokens ?? null,
      $ct: r.completionTokens ?? null,
      $lat: r.latencyMs,
      $finish: r.finish,
      $err: r.error ?? null,
      $ts: r.turnSeq ?? null,
      $pf: r.providerFinish ?? null,
    };
    try {
      this.insertLlmCall.run(params);
    } catch {
      if (this.reopen()) {
        try {
          this.insertLlmCall.run(params);
        } catch {
          // Logging is best-effort; never throw.
        }
      }
    }
  }

  // --- TraceSink (Workstream D) ---------------------------------------------

  recordTurnTrace(t: TurnTrace): void {
    const params = {
      $cid: t.campaignId,
      $char: t.characterId,
      $ts: t.turnSeq,
      $ss: t.seqStart,
      $se: t.seqEnd,
      $as: t.atStart,
      $ae: t.atEnd,
      $trig: t.trigger,
      $json: JSON.stringify(t),
    };
    try {
      this.insertTrace.run(params);
    } catch {
      if (this.reopen()) {
        try {
          this.insertTrace.run(params);
        } catch {
          // Trace telemetry is best-effort; never throw.
        }
      }
    }
  }

  readTraces(campaignId: string, characterId: string, query: TurnTraceQuery = {}): StoredTurnTrace[] {
    const params: Record<string, string | number> = { $cid: campaignId, $char: characterId };
    let sql = `SELECT id, json FROM turn_traces WHERE campaign_id = $cid AND character_id = $char`;
    if (query.sinceSeq !== undefined) {
      sql += ` AND turn_seq >= $since`;
      params.$since = query.sinceSeq;
    }
    sql += ` ORDER BY id ASC`;
    if (query.limit !== undefined) {
      sql += ` LIMIT $limit`;
      params.$limit = query.limit;
    }
    const rows = this.db.query(sql).all(params) as { id: number; json: string }[];
    return rows.map((r) => ({ id: r.id, ...(JSON.parse(r.json) as TurnTrace) }));
  }

  readLlmCalls(campaignId: string, query: LlmCallQuery = {}): StoredLlmCall[] {
    const params: Record<string, string | number> = { $cid: campaignId };
    let sql =
      `SELECT id, campaign_id, at, role, model, kind, request_json, response_text, reasoning_text,
         prompt_tokens, completion_tokens, latency_ms, finish, error, turn_seq, provider_finish
       FROM llm_calls WHERE campaign_id = $cid`;
    if (query.sinceId !== undefined) {
      sql += ` AND id > $since`;
      params.$since = query.sinceId;
    }
    sql += ` ORDER BY id ASC`;
    if (query.limit !== undefined) {
      sql += ` LIMIT $limit`;
      params.$limit = query.limit;
    }
    const rows = this.db.query(sql).all(params) as LlmCallRow[];
    return rows.map(rowToCall);
  }

  /**
   * Campaigns present in the DB (snapshots, events, or llm_calls), newest activity first.
   *
   * llm_calls rows are campaign-keyed only, so their recency FOLDS into the campaign's real
   * character rows rather than minting a separate `''` row — otherwise every LLM call bumps a
   * phantom "legacy" row above the character actually being played, and the viewer opens a
   * session with calls but no transcript/state (live finding #6, 07-18). A bare `''` row still
   * surfaces when the campaign has NO play rows at all (llm-only, or genuine legacy CLI saves
   * whose snapshots themselves carry `character_id = ''`).
   */
  listCampaigns(): CampaignSummary[] {
    const rows = this.db
      .query(
        `WITH play AS (
           SELECT campaign_id AS cid, character_id AS char, max(t) AS updated FROM (
             SELECT campaign_id, character_id, updated_at AS t FROM snapshots
             UNION ALL SELECT campaign_id, character_id, at FROM events
           ) GROUP BY campaign_id, character_id
         ),
         calls AS (
           SELECT campaign_id AS cid, max(at) AS updated FROM llm_calls GROUP BY campaign_id
         )
         SELECT p.cid AS cid, p.char AS char, max(p.updated, coalesce(c.updated, 0)) AS updated
           FROM play p LEFT JOIN calls c ON c.cid = p.cid
         UNION ALL
         SELECT c.cid AS cid, '' AS char, c.updated AS updated
           FROM calls c WHERE NOT EXISTS (SELECT 1 FROM play p WHERE p.cid = c.cid)
         ORDER BY updated DESC`,
      )
      .all() as { cid: string; char: string; updated: number }[];
    return rows.map((r) => ({ campaignId: r.cid, characterId: r.char, updatedAt: r.updated }));
  }

  /** Persist the world+campaign so the viewer can resolve names and show context. */
  savePlayset(campaignId: string, playset: unknown): void {
    const params = { $cid: campaignId, $json: JSON.stringify(playset), $at: Date.now() };
    try {
      this.upsertMeta.run(params);
    } catch {
      if (this.reopen()) {
        try {
          this.upsertMeta.run(params);
        } catch {
          // best-effort
        }
      }
    }
  }

  loadPlayset(campaignId: string): unknown | null {
    const row = this.selectMeta.get({ $cid: campaignId }) as { playset_json: string } | null;
    return row ? JSON.parse(row.playset_json) : null;
  }

  /** Wipe one campaign+character save's progress and transcript (the campaign playset/meta is kept). */
  clearSave(key: SaveKey): void {
    const del = (table: string): void => {
      this.db
        .query(`DELETE FROM ${table} WHERE campaign_id = $cid AND character_id = $char`)
        .run(this.params(key));
    };
    const all = (): void => {
      del("snapshots");
      del("events");
    };
    this.atomic(all);
  }

  /**
   * Truncate a save's durable log at `seq`: drop every event `seq >= seq` AND every turn_trace whose
   * span reaches into the truncated tail (`seq_end >= seq`, catching the straddling edited-turn row).
   * Backs the engine's rewind — everything after the anchor is discarded permanently (linear
   * truncate, not a branch). The snapshot is left untouched: the caller re-saves the folded state.
   * Legacy compatibility seam; new engine code uses atomic `rewindSave`. Errors propagate so callers
   * cannot report a rewind that did not take. The llm_calls cost ledger is
   * NEVER touched (campaign-wide, append-only, read by the Observatory).
   */
  deleteEventsAfter(key: SaveKey, seq: number): void {
    const run = (): void => {
      this.db
        .query(`DELETE FROM events WHERE campaign_id = $cid AND character_id = $char AND seq >= $seq`)
        .run({ ...this.params(key), $seq: seq });
      this.db
        .query(`DELETE FROM turn_traces WHERE campaign_id = $cid AND character_id = $char AND seq_end >= $seq`)
        .run({ ...this.params(key), $seq: seq });
    };
    this.atomic(run);
  }

  /** Wipe a campaign's progress, transcripts, and call log (the playset/meta is kept). */
  clearCampaign(campaignId: string): void {
    const del = (table: string): void => {
      this.db.query(`DELETE FROM ${table} WHERE campaign_id = $cid`).run({ $cid: campaignId });
    };
    const all = (): void => {
      del("snapshots");
      del("events");
      del("llm_calls");
      del("turn_traces");
    };
    try {
      all();
    } catch {
      if (this.reopen()) {
        try {
          all();
        } catch {
          // best-effort
        }
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

interface LlmCallRow {
  id: number;
  campaign_id: string;
  at: number;
  role: string;
  model: string;
  kind: string;
  request_json: string;
  response_text: string;
  reasoning_text: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number;
  finish: string;
  error: string | null;
  turn_seq: number | null;
  provider_finish: string | null;
}

function rowToCall(r: LlmCallRow): StoredLlmCall {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    at: r.at,
    role: r.role as StoredLlmCall["role"],
    model: r.model,
    kind: r.kind as StoredLlmCall["kind"],
    request: JSON.parse(r.request_json),
    responseText: r.response_text,
    reasoningText: r.reasoning_text,
    promptTokens: r.prompt_tokens ?? undefined,
    completionTokens: r.completion_tokens ?? undefined,
    latencyMs: r.latency_ms,
    finish: r.finish as StoredLlmCall["finish"],
    error: r.error ?? undefined,
    turnSeq: r.turn_seq ?? undefined,
    providerFinish: r.provider_finish ?? undefined,
  };
}
