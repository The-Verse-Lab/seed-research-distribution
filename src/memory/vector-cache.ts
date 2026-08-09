/**
 * Vector cache — a zero-dependency on-disk persistence layer for the lore embeddings (M4 follow-up).
 *
 * The lore RAG index (`LoreRetriever`) re-embeds the whole corpus into an `InMemoryVectorStore` on
 * every startup. That's the one slow part of a cold start (an embedding round-trip per chunk). This
 * cache lets a build SKIP the embed when the corpus and the embedding model are unchanged: it stores
 * exactly what `VectorStore.upsert` consumes (`{ docs, vectors }`) plus a **signature** of the inputs
 * that produced them. On the next build, if the signature matches, the vectors are loaded straight
 * into the store and `gateway.embed` is never called for the docs.
 *
 * This is the benefit a vector DB (LanceDB) would give, done the Bun-clean way: hashing via
 * `node:crypto` `createHash("sha256")`, file IO via `node:fs/promises` — both Bun built-ins, ZERO new
 * packages.
 *
 * Three hard properties, mirroring the rest of the M4 RAG layer:
 *  - **Read-only / not the game store.** This persists EMBEDDINGS only — no reducer, no deltas, no
 *    world state. It must not import `src/state/*` (the game-state store) or `src/world/*`. The cache
 *    file is runtime data UNDER the data dir (like `seed.db`) — never written into the repo.
 *  - **Best-effort / never-stall.** A missing, corrupt, or unreadable cache yields `null` from
 *    `load()` (the retriever falls through to a normal embed); a `save()` IO error is swallowed. A
 *    cache fault must NEVER throw, crash, or stall a turn. Saves are atomic (temp file + rename) so a
 *    crash mid-write can't leave a half-written file the next load would choke on.
 *  - **Correct invalidation.** The signature folds in the corpus (each doc's `id`/`text`/`visibility`)
 *    AND the embedding-model hint, so changing lore OR the model produces a different signature ⇒ a
 *    rebuild. A *matching* signature guarantees the cached vectors were produced from these exact
 *    docs by this exact model, so loading them reproduces identical search results.
 *
 * @author Runkai Zhang
 */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import type { VectorDoc } from "./vector-store.ts";

/** Bump if the on-disk shape changes incompatibly — an old `version` is treated as a cache miss. */
export const VECTOR_CACHE_VERSION = 1 as const;

/**
 * The persisted index: everything needed to reconstitute the store without re-embedding, plus the
 * `signature` that ties these vectors to the exact corpus + model that produced them.
 */
export interface CachedIndex {
  /** On-disk schema version; a mismatch invalidates the cache (treated as missing). */
  version: number;
  /** `corpusSignature(docs, modelHint)` — load only trusts the cache when this matches. */
  signature: string;
  /** The embedding model that produced `vectors` (recorded for provenance/debugging). */
  model: string;
  /** Exactly what `VectorStore.upsert` takes — the indexed docs… */
  docs: VectorDoc[];
  /** …and their vectors, positionally aligned with `docs`. */
  vectors: number[][];
}

/**
 * A pluggable on-disk cache for a single retriever's index. `modelHint` is the configured embedding
 * model; the retriever folds it into the signature so a model swap invalidates. Both methods are
 * best-effort and never throw: `load` returns `null` on any miss/fault, `save` swallows IO errors.
 */
export interface VectorCache {
  /** The embedding model this cache is keyed to — folded into the signature by the retriever. */
  readonly modelHint: string;
  /** The cached index if present, valid, and parseable; otherwise `null` (best-effort, never throws). */
  load(): Promise<CachedIndex | null>;
  /** Persist the index atomically. Best-effort: an IO error is swallowed (never throws). */
  save(index: CachedIndex): Promise<void>;
}

/**
 * Stable, deterministic signature of (corpus, embedding model). Folds in each doc's identifying
 * fields — `id`, `text`, and `visibility` (the only metadata that affects bucketing) — in ARRAY
 * order (the corpus order is itself deterministic via `collectLoreDocs`), then the model hint. Two
 * builds over the same docs with the same model hash identical; ANY change to a doc's id/text/
 * visibility, the doc set, their order, or the model changes the hash ⇒ the cache is invalidated.
 *
 * A length-prefixed field encoding (`len:value`) makes the join injective, so no two distinct corpora
 * can collide by a value coincidentally containing the field separator.
 */
export function corpusSignature(
  docs: ReadonlyArray<{ id: string; text: string; metadata?: Record<string, unknown> }>,
  modelHint: string,
): string {
  const h = createHash("sha256");
  const field = (s: string): void => {
    h.update(String(s.length));
    h.update(":");
    h.update(s);
    h.update("\u0000"); // unambiguous field terminator
  };
  for (const d of docs) {
    field(d.id);
    field(d.text);
    // `visibility` is the one piece of metadata that changes how a hit is routed (public vs secret),
    // so it's part of the corpus identity. Absent ⇒ empty, kept stable across runs.
    field(typeof d.metadata?.visibility === "string" ? d.metadata.visibility : "");
    h.update("\u0001"); // record terminator
  }
  h.update("::model=");
  h.update(modelHint);
  return h.digest("hex");
}

/**
 * JSON-file cache under the data dir. `load` is forgiving — missing file, unparseable JSON, a wrong
 * `version`, or any structural surprise all return `null` (a normal rebuild follows). `save` writes
 * to a sibling temp file and atomically renames it into place, so a crash mid-write can never leave a
 * half-written cache; any IO failure (read-only dir, disk full) is swallowed.
 */
export class FileVectorCache implements VectorCache {
  constructor(
    private readonly path: string,
    readonly modelHint: string,
  ) {}

  async load(): Promise<CachedIndex | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return null; // missing / unreadable — a cold build follows
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isCachedIndex(parsed) ? parsed : null;
    } catch {
      return null; // corrupt JSON — discard and rebuild
    }
  }

  async save(index: CachedIndex): Promise<void> {
    // `.tmp.<pid>` keeps concurrent writers (unlikely, but cheap insurance) from clobbering one
    // temp file; rename is atomic on the same filesystem, so a reader sees either the old or the
    // complete new file, never a partial one.
    const tmp = `${this.path}.tmp.${process.pid}`;
    try {
      await writeFile(tmp, JSON.stringify(index), "utf8");
      await rename(tmp, this.path);
    } catch {
      // Best-effort: persistence must never break a turn. Try to clear the temp file so a failed
      // save doesn't litter the data dir; ignore if that fails too.
      try {
        await unlink(tmp);
      } catch {
        /* nothing more to do */
      }
    }
  }
}

/** The default cache: a no-op. `load` always misses, `save` does nothing — used when caching is off. */
export class NoopVectorCache implements VectorCache {
  readonly modelHint: string;
  constructor(modelHint = "") {
    this.modelHint = modelHint;
  }
  load(): Promise<CachedIndex | null> {
    return Promise.resolve(null);
  }
  save(): Promise<void> {
    return Promise.resolve();
  }
}

/** Structural guard so a hand-edited / stale-shape file is treated as a miss rather than trusted. */
function isCachedIndex(v: unknown): v is CachedIndex {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === VECTOR_CACHE_VERSION &&
    typeof o.signature === "string" &&
    typeof o.model === "string" &&
    Array.isArray(o.docs) &&
    Array.isArray(o.vectors)
  );
}
