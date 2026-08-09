/** HeartbeatScheduler pause/resume semantics for warm, temporarily disconnected sessions. */
import { describe, expect, test } from "bun:test";
import { HeartbeatScheduler } from "../src/director/heartbeat.ts";

describe("HeartbeatScheduler", () => {
  test("pause suppresses ticks while retaining registrations for resume", () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let nextId = 1;
    const live = new Map<number, () => void>();
    const delays = new Map<number, number>();

    globalThis.setInterval = ((callback: () => void, delay: number) => {
      const id = nextId++;
      live.set(id, callback);
      delays.set(id, delay);
      return id;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => {
      live.delete(id);
    }) as unknown as typeof clearInterval;

    try {
      const scheduler = new HeartbeatScheduler();
      const ticks: string[] = [];
      scheduler.onTick((id) => ticks.push(id));
      scheduler.register("npc.one", 30);
      expect([...delays.values()]).toEqual([30_000]);
      [...live.values()][0]?.();
      expect(ticks).toEqual(["npc.one"]);

      scheduler.pause();
      expect(live.size).toBe(0);
      scheduler.register("npc.two", 45);
      expect(live.size).toBe(0);

      scheduler.resume();
      expect(live.size).toBe(2);
      for (const fire of live.values()) fire();
      expect(ticks.slice(1).sort()).toEqual(["npc.one", "npc.two"]);

      scheduler.stop();
      expect(live.size).toBe(0);
      scheduler.resume();
      expect(live.size).toBe(0);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  // Regression: combat suspends autonomy with stop() and combat-end re-register()s every companion.
  // stop() must NOT set the viewer-pause flag, or those re-registrations silently no-op and NPCs go
  // permanently inert after the first fight (audit 2026-07-15, WIP regression in heartbeat.ts).
  test("stop() then register() re-arms with a viewer present (combat suspend → combat end)", () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let nextId = 1;
    const live = new Map<number, () => void>();
    globalThis.setInterval = ((callback: () => void) => {
      const id = nextId++;
      live.set(id, callback);
      return id;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => void live.delete(id)) as unknown as typeof clearInterval;

    try {
      const scheduler = new HeartbeatScheduler();
      const ticks: string[] = [];
      scheduler.onTick((id) => ticks.push(id));

      scheduler.register("npc.one", 30); // viewer present, no pause
      expect(live.size).toBe(1);

      scheduler.stop(); // combat begins — full suspend
      expect(live.size).toBe(0);

      scheduler.register("npc.one", 30); // combat ends — ensureHeartbeats re-registers
      expect(live.size).toBe(1); // MUST re-arm; the bug left it at 0 forever

      [...live.values()][0]?.();
      expect(ticks).toContain("npc.one");
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});
