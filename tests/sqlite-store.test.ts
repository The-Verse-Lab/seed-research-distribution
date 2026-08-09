/**
 * SQLite persistence tests — round-trip, ordering, restart continuity.
 *
 * @author Runkai Zhang
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqliteGameStateStore } from "../src/state/sqlite-store.ts";
import { makeSaveKey, type SaveKey } from "../src/state/store.ts";
import type { GameState } from "../src/state/types.ts";
import type { GameEvent } from "../src/events/types.ts";

const DB = join(tmpdir(), "seed-sqlite-test.db");

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

const K = (campaignId = "c1", characterId = "pc.you"): SaveKey => makeSaveKey(campaignId, characterId);

function fixtureState(id = "c1"): GameState {
  return {
    campaignId: id,
    worldId: "w1",
    partyLocationId: "loc.tavern",
    clock: 3,
    party: ["pc.you"],
    companions: [],
    actors: {},
    quests: {},
    relationships: {},
    autonomy: {},
    flags: { mood: "tense" },
  };
}

const ev = (seq: number) => ({
  id: `e${seq}`,
  at: 1000 + seq,
  seq,
  kind: "system",
  level: "info",
  message: `m${seq}`,
}) satisfies GameEvent;

describe("BunSqliteGameStateStore", () => {
  test("snapshot round-trips losslessly", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.save(K(), fixtureState());
    const loaded = await store.load(K());
    expect(loaded?.clock).toBe(3);
    expect(loaded?.flags.mood).toBe("tense");
    store.close();
  });

  test("events append and read back in seq order, with sinceSeq + limit", async () => {
    const store = new BunSqliteGameStateStore(DB);
    for (const s of [0, 1, 2, 3]) await store.appendEvent(K(), ev(s));
    expect((await store.readEvents(K())).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect((await store.readEvents(K(), { sinceSeq: 2 })).map((e) => e.seq)).toEqual([2, 3]);
    // limit returns the MOST RECENT N (still oldest-first), so the narrator sees recent play.
    expect((await store.readEvents(K(), { limit: 2 })).map((e) => e.seq)).toEqual([2, 3]);
    store.close();
  });

  test("silent events stay replay-readable but can be excluded from story-facing reads", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.appendEvent(K(), ev(0));
    await store.appendEvent(K(), { ...ev(1), silent: true });
    await store.appendEvent(K(), ev(2));

    expect((await store.readEvents(K())).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await store.readEvents(K(), { includeSilent: false })).map((e) => e.seq)).toEqual([0, 2]);
    expect((await store.readEvents(K(), { limit: 2, includeSilent: false })).map((e) => e.seq)).toEqual([0, 2]);
    store.close();
  });

  test("getMaxSeq is -1 when empty, then the high-water mark", async () => {
    const store = new BunSqliteGameStateStore(DB);
    expect(await store.getMaxSeq(K())).toBe(-1);
    await store.appendEvent(K(), ev(0));
    await store.appendEvent(K(), ev(1));
    expect(await store.getMaxSeq(K())).toBe(1);
    store.close();
  });

  test("data survives reopening the same file", async () => {
    const s1 = new BunSqliteGameStateStore(DB);
    await s1.save(K(), fixtureState());
    await s1.appendEvent(K(), ev(0));
    s1.close();

    const s2 = new BunSqliteGameStateStore(DB);
    expect((await s2.load(K()))?.clock).toBe(3);
    expect(await s2.getMaxSeq(K())).toBe(0);
    s2.close();
  });

  test("commitTurn rolls back its event batch when the snapshot write fails", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.commitTurn(K(), fixtureState(), [ev(0)]);

    const fault = new Database(DB);
    fault.run(
      `CREATE TRIGGER fail_snapshot_update BEFORE UPDATE ON snapshots
       BEGIN SELECT RAISE(ABORT, 'forced snapshot failure'); END`,
    );
    fault.close();

    await expect(store.commitTurn(K(), { ...fixtureState(), clock: 99 }, [ev(1)])).rejects.toThrow(
      /forced snapshot failure/i,
    );
    expect((await store.load(K()))?.clock).toBe(3);
    expect((await store.readEvents(K())).map((event) => event.seq)).toEqual([0]);
    store.close();
  });

  test("rewindSave rolls back tail deletion when the folded snapshot write fails", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.commitTurn(K(), fixtureState(), [ev(0), ev(1), ev(2)]);

    const fault = new Database(DB);
    fault.run(
      `CREATE TRIGGER fail_rewind_snapshot BEFORE UPDATE ON snapshots
       BEGIN SELECT RAISE(ABORT, 'forced rewind snapshot failure'); END`,
    );
    fault.close();

    await expect(store.rewindSave(K(), 1, { ...fixtureState(), clock: 1 })).rejects.toThrow(
      /forced rewind snapshot failure/i,
    );
    expect((await store.load(K()))?.clock).toBe(3);
    expect((await store.readEvents(K())).map((event) => event.seq)).toEqual([0, 1, 2]);
    store.close();
  });

  test("a duplicate seq rejects loudly instead of silently diverging the log", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.appendEvent(K(), ev(0));
    await expect(store.appendEvent(K(), { ...ev(0), message: "different event" })).rejects.toThrow();
    expect((await store.readEvents(K())).length).toBe(1);
    store.close();
  });

  test("a save self-heals after the connection is broken", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.save(K(), fixtureState());
    store.close(); // simulate a broken handle mid-session
    await store.save(K(), { ...fixtureState(), clock: 99 }); // must reopen + save, not throw
    expect((await store.load(K()))?.clock).toBe(99);
    store.close();
  });

  test("a save self-heals when the data directory is deleted out from under it", async () => {
    const dir = join(tmpdir(), "seed-selfheal-test");
    rmSync(dir, { recursive: true, force: true });
    const store = new BunSqliteGameStateStore(join(dir, "seed.db"));
    await store.save(K(), fixtureState());
    store.close();
    rmSync(dir, { recursive: true, force: true }); // the whole data dir vanishes
    await store.save(K(), { ...fixtureState(), clock: 77 }); // reopen must recreate dir + db
    expect((await store.load(K()))?.clock).toBe(77);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("snapshots and events are independent per campaign plus character", async () => {
    const store = new BunSqliteGameStateStore(DB);
    const ash = K("c1", "pc.ashguard");
    const mire = K("c1", "pc.mireglass");

    await store.save(ash, { ...fixtureState(), clock: 10, party: ["pc.ashguard"] });
    await store.save(mire, { ...fixtureState(), clock: 20, party: ["pc.mireglass"] });
    await store.appendEvent(ash, ev(0));
    await store.appendEvent(mire, { id: "mire0", at: 1000, seq: 0, kind: "system", level: "info", message: "mire" });
    await store.appendEvent(ash, ev(1));

    expect((await store.load(ash))?.clock).toBe(10);
    expect((await store.load(mire))?.clock).toBe(20);
    expect((await store.readEvents(ash)).map((e) => e.seq)).toEqual([0, 1]);
    expect((await store.readEvents(mire)).map((e) => e.seq)).toEqual([0]);
    expect(await store.getMaxSeq(ash)).toBe(1);
    expect(await store.getMaxSeq(mire)).toBe(0);
    expect(store.listCampaigns().map((c) => [c.campaignId, c.characterId]).sort()).toEqual([
      ["c1", "pc.ashguard"],
      ["c1", "pc.mireglass"],
    ]);
    store.close();
  });

  test("llm-call recency folds into character rows; a bare '' row only when llm-only", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.save(K("c1", "pc.ashguard"), fixtureState());
    const call = (campaignId: string, at: number) =>
      store.recordLlmCall({
        campaignId,
        at,
        role: "utility",
        model: "m",
        kind: "complete",
        request: { messages: [] },
        responseText: "ok",
        reasoningText: "",
        latencyMs: 5,
        finish: "ok",
      });
    // Calls are campaign-keyed only — their recency must bump the REAL character row, not mint
    // a separate always-newest "legacy" row above it (the viewer would open that phantom row and
    // find calls but no transcript/state — live finding #6, 07-18).
    call("c1", 9_000_000_000_000);
    expect(store.listCampaigns().filter((c) => c.campaignId === "c1")).toEqual([
      { campaignId: "c1", characterId: "pc.ashguard", updatedAt: 9_000_000_000_000 },
    ]);
    // A campaign with ONLY llm calls (no snapshots/events) still surfaces, as the bare '' row.
    call("c2", 5_000_000_000_000);
    const rows = store.listCampaigns();
    expect(rows.filter((c) => c.campaignId === "c2")).toEqual([
      { campaignId: "c2", characterId: "", updatedAt: 5_000_000_000_000 },
    ]);
    // Newest activity still sorts first across campaigns.
    expect(rows[0]?.campaignId).toBe("c1");
    store.close();
  });

  test("legacy campaign-only rows adopt only to their embedded primary PC, exactly once", async () => {
    const legacy = new Database(DB, { create: true });
    legacy.run(`CREATE TABLE snapshots (campaign_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    legacy.run(
      `CREATE TABLE events (
         campaign_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
         json TEXT NOT NULL, at INTEGER NOT NULL,
         PRIMARY KEY (campaign_id, seq)
       )`,
    );
    legacy
      .query(`INSERT INTO snapshots (campaign_id, json, updated_at) VALUES ($cid, $json, $at)`)
      .run({ $cid: "c1", $json: JSON.stringify({ ...fixtureState(), clock: 44 }), $at: 1 });
    legacy
      .query(`INSERT INTO events (campaign_id, seq, kind, json, at) VALUES ($cid, $seq, $kind, $json, $at)`)
      .run({ $cid: "c1", $seq: 7, $kind: "system", $json: JSON.stringify(ev(7)), $at: 7 });
    legacy.close();

    const store = new BunSqliteGameStateStore(DB);
    // Selecting a different character must NOT clone pc.you's history into that character.
    const unsafe = K("c1", "pc.ashguard");
    expect(await store.load(unsafe)).toBeNull();
    expect(await store.readEvents(unsafe)).toEqual([]);
    expect((await store.load(K("c1", "")))?.clock).toBe(44);

    const adopted = K("c1", "pc.you");
    expect((await store.load(adopted))?.clock).toBe(44);
    expect((await store.readEvents(adopted)).map((e) => e.seq)).toEqual([7]);
    expect(await store.getMaxSeq(adopted)).toBe(7);

    await store.save(adopted, { ...fixtureState(), clock: 45 });
    expect((await store.load(adopted))?.clock).toBe(45);
    expect(await store.load(K("c1", ""))).toBeNull();
    store.close();

    const db = new Database(DB);
    const snapshotInfo = db.query(`PRAGMA table_info(snapshots)`).all() as { name: string; pk: number }[];
    const eventInfo = db.query(`PRAGMA table_info(events)`).all() as { name: string; pk: number }[];
    expect(snapshotInfo.find((c) => c.name === "character_id")?.pk).toBe(2);
    expect(eventInfo.find((c) => c.name === "character_id")?.pk).toBe(2);
    expect(eventInfo.some((c) => c.name === "silent")).toBe(true);
    db.close();
  });

  test("clearCampaign wipes progress, events, and call log but keeps the playset", async () => {
    const store = new BunSqliteGameStateStore(DB);
    await store.save(K(), fixtureState());
    await store.appendEvent(K(), ev(0));
    store.recordLlmCall({
      campaignId: "c1", at: 1, role: "narrator", model: "m", kind: "stream",
      request: {}, responseText: "x", reasoningText: "", latencyMs: 1, finish: "ok",
    });
    store.savePlayset("c1", { world: { name: "W" } });

    store.clearCampaign("c1");
    expect(await store.load(K())).toBeNull();
    expect((await store.readEvents(K())).length).toBe(0);
    expect(store.readLlmCalls("c1").length).toBe(0);
    expect((store.loadPlayset("c1") as { world: { name: string } }).world.name).toBe("W");
    store.close();
  });

  test("turn traces + llm_calls.turn_seq round-trip, tail by sinceSeq, and survive reopen (Workstream D)", () => {
    const s1 = new BunSqliteGameStateStore(DB);
    s1.recordTurnTrace({
      campaignId: "c1", characterId: "pc.you", turnSeq: 5, seqStart: 5, seqEnd: 8, atStart: 1, atEnd: 2,
      trigger: "player", input: "hello", classifierKind: "dialogueToNpc", classifierTargetId: "npc.lyra",
      classifierConfidence: 0.9, npcBeats: [{ actorId: "npc.lyra", name: "Lyra", dialogue: "Hi" }],
    });
    s1.recordLlmCall({
      campaignId: "c1", at: 1, role: "utility", model: "m", kind: "complete",
      request: {}, responseText: "x", reasoningText: "", latencyMs: 1, finish: "ok", turnSeq: 5,
    });
    s1.close();

    const s2 = new BunSqliteGameStateStore(DB);
    const traces = s2.readTraces("c1", "pc.you");
    expect(traces.length).toBe(1);
    expect(traces[0]!.turnSeq).toBe(5);
    expect(traces[0]!.classifierKind).toBe("dialogueToNpc");
    expect(traces[0]!.npcBeats?.[0]?.name).toBe("Lyra");
    expect(typeof traces[0]!.id).toBe("number");
    // The call is correlated to its turn.
    expect(s2.readLlmCalls("c1")[0]?.turnSeq).toBe(5);
    // Tail semantics: turn_seq >= sinceSeq.
    expect(s2.readTraces("c1", "pc.you", { sinceSeq: 6 }).length).toBe(0);
    expect(s2.readTraces("c1", "pc.you", { sinceSeq: 5 }).length).toBe(1);
    // Scoped to the save key.
    expect(s2.readTraces("c1", "other").length).toBe(0);
    s2.close();
  });

  test("a pre-turn_seq (v3) DB migrates: llm_calls gains turn_seq (null on old rows) and turn_traces appears", () => {
    const legacy = new Database(DB, { create: true });
    legacy.run("PRAGMA user_version = 3");
    legacy.run(`CREATE TABLE snapshots (campaign_id TEXT NOT NULL, character_id TEXT NOT NULL DEFAULT '', json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (campaign_id, character_id))`);
    legacy.run(`CREATE TABLE events (campaign_id TEXT NOT NULL, character_id TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL, silent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (campaign_id, character_id, seq))`);
    legacy.run(`CREATE TABLE llm_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, request_json TEXT NOT NULL, response_text TEXT NOT NULL, reasoning_text TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER NOT NULL, finish TEXT NOT NULL, error TEXT)`);
    legacy.query(`INSERT INTO llm_calls (campaign_id, at, role, model, kind, request_json, response_text, reasoning_text, latency_ms, finish) VALUES ('c1', 1, 'narrator', 'm', 'stream', '{}', 'x', '', 5, 'ok')`).run();
    legacy.close();

    const store = new BunSqliteGameStateStore(DB);
    // The old call survives; its turn_seq is null → undefined (simply ungrouped).
    const calls = store.readLlmCalls("c1");
    expect(calls.length).toBe(1);
    expect(calls[0]?.turnSeq).toBeUndefined();
    // The trace table now exists and is usable.
    store.recordTurnTrace({ campaignId: "c1", characterId: "", turnSeq: 2, seqStart: 2, seqEnd: 2, atStart: 1, atEnd: 1, trigger: "heartbeat", npcId: "npc.lyra" });
    expect(store.readTraces("c1", "").length).toBe(1);
    store.close();

    const db = new Database(DB);
    const cols = db.query(`PRAGMA table_info(llm_calls)`).all() as { name: string }[];
    expect(cols.some((c) => c.name === "turn_seq")).toBe(true);
    expect(cols.some((c) => c.name === "provider_finish")).toBe(true);
    expect((db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version).toBe(6);
    db.close();
  });

  test("pruneTelemetry drops old llm_calls/turn_traces rows but NEVER touches events (rewind-load-bearing)", async () => {
    const store = new BunSqliteGameStateStore(DB);
    const now = Date.now();
    const old = now - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const call = (at: number) =>
      store.recordLlmCall({
        campaignId: "c1", at, role: "utility", model: "m", kind: "complete",
        request: {}, responseText: "x", reasoningText: "", latencyMs: 1, finish: "ok",
      });
    const trace = (atEnd: number, turnSeq: number) =>
      store.recordTurnTrace({
        campaignId: "c1", characterId: "pc.you", turnSeq, seqStart: turnSeq, seqEnd: turnSeq,
        atStart: atEnd - 1, atEnd, trigger: "player",
      });
    call(old);
    call(now);
    trace(old, 1);
    trace(now, 2);
    // An events row as old as the stale telemetry — retention must not reach it.
    await store.appendEvent(K(), { ...ev(1), at: old });

    store.pruneTelemetry(7);
    expect(store.readLlmCalls("c1").length).toBe(1);
    expect(store.readLlmCalls("c1")[0]?.at).toBe(now);
    const traces = store.readTraces("c1", "pc.you");
    expect(traces.length).toBe(1);
    expect(traces[0]?.turnSeq).toBe(2);
    expect((await store.readEvents(K())).length).toBe(1);
    store.close();
  });
});
