/**
 * Lore ingestion — turn a world's authored lore (`World.lore[]`) into visibility-tagged chunks
 * ready to embed and index for read-only retrieval (M4, Part A).
 *
 * Pure and deterministic: no IO, no clock, no rand — given a World it always yields the same
 * chunks in the same order, so the index is reproducible and unit-testable offline. Visibility
 * follows a simple tag convention: an entry tagged `gm`/`secret`/`hidden` is classified `secret`;
 * everything else is `public`. The retriever indexes BOTH and buckets each hit by visibility:
 * `public` goes into the shared brief (DM + NPCs), `secret` ONLY into the DM's private narrate
 * channel (never an NPC prompt). The privacy boundary is enforced at the wiring layer.
 *
 * No file ingestion in v1 (the old base read `worlds/<name>/lore/*.md`); we index the structured
 * `World.lore[]` only, keeping retrieval a pure function of the loaded World.
 *
 * @author Runkai Zhang
 */
import type { World } from "../content/schema.ts";

/** A chunk may be read by everyone (the shared brief) or only by the GM (the DM-only narrate channel). */
export type Visibility = "public" | "secret";

/** A single retrievable lore chunk derived from one `World.lore[]` entry. */
export interface LoreDoc {
  /** Stable id `lore:<sourceId>#<chunkIndex>` — stable across runs so upserts are idempotent. */
  id: string;
  /** Short human label for the chunk (the lore title) — rendered as the bullet's prefix. */
  title: string;
  /** The chunk body that gets embedded and injected. */
  text: string;
  visibility: Visibility;
  /** Where the chunk came from (the lore id), for debugging. */
  source: string;
}

/** Tags that mark an entry GM-only. Case-insensitive. */
const SECRET_TAGS = new Set(["gm", "secret", "hidden"]);

/** Default chunking knobs — generous for short hand-authored lore; overlap keeps context across cuts. */
export const DEFAULT_CHUNK = { maxWords: 300, overlap: 40 } as const;

/**
 * Split prose into overlapping word windows. Returns the text as a single (whitespace-collapsed)
 * chunk when it fits within `maxWords`; otherwise slides a window of `maxWords` forward by
 * `maxWords - overlap` each step so adjacent chunks share context. Empty/whitespace text → [].
 */
export function chunkText(
  text: string,
  opts: { maxWords?: number; overlap?: number } = {},
): string[] {
  const maxWords = Math.max(1, opts.maxWords ?? DEFAULT_CHUNK.maxWords);
  const overlap = Math.min(Math.max(0, opts.overlap ?? DEFAULT_CHUNK.overlap), maxWords - 1);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= maxWords) return [words.join(" ")];

  const step = Math.max(1, maxWords - overlap);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
    if (i + maxWords >= words.length) break;
  }
  return chunks;
}

/**
 * Classify an entry's visibility from its tags. Any `gm`/`secret`/`hidden` tag (case-insensitive)
 * makes the whole entry `secret`; otherwise `public`.
 */
export function visibilityOf(tags: readonly string[]): Visibility {
  return tags.some((t) => SECRET_TAGS.has(t.trim().toLowerCase())) ? "secret" : "public";
}

/**
 * Gather every lore chunk for a world from the structured `World.lore[]` entries, in authored
 * order. Each entry's `title` is prepended to its `body` before chunking so the title is part of
 * what's embedded (a short entry then embeds title+body together). Deduped by chunk id defensively
 * (the loader already enforces unique lore ids, but a malformed hand-edited world won't double-index).
 */
export function collectLoreDocs(world: World): LoreDoc[] {
  const docs: LoreDoc[] = [];
  const seen = new Set<string>();

  for (const entry of world.lore) {
    const visibility = visibilityOf(entry.tags ?? []);
    const body = `${entry.title}\n${entry.body}`.trim();
    chunkText(body).forEach((text, i) => {
      const id = `lore:${entry.id}#${i}`;
      if (seen.has(id)) return;
      seen.add(id);
      docs.push({ id, title: entry.title, text, visibility, source: `lore:${entry.id}` });
    });
  }

  return docs;
}

/**
 * Build LoreDocs from a bare list of strings (e.g. an NPC's `knowledge[]`). Each non-empty string
 * becomes one public chunk with a stable id under `prefix`. Used by the per-NPC retrieval path so an
 * NPC can speak from what it personally knows. Knowledge is always public (it feeds an NPC's own
 * spoken reply); GM-secret knowledge is not a concept on the trunk.
 */
export function knowledgeDocs(prefix: string, knowledge: readonly string[]): LoreDoc[] {
  const docs: LoreDoc[] = [];
  const seen = new Set<string>();
  knowledge.forEach((line, i) => {
    const text = line.trim();
    if (!text) return;
    const id = `${prefix}#${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    docs.push({ id, title: "", text, visibility: "public", source: prefix });
  });
  return docs;
}
