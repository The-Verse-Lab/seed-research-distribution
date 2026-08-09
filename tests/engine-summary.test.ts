/**
 * Engine ↔ rolling-summary wiring (M4 follow-up) — the offline end-to-end smoke + best-effort guards.
 *
 * Proves the feature through the real `GameEngine` seam the CLI uses, fully OFFLINE (deterministic):
 *  - **regen + persistence + brief:** play several turns past the batch threshold ⇒ the engine folds
 *    the scrolled-out events into a summary (the deterministic `buildDigest` floor offline), writes
 *    the save-keyed summary sidecar, advances the cursor, and the summary then appears in the
 *    narrator brief on a LATER turn as `# STORY SO FAR`.
 *  - **NOT source of truth:** the summary lives ONLY in the sidecar — never in the persisted
 *    GameState snapshot (asserted by inspecting the store's saved state).
 *  - **best-effort / never-stall:** with summaries OFF (`summary:false`) no file is written and no
 *    `# STORY SO FAR` ever appears; a store whose reads throw on the summary path never crashes a
 *    turn.
 *
 * Deterministic + isolated: OfflineGateway, a throwaway `dataDir` per case (never `./data`), an
 * in-memory store. The background fold is fire-and-forget, so tests POLL (bounded) for the sidecar /
 * brief rather than racing it.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GameEngine, SUMMARY_BATCH, summarySidecarPath } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { LlmRole } from "../src/llm/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey, type EventQuery, type SaveKey } from "../src/state/store.ts";
import type { GameState } from "../src/state/types.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { StoredSummary } from "../src/memory/summary-store.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

function playset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Testhold",
    summary: "A quiet vale ringed by old stones.",
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

const key = makeSaveKey("c.t", "pc.you");

/** A captured narrator brief per turn (last user message to the narrator role). */
class BriefSpy implements LlmGateway {
  readonly briefs: string[] = [];
  private readonly inner = new OfflineGateway();
  complete(role: LlmRole, req: Parameters<LlmGateway["complete"]>[1]) {
    return this.inner.complete(role, req);
  }
  async *stream(role: LlmRole, req: Parameters<LlmGateway["stream"]>[1]) {
    if (role === "narrator") {
      const user = [...req.messages].reverse().find((m) => m.role === "user");
      if (user) this.briefs.push(user.content);
    }
    yield* this.inner.stream(role, req);
  }
  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Bounded poll: resolve once `cond()` is true, or after `tries` microtask/macrotask yields. */
async function waitFor(cond: () => boolean | Promise<boolean>, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond() as Promise<boolean>;
}

let ROOT = "";
async function tmpDir(): Promise<string> {
  if (!ROOT) ROOT = await mkdtemp(join(tmpdir(), "seed-esum-"));
  return mkdtemp(join(ROOT, "dd-"));
}
afterAll(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
});

describe("engine — rolling summary (offline, end-to-end)", () => {
  test("plays past the batch threshold ⇒ folds, persists a sidecar, and carries # STORY SO FAR forward", async () => {
    const dataDir = await tmpDir();
    const sidecar = summarySidecarPath(dataDir, key);
    const gateway = new BriefSpy();
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({ classifier: heuristicClassifier, playset: playset(), store, gateway, dataDir });
    await engine.start();

    // Each freeform turn emits at least one renderable event; run comfortably past SUMMARY_BATCH so a
    // fold is guaranteed to fire. (The fold runs fire-and-forget after each turn.)
    const turns = SUMMARY_BATCH + 6;
    for (let i = 0; i < turns; i++) {
      await engine.submitPlayerInput(`I search the ring of stones, attempt ${i}.`);
    }

    // The background fold settles → the sidecar appears.
    expect(await waitFor(() => exists(sidecar))).toBe(true);
    const stored = JSON.parse(await readFile(sidecar, "utf8")) as StoredSummary;
    expect(stored.campaignId).toBe("c.t");
    expect(stored.summary.length).toBeGreaterThan(0); // the deterministic digest floor, offline
    expect(stored.cursorSeq).toBeGreaterThanOrEqual(SUMMARY_BATCH - 1); // the cursor advanced

    // One more turn AFTER the summary exists ⇒ its brief carries `# STORY SO FAR`.
    const before = gateway.briefs.length;
    await engine.submitPlayerInput("I take stock of what has happened so far.");
    expect(await waitFor(() => gateway.briefs.length > before)).toBe(true);
    expect(gateway.briefs.at(-1) ?? "").toContain("# STORY SO FAR");
  });

  test("the summary is NOT in the persisted GameState snapshot (it is a sidecar-only derived cache)", async () => {
    const dataDir = await tmpDir();
    const sidecar = summarySidecarPath(dataDir, key);
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({ classifier: heuristicClassifier, playset: playset(), store, gateway: new OfflineGateway(), dataDir });
    await engine.start();
    for (let i = 0; i < SUMMARY_BATCH + 6; i++) await engine.submitPlayerInput(`Look around ${i}.`);
    await waitFor(() => exists(sidecar));

    const snapshot = (await store.load(key)) as GameState;
    // No summary text leaks into the snapshot under any plausible key.
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("# STORY SO FAR");
    expect(Object.keys(snapshot)).not.toContain("summary");
    expect(Object.keys(snapshot)).not.toContain("storySoFar");
  });

  test("a fresh engine on the same dataDir LOADS the sidecar and uses it from the first turn's brief", async () => {
    const dataDir = await tmpDir();
    const sidecar = summarySidecarPath(dataDir, key);

    // First engine: generate + persist the summary.
    const first = new GameEngine({ classifier: heuristicClassifier, playset: playset(), store: new InMemoryGameStateStore(), gateway: new OfflineGateway(), dataDir });
    await first.start();
    for (let i = 0; i < SUMMARY_BATCH + 6; i++) await first.submitPlayerInput(`Search ${i}.`);
    expect(await waitFor(() => exists(sidecar))).toBe(true);

    // Second engine, SAME dir, fresh in-memory log (cursor loaded from the sidecar): the very first
    // turn's brief already carries the loaded `# STORY SO FAR`.
    const gateway = new BriefSpy();
    const second = new GameEngine({ classifier: heuristicClassifier, playset: playset(), store: new InMemoryGameStateStore(), gateway, dataDir });
    await second.start();
    await second.submitPlayerInput("What has happened so far?");
    expect(gateway.briefs.at(-1) ?? "").toContain("# STORY SO FAR");
  });

  test("summaries OFF (summary:false): no sidecar is written and no # STORY SO FAR ever appears", async () => {
    const dataDir = await tmpDir();
    const sidecar = summarySidecarPath(dataDir, key);
    const gateway = new BriefSpy();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: playset(),
      store: new InMemoryGameStateStore(),
      gateway,
      dataDir,
      summary: false,
    });
    await engine.start();
    for (let i = 0; i < SUMMARY_BATCH + 6; i++) await engine.submitPlayerInput(`Search ${i}.`);
    // Give any (disabled) background work a chance — it should do nothing.
    await new Promise((r) => setTimeout(r, 50));
    expect(await exists(sidecar)).toBe(false);
    expect(gateway.briefs.every((b) => !b.includes("# STORY SO FAR"))).toBe(true);
  });

  test("best-effort: a store whose summary-path reads throw never crashes a turn", async () => {
    const dataDir = await tmpDir();
    // A store that throws on the limited/sinceSeq reads the fold uses, but works for the turn's own
    // recent-window read (limit RECENT_EVENT_READ_LIMIT). Distinguish by the small limit the fold uses.
    class FlakyStore extends InMemoryGameStateStore {
      override readEvents(saveKey: SaveKey, query?: EventQuery) {
        if (query?.limit === 1 || query?.sinceSeq !== undefined) {
          return Promise.reject(new Error("summary read boom"));
        }
        return super.readEvents(saveKey, query);
      }
    }
    const engine = new GameEngine({ classifier: heuristicClassifier, playset: playset(), store: new FlakyStore(), gateway: new OfflineGateway(), dataDir });
    await engine.start();
    // Every turn fires a fold that hits the throwing read; none of them may surface.
    for (let i = 0; i < SUMMARY_BATCH + 4; i++) {
      await expect(engine.submitPlayerInput(`Look ${i}.`)).resolves.toBeUndefined();
    }
    // The turns still ran (state advanced); the sidecar was never written.
    expect(await exists(summarySidecarPath(dataDir, key))).toBe(false);
  });
});
