/**
 * Lore retrieval (M4, Part A + secret-lore follow-up) — ingest chunking + the LoreRetriever plumbing.
 *
 * Everything here runs on the deterministic OfflineGateway (`hashToVec`), so it asserts the
 * PLUMBING — the right doc is retrievable, hits are bucketed by visibility (`public` vs `secret`)
 * with a secret entry NEVER appearing in `public`, weak hits are filtered, results are
 * deterministic, and a throwing gateway degrades to empty buckets — NEVER semantic ranking quality
 * (offline embeddings are non-semantic by construction). Read-only: no engine, no state, no store.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { EmbeddingResult } from "../src/llm/types.ts";
import { chunkText, collectLoreDocs, knowledgeDocs, visibilityOf, type LoreDoc } from "../src/memory/ingest.ts";
import { LoreRetriever } from "../src/memory/retriever.ts";
import { WorldSchema, type World } from "../src/content/schema.ts";

function world(lore: { id: string; title: string; body: string; tags?: string[] }[]): World {
  return WorldSchema.parse({ id: "w.t", name: "T", summary: "s", lore });
}

describe("chunkText — overlapping word windows", () => {
  test("short text fits in a single (whitespace-collapsed) chunk", () => {
    expect(chunkText("a  b   c")).toEqual(["a b c"]);
  });

  test("empty / whitespace-only text yields no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  test("long text splits into overlapping windows that re-cover the whole corpus", () => {
    const words = Array.from({ length: 25 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(" "), { maxWords: 10, overlap: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    // Window size respected.
    for (const c of chunks) expect(c.split(" ").length).toBeLessThanOrEqual(10);
    // Adjacent windows overlap (step = maxWords - overlap = 6).
    expect(chunks[0]).toBe(words.slice(0, 10).join(" "));
    expect(chunks[1]).toBe(words.slice(6, 16).join(" "));
    // Every word appears in at least one chunk (no gaps).
    const covered = new Set(chunks.flatMap((c) => c.split(" ")));
    for (const w of words) expect(covered.has(w)).toBe(true);
  });
});

describe("collectLoreDocs — visibility + stable ids", () => {
  test("classifies visibility from tags (gm/secret/hidden ⇒ secret)", () => {
    expect(visibilityOf(["magic"])).toBe("public");
    expect(visibilityOf(["lore", "SECRET"])).toBe("secret");
    expect(visibilityOf(["GM"])).toBe("secret");
    expect(visibilityOf(["hidden"])).toBe("secret");
  });

  test("derives stable ids and embeds title+body", () => {
    const docs = collectLoreDocs(world([{ id: "lore.a", title: "Title A", body: "Body of A." }]));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe("lore:lore.a#0");
    expect(docs[0]!.text).toContain("Title A");
    expect(docs[0]!.text).toContain("Body of A.");
    expect(docs[0]!.visibility).toBe("public");
  });
});

describe("LoreRetriever — build + retrieve plumbing (offline-deterministic)", () => {
  const corpus = world([
    { id: "lore.alpha", title: "Dragons", body: "The northern dragons hoard gold beneath the peaks." },
    { id: "lore.beta", title: "Rivers", body: "The Bracken brook winds through the market village." },
    { id: "lore.gamma", title: "Stones", body: "Seven warden stones ring the vale against the dark." },
  ]);

  test("an exact-text query surfaces the matching doc (identity plumbing)", async () => {
    const docs = collectLoreDocs(corpus);
    const r = new LoreRetriever(docs);
    await r.build(new OfflineGateway());
    // Query == a doc's exact chunk text ⇒ cosine 1.0 for that doc ⇒ it is the top hit.
    const target = docs.find((d) => d.source === "lore:lore.beta")!;
    const got = await r.retrieve(target.text, { k: 1, minScore: 0.99 });
    expect(got.public).toHaveLength(1);
    expect(got.public[0]).toContain("Rivers");
    expect(got.public[0]).toContain("Bracken brook");
  });

  test("offline determinism: same query twice, and two independent retrievers, agree", async () => {
    const docs = collectLoreDocs(corpus);
    const target = docs.find((d) => d.source === "lore:lore.alpha")!;

    const r1 = new LoreRetriever(collectLoreDocs(corpus));
    await r1.build(new OfflineGateway());
    const a = await r1.retrieve(target.text, { k: 3, minScore: 0 });
    const b = await r1.retrieve(target.text, { k: 3, minScore: 0 });
    expect(a).toEqual(b);

    const r2 = new LoreRetriever(collectLoreDocs(corpus));
    await r2.build(new OfflineGateway());
    const c = await r2.retrieve(target.text, { k: 3, minScore: 0 });
    expect(c).toEqual(a);
  });

  test("below-threshold hits are filtered (a non-identical query at a high floor ⇒ empty)", async () => {
    const docs = collectLoreDocs(corpus);
    const r = new LoreRetriever(docs);
    await r.build(new OfflineGateway());
    // No doc equals this exact string, so no cosine reaches 1.0; a 1.0 floor drops everything.
    const got = await r.retrieve("a completely unrelated phrase about nothing", { k: 3, minScore: 1.0 });
    expect(got).toEqual({ public: [], secret: [] });
  });

  test("blank query and no-lore world both yield empty buckets without touching the gateway", async () => {
    const r = new LoreRetriever(collectLoreDocs(corpus));
    await r.build(new OfflineGateway());
    expect(await r.retrieve("   ", { k: 3 })).toEqual({ public: [], secret: [] });

    const empty = new LoreRetriever(collectLoreDocs(world([])));
    await empty.build(new OfflineGateway());
    expect(await empty.retrieve("anything", { k: 3 })).toEqual({ public: [], secret: [] });
  });
});

describe("LoreRetriever — visibility bucketing: secret is retrievable but ONLY in the secret bucket", () => {
  const mixed = world([
    { id: "lore.pub", title: "Public", body: "Anyone may know the brook runs east.", tags: ["place"] },
    { id: "lore.sec", title: "Secret", body: "Only the GM knows the warden seal is failing.", tags: ["secret"] },
  ]);

  test("a secret-tagged entry is now retrievable — but in `secret`, never in `public`", async () => {
    const docs = collectLoreDocs(mixed);
    const secret = docs.find((d) => d.source === "lore:lore.sec")!;
    expect(secret.visibility).toBe("secret");

    const r = new LoreRetriever(docs);
    await r.build(new OfflineGateway());

    // Querying the secret's exact chunk text (cosine 1.0) surfaces it — in the secret bucket only.
    const got = await r.retrieve(secret.text, { k: 5, minScore: 0 });
    expect(got.secret.some((s) => s.includes("warden seal is failing"))).toBe(true);
    // ...and it is NEVER blended into the public bucket — the privacy boundary at the retriever.
    expect(got.public.some((s) => s.includes("warden seal is failing"))).toBe(false);
    expect(got.public.some((s) => s.includes("Secret"))).toBe(false);
  });

  test("a public entry is retrievable in `public`, never in `secret`", async () => {
    const docs = collectLoreDocs(mixed);
    const pub = docs.find((d) => d.source === "lore:lore.pub")!;
    const r = new LoreRetriever(docs);
    await r.build(new OfflineGateway());

    const got = await r.retrieve(pub.text, { k: 5, minScore: 0 });
    expect(got.public.some((s) => s.includes("brook runs east"))).toBe(true);
    expect(got.secret.some((s) => s.includes("brook runs east"))).toBe(false);
  });

  test("a broad query returns both buckets disjoint (no chunk appears in both)", async () => {
    const docs = collectLoreDocs(mixed);
    const r = new LoreRetriever(docs);
    await r.build(new OfflineGateway());
    // Floor 0 ⇒ both the public and secret chunks clear the threshold, exercising both buckets.
    const got = await r.retrieve("the warden brook seal east", { k: 5, minScore: 0 });
    expect(got.public.length + got.secret.length).toBeGreaterThan(0);
    for (const s of got.secret) expect(got.public).not.toContain(s);
    // The secret chunk, if present, is on the secret side only.
    if (got.secret.length) expect(got.secret.some((s) => s.includes("warden seal is failing"))).toBe(true);
  });
});

describe("LoreRetriever — best-effort: a throwing gateway yields empty and never throws", () => {
  /** A gateway whose embed always rejects (simulates an endpoint down mid-turn). */
  const throwingGateway = (): LlmGateway =>
    ({
      embed: (): Promise<EmbeddingResult> => Promise.reject(new Error("embed endpoint down")),
      complete: () => Promise.reject(new Error("n/a")),
      stream: async function* () {
        /* unused */
      },
    }) as unknown as LlmGateway;

  test("build does not throw on a failing gateway and leaves the index unbuilt", async () => {
    const r = new LoreRetriever(collectLoreDocs(world([{ id: "lore.a", title: "A", body: "Body A." }])));
    await r.build(throwingGateway()); // must resolve, not reject
    expect(r.ready).toBe(false);
  });

  test("retrieve returns empty BUCKETS (no throw) when the gateway is failing", async () => {
    const r = new LoreRetriever(collectLoreDocs(world([{ id: "lore.a", title: "A", body: "Body A." }])));
    await r.build(throwingGateway());
    const got = await r.retrieve("anything at all", { k: 3 });
    expect(got).toEqual({ public: [], secret: [] });
  });

  test("retrieve returns empty buckets when build() was never called (no gateway captured)", async () => {
    const r = new LoreRetriever(collectLoreDocs(world([{ id: "lore.a", title: "A", body: "Body A." }])));
    const got = await r.retrieve("anything at all", { k: 3 });
    expect(got).toEqual({ public: [], secret: [] });
  });
});

describe("knowledgeDocs — per-NPC knowledge as public chunks", () => {
  test("each non-empty line becomes one public chunk with a stable id", () => {
    const docs: LoreDoc[] = knowledgeDocs("knowledge:npc.x", ["Knows the road", "", "  ", "Knows the well"]);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.id).toBe("knowledge:npc.x#0");
    expect(docs[1]!.id).toBe("knowledge:npc.x#3");
    expect(docs.every((d) => d.visibility === "public")).toBe(true);
  });
});
