/**
 * Summary store — a best-effort on-disk sidecar for the campaign rolling-summary (M4 follow-up).
 *
 * The "story so far" (`src/memory/summary.ts`) is an LLM-generated derived cache, NOT source of
 * truth: it must never enter the `WorldModel`/reducer/deltas/snapshot/event-log (that would break
 * the `snapshot==fold(deltas)` replay invariant). So it is persisted SEPARATELY here — a tiny JSON
 * file under the data dir, beside `seed.db` and `lore-vectors.json` — exactly mirroring
 * `FileVectorCache`'s posture: atomic temp+rename writes, a forgiving load, and both methods
 * best-effort (NEVER throw). A missing/corrupt/unreadable sidecar simply yields `null` (the engine
 * starts from an empty summary), and a save IO error is swallowed (a turn is never blocked or
 * crashed by summary persistence).
 *
 * It stores `{ summary, cursorSeq }`: the running prose and the highest event `seq` already folded
 * into it, so the engine knows which newer events still need folding.
 *
 * @author Runkai Zhang
 */
import { readFile, rename, writeFile, unlink } from "node:fs/promises";

/** Bump if the on-disk shape changes incompatibly — an old `version` is treated as a miss. */
export const SUMMARY_STORE_VERSION = 1 as const;

/** The persisted rolling summary for one campaign. */
export interface StoredSummary {
  /** On-disk schema version; a mismatch invalidates the sidecar (treated as missing). */
  version: number;
  /** The campaign this summary belongs to (sanity tag; the file is per-campaign by path). */
  campaignId: string;
  /** The running "story so far" prose. */
  summary: string;
  /** The highest event `seq` already folded into `summary` (the fold cursor). */
  cursorSeq: number;
}

/**
 * A pluggable best-effort store for a single campaign's rolling summary. Both methods never throw:
 * `load` returns `null` on any miss/fault, `save` swallows IO errors.
 */
export interface SummaryStore {
  /** The stored summary if present, valid, and parseable; otherwise `null` (never throws). */
  load(): Promise<StoredSummary | null>;
  /** Persist the summary atomically. Best-effort: an IO error is swallowed (never throws). */
  save(value: StoredSummary): Promise<void>;
  /**
   * Invalidate any save from a now-discarded timeline (a rewind). A save that snapshotted the summary
   * BEFORE this call must not clobber the on-disk file the rewind writes AFTER it. Optional — a store
   * with no on-disk race (Noop) can omit it. Callers use `store.invalidate?.()`.
   */
  invalidate?(): void;
}

/**
 * JSON-file sidecar under the data dir. `load` is forgiving — a missing file, unparseable JSON, a
 * wrong `version`, or any structural surprise all return `null`. `save` writes to a sibling temp
 * file and atomically renames it into place, so a crash mid-write can never leave a half-written
 * file the next load would choke on; any IO failure is swallowed.
 */
export class FileSummaryStore implements SummaryStore {
  /** Timeline epoch, bumped by {@link invalidate} on a rewind — the stale-clobber guard in {@link save}. */
  private epoch = 0;
  /** Per-call counter so two concurrent saves never share a temp path (no torn temp file). */
  private saveSeq = 0;

  constructor(private readonly path: string) {}

  /** Bump the epoch so an in-flight save from a discarded timeline aborts before it renames. */
  invalidate(): void {
    this.epoch++;
  }

  async load(): Promise<StoredSummary | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return null; // missing / unreadable — start from an empty summary
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isStoredSummary(parsed) ? parsed : null;
    } catch {
      return null; // corrupt JSON — discard
    }
  }

  async save(value: StoredSummary): Promise<void> {
    const epoch = this.epoch;
    // Epoch + a per-call counter keep the temp path unique across a rewind AND across concurrent saves.
    const tmp = `${this.path}.tmp.${process.pid}.${epoch}.${this.saveSeq++}`;
    try {
      await writeFile(tmp, JSON.stringify(value), "utf8");
      // A rewind invalidated this timeline after the snapshot was taken — drop it rather than clobber
      // the file the rewind just wrote with a summary describing turns that never happened.
      if (epoch !== this.epoch) {
        await unlink(tmp).catch(() => {});
        return;
      }
      await rename(tmp, this.path);
    } catch {
      // Best-effort: persistence must never break a turn. Clear the temp file if we can.
      try {
        await unlink(tmp);
      } catch {
        /* nothing more to do */
      }
    }
  }
}

/** The default store: a no-op. `load` always misses, `save` does nothing — used when summaries are off. */
export class NoopSummaryStore implements SummaryStore {
  load(): Promise<StoredSummary | null> {
    return Promise.resolve(null);
  }
  save(_value: StoredSummary): Promise<void> {
    return Promise.resolve();
  }
}

/** Structural guard so a hand-edited / stale-shape file is treated as a miss rather than trusted. */
function isStoredSummary(v: unknown): v is StoredSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === SUMMARY_STORE_VERSION &&
    typeof o.campaignId === "string" &&
    typeof o.summary === "string" &&
    typeof o.cursorSeq === "number"
  );
}
