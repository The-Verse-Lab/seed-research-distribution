/**
 * Lore retrieval — the read-only RAG bridge (M4, Part A).
 *
 * Builds an in-memory vector index over a fixed lore corpus (once, lazily, single-flight), then
 * answers `retrieve(query)` with the most relevant chunks. This is a PURE READ subsystem: it
 * mutates no world state, emits no deltas, persists nothing. Retrieval is a pure function of
 * (query text, fixed corpus) → strings appended to a prompt.
 *
 * Two hard guarantees:
 *  - **Best-effort / never-stall.** Any embed/search failure (endpoint down mid-turn, timeout)
 *    returns EMPTY rather than throwing, so retrieval can never break or stall a turn — the same
 *    doctrine as logging/persistence. A failed build is not latched, so a later turn may retry.
 *  - **Secret lore is bucketed, never blended.** ALL docs (public + secret) are embedded/indexed,
 *    but each hit is routed by its doc's `visibility` into a separate bucket: `public` (the shared
 *    brief, seen by the DM *and* NPCs) vs `secret` (a GM-only narrate channel — see the caller).
 *    The retriever never blends the two; the privacy boundary is enforced at the wiring layer by
 *    routing `secret` ONLY into the DM's private message, never into `contextText` or an NPC prompt.
 *
 * The gateway is dependency-injected via `build(gateway)`; offline embeddings are deterministic
 * (`hashToVec`) so the PLUMBING is fully testable offline — but offline ranking is NOT semantic.
 * Built on the trunk's `InMemoryVectorStore` (brute-force cosine, L2-agnostic) — not forked.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../llm/gateway.ts";
import type { LoreDoc } from "./ingest.ts";
import { InMemoryVectorStore, type VectorDoc, type VectorStore } from "./vector-store.ts";
import { NoopVectorCache, corpusSignature, type VectorCache } from "./vector-cache.ts";

/**
 * Retrieved lore, as rendered prompt bullets, split by visibility. `public` goes into the shared
 * brief (DM + NPCs); `secret` goes ONLY into the DM's private narrate channel (never an NPC prompt,
 * never `contextText`). Buckets are independent — a `secret` hit is NEVER also in `public`.
 */
export interface RetrievedLore {
  public: string[];
  secret: string[];
}

const EMPTY: RetrievedLore = { public: [], secret: [] };

export interface RetrieveOptions {
  /** Max hits to return. */
  k?: number;
  /** Cosine-score floor a hit must clear to count (drops weak/noise matches). */
  minScore?: number;
}

/** Default retrieval knobs (overridable per call / from env at the wiring layer). */
export const DEFAULT_RETRIEVE = { k: 4, minScore: 0.1 } as const;

/** Render a chunk for prompt injection — a labeled bullet so the brief stays scannable. */
function renderChunk(doc: LoreDoc): string {
  return doc.title ? `‣ ${doc.title}: ${doc.text}` : `‣ ${doc.text}`;
}

export class LoreRetriever {
  private readonly store: VectorStore;
  private readonly byId = new Map<string, LoreDoc>();
  /** ALL docs that will be indexed (public + secret). Each hit is bucketed by its `visibility`. */
  private readonly docs: LoreDoc[];
  /** Set once a build succeeds. A failed build leaves this false so a later turn may retry. */
  private indexed = false;
  /** Single-flight guard so concurrent ticks share one build. */
  private building: Promise<void> | null = null;
  /** The gateway captured at build time, reused to embed queries. */
  private gateway: LlmGateway | null = null;
  /**
   * On-disk embedding cache. Default is a no-op (build always embeds); a `FileVectorCache` lets a
   * matching corpus+model load instead of re-embedding. PURE infra — embeddings only, never world
   * state. A cache fault never breaks a build (it falls through to a normal embed).
   */
  private readonly cache: VectorCache;

  constructor(
    docs: LoreDoc[],
    store: VectorStore = new InMemoryVectorStore(),
    cache: VectorCache = new NoopVectorCache(),
  ) {
    this.store = store;
    this.docs = docs;
    this.cache = cache;
    for (const d of this.docs) this.byId.set(d.id, d);
  }

  /** True once the index has been successfully built. */
  get ready(): boolean {
    return this.indexed;
  }

  /**
   * Build (or reuse) the index over ALL docs (public + secret), embedding via the injected gateway.
   * Idempotent and single-flight: a second call while a build is in flight awaits the same promise;
   * once built it's a no-op. Best-effort — a build failure resolves (it does not throw) and leaves
   * the index unbuilt so a later `build`/`retrieve` can retry. With no docs it succeeds trivially.
   */
  build(gateway: LlmGateway): Promise<void> {
    this.gateway = gateway;
    if (this.indexed) return Promise.resolve();
    if (this.building) return this.building;
    this.building = this.doBuild(gateway).then(
      () => {
        this.indexed = true;
        this.building = null;
      },
      () => {
        // Swallow: retrieval is best-effort. Leave unbuilt so a later turn may retry.
        this.building = null;
      },
    );
    return this.building;
  }

  private async doBuild(gateway: LlmGateway): Promise<void> {
    if (this.docs.length === 0) return; // nothing to index — a no-lore world is a no-op
    const vdocs: VectorDoc[] = this.docs.map((d) => ({
      id: d.id,
      text: d.text,
      metadata: { title: d.title, visibility: d.visibility, source: d.source },
    }));
    const sig = corpusSignature(vdocs, this.cache.modelHint);

    // Cache hit: the on-disk vectors were produced from THESE exact docs by THIS exact model, so
    // loading them reproduces identical search results — skip the embed round-trip entirely. The
    // load is best-effort (returns null on any miss/fault), so a fault simply falls through to embed.
    const cached = await this.cache.load();
    if (cached && cached.signature === sig) {
      await this.store.upsert(cached.docs, cached.vectors);
      return; // gateway.embed is NEVER called for the docs on a hit
    }

    // Cache miss (or no/Noop cache): embed as before, index, then persist for next time. The save is
    // best-effort and atomic — an IO failure is swallowed and never breaks the build.
    const { vectors, model } = await gateway.embed("embedding", this.docs.map((d) => d.text));
    await this.store.upsert(vdocs, vectors);
    await this.cache.save({ version: 1, signature: sig, model, docs: vdocs, vectors });
  }

  /**
   * Retrieve up to `k` chunks relevant to `query`, dropping any below `minScore`, split into
   * `public` / `secret` buckets by each hit's `visibility`. Best-effort: returns empty buckets on a
   * blank query, an unbuilt index, or ANY embed/search failure — never throws, so a turn proceeds
   * unaffected. Builds the index on first use if a gateway has been provided. `k` caps the total
   * hits considered (across both visibilities), matching the single-index search.
   */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedLore> {
    const q = query.trim();
    if (!q || this.docs.length === 0) return EMPTY;
    const k = opts.k ?? DEFAULT_RETRIEVE.k;
    const minScore = opts.minScore ?? DEFAULT_RETRIEVE.minScore;
    try {
      if (!this.indexed) {
        if (!this.gateway) return EMPTY; // build() never called — stay silent, never stall
        await this.build(this.gateway);
        if (!this.indexed) return EMPTY; // build failed (best-effort) — empty this turn
      }
      const gateway = this.gateway;
      if (!gateway) return EMPTY;
      const { vectors } = await gateway.embed("embedding", [q]);
      const qv = vectors[0];
      if (!qv) return EMPTY;
      const hits = await this.store.search(qv, k);
      const pub: string[] = [];
      const secret: string[] = [];
      for (const hit of hits) {
        if (hit.score < minScore) continue;
        const doc = this.byId.get(hit.doc.id);
        if (!doc) continue;
        // Route by the doc's own visibility — the privacy boundary. `secret` is consumed ONLY by the
        // DM's private narrate channel at the wiring layer; it never enters the shared brief/NPC path.
        (doc.visibility === "secret" ? secret : pub).push(renderChunk(doc));
      }
      return { public: pub, secret };
    } catch {
      return EMPTY; // never-stall: any failure ⇒ empty buckets, the turn proceeds
    }
  }
}
