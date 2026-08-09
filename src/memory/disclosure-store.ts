/**
 * Disclosure store — a best-effort per-NPC ledger of claims an NPC has voiced in play
 * (`factsAsserted` on an `NpcBeat`), persisted to a JSON sidecar beside `seed.db` (exactly the posture
 * of `NpcHistoryStore`/`FileSummaryStore`: a DERIVED cache, never the WorldModel/reducer/deltas, so the
 * `snapshot==fold(deltas)` replay invariant is untouched — these claims are LLM-extracted and
 * non-deterministic, so they MUST live outside the model).
 *
 * It is injected read-only into NPC + GM briefs as attributed speaker history (`# PRIOR NPC CLAIMS`).
 * Claims are never authoritative world truth; they only keep a speaker's remembered story stable — the deferred
 * deferred disclosure-ledger design, realized. Bounded (a rolling cap per NPC,
 * oldest dropped) and deduped case-insensitively. Every method is best-effort and NEVER throws —
 * persistence must never break a turn.
 *
 * @author Runkai Zhang
 */
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SaveKey } from "../state/store.ts";

/** Bump if the on-disk shape changes incompatibly — an old `version` is treated as a miss. */
export const DISCLOSURE_STORE_VERSION = 2 as const;

/** Max facts retained per NPC — oldest dropped past this (a rolling ledger, never unbounded growth). */
export const DISCLOSURE_MAX_FACTS = 40;

interface StoredDisclosures {
  version: number;
  campaignId: string;
  facts: Record<string, SequencedFact[]>;
}

interface SequencedFact {
  text: string;
  seq: number;
}

/** The sidecar path for one (campaign×character) save — mirrors `npcHistorySidecarPath`, filename-safe. */
export function disclosureSidecarPath(dataDir: string, key: SaveKey): string {
  const seg = (s: string): string => s.replace(/[^a-z0-9._-]+/gi, "_");
  return join(dataDir, `disclosure-${seg(key.campaignId)}-${seg(key.characterId)}.json`);
}

export class DisclosureStore {
  private readonly facts = new Map<string, SequencedFact[]>();
  /**
   * Timeline epoch, bumped by {@link clear} on a rewind. A late async persist that snapshotted the
   * facts before the rewind is dropped by the guard in {@link save}, so a discarded timeline's
   * disclosures can't reload from a stale sidecar into the rewound present.
   */
  private epoch = 0;
  /** Sequence anchor assigned by the engine for writes made by the current tick. */
  private originSeq = -1;
  /** Per-call counter so two concurrent saves never share a temp path (no torn temp file). */
  private saveSeq = 0;
  /** True once facts were recorded but not yet persisted — the engine flushes this each turn so a
   *  mid-session reload (no long rest) can't lose facts an NPC voiced and then contradict them. */
  private dirty = false;

  /** Whether new facts have been recorded since the last successful save (the per-turn flush check). */
  isDirty(): boolean {
    return this.dirty;
  }

  /** `path=null` ⇒ in-memory only (no persistence). `campaignId` is a sanity tag guarding a stale file. */
  constructor(
    private readonly path: string | null,
    private readonly campaignId: string,
  ) {}

  /** The facts this NPC has established (a fresh empty list if none). */
  get(npcId: string): string[] {
    return (this.facts.get(npcId) ?? []).map((fact) => fact.text);
  }

  /** Start a new attribution window for synchronous disclosure writes in this tick. */
  beginTurn(originSeq: number): void {
    this.epoch++;
    this.originSeq = originSeq;
  }

  /** The current timeline epoch — snapshot it before scheduling an async write, pass it back as a guard. */
  currentEpoch(): number {
    return this.epoch;
  }

  /**
   * Invalidate every established fact and bump the epoch (a rewind discarded the timeline that voiced
   * them). Persist the emptied state via {@link save} so a stale sidecar can't reload on next start.
   */
  clear(): void {
    this.facts.clear();
    this.epoch++;
    this.originSeq = -1;
    this.dirty = true;
  }

  /** Drop facts voiced in the discarded tail; unattributed records are conservatively removed. */
  truncateFrom(anchorSeq: number): void {
    this.epoch++;
    this.originSeq = -1;
    for (const [npcId, facts] of this.facts) {
      const kept = facts.filter((fact) => fact.seq >= 0 && fact.seq < anchorSeq);
      if (kept.length === 0) this.facts.delete(npcId);
      else this.facts.set(npcId, kept);
    }
    this.dirty = true;
  }

  /**
   * Record facts an NPC asserted this turn: trim, drop blanks, dedup case-insensitively against what it
   * already established, and cap at `DISCLOSURE_MAX_FACTS` (oldest dropped). In-memory; call `save()` to
   * persist. Returns true iff anything new was added. Never throws.
   */
  record(npcId: string, facts: string[] | undefined): boolean {
    if (!facts || facts.length === 0) return false;
    const list = this.facts.get(npcId) ?? [];
    const seen = new Set(list.map((fact) => fact.text.toLowerCase()));
    let added = false;
    for (const raw of facts) {
      const f = (raw ?? "").trim();
      if (!f) continue;
      const key = f.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ text: f, seq: this.originSeq });
      added = true;
    }
    if (!added) return false;
    if (list.length > DISCLOSURE_MAX_FACTS) list.splice(0, list.length - DISCLOSURE_MAX_FACTS);
    this.facts.set(npcId, list);
    this.dirty = true;
    return true;
  }

  /** Load the sidecar into memory (best-effort). Missing / corrupt / version-/campaign-mismatch ⇒ empty. */
  async load(): Promise<void> {
    if (!this.path) return;
    let parsed: StoredDisclosures | undefined;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8")) as StoredDisclosures;
    } catch {
      return; // missing / unreadable / corrupt
    }
    if (!parsed || parsed.version !== DISCLOSURE_STORE_VERSION || parsed.campaignId !== this.campaignId) return;
    if (!parsed.facts || typeof parsed.facts !== "object") return;
    for (const [id, list] of Object.entries(parsed.facts)) {
      if (Array.isArray(list)) {
        this.facts.set(
          id,
          list.filter(
            (fact): fact is SequencedFact =>
              !!fact && typeof fact === "object" && typeof fact.text === "string" && Number.isSafeInteger(fact.seq),
          ),
        );
      }
    }
  }

  /** Persist atomically (temp + rename). Best-effort: any IO error is swallowed (never blocks a turn). */
  async save(): Promise<void> {
    if (!this.path) return;
    const epoch = this.epoch;
    const value: StoredDisclosures = {
      version: DISCLOSURE_STORE_VERSION,
      campaignId: this.campaignId,
      facts: Object.fromEntries(this.facts),
    };
    // The temp name carries the epoch + a per-call counter so a rewind's fresh save AND any concurrent
    // save each get a unique path (no torn temp file, no stale collision).
    const tmp = `${this.path}.tmp.${process.pid}.${epoch}.${this.saveSeq++}`;
    try {
      await writeFile(tmp, JSON.stringify(value), "utf8");
      // A rewind bumped the epoch after this snapshot was taken — don't clobber the truth with a stale file.
      if (epoch !== this.epoch) {
        await unlink(tmp).catch(() => {});
        return;
      }
      await rename(tmp, this.path);
      this.dirty = false; // persisted — clear only on success so an IO failure retries next turn
    } catch {
      try {
        await unlink(tmp);
      } catch {
        /* nothing more to do */
      }
    }
  }
}
