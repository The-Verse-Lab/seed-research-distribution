/**
 * Engine turn-loop tests — assert the emitted event sequence for representative inputs,
 * fully deterministic (offline gateway + seeded rng, no network).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { byKind, kinds, LeaderPlanGateway, makeEngine } from "./support/harness.ts";
import { freeformPlan } from "../src/engine/turn-plan.ts";
import { TURN_COSTS } from "../src/rules/costs.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import { makeSaveKey } from "../src/state/store.ts";

/** A gateway whose every call fails — to exercise mid-turn narrator degradation. */
class FailingGateway implements LlmGateway {
  complete(): Promise<never> {
    return Promise.reject(new Error("endpoint down"));
  }
  async *stream(): AsyncGenerator<never> {
    throw new Error("endpoint down");
  }
  embed(): Promise<{ vectors: number[][]; model: string }> {
    return Promise.resolve({ vectors: [], model: "failing" });
  }
}

describe("start()", () => {
  test("emits a system load notice then the opening narration", async () => {
    const { events } = await makeEngine();
    expect(kinds(events)).toEqual(["system", "narration"]);
    expect(byKind(events, "narration")[0]?.text).toContain("Ashen Tankard");
  });
});

describe("freeform narration", () => {
  test("produces a single narration that echoes the action (offline)", async () => {
    const { engine, events } = await makeEngine();
    events.length = 0;
    await engine.submitPlayerInput("I admire the firelight and the worn floorboards.");
    // The player's own free-text line is recorded as a dialogue event (so it lands in the transcript
    // export and the narrator's # RECENT history) ahead of the GM's narration.
    expect(kinds(events)).toEqual(["dialogue", "narration"]);
    expect(byKind(events, "narration")[0]?.text).toContain("admire the firelight");
  });
});

describe("movement", () => {
  test("to a connected location updates state and narrates", async () => {
    const { engine, events } = await makeEngine();
    events.length = 0;
    await engine.submitPlayerInput("go to the square");
    // Movement now crosses the reducer: authoritative entityMoved delta(s), then the prose
    // summary (`stateChanged`) immediately followed by narration. A travelling companion also gets a
    // "traveled" memory beat, whose `npcMemoryRecorded` delta commits AFTER narration — so assert the
    // stateChanged→narration adjacency rather than that narration is the very last event.
    const k = kinds(events);
    const sc = k.indexOf("stateChanged");
    expect(sc).toBeGreaterThanOrEqual(0);
    expect(k[sc + 1]).toBe("narration");
    expect(byKind(events, "entityMoved").some((e) => e.entityId === "pc.you" && e.to === "loc.square")).toBe(
      true,
    );
    expect(engine.getState().partyLocationId).toBe("loc.square");
  });

  test("with no reachable destination does not move the party", async () => {
    const { engine, events } = await makeEngine();
    events.length = 0;
    await engine.submitPlayerInput("go to the distant capital");
    expect(engine.getState().partyLocationId).toBe("loc.tavern");
    // Leading `dialogue` is the recorded player line (see the freeform-narration test). The
    // `stateChanged` between it and the prose is the r14 degrade RECEIPT — the refusal reaches the
    // screen mechanically, where narrator prose cannot overwrite it (fixture-combat t6–t8 ran this
    // degrade silently three turns straight). This line carries no destination the DSL grounds,
    // so it takes the destination-less branch's nameless receipt, ways-out list and all.
    expect(kinds(events)).toEqual(["dialogue", "stateChanged", "narration"]);
    const receipt = byKind(events, "stateChanged")[0];
    expect(receipt?.summary).toContain("No clear way onward from here.");
    expect(receipt?.summary).toContain("Ways on from here:");
  });
});

describe("ability check", () => {
  test("an uncertain attempt rolls deterministically and narrates the verdict", async () => {
    const { engine, events } = await makeEngine();
    events.length = 0;
    await engine.submitPlayerInput("I climb up onto the rafters.");
    // Leading `dialogue` is the recorded player line (see the freeform-narration test).
    expect(kinds(events)).toEqual(["dialogue", "diceRolled", "narration"]);
    const roll = byKind(events, "diceRolled")[0];
    expect(roll?.purpose).toContain("Dexterity");
    expect(roll?.rolls.length).toBe(1);
    expect(typeof roll?.success).toBe("boolean");
  });

  test("the same seed yields the same roll (replayable)", async () => {
    const a = await makeEngine();
    a.events.length = 0;
    await a.engine.submitPlayerInput("I climb up onto the rafters.");
    const b = await makeEngine();
    b.events.length = 0;
    await b.engine.submitPlayerInput("I climb up onto the rafters.");
    expect(byKind(a.events, "diceRolled")[0]?.total).toBe(byKind(b.events, "diceRolled")[0]?.total);
  });
});

describe("companion dialogue", () => {
  test("addressing a companion yields the player line then the companion's reply", async () => {
    const { engine, events, beats } = await makeEngine();
    events.length = 0;
    beats.length = 0;
    await engine.submitPlayerInput("Lyra, what's our move?");
    // The PLAYER's line is still a dialogue event; the companion's PUBLIC reply is a DM-narrated beat.
    const lines = byKind(events, "dialogue");
    expect(lines.length).toBe(1);
    expect(lines[0]?.actorId).toBe("pc.you");
    const reply = beats.find((b) => b.actorId === "npc.lyra");
    expect(reply).toBeDefined();
    expect((reply?.dialogue?.length ?? 0)).toBeGreaterThan(0);
  });

  test("addressing a present location NPC (non-companion) yields a real in-character reply", async () => {
    // Workstream B slice: public address reaches ANY present NPC through the ephemeral fallback
    // agent — Brann answers himself now (as a DM-narrated beat), no longer voiced inside GM narration.
    const { engine, events, beats } = await makeEngine();
    events.length = 0;
    beats.length = 0;
    await engine.submitPlayerInput("Brann, heard anything from the east road?");
    // The PLAYER's line is still a dialogue event; the addressed NPC's PUBLIC reply is a beat.
    const lines = byKind(events, "dialogue");
    expect(lines[0]?.actorId).toBe("pc.you");
    const reply = beats.find((b) => b.actorId === "npc.brann"); // the addressed NPC answers
    expect(reply).toBeDefined();
    expect((reply?.dialogue?.length ?? 0)).toBeGreaterThan(0);
    // A PUBLIC reply carries no private-channel dialogue event — everyone hears it.
    expect(byKind(events, "dialogue").some((d) => d.actorId === "npc.brann")).toBe(false);
    // (A companion may still add a priority-B autonomy reaction after — that path is unchanged.)
  });
});

describe("heartbeat tick", () => {
  // Updated for Phase 6 (the autonomy Director): a heartbeat is no longer a no-op. Lyra is a
  // `leader` companion in the example world, so her heartbeat can self-initiate a party-level
  // proposal (priority C). The clock still only advances on a player turn.
  test("a leader companion's heartbeat self-initiates a proposal when its intent is a real plan", async () => {
    const { engine, events } = await makeEngine({
      gateway: new LeaderPlanGateway({
        act: { do: "move", target: "loc.square" },
        visibleSpeech: "We should take the square before dark.",
      }),
    });
    const clock = engine.getState().clock;
    events.length = 0;
    await engine.tickHeartbeat("npc.lyra");
    expect(byKind(events, "npcProposal").length).toBe(1);
    expect(engine.getState().clock).toBe(clock); // heartbeats don't tick the in-game clock
  });

  test("a leader's command-less beat SPEAKS instead of minting an empty AGREE/DECLINE card", async () => {
    // The 2026-07-24 playtest's proposal churn: every spontaneous beat became a card, including pure
    // advice ("keep your spacing"), because the gate short-circuited on `priority === "C"` before it
    // ever asked whether there was a command to consent TO. Accepting one of those did nothing at all.
    const { engine, events } = await makeEngine();
    events.length = 0;
    await engine.tickHeartbeat("npc.lyra");
    expect(byKind(events, "npcProposal").length).toBe(0);
  });
});

describe("robustness", () => {
  test("empty input is a no-op (no events, no clock advance)", async () => {
    const { engine, events } = await makeEngine();
    const clock = engine.getState().clock;
    events.length = 0;
    await engine.submitPlayerInput("   ");
    expect(events.length).toBe(0);
    expect(engine.getState().clock).toBe(clock);
  });

  test("the in-game clock advances on a real turn", async () => {
    const { engine } = await makeEngine();
    const before = engine.getState().clock;
    // Per-action costs (Workstream H): a real turn advances by its kind's cost-table row —
    // at least the historic minute, never zero.
    await engine.submitPlayerInput("I wait and listen.");
    expect(engine.getState().clock).toBeGreaterThanOrEqual(before + 1);
  });

  test("a prior turn's verdict does not leak into the next narration", async () => {
    const { engine, events } = await makeEngine();
    await engine.submitPlayerInput("I climb the wall."); // resolves a check (a verdict exists)
    events.length = 0;
    await engine.submitPlayerInput("I take a slow look around.");
    const narration = byKind(events, "narration")[0]?.text ?? "";
    expect(narration).not.toContain("attempt succeeds");
    expect(narration).not.toContain("attempt fails");
  });
});

describe("review fixes", () => {
  test("system notices are broadcast but not written to the durable log", async () => {
    const { store, playset } = await makeEngine();
    const logged = await store.readEvents(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]));
    expect(logged.every((e) => e.kind !== "system")).toBe(true);
    expect(logged.some((e) => e.kind === "narration")).toBe(true);
  });

  test("a meta/OOC request gets a system hint, no narration, and no clock advance", async () => {
    const metaClassifier: TurnClassifier = {
      classify: () => Promise.resolve({ ...freeformPlan(), kind: "metaOOC" }),
    };
    const { engine, events } = await makeEngine({ classifier: metaClassifier });
    const before = engine.getState().clock;
    events.length = 0;
    await engine.submitPlayerInput("save my game, please");
    expect(kinds(events)).toContain("system");
    expect(kinds(events)).not.toContain("narration");
    expect(engine.getState().clock).toBe(before);
  });

  test("a narrator outage degrades to offline narration without losing the turn", async () => {
    const { engine, events } = await makeEngine({ gateway: new FailingGateway() });
    const before = engine.getState().clock;
    events.length = 0;
    await engine.submitPlayerInput("I wait by the fire.");
    expect(byKind(events, "narration")[0]?.text.length ?? 0).toBeGreaterThan(0);
    expect(engine.getState().clock).toBe(before + TURN_COSTS.freeformNarrative.minutes);
  });

  test("an incidental location-word does not trigger movement", async () => {
    const { engine } = await makeEngine();
    await engine.submitPlayerInput("I examine the square table for scratches.");
    expect(engine.getState().partyLocationId).toBe("loc.tavern"); // did not travel
  });

  test("restart re-initializes the campaign from the opening", async () => {
    const { engine, events } = await makeEngine();
    await engine.submitPlayerInput("I wait and listen.");
    expect(engine.getState().clock).toBeGreaterThan(0);
    events.length = 0;
    await engine.restart();
    expect(engine.getState().clock).toBe(0);
    expect(kinds(events)).toContain("narration"); // opening replayed
  });
});
