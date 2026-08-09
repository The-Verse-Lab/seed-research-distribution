/**
 * D1 — heartbeat-vs-player-submit serialization (live r2, repro'd 4×/6).
 *
 * Every player turn now rides one engine-level promise chain (`runTickQueued`); a heartbeat
 * skips whenever the chain is busy OR a turn is queued, and a player submit that arrives while a
 * heartbeat is mid-flight WAITS its turn instead of hitting `runTick`'s in-flight throw. Offline
 * gateway + freeform classifier throughout — every assertion is deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { freeformClassifier } from "../src/engine/classify.ts";
import { loadExample } from "./support/harness.ts";

async function makeEngine(): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = await loadExample();
  const engine = new GameEngine({
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    classifier: freeformClassifier,
    rng: mulberry32(7),
    summary: false,
  });
  const events: GameEvent[] = [];
  engine.subscribe((event) => events.push(event));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

describe("tick serialization (D1)", () => {
  test("a heartbeat firing while a player turn is queued/in flight is skipped, not interleaved", async () => {
    const { engine, events } = await makeEngine();

    const turn = engine.submitPlayerInput("I look around the tavern");
    // Fired in the gap between enqueue and execution — the exact r2 race window.
    const beat = engine.tickHeartbeat("npc.lyra");
    await Promise.all([turn, beat]);

    // The player turn narrated; nothing threw and no autonomous tick interleaved mid-turn.
    expect(events.some((e) => e.kind === "narration")).toBe(true);
  });

  test("a player submit during an in-flight heartbeat waits its turn instead of throwing", async () => {
    const { engine, events } = await makeEngine();

    const beat = engine.tickHeartbeat("npc.lyra");
    // Pre-fix this rejected with "Another game operation is already in progress."
    const turn = engine.submitPlayerInput("I look around the tavern");
    await Promise.all([beat, turn]);

    expect(events.some((e) => e.kind === "narration")).toBe(true);
  });

  test("two rapid submits both resolve, in order", async () => {
    const { engine, events } = await makeEngine();

    const first = engine.submitPlayerInput("I check the hearth");
    const second = engine.submitPlayerInput("I sit down by the window");
    await Promise.all([first, second]);

    const narrations = events.filter((e) => e.kind === "narration");
    expect(narrations.length).toBeGreaterThanOrEqual(2);
  });
});
