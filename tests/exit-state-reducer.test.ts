/**
 * Exit-state reducer + replay spine (Workstream H) — the single-writer + `snapshot == fold(deltas)`
 * contract for the mutable exit-state overlay. Pure, deterministic, no engine/IO. Asserts: the pure
 * leaf helpers (exitKey, content-derived initial states, the isPassable truth table, display tags),
 * `setExitState` mirroring onto the reverse exit (one ABSOLUTE delta per changed direction, exactly
 * one when the exit is one-way), idempotent noops, rejection of unknown exits, that movement —
 * party AND lone NPC alike — obeys the same barred-exit physics, that traversal READS never
 * materialize the slice (protecting snapshot == fold(deltas)), and that a collected delta sequence
 * folds back to the live model's exact projection.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { applyCommand } from "../src/world/reducer.ts";
import { applyDelta, reduceDeltas } from "./support/replay.ts";
import { fromGameState, toGameState, partyLocationOf, type WorldModel } from "../src/world/model.ts";
import {
  exitKey,
  initialExitState,
  isPassable,
  exitStateTag,
  type ExitRuntimeState,
  type ExitStateSlice,
} from "../src/rules/exit-state.ts";
import { overlayExitState, canTraverse, exitVerdict, barredExitsAt } from "../src/world/traversal.ts";
import { ExitSchema, type Exit } from "../src/content/schema.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import { loadExample } from "./support/harness.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";

/** A started engine's projected state → a fresh model seeded from the example world. */
async function exampleModel(): Promise<WorldModel> {
  const playset = await loadExample();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  return fromGameState(engine.getState(), playset.world, playset.campaign);
}

/** Stamp a pre-delta with the id/at/seq the bus assigns, yielding a full DeltaEvent. */
const stamp = (pre: EmittedDelta, seq: number): DeltaEvent =>
  ({ ...pre, id: `d${seq}`, at: 0, seq }) as DeltaEvent;

/** A schema-parsed Exit (defaults applied) so the leaf helpers see real content shapes. */
const exit = (partial: Record<string, unknown> = {}): Exit => ExitSchema.parse({ to: "loc.b", ...partial });

describe("exit-state — pure leaf helpers", () => {
  test("exitKey is the directed `from->to` string", () => {
    expect(exitKey("loc.a", "loc.b")).toBe("loc.a->loc.b");
    expect(exitKey("loc.b", "loc.a")).toBe("loc.b->loc.a"); // direction matters — distinct keys
  });

  test("initialExitState derives from content: barrier kind, legacy locked, plain open", () => {
    expect(initialExitState(exit({ barrier: { kind: "door" } }))).toBe("locked");
    expect(initialExitState(exit({ barrier: { kind: "gate" } }))).toBe("locked");
    expect(initialExitState(exit({ barrier: { kind: "magical" } }))).toBe("locked");
    expect(initialExitState(exit({ barrier: { kind: "rubble" } }))).toBe("blocked"); // force is the only way through
    expect(initialExitState(exit({ locked: true }))).toBe("locked"); // legacy hard lock, no barrier
    expect(initialExitState(exit())).toBe("open"); // plain exit
  });

  test("isPassable truth table: open/broken pass, locked/blocked bar", () => {
    expect(isPassable("open")).toBe(true);
    expect(isPassable("broken")).toBe(true); // a forced door stays open for good
    expect(isPassable("locked")).toBe(false);
    expect(isPassable("blocked")).toBe(false);
  });

  test("exitStateTag renders the display suffix per state (open is empty)", () => {
    const tags: Record<ExitRuntimeState, string> = {
      open: "",
      locked: " (locked)",
      blocked: " (blocked)",
      broken: " (broken open)",
    };
    for (const [state, tag] of Object.entries(tags)) {
      expect(exitStateTag(state as ExitRuntimeState)).toBe(tag);
    }
  });
});

describe("reducer — setExitState", () => {
  test("locking a two-way exit mirrors onto the reverse: two absolute deltas, both directions barred", async () => {
    const model = await exampleModel();
    const res = applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "locked" });
    expect(res.mutated).toBe(true);
    // One absolute delta PER CHANGED DIRECTION — the reverse exit exists, so exactly two.
    expect(res.deltas).toHaveLength(2);
    expect(res.deltas[0]).toMatchObject({ kind: "exitStateChanged", locationId: "loc.tavern", to: "loc.square", state: "locked" });
    expect(res.deltas[1]).toMatchObject({ kind: "exitStateChanged", locationId: "loc.square", to: "loc.tavern", state: "locked" });

    // The overlay reads back "locked" for BOTH directions (a door is one object seen from two sides).
    expect(overlayExitState(model.modules, "loc.tavern", "loc.square")).toBe("locked");
    expect(overlayExitState(model.modules, "loc.square", "loc.tavern")).toBe("locked");
    expect(canTraverse(model, "loc.tavern", "loc.square")).toBe(false);
    expect(canTraverse(model, "loc.square", "loc.tavern")).toBe(false);

    // The party cannot pass, and stays put.
    const move = applyCommand(model, { type: "moveParty", to: "loc.square" });
    expect(move.mutated).toBe(false);
    expect(move.rejected?.reason).toContain("locked");
    expect(partyLocationOf(model)).toBe("loc.tavern");

    // Same physics for a lone NPC: moveEntity through the locked exit is rejected too.
    const npcMove = applyCommand(model, { type: "moveEntity", entityId: "npc.brann", to: "loc.square" });
    expect(npcMove.mutated).toBe(false);
    expect(npcMove.rejected?.reason).toContain("locked");
    expect(model.entities.get("npc.brann")?.locationId).toBe("loc.tavern");
  });

  test("re-applying the same state is an idempotent noop: no mutation, zero deltas", async () => {
    const model = await exampleModel();
    applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "locked" });
    const again = applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "locked" });
    expect(again.mutated).toBe(false);
    expect(again.deltas).toHaveLength(0);
  });

  test("re-opening a locked exit lets the party through again", async () => {
    const model = await exampleModel();
    applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "locked" });
    expect(applyCommand(model, { type: "moveParty", to: "loc.square" }).mutated).toBe(false);

    const reopen = applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "open" });
    expect(reopen.mutated).toBe(true);
    const move = applyCommand(model, { type: "moveParty", to: "loc.square" });
    expect(move.mutated).toBe(true);
    expect(partyLocationOf(model)).toBe("loc.square");
  });

  test("broken is passable — a blocked exit bars movement, breaking it opens the way for good", async () => {
    const model = await exampleModel();
    applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "blocked" });
    const barred = applyCommand(model, { type: "moveParty", to: "loc.square" });
    expect(barred.mutated).toBe(false);
    expect(barred.rejected?.reason).toContain("blocked");

    applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "broken" });
    expect(canTraverse(model, "loc.tavern", "loc.square")).toBe(true);
    expect(applyCommand(model, { type: "moveParty", to: "loc.square" }).mutated).toBe(true);
    expect(partyLocationOf(model)).toBe("loc.square");
  });

  test("a one-way exit (no reverse) emits exactly ONE delta — nothing to mirror onto", async () => {
    const model = await exampleModel();
    // Hand-craft the map so only tavern→square exists: strip the square's exits entirely.
    model.map.exits.set("loc.square", []);
    const res = applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state: "locked" });
    expect(res.mutated).toBe(true);
    expect(res.deltas).toHaveLength(1);
    expect(res.deltas[0]).toMatchObject({ kind: "exitStateChanged", locationId: "loc.tavern", to: "loc.square", state: "locked" });
    expect(overlayExitState(model.modules, "loc.tavern", "loc.square")).toBe("locked");
    expect(overlayExitState(model.modules, "loc.square", "loc.tavern")).toBeUndefined();
    // Only the one directed key was written.
    expect(Object.keys((model.modules.exitState as ExitStateSlice).states)).toEqual(["loc.tavern->loc.square"]);
  });

  test("an unknown exit is rejected with 'no exit' and mutates nothing", async () => {
    const model = await exampleModel();
    const res = applyCommand(model, { type: "setExitState", locationId: "loc.tavern", to: "loc.nowhere", state: "locked" });
    expect(res.mutated).toBe(false);
    expect(res.deltas).toHaveLength(0);
    expect(res.rejected?.reason).toContain("no exit");
  });
});

describe("traversal — reads never materialize the slice", () => {
  test("canTraverse/exitVerdict/barredExitsAt on a fresh model leave modules.exitState absent", async () => {
    const model = await exampleModel();
    expect("exitState" in model.modules).toBe(false); // nothing wrote it during startup

    expect(canTraverse(model, "loc.tavern", "loc.square")).toBe(true);
    expect(exitVerdict(model, "loc.tavern", "loc.square")?.state).toBe("open");
    expect(barredExitsAt(model, "loc.tavern")).toEqual([]);
    expect(overlayExitState(model.modules, "loc.tavern", "loc.square")).toBeUndefined();

    // READ-only discipline: a read materializing the slice would let a live model and a delta-fold
    // diverge in shape and silently break `snapshot == fold(deltas)`.
    expect("exitState" in model.modules).toBe(false);
  });
});

describe("replay — fold stays in lockstep with the reducer", () => {
  test("a lock→broken delta sequence folds onto the pre-command seed to the live projection", async () => {
    const live = await exampleModel();
    const seed = structuredClone(live); // the fold target: the very same pre-command seed

    const deltas: DeltaEvent[] = [];
    for (const state of ["locked", "broken"] as const) {
      const res = applyCommand(live, { type: "setExitState", locationId: "loc.tavern", to: "loc.square", state });
      expect(res.mutated).toBe(true);
      expect(res.deltas).toHaveLength(2); // mirrored — both directions each time
      for (const pre of res.deltas) deltas.push(stamp(pre, deltas.length));
    }

    reduceDeltas(seed, deltas);
    expect(toGameState(seed)).toEqual(toGameState(live));

    // Absolute post-state deltas are idempotent: re-folding changes nothing.
    for (const d of deltas) applyDelta(seed, d);
    expect(toGameState(seed)).toEqual(toGameState(live));
  });
});
