/**
 * DisclosureStore — the derived per-NPC ledger of facts an NPC has voiced in play: record (trim, dedup
 * case-insensitively, rolling cap), get defaults to empty, and best-effort JSON persistence (round-trip +
 * a campaign-id guard). A derived cache, never the WorldModel — the replay invariant is untouched.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCLOSURE_MAX_FACTS, DisclosureStore, disclosureSidecarPath } from "../src/memory/disclosure-store.ts";

describe("DisclosureStore", () => {
  test("record accrues facts; get defaults to empty; blanks are ignored", () => {
    const s = new DisclosureStore(null, "c1");
    expect(s.get("npc.a")).toEqual([]);
    expect(s.record("npc.a", ["The bridge is out.", "  "])).toBe(true);
    expect(s.get("npc.a")).toEqual(["The bridge is out."]);
  });

  test("record dedups case-insensitively and reports when nothing new was added", () => {
    const s = new DisclosureStore(null, "c1");
    s.record("npc.a", ["The bridge is out."]);
    expect(s.record("npc.a", ["the BRIDGE is out.", "  "])).toBe(false); // dup + blank ⇒ nothing new
    expect(s.get("npc.a")).toEqual(["The bridge is out."]);
    expect(s.record("npc.a", ["A new fact."])).toBe(true);
    expect(s.get("npc.a")).toEqual(["The bridge is out.", "A new fact."]);
  });

  test("record caps at DISCLOSURE_MAX_FACTS, dropping the oldest (a rolling ledger)", () => {
    const s = new DisclosureStore(null, "c1");
    for (let i = 0; i < DISCLOSURE_MAX_FACTS + 5; i++) s.record("npc.a", [`fact ${i}`]);
    const facts = s.get("npc.a");
    expect(facts).toHaveLength(DISCLOSURE_MAX_FACTS);
    expect(facts[0]).toBe("fact 5"); // the first five were dropped
    expect(facts[facts.length - 1]).toBe(`fact ${DISCLOSURE_MAX_FACTS + 4}`);
  });

  test("record is a no-op for empty/undefined input", () => {
    const s = new DisclosureStore(null, "c1");
    expect(s.record("npc.a", [])).toBe(false);
    expect(s.record("npc.a", undefined)).toBe(false);
    expect(s.get("npc.a")).toEqual([]);
  });

  test("save → load round-trips per-NPC facts to the sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-disclosure-"));
    const path = disclosureSidecarPath(dir, { campaignId: "c1", characterId: "pc.you" });
    const a = new DisclosureStore(path, "c1");
    a.record("npc.a", ["remembered fact"]);
    await a.save();
    const b = new DisclosureStore(path, "c1");
    await b.load();
    expect(b.get("npc.a")).toEqual(["remembered fact"]);
  });

  test("load rejects a campaign-id mismatch (a stale/foreign sidecar starts blank)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-disclosure-"));
    const path = disclosureSidecarPath(dir, { campaignId: "c1", characterId: "pc.you" });
    const a = new DisclosureStore(path, "c1");
    a.record("npc.a", ["x"]);
    await a.save();
    const other = new DisclosureStore(path, "c2"); // a different campaign shares the path
    await other.load();
    expect(other.get("npc.a")).toEqual([]);
  });

  test("clear empties every fact and bumps the epoch (rewind invalidation)", () => {
    const s = new DisclosureStore(null, "c1");
    s.record("npc.a", ["The bridge is out."]);
    const before = s.currentEpoch();
    s.clear();
    expect(s.get("npc.a")).toEqual([]);
    expect(s.currentEpoch()).toBe(before + 1);
  });

  test("clear + save persists the EMPTIED ledger — a rewound crash won't reload discarded facts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-disclosure-"));
    const path = disclosureSidecarPath(dir, { campaignId: "c1", characterId: "pc.you" });
    const a = new DisclosureStore(path, "c1");
    a.record("npc.a", ["a fact from the discarded timeline"]);
    await a.save();
    a.clear(); // a rewind discards the timeline that voiced that fact
    await a.save(); // rewind persists the emptied sidecar
    const b = new DisclosureStore(path, "c1"); // a fresh restart reads the sidecar
    await b.load();
    expect(b.get("npc.a")).toEqual([]); // the discarded fact does NOT reload
  });

  test("truncateFrom retains attributable prefix facts and drops the discarded tail", () => {
    const s = new DisclosureStore(null, "c1");
    s.beginTurn(10);
    s.record("npc.a", ["kept before the anchor"]);
    s.beginTurn(20);
    s.record("npc.a", ["discarded at the anchor"]);

    s.truncateFrom(20);

    expect(s.get("npc.a")).toEqual(["kept before the anchor"]);
  });
});
