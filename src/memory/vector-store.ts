/**
 * Vector memory — retrieval over lore + campaign history, and per-NPC knowledge.
 *
 * The interface is the contract; a real LanceDB/pgvector adapter arrives at M4. The
 * in-memory cosine implementation below is small but real, so retrieval can be developed
 * and tested before a heavyweight vector DB is wired in.
 *
 * @author Runkai Zhang
 */

export interface VectorDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SearchHit {
  doc: VectorDoc;
  score: number;
}

export interface VectorStore {
  upsert(docs: VectorDoc[], vectors: number[][]): Promise<void>;
  search(queryVector: number[], k: number): Promise<SearchHit[]>;
}

/** Cosine similarity of two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Brute-force in-memory store. Fine for a single hand-authored world; not for scale. */
export class InMemoryVectorStore implements VectorStore {
  private entries: { doc: VectorDoc; vector: number[] }[] = [];

  upsert(docs: VectorDoc[], vectors: number[][]): Promise<void> {
    docs.forEach((doc, i) => {
      const vector = vectors[i] ?? [];
      const existing = this.entries.findIndex((e) => e.doc.id === doc.id);
      if (existing >= 0) this.entries[existing] = { doc, vector };
      else this.entries.push({ doc, vector });
    });
    return Promise.resolve();
  }

  search(queryVector: number[], k: number): Promise<SearchHit[]> {
    const hits = this.entries
      .map((e) => ({ doc: e.doc, score: cosineSimilarity(queryVector, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return Promise.resolve(hits);
  }
}
