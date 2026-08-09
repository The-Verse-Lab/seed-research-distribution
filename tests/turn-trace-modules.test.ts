/**
 * Per-module attribution — the turn trace records WHO acted, not just what the turn decided.
 *
 * `TickRunner` observes each phase handler (the commit queue's tail, the tick's applied-command
 * ledger, the bus seq) and hands the diff to a `TickProbe`. Two properties matter and are pinned
 * here: the probe is INERT unless a trace sink asked for it (a tick with no sink must behave exactly
 * as it did before attribution existed), and attribution never becomes a way for telemetry to break
 * a turn — a probe that throws is swallowed, a handler that throws is recorded AND rethrown.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { makeEngine } from "./support/harness.ts";
import { TickRunner, type TickContext, type TickModule, type TickProbe } from "../src/engine/tick.ts";
import type { ModulePhaseTrace, TurnTrace } from "../src/logging/types.ts";
import type { Command } from "../src/world/commands.ts";

/** A context with just the fields the probe observes (the runner reads everything defensively). */
function probeCtx(): TickContext {
  const queue: Command[] = [];
  const turnCommands: Command[] = [];
  return { data: { turnCommands }, queue } as unknown as TickContext;
}

async function runWith(module: TickModule, probe?: TickProbe, ctx: TickContext = probeCtx()): Promise<TickContext> {
  const runner = new TickRunner();
  runner.register(module);
  await runner.run(ctx, probe);
  return ctx;
}

function collector(): { probe: TickProbe; seen: ModulePhaseTrace[] } {
  const seen: ModulePhaseTrace[] = [];
  let seq = 0;
  return { probe: { seq: () => seq++, record: (r) => void seen.push(r) }, seen };
}

describe("tick module attribution", () => {
  test("a handler's enqueued and applied commands are attributed to it by name and phase", async () => {
    const { probe, seen } = collector();
    await runWith(
      {
        id: "spender",
        phases: {
          react: (ctx) => {
            ctx.queue.push({ type: "adjustHp", entityId: "pc.you", by: -1 });
            (ctx.data.turnCommands as Command[]).push({ type: "adjustCoins", entityId: "pc.you", by: -5 });
          },
        },
      },
      probe,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.moduleId).toBe("spender");
    expect(seen[0]!.phase).toBe("react");
    expect(seen[0]!.enqueued).toEqual(["adjustHp"]);
    expect(seen[0]!.applied).toEqual(["adjustCoins"]);
    expect(typeof seen[0]!.ms).toBe("number");
  });

  test("a no-op handler records a row with no mutation fields at all", async () => {
    const { probe, seen } = collector();
    await runWith({ id: "quiet", phases: { narrate: () => {} } }, probe);
    expect(seen[0]).toMatchObject({ moduleId: "quiet", phase: "narrate" });
    expect(seen[0]!.enqueued).toBeUndefined();
    expect(seen[0]!.applied).toBeUndefined();
    expect(seen[0]!.error).toBeUndefined();
  });

  test("one module's work is never charged to the next one", async () => {
    const { probe, seen } = collector();
    const runner = new TickRunner();
    runner.register({
      id: "first",
      phases: { react: (ctx) => void ctx.queue.push({ type: "adjustHp", entityId: "a", by: 1 }) },
    });
    runner.register({ id: "second", phases: { react: () => {} } });
    await runner.run(probeCtx(), probe);
    expect(seen.map((r) => [r.moduleId, r.enqueued])).toEqual([
      ["first", ["adjustHp"]],
      ["second", undefined],
    ]);
  });

  test("a throwing handler is recorded by name and the tick still fails", async () => {
    const { probe, seen } = collector();
    const boom = { id: "broken", phases: { resolve: () => { throw new Error("kaboom"); } } };
    await expect(runWith(boom, probe)).rejects.toThrow("kaboom");
    expect(seen[0]).toMatchObject({ moduleId: "broken", phase: "resolve", error: "kaboom" });
  });

  test("a probe that throws cannot break the tick", async () => {
    const bad: TickProbe = {
      record: () => {
        throw new Error("telemetry exploded");
      },
    };
    const ctx = await runWith(
      { id: "worker", phases: { react: (c) => void c.queue.push({ type: "adjustHp", entityId: "a", by: 1 }) } },
      bad,
    );
    expect(ctx.queue).toHaveLength(1); // the handler's work landed regardless
  });

  test("with no probe the runner takes its original path — a bare context still runs", async () => {
    // `tick-module-order.test.ts` calls `run({data:{}})`; the unprobed path must keep tolerating that.
    const ran: string[] = [];
    const runner = new TickRunner();
    runner.register({ id: "m", phases: { perceive: () => void ran.push("perceive") } });
    await runner.run({ data: {} } as unknown as TickContext);
    expect(ran).toEqual(["perceive"]);
  });

  test("a probed run tolerates a context with no queue or data", async () => {
    const { probe, seen } = collector();
    const runner = new TickRunner();
    runner.register({ id: "m", phases: { perceive: () => {} } });
    await runner.run({} as unknown as TickContext, probe);
    expect(seen[0]!.moduleId).toBe("m");
    expect(seen[0]!.enqueued).toBeUndefined();
  });
});

describe("module attribution on a real turn", () => {
  async function traceOneTurn(input: string): Promise<TurnTrace> {
    const traces: TurnTrace[] = [];
    const { engine } = await makeEngine({ onTurnTrace: (t) => traces.push(t) });
    await engine.submitPlayerInput(input);
    engine.stop();
    const player = traces.filter((t) => t.trigger === "player");
    expect(player).toHaveLength(1);
    return player[0]!;
  }

  test("a player turn attributes its world changes to the modules that made them", async () => {
    const t = await traceOneTurn("I look around the room.");
    expect(t.modules?.length).toBeGreaterThan(0);
    // `core` owns the mutation chokepoint: the commit transaction applies the tick's commands.
    const core = t.modules!.filter((m) => m.moduleId === "core");
    expect(core.length).toBeGreaterThan(0);
    // Every listed row earned its place — mutated, emitted, threw, or cost real time.
    for (const m of t.modules!) {
      expect(!!(m.enqueued || m.applied || m.emitted || m.error) || m.ms >= 2).toBe(true);
      expect(m.phase).toBeTruthy();
    }
    // Somebody narrated: the turn emitted events, and they are charged to a module.
    expect(t.modules!.some((m) => (m.emitted ?? 0) > 0)).toBe(true);
  });

  test("the quiet handlers are counted, never silently dropped", async () => {
    const t = await traceOneTurn("I look around the room.");
    // A tick invokes far more handlers than it lists; the remainder must be accounted for.
    expect((t.modulesQuiet ?? 0) + (t.modules?.length ?? 0)).toBeGreaterThan(t.modules?.length ?? 0);
  });

  test("with no trace sink the engine builds no probe and the turn is unaffected", async () => {
    const { engine } = await makeEngine();
    await engine.submitPlayerInput("I look around the room.");
    engine.stop();
    // Nothing to assert on the trace (there is none) — the point is that the turn completes.
    expect(engine.getState().partyLocationId).toBeTruthy();
  });
});
