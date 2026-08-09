/**
 * Vector cache (M4 follow-up) — the zero-dependency on-disk lore-embedding cache.
 *
 * Asserts the contract end-to-end through `LoreRetriever`, plus the cache unit behaviour:
 *  - **load-skips-embed**: a second retriever over the SAME cache file + SAME docs LOADS the vectors
 *    and never calls `gateway.embed` for the docs (proven with a spy gateway that counts embed calls,
 *    splitting doc-embeds from the single query-embed). Search results equal a fresh embed (determinism).
 *  - **invalidation**: changing the corpus (a doc's text) OR the model hint changes the signature ⇒ a
 *    re-embed + re-save (the spy's doc-embed count goes back up).
 *  - **best-effort**: a missing cache, corrupt JSON, and an unwritable path all degrade silently — the
 *    build still succeeds (a normal embed), nothing throws.
 *  - **atomic save**: a successful save leaves the cache file and NO `.tmp.*` sibling behind.
 *
 * All offline-deterministic (`OfflineGateway` / `hashToVec`), file IO under a throwaway temp dir.
 *
 * @author Runkai Zhang
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { EmbeddingResult, LlmRole } from "../src/llm/types.ts";
import { collectLoreDocs, type LoreDoc } from "../src/memory/ingest.ts";
import { LoreRetriever } from "../src/memory/retriever.ts";
import {
  FileVectorCache,
  NoopVectorCache,
  corpusSignature,
  VECTOR_CACHE_VERSION,
} from "../src/memory/vector-cache.ts";
import { WorldSchema, type World } from "../src/content/schema.ts";

function world(lore: { id: string; title: string; body: string; tags?: string[] }[]): World {
  return WorldSchema.parse({ id: "w.t", name: "T", summary: "s", lore });
}

const CORPUS = world([
  { id: "lore.alpha", title: "Dragons", body: "The northern dragons hoard gold beneath the peaks." },
  { id: "lore.beta", title: "Rivers", body: "The Bracken brook winds through the market village." },
  { id: "lore.gamma", title: "Stones", body: "Seven warden stones ring the vale against the dark.", tags: ["secret"] },
]);

/**
 * An OfflineGateway-backed spy that counts embed calls, separating the (potentially large) DOC embed
 * — passed as `>1` text or as the whole corpus — from the single QUERY embed (`[oneString]`). The
 * load-skips-embed proof is exactly `docEmbedCalls === 0` after a cache hit, while query embeds still
 * happen so `retrieve` works.
 */
class CountingGateway implements LlmGateway {
  docEmbedCalls = 0;
  queryEmbedCalls = 0;
  totalTextsEmbedded = 0;
  private readonly inner = new OfflineGateway();
  constructor(private readonly docCount: number) {}
  complete(role: LlmRole, req: Parameters<LlmGateway["complete"]>[1]) {
    return this.inner.complete(role, req);
  }
  stream(role: LlmRole, req: Parameters<LlmGateway["stream"]>[1]) {
    return this.inner.stream(role, req);
  }
  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    this.totalTextsEmbedded += texts.length;
    // A build embeds the whole corpus in one call; a retrieve embeds exactly one query string.
    if (texts.length === 1 && this.docCount !== 1) this.queryEmbedCalls += 1;
    else this.docEmbedCalls += 1;
    return this.inner.embed(role, texts);
  }
}

let TMP_ROOT = "";
async function tmp(): Promise<string> {
  if (!TMP_ROOT) TMP_ROOT = await mkdtemp(join(tmpdir(), "seed-vc-"));
  return mkdtemp(join(TMP_ROOT, "case-"));
}

afterAll(async () => {
  if (TMP_ROOT) await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("corpusSignature — deterministic, order-stable, invalidates on corpus or model change", () => {
  const docs = collectLoreDocs(CORPUS).map((d) => ({
    id: d.id,
    text: d.text,
    metadata: { visibility: d.visibility },
  }));

  test("same docs + same model ⇒ identical signature (deterministic)", () => {
    expect(corpusSignature(docs, "m1")).toBe(corpusSignature(docs, "m1"));
  });

  test("changing the model hint changes the signature", () => {
    expect(corpusSignature(docs, "m1")).not.toBe(corpusSignature(docs, "m2"));
  });

  test("changing any doc's text changes the signature", () => {
    const mutated = docs.map((d, i) => (i === 0 ? { ...d, text: d.text + " (edited)" } : d));
    expect(corpusSignature(mutated, "m1")).not.toBe(corpusSignature(docs, "m1"));
  });

  test("changing a doc's id or visibility changes the signature", () => {
    const reId = docs.map((d, i) => (i === 0 ? { ...d, id: d.id + "x" } : d));
    expect(corpusSignature(reId, "m1")).not.toBe(corpusSignature(docs, "m1"));
    const reVis = docs.map((d, i) => (i === 0 ? { ...d, metadata: { visibility: "secret" } } : d));
    expect(corpusSignature(reVis, "m1")).not.toBe(corpusSignature(docs, "m1"));
  });

  test("reordering docs changes the signature (order is part of corpus identity)", () => {
    const reordered = [docs[1]!, docs[0]!, ...docs.slice(2)];
    expect(corpusSignature(reordered, "m1")).not.toBe(corpusSignature(docs, "m1"));
  });
});

describe("FileVectorCache — best-effort load/save, atomic, never throws", () => {
  test("load returns null when the file is missing", async () => {
    const cache = new FileVectorCache(join(await tmp(), "absent.json"), "m");
    expect(await cache.load()).toBeNull();
  });

  test("load returns null on corrupt JSON (never throws)", async () => {
    const path = join(await tmp(), "corrupt.json");
    await writeFile(path, "{ this is : not json", "utf8");
    const cache = new FileVectorCache(path, "m");
    expect(await cache.load()).toBeNull();
  });

  test("load returns null on a wrong-version / wrong-shape file", async () => {
    const path = join(await tmp(), "stale.json");
    await writeFile(path, JSON.stringify({ version: 999, signature: "x", model: "m", docs: [], vectors: [] }), "utf8");
    expect(await new FileVectorCache(path, "m").load()).toBeNull();
    await writeFile(path, JSON.stringify({ hello: "world" }), "utf8");
    expect(await new FileVectorCache(path, "m").load()).toBeNull();
  });

  test("save then load round-trips, and leaves NO temp sibling (atomic)", async () => {
    const dir = await tmp();
    const path = join(dir, "lore-vectors.json");
    const cache = new FileVectorCache(path, "m");
    const index = {
      version: VECTOR_CACHE_VERSION,
      signature: "sig-1",
      model: "m",
      docs: [{ id: "a", text: "alpha", metadata: { visibility: "public" } }],
      vectors: [[0.1, 0.2, 0.3]],
    };
    await cache.save(index);
    expect(await cache.load()).toEqual(index);
    // Atomic write: no `.tmp.*` file left behind in the data dir.
    const entries = await readdir(dir);
    expect(entries).toContain("lore-vectors.json");
    expect(entries.some((e) => e.includes(".tmp."))).toBe(false);
  });

  test("save to an unwritable path is swallowed (best-effort, no throw)", async () => {
    // A path whose parent does not exist — writeFile rejects, save must NOT.
    const cache = new FileVectorCache(join(await tmp(), "no", "such", "dir", "c.json"), "m");
    await cache.save({ version: VECTOR_CACHE_VERSION, signature: "s", model: "m", docs: [], vectors: [] });
    // Reaching here without throwing is the assertion; a later load still misses.
    expect(await cache.load()).toBeNull();
  });
});

describe("LoreRetriever + FileVectorCache — load-skips-embed, determinism, invalidation", () => {
  const docs = collectLoreDocs(CORPUS);
  const target = docs.find((d) => d.source === "lore:lore.beta")!;

  async function freshRetriever(path: string, model: string, loreDocs: LoreDoc[] = collectLoreDocs(CORPUS)) {
    const gw = new CountingGateway(loreDocs.length);
    const r = new LoreRetriever(loreDocs, undefined, new FileVectorCache(path, model));
    return { gw, r };
  }

  test("first build EMBEDS the docs + writes the cache; a second build over the same file LOADS (no doc embed) and returns identical results", async () => {
    const path = join(await tmp(), "lore-vectors.json");

    // First build: cold — embeds the corpus once, saves the cache.
    const first = await freshRetriever(path, "nomic-embed-text");
    await first.r.build(first.gw);
    expect(first.gw.docEmbedCalls).toBe(1); // the corpus was embedded
    const fresh = await first.r.retrieve(target.text, { k: 3, minScore: 0 });
    expect(fresh.public.length + fresh.secret.length).toBeGreaterThan(0);

    // The cache file now exists on disk.
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(VECTOR_CACHE_VERSION);

    // Second build: warm — SAME file, SAME docs, SAME model ⇒ LOADS, never embeds the docs.
    const second = await freshRetriever(path, "nomic-embed-text");
    await second.r.build(second.gw);
    expect(second.gw.docEmbedCalls).toBe(0); // <-- load-skips-embed proof
    const loaded = await second.r.retrieve(target.text, { k: 3, minScore: 0 });
    expect(second.gw.queryEmbedCalls).toBe(1); // the query still embeds, so retrieve works

    // Determinism: results from the LOADED index equal the fresh-embed results.
    expect(loaded).toEqual(fresh);
  });

  test("invalidation — a changed corpus (a doc's text edited) re-embeds + re-saves", async () => {
    const path = join(await tmp(), "lore-vectors.json");
    const cold = await freshRetriever(path, "nomic-embed-text");
    await cold.r.build(cold.gw);
    expect(cold.gw.docEmbedCalls).toBe(1);

    // Edit one lore body ⇒ different chunk text ⇒ different signature ⇒ cache MISS ⇒ re-embed.
    const edited = world([
      { id: "lore.alpha", title: "Dragons", body: "The SOUTHERN dragons hoard gems beneath the peaks." },
      { id: "lore.beta", title: "Rivers", body: "The Bracken brook winds through the market village." },
      { id: "lore.gamma", title: "Stones", body: "Seven warden stones ring the vale against the dark.", tags: ["secret"] },
    ]);
    const warm = await freshRetriever(path, "nomic-embed-text", collectLoreDocs(edited));
    await warm.r.build(warm.gw);
    expect(warm.gw.docEmbedCalls).toBe(1); // re-embedded — NOT loaded
  });

  test("invalidation — a changed embedding-model hint re-embeds", async () => {
    const path = join(await tmp(), "lore-vectors.json");
    const cold = await freshRetriever(path, "nomic-embed-text");
    await cold.r.build(cold.gw);
    expect(cold.gw.docEmbedCalls).toBe(1);

    // Same corpus, DIFFERENT model hint ⇒ signature mismatch ⇒ re-embed.
    const warm = await freshRetriever(path, "some-other-embed-model");
    await warm.r.build(warm.gw);
    expect(warm.gw.docEmbedCalls).toBe(1); // re-embedded — the model is part of the signature
  });

  test("best-effort — a corrupt cache file falls through to a normal embed (build still succeeds)", async () => {
    const path = join(await tmp(), "lore-vectors.json");
    await writeFile(path, "}{ not json at all", "utf8");
    const { gw, r } = await freshRetriever(path, "nomic-embed-text");
    await r.build(gw); // must not throw
    expect(r.ready).toBe(true);
    expect(gw.docEmbedCalls).toBe(1); // fell through to embed
    // ...and it RE-SAVES a valid cache, so the next build can load it.
    const next = await freshRetriever(path, "nomic-embed-text");
    await next.r.build(next.gw);
    expect(next.gw.docEmbedCalls).toBe(0);
  });

  test("NoopVectorCache (the default) always embeds and writes no file", async () => {
    const gw = new CountingGateway(docs.length);
    const r = new LoreRetriever(collectLoreDocs(CORPUS), undefined, new NoopVectorCache("nomic-embed-text"));
    await r.build(gw);
    expect(gw.docEmbedCalls).toBe(1);
    // A second build on the same retriever instance is idempotent (already indexed) — still no load.
    await r.build(gw);
    expect(gw.docEmbedCalls).toBe(1);
  });
});
