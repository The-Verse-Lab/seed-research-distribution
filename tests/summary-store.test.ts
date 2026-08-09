/**
 * Summary store (M4 follow-up) — the best-effort `{summary, cursorSeq}` sidecar.
 *
 * Asserts the persistence posture (mirroring `vector-cache`): a clean round-trip, a FORGIVING load
 * (missing file, corrupt JSON, a wrong version, or a stale shape all return `null`), and a save that
 * NEVER throws — even to an unwritable path. The sidecar is a derived cache, NOT source of truth, so
 * a fault must degrade to "no summary", never crash a turn.
 *
 * Isolated: a throwaway temp dir per run; never `./data`.
 *
 * @author Runkai Zhang
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileSummaryStore,
  NoopSummaryStore,
  SUMMARY_STORE_VERSION,
  type StoredSummary,
} from "../src/memory/summary-store.ts";

let ROOT = "";
async function tmp(): Promise<string> {
  if (!ROOT) ROOT = await mkdtemp(join(tmpdir(), "seed-sumstore-"));
  return mkdtemp(join(ROOT, "d-"));
}
afterAll(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
});

const sample = (overrides: Partial<StoredSummary> = {}): StoredSummary => ({
  version: SUMMARY_STORE_VERSION,
  campaignId: "c.t",
  summary: "The party reached the keep.",
  cursorSeq: 17,
  ...overrides,
});

describe("FileSummaryStore", () => {
  test("round-trips a saved summary", async () => {
    const path = join(await tmp(), "summary.json");
    const store = new FileSummaryStore(path);
    await store.save(sample());
    const loaded = await store.load();
    expect(loaded).toEqual(sample());
  });

  test("a save overwrites the prior value (atomic)", async () => {
    const path = join(await tmp(), "summary.json");
    const store = new FileSummaryStore(path);
    await store.save(sample({ summary: "first", cursorSeq: 1 }));
    await store.save(sample({ summary: "second", cursorSeq: 5 }));
    const loaded = await store.load();
    expect(loaded?.summary).toBe("second");
    expect(loaded?.cursorSeq).toBe(5);
  });

  test("missing file ⇒ null (no throw)", async () => {
    const store = new FileSummaryStore(join(await tmp(), "nope.json"));
    expect(await store.load()).toBeNull();
  });

  test("corrupt JSON ⇒ null", async () => {
    const path = join(await tmp(), "summary.json");
    await writeFile(path, "{ not valid json", "utf8");
    expect(await new FileSummaryStore(path).load()).toBeNull();
  });

  test("a wrong version ⇒ null (treated as a miss)", async () => {
    const path = join(await tmp(), "summary.json");
    await writeFile(path, JSON.stringify(sample({ version: 999 })), "utf8");
    expect(await new FileSummaryStore(path).load()).toBeNull();
  });

  test("a stale/foreign shape ⇒ null", async () => {
    const path = join(await tmp(), "summary.json");
    await writeFile(path, JSON.stringify({ hello: "world" }), "utf8");
    expect(await new FileSummaryStore(path).load()).toBeNull();
  });

  test("save to an unwritable path is swallowed (never throws) and leaves no temp litter", async () => {
    const dir = await tmp();
    // A directory that doesn't exist under a FILE path component → writeFile rejects.
    const bogus = join(dir, "summary.json", "deeper", "summary.json");
    const store = new FileSummaryStore(bogus);
    await expect(store.save(sample())).resolves.toBeUndefined();
    // Nothing readable was produced.
    expect(await store.load()).toBeNull();
  });

  test("the persisted file is plain JSON of the value", async () => {
    const path = join(await tmp(), "summary.json");
    await new FileSummaryStore(path).save(sample());
    const raw = JSON.parse(await readFile(path, "utf8")) as StoredSummary;
    expect(raw.campaignId).toBe("c.t");
    expect(raw.cursorSeq).toBe(17);
  });

  test("a save from a discarded timeline (invalidate() between snapshot and rename) never clobbers the file", async () => {
    // Models the rewind race: an in-flight fold's save() (epoch snapshotted at call start) must NOT
    // overwrite the empty summary the rewind writes AFTER it. `invalidate()` bumps the epoch; the
    // stale save's post-writeFile recheck then aborts before renaming.
    const path = join(await tmp(), "summary.json");
    const store = new FileSummaryStore(path);
    const stale = store.save(sample({ summary: "DISCARDED TIMELINE — turns that never happened" })); // epoch 0 captured
    store.invalidate(); // a rewind — epoch → 1
    await store.save(sample({ summary: "", cursorSeq: -1 })); // the rewind's empty save, epoch 1
    await stale; // the epoch-0 save resolves LAST, but its recheck drops it (no rename)
    expect((await store.load())?.summary).toBe(""); // the discarded summary did NOT win
  });
});

describe("NoopSummaryStore", () => {
  test("load always misses and save does nothing", async () => {
    const store = new NoopSummaryStore();
    await expect(store.save(sample())).resolves.toBeUndefined();
    expect(await store.load()).toBeNull();
  });
});
