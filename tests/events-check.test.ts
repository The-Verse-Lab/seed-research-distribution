/**
 * Phase 1 (Mystery wave prereq) — `check` in the GENERIC prebaked EventsModule.
 *
 * Before this, `check` silently no-op'd in the prebaked path (`effectToCommand` returns null for it),
 * so an authored "search → skill check → reveal" beat could never branch. The module now expands
 * `check` recursively like the travel/npc-event expanders: a private keyed d20, a settled
 * `diceRolled` event, then `onSuccess`/`onFail`. DC extremes make the branch deterministic here
 * regardless of the PC's ability scores.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { PrebakedEventSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";

function thistledown(): Promise<PlaySet> {
  return loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url)));
}

function makeEngine(playset: PlaySet, store: InMemoryGameStateStore) {
  const engine = new GameEngine({ classifier: heuristicClassifier, playset, store, gateway: new OfflineGateway(), rng: mulberry32(7) });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

const narrations = (events: GameEvent[]): string[] =>
  events.filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration").map((e) => e.text);

const diceRolls = (events: GameEvent[]) =>
  events.filter((e): e is Extract<GameEvent, { kind: "diceRolled" }> => e.kind === "diceRolled");

describe("prebaked check effect branches", () => {
  test("a passing check fires onSuccess, enqueues its nested effects, and emits a settled diceRolled", async () => {
    const playset = await thistledown();
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.test-search-pass",
        when: "onTick",
        trigger: { allOf: [{ kind: "clockAtLeast", minutes: 0 }] },
        effects: [
          {
            kind: "check",
            ability: "int",
            dc: -50, // unreachable-low ⇒ always succeeds regardless of the PC's INT
            onSuccess: [
              { kind: "narrate", text: "SEARCH-SUCCESS: a loose floorboard lifts free." },
              { kind: "setFlag", key: "found_the_ledger" },
            ],
            onFail: [{ kind: "narrate", text: "SEARCH-FAIL" }],
          },
        ],
        once: "campaign",
      }),
    );
    const { engine, events } = makeEngine(playset, new InMemoryGameStateStore());
    await engine.start();

    await engine.submitPlayerInput("search the room");

    expect(narrations(events).some((t) => t.includes("SEARCH-SUCCESS"))).toBe(true);
    expect(narrations(events).some((t) => t.includes("SEARCH-FAIL"))).toBe(false);
    // Nested onSuccess command reached the reducer.
    expect(engine.getState().flags.found_the_ledger).toBe(true);
    // The roll surfaced as a settled dice event the client can render.
    const roll = diceRolls(events).find((d) => d.purpose === "INT check (DC -50)");
    expect(roll?.success).toBe(true);
    expect(roll?.notation).toBe("1d20");
    expect(roll?.rolls.length).toBe(1);
  });

  test("a failing check fires onFail, never onSuccess", async () => {
    const playset = await thistledown();
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.test-search-fail",
        when: "onTick",
        trigger: { allOf: [{ kind: "clockAtLeast", minutes: 0 }] },
        effects: [
          {
            kind: "check",
            ability: "dex",
            dc: 100, // unreachable-high ⇒ always fails
            onSuccess: [{ kind: "narrate", text: "PICK-SUCCESS" }],
            onFail: [{ kind: "narrate", text: "PICK-FAIL: the lock holds fast." }],
          },
        ],
        once: "campaign",
      }),
    );
    const { engine, events } = makeEngine(playset, new InMemoryGameStateStore());
    await engine.start();

    await engine.submitPlayerInput("pick the lock");

    expect(narrations(events).some((t) => t.includes("PICK-FAIL"))).toBe(true);
    expect(narrations(events).some((t) => t.includes("PICK-SUCCESS"))).toBe(false);
    expect(diceRolls(events).find((d) => d.purpose === "DEX check (DC 100)")?.success).toBe(false);
  });
});
