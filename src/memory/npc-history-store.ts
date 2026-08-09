/**
 * NPC-history store — a best-effort in-memory map of per-NPC derived history (`src/memory/npc-history.ts`),
 * persisted to a JSON sidecar beside `seed.db` (exactly the posture of `FileSummaryStore`: a DERIVED cache,
 * never the WorldModel/reducer/deltas, so the `snapshot==fold(deltas)` replay invariant is untouched).
 *
 * The live loop: `recordGist` accrues a day-buffer entry after each addressed reply; `foldAll` runs the
 * sleep-consolidation fold at a long rest (each NPC's dayGists → rolling history, buffer cleared) and
 * persists. `get` feeds `renderHistoryBlock` into the NPC's reply prompt. A `null` path ⇒ in-memory only
 * (no persistence). Every method is best-effort and NEVER throws — persistence must never break a turn.
 *
 * @author Runkai Zhang
 */
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmGateway } from "../llm/gateway.ts";
import {
  defaultNpcHistory,
  foldNpcHistory,
  NPC_GIST_CAP,
  NPC_HISTORY_MAX_WORDS,
  type NpcHistory,
} from "./npc-history.ts";
import type { SaveKey } from "../state/store.ts";

/** Bump if the on-disk shape changes incompatibly — an old `version` is treated as a miss. */
export const NPC_HISTORY_STORE_VERSION = 2 as const;

interface SequencedGist {
  text: string;
  seq: number;
}

interface SequencedNpcHistory {
  history: string;
  /** Highest origin seq consolidated into `history`; -1 means unattributed/legacy-like. */
  historySeq: number;
  dayGists: SequencedGist[];
}

interface StoredNpcHistories {
  version: number;
  campaignId: string;
  histories: Record<string, SequencedNpcHistory>;
}

/** The sidecar path for one (campaign×character) save — mirrors `summarySidecarPath`, filename-safe. */
export function npcHistorySidecarPath(dataDir: string, key: SaveKey): string {
  const seg = (s: string): string => s.replace(/[^a-z0-9._-]+/gi, "_");
  return join(dataDir, `npc-history-${seg(key.campaignId)}-${seg(key.characterId)}.json`);
}

export class NpcHistoryStore {
  private readonly histories = new Map<string, SequencedNpcHistory>();
  /**
   * Timeline epoch, bumped by {@link clear} on a rewind. An async write (gist extraction, `foldAll`)
   * that captured a stale epoch via {@link currentEpoch} no-ops instead of resurrecting a discarded
   * timeline's memory into the rewound present.
   */
  private epoch = 0;
  /** Sequence anchor assigned by the engine for writes made by the current tick. */
  private originSeq = -1;
  /** Per-call counter so two concurrent saves never share a temp path (no torn temp file). */
  private saveSeq = 0;
  /** True once a gist was buffered but not yet persisted — the engine flushes this each turn so a
   *  mid-session reload (no long rest) reloads the buffered gists instead of forgetting them. */
  private dirty = false;

  /** Whether a gist has been buffered since the last successful save (the per-turn flush check). */
  isDirty(): boolean {
    return this.dirty;
  }

  /** `path=null` ⇒ in-memory only (no persistence). `campaignId` is a sanity tag guarding a stale file. */
  constructor(
    private readonly path: string | null,
    private readonly campaignId: string,
  ) {}

  /** This NPC's history (a fresh empty one if unseen). */
  get(npcId: string): NpcHistory {
    const stored = this.histories.get(npcId);
    if (!stored) return defaultNpcHistory();
    return { history: stored.history, dayGists: stored.dayGists.map((gist) => gist.text) };
  }

  /** Start a new attribution window. Late writes from the prior turn are invalidated, never mis-tagged. */
  beginTurn(originSeq: number): void {
    this.epoch++;
    this.originSeq = originSeq;
  }

  /** The current timeline epoch — snapshot it before scheduling an async write, pass it back as a guard. */
  currentEpoch(): number {
    return this.epoch;
  }

  /**
   * Invalidate every in-memory history and bump the epoch (a rewind discarded the timeline that
   * produced them). Any in-flight gist/fold that captured the old epoch is dropped by the guards
   * below. Persist the emptied state via {@link save} so a stale sidecar can't reload on next start.
   */
  clear(): void {
    this.histories.clear();
    this.epoch++;
    this.originSeq = -1;
    this.dirty = true;
  }

  /** Drop memory from a discarded event tail while retaining attributable prefix entries. */
  truncateFrom(anchorSeq: number): void {
    this.epoch++;
    this.originSeq = -1;
    for (const [npcId, value] of this.histories) {
      const keepHistory = value.historySeq >= 0 && value.historySeq < anchorSeq;
      const dayGists = value.dayGists.filter((gist) => gist.seq >= 0 && gist.seq < anchorSeq);
      if (!keepHistory && dayGists.length === 0) this.histories.delete(npcId);
      else {
        this.histories.set(npcId, {
          history: keepHistory ? value.history : "",
          historySeq: keepHistory ? value.historySeq : -1,
          dayGists,
        });
      }
    }
    this.dirty = true;
  }

  /**
   * Append a gist to an NPC's day-buffer (in-memory; persisted at the next fold). Blank ⇒ no-op. A
   * stale `epoch` (a rewind cleared this store since the gist was scheduled) ⇒ no-op.
   */
  recordGist(npcId: string, gist: string, epoch?: number): void {
    if (epoch !== undefined && epoch !== this.epoch) return;
    const text = gist.trim();
    if (!text) return;
    const current = this.histories.get(npcId) ?? { history: "", historySeq: -1, dayGists: [] };
    this.histories.set(npcId, {
      ...current,
      dayGists: [...current.dayGists, { text, seq: this.originSeq }].slice(-NPC_GIST_CAP),
    });
    this.dirty = true;
  }

  /**
   * Sleep consolidation: fold every NPC that has pending day-gists (history ← fold(history, gists),
   * buffer cleared), then persist. Best-effort per NPC — a failed fold keeps that buffer for the next
   * rest. Never throws. No-op (and no save) when nothing accrued.
   */
  async foldAll(gateway: LlmGateway): Promise<void> {
    const startEpoch = this.epoch;
    let changed = false;
    for (const [npcId, h] of this.histories) {
      if (h.dayGists.length === 0) continue;
      try {
        const history = await foldNpcHistory(gateway, {
          prevHistory: h.history,
          gists: h.dayGists.map((gist) => gist.text),
          maxWords: NPC_HISTORY_MAX_WORDS,
        });
        // A rewind cleared this store mid-fold — the folded result belongs to a discarded timeline.
        if (startEpoch !== this.epoch) return;
        this.histories.set(npcId, {
          history,
          historySeq: Math.max(h.historySeq, ...h.dayGists.map((gist) => gist.seq)),
          dayGists: [],
        });
        changed = true;
      } catch {
        /* keep the buffer; retry at the next rest */
      }
    }
    if (changed) await this.save();
  }

  /** Load the sidecar into memory (best-effort). Missing / corrupt / version-/campaign-mismatch ⇒ empty. */
  async load(): Promise<void> {
    if (!this.path) return;
    let parsed: StoredNpcHistories | undefined;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8")) as StoredNpcHistories;
    } catch {
      return; // missing / unreadable / corrupt
    }
    if (!parsed || parsed.version !== NPC_HISTORY_STORE_VERSION || parsed.campaignId !== this.campaignId) return;
    if (!parsed.histories || typeof parsed.histories !== "object") return;
    for (const [id, h] of Object.entries(parsed.histories)) {
      if (h && typeof h.history === "string" && Number.isSafeInteger(h.historySeq) && Array.isArray(h.dayGists)) {
        const dayGists = h.dayGists.filter(
          (gist): gist is SequencedGist =>
            !!gist && typeof gist === "object" && typeof gist.text === "string" && Number.isSafeInteger(gist.seq),
        );
        this.histories.set(id, { history: h.history, historySeq: h.historySeq, dayGists });
      }
    }
  }

  /** Persist atomically (temp + rename). Best-effort: any IO error is swallowed (never blocks a turn). */
  async save(): Promise<void> {
    if (!this.path) return;
    const epoch = this.epoch;
    const value: StoredNpcHistories = {
      version: NPC_HISTORY_STORE_VERSION,
      campaignId: this.campaignId,
      histories: Object.fromEntries(this.histories),
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
