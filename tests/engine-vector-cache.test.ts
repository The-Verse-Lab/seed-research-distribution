/**
 * Engine ↔ lore vector-cache wiring (M4 follow-up) — the two-start "load-skips-embed" smoke, offline.
 *
 * Proves the cache works end-to-end through `GameEngine`, the seam the CLI uses:
 *  - **cache ON (default):** a first engine over a temp `dataDir` builds the lore index and writes
 *    `<dataDir>/lore-vectors.json`; a SECOND engine on the SAME dir + SAME world LOADS it — its spy
 *    gateway records ZERO doc-embeds (only the per-turn query embed) — and retrieval still surfaces
 *    the right lore (`# RELEVANT LORE` in the brief).
 *  - **cache OFF (`lore.cache=false`):** no file is written and the second engine re-embeds — the knob
 *    (`SEED_LORE_CACHE`) genuinely gates persistence.
 *
 * Deterministic + isolated: OfflineGateway embeddings, a throwaway `dataDir` per case (never `./data`),
 * the InMemory store. The index is forced to build by running ONE player turn (the narrate phase
 * awaits `lore.retrieve`, which self-builds) so there's no race on the background `start()` build.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { EmbeddingResult, LlmRole } from "../src/llm/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { loadConfig } from "../src/config/env.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** Records narrator briefs (to assert lore injection) and counts DOC embeds vs the QUERY embed. */
class SpyGateway implements LlmGateway {
  docEmbedCalls = 0;
  queryEmbedCalls = 0;
  readonly narratorBriefs: string[] = [];
  private readonly inner = new OfflineGateway();
  complete(role: LlmRole, req: Parameters<LlmGateway["complete"]>[1]) {
    return this.inner.complete(role, req);
  }
  async *stream(role: LlmRole, req: Parameters<LlmGateway["stream"]>[1]) {
    if (role === "narrator") {
      const user = [...req.messages].reverse().find((m) => m.role === "user");
      if (user) this.narratorBriefs.push(user.content);
    }
    yield* this.inner.stream(role, req);
  }
  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    // A build embeds the whole corpus (here >1 chunk); a retrieve embeds exactly one query string.
    if (texts.length === 1) this.queryEmbedCalls += 1;
    else this.docEmbedCalls += 1;
    return this.inner.embed(role, texts);
  }
}

function playset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Testhold",
    summary: "A quiet vale ringed by old stones.",
    lore: [
      { id: "lore.stones", title: "The Warden Stones", body: "Seven standing stones ring the vale, set to hold back the dark." },
      { id: "lore.brook", title: "The Bracken Brook", body: "The brook winds east through the market village toward the mill." },
    ],
    locations: [{ id: "loc.room", name: "The Ring", description: "A circle of weathered stones." }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.t",
    name: "C",
    worldId: "w.t",
    characters: [{ id: "pc.you", name: "You", stats: STATS }],
    startingState: { locationId: "loc.room", party: ["pc.you"] },
  });
  return { world, campaign };
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** One engine over a given temp dir; one turn forces the lore index to build (and the cache to save). */
async function runOneTurn(dataDir: string, cache: boolean): Promise<SpyGateway> {
  const gateway = new SpyGateway();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset: playset(),
    store: new InMemoryGameStateStore(),
    gateway,
    lore: { k: 4, minScore: 0, cache },
    dataDir,
    embeddingModel: "nomic-embed-text",
  });
  await engine.start();
  await engine.submitPlayerInput("I study the warden stones around me.");
  return gateway;
}

let TMP_ROOT = "";
async function tmpDir(): Promise<string> {
  if (!TMP_ROOT) TMP_ROOT = await mkdtemp(join(tmpdir(), "seed-evc-"));
  return mkdtemp(join(TMP_ROOT, "dd-"));
}

afterAll(async () => {
  if (TMP_ROOT) await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("engine — lore vector cache: two-start load-skips-embed (offline)", () => {
  test("cache ON: first start writes the cache; a second start on the same dir LOADS (no doc embed) and still surfaces lore", async () => {
    const dataDir = await tmpDir();
    const cachePath = join(dataDir, "lore-vectors.json");

    // First start: cold — embeds the corpus, writes the cache.
    const first = await runOneTurn(dataDir, true);
    expect(first.docEmbedCalls).toBe(1);
    expect(await exists(cachePath)).toBe(true);
    expect(first.narratorBriefs.at(-1) ?? "").toContain("# RELEVANT LORE");

    // Second start: warm — SAME dir + world ⇒ LOADS the vectors, never re-embeds the docs.
    const second = await runOneTurn(dataDir, true);
    expect(second.docEmbedCalls).toBe(0); // <-- the load-skips-embed proof through the engine
    expect(second.queryEmbedCalls).toBeGreaterThan(0); // the turn's query still embeds
    // Retrieval still works off the loaded index — the same lore reaches the brief.
    expect(second.narratorBriefs.at(-1) ?? "").toContain("# RELEVANT LORE");
    expect(second.narratorBriefs.at(-1) ?? "").toContain("The Warden Stones");
  });

  test("cache OFF: no file is written and a second start re-embeds (the SEED_LORE_CACHE knob gates persistence)", async () => {
    const dataDir = await tmpDir();
    const cachePath = join(dataDir, "lore-vectors.json");

    const first = await runOneTurn(dataDir, false);
    expect(first.docEmbedCalls).toBe(1);
    expect(await exists(cachePath)).toBe(false); // Noop cache ⇒ nothing on disk

    const second = await runOneTurn(dataDir, false);
    expect(second.docEmbedCalls).toBe(1); // no cache ⇒ re-embedded
    expect(await exists(cachePath)).toBe(false);
  });
});

describe("SEED_LORE_CACHE knob — loadConfig parses it (default ON, opt-out)", () => {
  test("default is ON", () => {
    expect(loadConfig({}).lore.cache).toBe(true);
  });
  test("explicit off values disable it", () => {
    for (const v of ["0", "false", "off", "no", "OFF", "False"]) {
      expect(loadConfig({ SEED_LORE_CACHE: v }).lore.cache).toBe(false);
    }
  });
  test("truthy / other values keep it on", () => {
    for (const v of ["1", "true", "on", "yes", "anything"]) {
      expect(loadConfig({ SEED_LORE_CACHE: v }).lore.cache).toBe(true);
    }
  });
});
