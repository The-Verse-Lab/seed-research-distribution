/**
 * Turn trace (Workstream D, slim) — the engine hands a per-turn decision skeleton to `onTurnTrace`.
 *
 * Telemetry, not world state: it never touches the reducer/deltas/brief. These specs pin the
 * shape (classifier decision + accepted PUBLIC NPC beats), determinism under a fixed seed, and the
 * The disclosure-ledger / structured-NpcIntent cores are deferred.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { makeEngine } from "./support/harness.ts";
import type { TurnTrace } from "../src/logging/types.ts";

async function traceOneTurn(input: string): Promise<TurnTrace> {
  const traces: TurnTrace[] = [];
  const { engine } = await makeEngine({ onTurnTrace: (t) => traces.push(t) });
  await engine.submitPlayerInput(input);
  engine.stop();
  const player = traces.filter((t) => t.trigger === "player");
  expect(player.length).toBe(1);
  return player[0]!;
}

describe("turn trace (Workstream D)", () => {
  test("a player turn produces one trace carrying the classified decision + accepted NPC beats", async () => {
    const t = await traceOneTurn("Lyra, what's the plan?");
    expect(t.trigger).toBe("player");
    expect(t.input).toBe("Lyra, what's the plan?");
    expect(t.classifierKind).toBe("dialogueToNpc");
    expect(t.classifierTargetId).toBe("npc.lyra");
    expect(typeof t.classifierConfidence).toBe("number");
    // A well-formed seq/time window.
    expect(t.turnSeq).toBeGreaterThanOrEqual(0);
    expect(t.seqStart).toBe(t.turnSeq);
    expect(t.seqEnd).toBeGreaterThanOrEqual(t.seqStart - 1);
    expect(t.atEnd).toBeGreaterThanOrEqual(t.atStart);
    // The addressed companion's reply is an accepted, already-emitted PUBLIC beat.
    expect(t.npcBeats?.some((b) => b.actorId === "npc.lyra" && !!b.dialogue)).toBe(true);
  });

  test("a check turn records the classifier check (ability + dc)", async () => {
    const t = await traceOneTurn("I try to pick the lock.");
    expect(t.classifierKind).toBe("attemptRequiringCheck");
    expect(t.classifierCheck).toBeTruthy();
    expect(typeof t.classifierCheck?.dc).toBe("number");
  });

  test("same seed + same input → identical decision fields (determinism)", async () => {
    const a = await traceOneTurn("Lyra, what's the plan?");
    const b = await traceOneTurn("Lyra, what's the plan?");
    expect(b.classifierKind).toBe(a.classifierKind);
    expect(b.classifierTargetId).toBe(a.classifierTargetId);
    expect(b.turnSeq).toBe(a.turnSeq);
    expect(b.npcBeats?.map((x) => x.actorId)).toEqual(a.npcBeats?.map((x) => x.actorId));
  });

  test("the turn auditor records Tier-1 violations on the trace; clean turns carry no audit", async () => {
    // Clean turn: nothing in the echoed prose matches a violation pattern — no audit field at all.
    const clean = await traceOneTurn("I look around the room.");
    expect(clean.audit).toBeUndefined();
    // A phantom door-opening claim rides the player line into the (offline) narrator echo with no
    // setExitState to authorize it: the auditor screens the EMITTED prose and records the finding,
    // machine-visible in the Observatory instead of eyeball-only.
    const dirty = await traceOneTurn("The heavy cellar door swings open before me and I slip through.");
    expect(dirty.audit?.some((a) => a.kind === "phantomState")).toBe(true);
    expect(dirty.audit?.[0]?.detail).toBeTruthy();
  });

});
