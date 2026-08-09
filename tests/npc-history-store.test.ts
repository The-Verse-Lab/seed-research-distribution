/**
 * NpcHistoryStore — the derived per-NPC history cache: day-buffer accrual, the sleep-consolidation
 * fold (clears the buffer), and best-effort JSON persistence (round-trip + a campaign-id guard). The
 * fold's model call is stubbed; whether it uses the model text or the deterministic floor, the buffer
 * must clear and the history must land.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmGateway } from "../src/llm/gateway.ts";
import { NpcHistoryStore, npcHistorySidecarPath } from "../src/memory/npc-history-store.ts";

/** A gateway whose `complete` returns fixed prose — enough for `foldNpcHistory`. */
const stubGateway = (text: string): LlmGateway =>
  ({ complete: async () => ({ text, model: "stub-model", blocked: false }) }) as unknown as LlmGateway;

describe("NpcHistoryStore", () => {
  test("recordGist accrues into the day-buffer; get defaults to empty", () => {
    const s = new NpcHistoryStore(null, "c1");
    expect(s.get("npc.a")).toEqual({ history: "", dayGists: [] });
    s.recordGist("npc.a", "Asked about the ledger.");
    s.recordGist("npc.a", "   "); // blank ignored
    expect(s.get("npc.a").dayGists).toEqual(["Asked about the ledger."]);
  });

  test("foldAll consolidates the day-gists into history and CLEARS the buffer", async () => {
    const s = new NpcHistoryStore(null, "c1");
    s.recordGist("npc.a", "one");
    s.recordGist("npc.a", "two");
    await s.foldAll(stubGateway("A folded memory."));
    const h = s.get("npc.a");
    expect(h.dayGists).toEqual([]); // buffer cleared at the fold
    expect(h.history.length).toBeGreaterThan(0); // consolidated (model text or deterministic floor)
  });

  test("foldAll is a no-op for an NPC with no gists", async () => {
    const s = new NpcHistoryStore(null, "c1");
    await s.foldAll(stubGateway("should not appear"));
    expect(s.get("npc.a")).toEqual({ history: "", dayGists: [] });
  });

  test("save → load round-trips per-NPC history to the sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-npc-hist-"));
    const path = npcHistorySidecarPath(dir, { campaignId: "c1", characterId: "pc.you" });
    const a = new NpcHistoryStore(path, "c1");
    a.recordGist("npc.a", "remembered");
    await a.save();
    const b = new NpcHistoryStore(path, "c1");
    await b.load();
    expect(b.get("npc.a").dayGists).toEqual(["remembered"]);
  });

  test("load rejects a campaign-id mismatch (a stale/foreign sidecar starts blank)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-npc-hist-"));
    const path = npcHistorySidecarPath(dir, { campaignId: "c1", characterId: "pc.you" });
    const a = new NpcHistoryStore(path, "c1");
    a.recordGist("npc.a", "x");
    await a.save();
    const other = new NpcHistoryStore(path, "c2"); // a different campaign shares the path
    await other.load();
    expect(other.get("npc.a")).toEqual({ history: "", dayGists: [] });
  });

  test("clear empties every history and bumps the epoch (rewind invalidation)", () => {
    const s = new NpcHistoryStore(null, "c1");
    s.recordGist("npc.a", "remembered");
    const before = s.currentEpoch();
    s.clear();
    expect(s.get("npc.a")).toEqual({ history: "", dayGists: [] });
    expect(s.currentEpoch()).toBe(before + 1);
  });

  test("a stale-epoch recordGist is DROPPED — an in-flight gist can't resurrect a cleared timeline", () => {
    const s = new NpcHistoryStore(null, "c1");
    const epoch = s.currentEpoch(); // captured before the async gist would have been scheduled
    s.clear(); // a rewind happens while the gist is in flight
    s.recordGist("npc.a", "from the discarded future", epoch);
    expect(s.get("npc.a").dayGists).toEqual([]); // dropped, not recorded
    // A gist captured AFTER the rewind (current epoch) still records normally.
    s.recordGist("npc.a", "present-day", s.currentEpoch());
    expect(s.get("npc.a").dayGists).toEqual(["present-day"]);
  });

  test("truncateFrom retains attributable prefix gists and drops the discarded tail", () => {
    const s = new NpcHistoryStore(null, "c1");
    s.beginTurn(10);
    s.recordGist("npc.a", "kept before the anchor", s.currentEpoch());
    s.beginTurn(20);
    s.recordGist("npc.a", "discarded at the anchor", s.currentEpoch());

    s.truncateFrom(20);

    expect(s.get("npc.a").dayGists).toEqual(["kept before the anchor"]);
  });
});
