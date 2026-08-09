/**
 * NPC-memory reducer + replay spine (M4 Part B) — the single-writer + `snapshot == fold(deltas)`
 * contract for the per-NPC journal. Pure, deterministic, no engine/IO. Asserts: append, salience-based
 * capping (keep highest-salience, ties → recent, chronological storage; all-same-kind degrades to
 * drop-oldest), the pure `salience`/`capJournal` leaf functions, clear (mutates / noop), and that the
 * recorded delta carries the ABSOLUTE post-cap journal so a re-fold is idempotent.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { applyCommand } from "../src/world/reducer.ts";
import { applyDelta } from "./support/replay.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { npcMemorySlice } from "../src/world/module-slices.ts";
import { capJournal, NPC_MEMORY_CAP, salience, type NpcMemoryEntry } from "../src/rules/npc-memory.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import { loadExample } from "./support/harness.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";

async function exampleModel(): Promise<WorldModel> {
  const playset = await loadExample();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  return fromGameState(engine.getState(), playset.world, playset.campaign);
}

const entry = (at: number, summary: string, kind = "addressed"): NpcMemoryEntry => ({ at, kind, summary });

/** Stamp a pre-delta with the id/at/seq the bus assigns, yielding a full DeltaEvent. */
const stamp = (pre: EmittedDelta, seq: number): DeltaEvent =>
  ({ ...pre, id: `d${seq}`, at: 0, seq }) as DeltaEvent;

describe("salience + capJournal — pure retention math", () => {
  test("salience orders kinds: questResolved > attireObserved > relationship == addressed > unknown > traveled", () => {
    const sQuest = salience(entry(0, "q", "questResolved"));
    const sAttire = salience(entry(0, "e", "attireObserved"));
    const sRel = salience(entry(0, "r", "relationship"));
    const sAddr = salience(entry(0, "a", "addressed"));
    const sUnknown = salience(entry(0, "u", "somethingNew"));
    const sTravel = salience(entry(0, "t", "traveled"));
    expect(sQuest).toBeGreaterThan(sAttire);
    expect(sAttire).toBeGreaterThan(sRel); // a witnessed attire change outranks the mid social beats
    expect(sRel).toBe(sAddr); // the two mid social beats tie
    expect(sAddr).toBeGreaterThan(sUnknown); // unknown is a mid default, below the named social beats
    expect(sUnknown).toBeGreaterThan(sTravel); // ...but deliberately above bulk traveled
  });

  test("under (and at) cap the input array is returned unchanged", () => {
    const j = [entry(1, "a"), entry(2, "b"), entry(3, "c")];
    expect(capJournal(j, 5)).toBe(j); // identity — not even a copy when under cap
    const atCap = [entry(1, "a"), entry(2, "b")];
    expect(capJournal(atCap, 2)).toBe(atCap);
  });

  test("over cap with mixed kinds keeps a high-salience beat that FIFO would have evicted", () => {
    // One questResolved first, then `cap` traveled beats. FIFO (drop-oldest) would evict the quest;
    // salience must keep it. Length collapses to cap; the quest beat survives.
    const cap = NPC_MEMORY_CAP;
    const journal: NpcMemoryEntry[] = [entry(0, "QUEST DONE", "questResolved")];
    for (let i = 1; i <= cap; i++) journal.push(entry(i, `traveled ${i}`, "traveled"));
    expect(journal).toHaveLength(cap + 1);
    const capped = capJournal(journal, cap);
    expect(capped).toHaveLength(cap);
    expect(capped.some((e) => e.summary === "QUEST DONE")).toBe(true);
    // It is the oldest traveled beat (at=1) that fell off, not the quest.
    expect(capped.some((e) => e.summary === "traveled 1")).toBe(false);
    expect(capped.some((e) => e.summary === `traveled ${cap}`)).toBe(true);
  });

  test("ties (same salience) break by recency — the more recent entries survive", () => {
    // 4 traveled beats (all equal salience), cap 2 → keep the two most recent by `at`.
    const journal = [entry(1, "t1", "traveled"), entry(2, "t2", "traveled"), entry(3, "t3", "traveled"), entry(4, "t4", "traveled")];
    const capped = capJournal(journal, 2);
    expect(capped.map((e) => e.summary)).toEqual(["t3", "t4"]); // chronological + most-recent two
  });

  test("the kept set is returned in chronological order, length exactly min(len, cap)", () => {
    // Interleave kinds so salience ordering != chronological ordering; assert storage is re-sorted.
    const journal: NpcMemoryEntry[] = [
      entry(1, "trav a", "traveled"),
      entry(2, "QUEST", "questResolved"),
      entry(3, "trav b", "traveled"),
      entry(4, "talk", "addressed"),
      entry(5, "trav c", "traveled"),
    ];
    const capped = capJournal(journal, 3);
    expect(capped).toHaveLength(3); // min(5, 3)
    // Kept by salience: QUEST(100), talk(50), then the most-recent traveled (trav c, at=5).
    // Stored chronologically by original `at`: QUEST(2) → talk(4) → trav c(5).
    expect(capped.map((e) => e.summary)).toEqual(["QUEST", "talk", "trav c"]);
    expect(capped.map((e) => e.at)).toEqual([2, 4, 5]); // strictly increasing ⇒ chronological
  });

  test("all-same-kind degrades to drop-oldest (FIFO) via the recency tiebreak", () => {
    const journal = Array.from({ length: 6 }, (_, i) => entry(i, `t${i}`, "traveled"));
    const capped = capJournal(journal, 4);
    // The 2 oldest fall off; the kept 4 stay chronological — identical to a FIFO splice.
    expect(capped.map((e) => e.summary)).toEqual(["t2", "t3", "t4", "t5"]);
  });
});

describe("reducer — recordNpcMemory", () => {
  test("appends a beat and emits the absolute post-state journal", async () => {
    const model = await exampleModel();
    const res = applyCommand(model, { type: "recordNpcMemory", npcId: "npc.lyra", entry: entry(1, "Spoke with You.") });
    expect(res.mutated).toBe(true);
    expect(res.deltas).toHaveLength(1);
    const d = res.deltas[0];
    expect(d?.kind).toBe("npcMemoryRecorded");
    // The delta carries the FULL journal (absolute post-state), not just the appended entry.
    expect((d as { entries: NpcMemoryEntry[] }).entries).toEqual([entry(1, "Spoke with You.")]);
    expect(npcMemorySlice(model).entries["npc.lyra"]).toEqual([entry(1, "Spoke with You.")]);
  });

  test("a second record appends (oldest first)", async () => {
    const model = await exampleModel();
    applyCommand(model, { type: "recordNpcMemory", npcId: "npc.lyra", entry: entry(1, "one") });
    applyCommand(model, { type: "recordNpcMemory", npcId: "npc.lyra", entry: entry(2, "two") });
    expect(npcMemorySlice(model).entries["npc.lyra"]?.map((e) => e.summary)).toEqual(["one", "two"]);
  });

  test("the journal is bounded at NPC_MEMORY_CAP, dropping the OLDEST", async () => {
    const model = await exampleModel();
    for (let i = 0; i < NPC_MEMORY_CAP + 5; i++) {
      applyCommand(model, { type: "recordNpcMemory", npcId: "npc.lyra", entry: entry(i, `beat ${i}`) });
    }
    const journal = npcMemorySlice(model).entries["npc.lyra"] ?? [];
    expect(journal).toHaveLength(NPC_MEMORY_CAP);
    // The 5 oldest fell off; the newest is the last recorded; the emitted delta reflects the cap too.
    expect(journal[0]?.summary).toBe("beat 5");
    expect(journal.at(-1)?.summary).toBe(`beat ${NPC_MEMORY_CAP + 4}`);
  });

  test("recording past the cap retains a high-salience beat a FIFO splice would have evicted", async () => {
    const model = await exampleModel();
    // A questResolved first, then enough traveled beats to overflow the cap.
    applyCommand(model, {
      type: "recordNpcMemory",
      npcId: "npc.lyra",
      entry: entry(0, "QUEST DONE", "questResolved"),
    });
    let lastDelta: EmittedDelta | undefined;
    for (let i = 1; i <= NPC_MEMORY_CAP; i++) {
      lastDelta = applyCommand(model, {
        type: "recordNpcMemory",
        npcId: "npc.lyra",
        entry: entry(i, `traveled ${i}`, "traveled"),
      }).deltas[0] as EmittedDelta;
    }
    const journal = npcMemorySlice(model).entries["npc.lyra"] ?? [];
    expect(journal).toHaveLength(NPC_MEMORY_CAP);
    // The quest beat survives in the slice (FIFO would have dropped it as the oldest entry)...
    expect(journal.some((e) => e.kind === "questResolved")).toBe(true);
    expect(journal.some((e) => e.summary === "traveled 1")).toBe(false); // the oldest traveled fell off instead
    // ...and the emitted absolute delta carries the same capped journal (so replay reproduces it).
    expect((lastDelta as { entries: NpcMemoryEntry[] }).entries).toEqual(journal);
  });

  test("the stored entry is a copy — mutating the input later doesn't change the journal", async () => {
    const model = await exampleModel();
    const e = entry(1, "original");
    applyCommand(model, { type: "recordNpcMemory", npcId: "npc.lyra", entry: e });
    e.summary = "tampered";
    expect(npcMemorySlice(model).entries["npc.lyra"]?.[0]?.summary).toBe("original");
  });
});

describe("reducer — clearNpcMemory", () => {
  test("clears a populated journal and emits npcMemoryCleared", async () => {
    const model = await exampleModel();
    applyCommand(model, { type: "recordNpcMemory", npcId: "npc.lyra", entry: entry(1, "x") });
    const res = applyCommand(model, { type: "clearNpcMemory", npcId: "npc.lyra" });
    expect(res.mutated).toBe(true);
    expect(res.deltas[0]?.kind).toBe("npcMemoryCleared");
    expect(npcMemorySlice(model).entries["npc.lyra"]).toBeUndefined();
  });

  test("clearing an NPC with no journal is a noop (no delta)", async () => {
    const model = await exampleModel();
    const res = applyCommand(model, { type: "clearNpcMemory", npcId: "npc.nobody" });
    expect(res.mutated).toBe(false);
    expect(res.deltas).toHaveLength(0);
  });
});

describe("replay — absolute-overwrite fold is idempotent", () => {
  test("npcMemoryRecorded overwrites with the absolute journal (applying twice == once)", async () => {
    const live = await exampleModel();
    const pre = applyCommand(live, {
      type: "recordNpcMemory",
      npcId: "npc.lyra",
      entry: entry(7, "Spoke with You."),
    }).deltas[0] as EmittedDelta;
    const delta = stamp(pre, 0);

    const target = structuredClone(live);
    // Wipe the slice on the target so the fold has to reconstruct it from the delta alone.
    target.modules.npcMemory = { entries: {} };
    applyDelta(target, delta);
    applyDelta(target, delta); // idempotent: re-applying the same absolute delta changes nothing
    expect(npcMemorySlice(target).entries["npc.lyra"]).toEqual([entry(7, "Spoke with You.")]);
    expect(npcMemorySlice(target).entries["npc.lyra"]).toEqual(npcMemorySlice(live).entries["npc.lyra"]);
  });

  test("npcMemoryCleared deletes the journal on fold", async () => {
    const live = await exampleModel();
    applyCommand(live, { type: "recordNpcMemory", npcId: "npc.lyra", entry: entry(1, "x") });
    const pre = applyCommand(live, { type: "clearNpcMemory", npcId: "npc.lyra" }).deltas[0] as EmittedDelta;

    const target = structuredClone(live);
    target.modules.npcMemory = { entries: { "npc.lyra": [entry(1, "x")] } };
    applyDelta(target, stamp(pre, 0));
    expect(npcMemorySlice(target).entries["npc.lyra"]).toBeUndefined();
  });

  test("the slice rides GameState.modules (auto-persists, no store change)", async () => {
    const model = await exampleModel();
    applyCommand(model, { type: "recordNpcMemory", npcId: "npc.lyra", entry: entry(3, "remembered") });
    const gs = toGameState(model);
    const slice = gs.modules?.npcMemory as { entries: Record<string, NpcMemoryEntry[]> };
    expect(slice.entries["npc.lyra"]).toEqual([entry(3, "remembered")]);
    // And it survives a projection round-trip (the persistence path).
    const playset = await loadExample();
    const again = toGameState(fromGameState(gs, playset.world, playset.campaign));
    expect((again.modules?.npcMemory as typeof slice).entries["npc.lyra"]).toEqual([entry(3, "remembered")]);
  });
});
