/** Authoritative engine persistence: fail-closed startup, staged publication, tail recovery, and rollback. */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaySet } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { GameEvent } from "../src/events/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { BunSqliteGameStateStore } from "../src/state/sqlite-store.ts";
import type { CommittedSnapshot, SaveKey } from "../src/state/store.ts";
import type { GameState } from "../src/state/types.ts";
import { loadExample } from "./support/harness.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";

function engineFor(playset: PlaySet, store: InMemoryGameStateStore | BunSqliteGameStateStore): GameEngine {
  return new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    classifier: heuristicClassifier,
    rng: mulberry32(17),
    summary: false,
  });
}

class FaultStore extends InMemoryGameStateStore {
  failCommit = false;
  failLoad = false;
  failReplace = false;

  override loadCommitted(key: SaveKey): Promise<CommittedSnapshot | null> {
    if (this.failLoad) return Promise.reject(new Error("forced snapshot read failure"));
    return super.loadCommitted(key);
  }

  override commitTurn(key: SaveKey, state: GameState, events: readonly GameEvent[]): Promise<void> {
    if (this.failCommit) return Promise.reject(new Error("forced turn commit failure"));
    return super.commitTurn(key, state, events);
  }

  override replaceSave(
    key: SaveKey,
    state: GameState,
    events: readonly GameEvent[] = [],
    options: { replayableFromOrigin?: boolean } = {},
  ): Promise<void> {
    if (this.failReplace) return Promise.reject(new Error("forced save replacement failure"));
    return super.replaceSave(key, state, events, options);
  }
}

describe("engine authoritative commit boundary", () => {
  test("a failed turn commit rolls back live state/log/seq and publishes none of the staged turn", async () => {
    const playset = await loadExample();
    const store = new FaultStore();
    const engine = engineFor(playset, store);
    const observed: GameEvent[] = [];
    engine.subscribe((event) => observed.push(event));
    await engine.start();
    observed.length = 0;

    const key = { campaignId: playset.campaign.id, characterId: playset.campaign.startingState.party[0]! };
    const stateBefore = structuredClone(engine.getState());
    const logBefore = structuredClone(await store.readEvents(key, { includeSilent: true }));
    const seqBefore = engine.bus.currentSeq?.();
    store.failCommit = true;

    await expect(engine.submitPlayerInput("I study the room in silence.")).rejects.toThrow(/forced turn commit/i);

    expect(engine.getState()).toEqual(stateBefore);
    expect(await store.readEvents(key, { includeSilent: true })).toEqual(logBefore);
    expect(engine.bus.currentSeq?.()).toBe(seqBefore);
    expect(observed).toEqual([]);
  });

  test("snapshot read errors fail closed and never overwrite the existing campaign", async () => {
    const playset = await loadExample();
    const store = new FaultStore();
    const first = engineFor(playset, store);
    await first.start();
    first.stop();
    const key = { campaignId: playset.campaign.id, characterId: playset.campaign.startingState.party[0]! };
    const stateBefore = await store.load(key);
    const logBefore = structuredClone(await store.readEvents(key, { includeSilent: true }));

    store.failLoad = true;
    const resumed = engineFor(playset, store);
    const observed: GameEvent[] = [];
    resumed.subscribe((event) => observed.push(event));
    await expect(resumed.start()).rejects.toThrow(/forced snapshot read failure/i);

    store.failLoad = false;
    expect(await store.load(key)).toEqual(stateBefore);
    expect(await store.readEvents(key, { includeSilent: true })).toEqual(logBefore);
    expect(observed).toEqual([]);
  });

  test("fresh opening prose is replaced atomically and is invisible when replacement fails", async () => {
    const playset = await loadExample();
    const store = new FaultStore();
    store.failReplace = true;
    const engine = engineFor(playset, store);
    const observed: GameEvent[] = [];
    engine.subscribe((event) => observed.push(event));

    await expect(engine.start()).rejects.toThrow(/forced save replacement failure/i);

    const key = { campaignId: playset.campaign.id, characterId: playset.campaign.startingState.party[0]! };
    expect(await store.load(key)).toBeNull();
    expect(await store.readEvents(key, { includeSilent: true })).toEqual([]);
    expect(observed).toEqual([]);
  });

  test("a failed restart replacement restores the running state and publishes no restart fiction", async () => {
    const playset = await loadExample();
    const store = new FaultStore();
    const engine = engineFor(playset, store);
    const observed: GameEvent[] = [];
    engine.subscribe((event) => observed.push(event));
    await engine.start();
    await engine.submitPlayerInput("I wait by the hearth.");
    const key = { campaignId: playset.campaign.id, characterId: playset.campaign.startingState.party[0]! };
    const stateBefore = structuredClone(engine.getState());
    const logBefore = structuredClone(await store.readEvents(key, { includeSilent: true }));
    observed.length = 0;
    store.failReplace = true;

    await expect(engine.restart()).rejects.toThrow(/forced save replacement failure/i);

    expect(engine.getState()).toEqual(stateBefore);
    expect(await store.readEvents(key, { includeSilent: true })).toEqual(logBefore);
    expect(observed).toEqual([]);
  });

  test("startup folds a durable tail beyond the snapshot cursor and checkpoints it", async () => {
    const playset = await loadExample();
    const store = new FaultStore();
    const first = engineFor(playset, store);
    await first.start();
    const key = { campaignId: playset.campaign.id, characterId: playset.campaign.startingState.party[0]! };
    const before = first.getState().clock;
    const seq = (await store.getMaxSeq(key)) + 1;
    await store.appendEvent(key, {
      id: "tail-clock",
      at: 1,
      seq,
      kind: "clockAdvanced",
      by: 7,
      to: before + 7,
      silent: true,
    });
    first.stop();

    const resumed = engineFor(playset, store);
    await resumed.start();

    expect(resumed.getState().clock).toBe(before + 7);
    expect((await store.loadCommitted(key))?.eventSeq).toBe(seq);
  });

  test("a missing snapshot with a nonempty log is not mistaken for a new game", async () => {
    const playset = await loadExample();
    const store = new FaultStore();
    const key = { campaignId: playset.campaign.id, characterId: playset.campaign.startingState.party[0]! };
    await store.appendEvent(key, { id: "orphan", at: 1, seq: 0, kind: "narration", text: "orphaned" });

    await expect(engineFor(playset, store).start()).rejects.toThrow(/snapshot is missing/i);
    expect((await store.readEvents(key)).map((event) => event.id)).toEqual(["orphan"]);
  });
});

describe("corrupt snapshot recovery", () => {
  test("a marked replay-complete SQLite save reconstructs from retained deltas", async () => {
    const path = join(tmpdir(), `seed-corrupt-recovery-${process.pid}-${performance.now()}.db`);
    const store = new BunSqliteGameStateStore(path);
    try {
      const firstPlayset = await loadExample();
      const first = engineFor(firstPlayset, store);
      await first.start();
      await first.submitPlayerInput("I wait and listen.");
      const expected = first.getState();
      first.stop();

      const db = new Database(path);
      db.run(`UPDATE snapshots SET json = '{broken json'`);
      db.close();

      const resumed = engineFor(await loadExample(), store);
      await resumed.start();
      expect(resumed.getState()).toEqual(expected);
      expect(await store.load({ campaignId: expected.campaignId, characterId: expected.party[0]! })).toEqual(expected);
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  test("an unmarked legacy-style corrupt snapshot fails closed instead of guessing", async () => {
    const path = join(tmpdir(), `seed-corrupt-legacy-${process.pid}-${performance.now()}.db`);
    const playset = await loadExample();
    const source = engineFor(playset, new InMemoryGameStateStore());
    await source.start();
    const state = source.getState();
    source.stop();
    const store = new BunSqliteGameStateStore(path);
    try {
      const key = { campaignId: state.campaignId, characterId: state.party[0]! };
      // Plain save() deliberately does not certify that an origin-complete log exists.
      await store.save(key, state);
      const db = new Database(path);
      db.run(`UPDATE snapshots SET json = '{broken json'`);
      db.close();

      await expect(engineFor(await loadExample(), store).start()).rejects.toThrow(/json|save|snapshot/i);
      const dbAfter = new Database(path);
      expect((dbAfter.query(`SELECT json FROM snapshots`).get() as { json: string }).json).toBe("{broken json");
      dbAfter.close();
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
});
