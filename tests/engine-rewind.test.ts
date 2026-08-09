/**
 * Edit-a-past-message & rewind — the engine primitive (`rewindTo`) plus the store truncation it
 * rides on. Fully deterministic (offline gateway + seeded rng + in-memory / temp-file stores).
 *
 * The fold itself (`snapshot == fold(deltas)`, all 35 delta kinds) is proven in replay.test.ts;
 * here we prove the ENGINE wires the fold + authored-content reset + log truncation together so a
 * rewind lands the world exactly at the end of the prior turn and discards everything after it.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEngine } from "./support/harness.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { BunSqliteGameStateStore } from "../src/state/sqlite-store.ts";
import { makeSaveKey, type SaveKey } from "../src/state/store.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";
import type { TurnTrace } from "../src/logging/types.ts";

const PLAYER = "pc.you";

/** The durable seqs of the player's own public dialogue lines (the rewind anchors), oldest first. */
async function playerLineSeqs(store: { readEvents: InMemoryGameStateStore["readEvents"] }, key: SaveKey): Promise<number[]> {
  const log = await store.readEvents(key, { includeSilent: true });
  return log
    .filter((e) => e.kind === "dialogue" && (e as { actorId?: string }).actorId === PLAYER && (e as { channel?: string }).channel !== "private")
    .map((e) => e.seq);
}

/** Everything the rewind must restore exactly — source-of-truth fields only. The `autonomy` slice is
 *  excluded: the resumed turn's perceive phase folds in one silent replyDepth reset (boundary
 *  semantics, replay.test.ts) that is overwritten by the resubmitted turn — bookkeeping, not truth. */
function sourceOfTruth(state: GameState): Omit<GameState, "autonomy"> {
  const clone = structuredClone(state);
  delete (clone as { autonomy?: unknown }).autonomy;
  return clone;
}

const combatActive = (state: GameState): boolean =>
  (state.modules?.combat as { active?: boolean } | undefined)?.active === true;

describe("store: beforeSeq + deleteEventsAfter", () => {
  const ev = (seq: number): GameEvent => ({ kind: "narration", text: `n${seq}`, id: `e${seq}`, at: 0, seq }) as GameEvent;

  test("readEvents({beforeSeq}) is an exclusive upper bound; deleteEventsAfter truncates the log", async () => {
    const store = new InMemoryGameStateStore();
    const key = makeSaveKey("c.x", PLAYER);
    for (let i = 0; i < 6; i++) await store.appendEvent(key, ev(i));

    expect((await store.readEvents(key, { beforeSeq: 3 })).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await store.readEvents(key, { beforeSeq: 0 })).map((e) => e.seq)).toEqual([]);

    store.deleteEventsAfter(key, 3);
    expect((await store.readEvents(key)).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(await store.getMaxSeq(key)).toBe(2);
  });

  test("sqlite deleteEventsAfter drops events AND turn_traces whose span reaches the tail", async () => {
    const path = join(tmpdir(), `seed-rewind-${process.pid}-${globalThis.performance.now()}.db`);
    const store = new BunSqliteGameStateStore(path);
    try {
      const key = makeSaveKey("c.x", PLAYER);
      for (let i = 0; i < 6; i++) await store.appendEvent(key, ev(i));
      const trace = (turnSeq: number, seqStart: number, seqEnd: number): TurnTrace => ({
        campaignId: key.campaignId,
        characterId: key.characterId,
        turnSeq,
        seqStart,
        seqEnd,
        atStart: 0,
        atEnd: 0,
        trigger: "player",
      });
      store.recordTurnTrace(trace(0, 0, 2)); // kept (seq_end 2 < 3)
      store.recordTurnTrace(trace(3, 3, 5)); // dropped (seq_end 5 >= 3)

      store.deleteEventsAfter(key, 3);

      expect((await store.readEvents(key)).map((e) => e.seq)).toEqual([0, 1, 2]);
      const traces = store.readTraces(key.campaignId, key.characterId);
      expect(traces.map((t) => t.turnSeq)).toEqual([0]);
    } finally {
      store.close?.();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});

describe("engine.rewindTo", () => {
  test("rewinds to the end of the prior turn, truncates downstream, and resubmits fresh", async () => {
    const { engine, store, playset } = await makeEngine();
    const key = makeSaveKey(playset.campaign.id, PLAYER);

    await engine.submitPlayerInput("I study the firelight and the worn floorboards.");
    const endOfTurn1 = sourceOfTruth(engine.getState());

    await engine.submitPlayerInput("I step toward the hearth to warm my hands.");
    await engine.submitPlayerInput("I hum an old road-song under my breath.");

    const anchors = await playerLineSeqs(store, key);
    expect(anchors.length).toBe(3);
    const preMax = await store.getMaxSeq(key);

    // Rewind to just before turn 2 → the world is back at the end of turn 1.
    await engine.rewindTo(anchors[1]!);

    expect(sourceOfTruth(engine.getState())).toEqual(endOfTurn1);

    // The log is truncated: nothing at/after the anchor survives, and the high-water mark dropped.
    const kept = await store.readEvents(key, { includeSilent: true });
    expect(kept.every((e) => e.seq < anchors[1]!)).toBe(true);
    const truncMax = await store.getMaxSeq(key);
    expect(truncMax).toBeLessThan(preMax);
    expect(truncMax).toBeLessThan(anchors[1]!);

    // Resubmit a DIFFERENT line — the edited turn streams from the reseeded head.
    await engine.submitPlayerInput("Instead, I slip out the back door into the night.");
    const after = await store.readEvents(key, { includeSilent: true });
    const edited = after.find(
      (e) => e.kind === "dialogue" && (e as { text?: string }).text === "Instead, I slip out the back door into the night.",
    );
    expect(edited).toBeDefined();
    expect(edited!.seq).toBeGreaterThan(truncMax);
    expect(await store.getMaxSeq(key)).toBeGreaterThan(truncMax);
  });

  test("regenerate: rewind to the last player line + resubmit the same text is a single fresh turn", async () => {
    const { engine, store, playset } = await makeEngine();
    const key = makeSaveKey(playset.campaign.id, PLAYER);

    await engine.submitPlayerInput("I look around the common room.");
    const line = "I ask the room who runs this place.";
    await engine.submitPlayerInput(line);

    const anchors = await playerLineSeqs(store, key);
    const lastAnchor = anchors.at(-1)!;

    await engine.rewindTo(lastAnchor);
    // After rewind the resubmitted line does not yet exist in the kept log.
    const kept = await store.readEvents(key, { includeSilent: true });
    expect(kept.some((e) => e.kind === "dialogue" && (e as { text?: string }).text === line)).toBe(false);

    await engine.submitPlayerInput(line); // same text → new dice/prose
    const anchorsAfter = await playerLineSeqs(store, key);
    expect(anchorsAfter.length).toBe(2); // still exactly two player lines, not three
    expect(anchorsAfter[0]).toBe(anchors[0]); // the kept first line's seq is unchanged
  });

  test("mid-combat edit: rewinding to before the fight clears the combat slice", async () => {
    const { engine, store, playset } = await makeEngine();
    const key = makeSaveKey(playset.campaign.id, PLAYER);

    await engine.submitPlayerInput("I warm myself by the fire a while.");
    const peaceful = sourceOfTruth(engine.getState());
    expect(combatActive(engine.getState())).toBe(false);
    expect(engine.getState().companions).toContain("npc.lyra");

    // Turn the blade on the companion — deliberate betrayal starts a real, logged fight.
    await engine.submitPlayerInput("I attack Lyra.");
    expect(combatActive(engine.getState())).toBe(true);

    const anchors = await playerLineSeqs(store, key);
    await engine.rewindTo(anchors.at(-1)!); // to before the attack

    expect(combatActive(engine.getState())).toBe(false);
    // The party slice folds back too: the struck companion is a member again.
    expect(engine.getState().companions).toContain("npc.lyra");
    expect(sourceOfTruth(engine.getState())).toEqual(peaceful);
  });

  test("aborts (state intact) when the atomic rewind transaction fails", async () => {
    // The store rejects its atomic truncate+snapshot unit. The engine must leave its live model and
    // durable log untouched instead of presenting a rewind that never committed.
    class NoTruncateStore extends InMemoryGameStateStore {
      override rewindSave(): Promise<void> {
        return Promise.reject(new Error("forced atomic rewind failure"));
      }
    }
    const store = new NoTruncateStore();
    const { engine, playset } = await makeEngine({ store });
    const key = makeSaveKey(playset.campaign.id, PLAYER);
    await engine.submitPlayerInput("I trace a knot in the wood grain.");
    await engine.submitPlayerInput("I count the coins in my purse.");
    const anchors = await playerLineSeqs(store, key);
    const before = structuredClone(engine.getState());
    const maxBefore = await store.getMaxSeq(key);

    await expect(engine.rewindTo(anchors.at(-1)!)).rejects.toThrow(/forced atomic rewind failure/i);

    // Nothing changed: the live state and the durable log are exactly as they were.
    expect(engine.getState()).toEqual(before);
    expect(await store.getMaxSeq(key)).toBe(maxBefore);
  });

  test("rejects an anchor that is not one of the player's own lines", async () => {
    const { engine, store, playset } = await makeEngine();
    const key = makeSaveKey(playset.campaign.id, PLAYER);
    await engine.submitPlayerInput("I nod to no one in particular.");
    const max = await store.getMaxSeq(key);
    // seq 0 is the opening narration, never a player dialogue line.
    await expect(engine.rewindTo(0)).rejects.toThrow();
    // An out-of-range anchor has no event at all.
    await expect(engine.rewindTo(max + 50)).rejects.toThrow();
  });
});
