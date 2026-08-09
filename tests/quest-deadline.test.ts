/**
 * Quest deadlines (2026-07-25 fix wave) — clocks with teeth. Accepting a quest that authors
 * `deadlineMinutes` arms an absolute due clock (`modules.questDeadlines`, engine post-command
 * hook — every accept channel funnels through `apply`); once the campaign clock passes it, the
 * quest-deadlines tick module fails the quest through the reducer on the next player turn.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
const NO_CHECK = { warranted: false, ability: null, skill: null, dc: null, reason: "" };
const QUEST = "quest.bond";

function mkPlayset(deadlineMinutes: number): PlaySet {
  const world = WorldSchema.parse({
    id: "w.due",
    name: "Dueworld",
    summary: "A world on the clock.",
    locations: [
      {
        id: "loc.a",
        name: "The Yard",
        description: "A yard.",
        exits: [{ to: "loc.b", name: "the long road", locked: false, hidden: false, minutes: 120 }],
      },
      {
        id: "loc.b",
        name: "The Mill",
        description: "A mill.",
        exits: [{ to: "loc.a", name: "back down the road", locked: false, hidden: false, minutes: 120 }],
      },
    ],
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.due",
    name: "Due Campaign",
    worldId: "w.due",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    quests: [
      {
        id: QUEST,
        name: "The Turning Bond",
        description: "A bond that turns at a real hour.",
        state: "offered",
        deadlineMinutes,
        deadlineFailText: "The bond has turned — a faster crew holds the claim now.",
      },
    ],
    startingState: { locationId: "loc.a", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

const moveTo = (destinationLocationId: string): TurnPlan =>
  ({
    kind: "movement",
    targetId: null,
    destinationLocationId,
    destinationName: null,
    movementMiss: false,
    check: NO_CHECK,
    confidence: 1,
  }) as TurnPlan;

function scripted(plans: TurnPlan[]): TurnClassifier {
  return {
    classify: async () =>
      plans.shift() ??
      ({ kind: "freeformNarrative", targetId: null, destinationLocationId: null, check: NO_CHECK, confidence: 1 } as TurnPlan),
  };
}

async function build(deadlineMinutes: number, plans?: TurnPlan[]) {
  const playset = mkPlayset(deadlineMinutes);
  const engine = new GameEngine({
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    classifier: scripted(plans ?? [moveTo("loc.b"), moveTo("loc.a")]),
    rng: mulberry32(11),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events };
}

describe("quest deadlines", () => {
  test("accepting arms dueAtClock; the TURN whose own cost crosses it fails the quest (not one later)", async () => {
    const { engine, events } = await build(200);
    const clockAtAccept = engine.getState().clock;

    await engine.submitAction({ kind: "acceptQuest", questId: QUEST });
    expect(engine.getState().quests[QUEST]).toBe("active");
    const armed = (engine.getState().modules?.questDeadlines ?? {}) as Record<string, number>;
    expect(armed[QUEST]).toBe(clockAtAccept + 200);

    await engine.submitPlayerInput("take the road to the mill"); // +120 — not yet due
    expect(engine.getState().quests[QUEST]).toBe("active");
    events.length = 0;
    // This turn's OWN 120-minute cost crosses the deadline: the watcher reads the prospective
    // end-of-turn clock, so the window closes on THIS turn — the failure beat stays attached to
    // the march that caused it (review finding: react runs before the commit-phase advance).
    await engine.submitPlayerInput("head back down the road"); // 120 + 120 = 240 > 200

    expect(engine.getState().quests[QUEST]).toBe("failed");
    expect(
      events.some((e) => e.kind === "questStateChanged" && e.questId === QUEST && e.state === "failed"),
    ).toBe(true);
  });

  test("investigation alone now consumes the window: dialogue-only turns cross a deadline (r4 clock repricing)", async () => {
    const { engine, events } = await build(25, []); // no scripted moves — pure conversation
    await engine.submitAction({ kind: "acceptQuest", questId: QUEST });
    expect(engine.getState().quests[QUEST]).toBe("active");
    // Every input classifies freeformNarrative, the 10-minute beat.
    await engine.submitPlayerInput("I read the posting again."); // +10
    await engine.submitPlayerInput("I ask around the yard."); // +20
    expect(engine.getState().quests[QUEST]).toBe("active");
    events.length = 0;
    await engine.submitPlayerInput("I keep asking."); // +30 > 25 — crosses on THIS turn
    expect(engine.getState().quests[QUEST]).toBe("failed");
    expect(
      events.some((e) => e.kind === "questStateChanged" && e.questId === QUEST && e.state === "failed"),
    ).toBe(true);
  });

  test("the closing window warns ONCE on the ledger channel, and the failure lands as a system line (r6 P3)", async () => {
    const { engine, events } = await build(240, [moveTo("loc.b"), moveTo("loc.a"), moveTo("loc.b")]);
    await engine.submitAction({ kind: "acceptQuest", questId: QUEST });
    events.length = 0;

    await engine.submitPlayerInput("take the road to the mill"); // +120 — inside the warn window (240/4=60? no: 120 ≤ min(720, 60)+... see below)
    const warnings = () =>
      events.filter((e) => e.kind === "stateChanged" && e.summary.includes("the window is closing"));
    // warnWindow = min(720, 240/4=60) = 60 — at 120 the quest is NOT yet inside it.
    expect(warnings()).toHaveLength(0);

    await engine.submitPlayerInput("head back down the road"); // 240 total — crosses due: failure, not warning
    expect(engine.getState().quests[QUEST]).toBe("failed");
    // The failure is LEDGER news (r6 P3: it used to be a rumour-styled prose line, easy to miss).
    expect(events.some((e) => e.kind === "stateChanged" && e.summary.includes("Quest failed: The Turning Bond."))).toBe(
      true,
    );
  });

  test("the approach warning fires before the deadline, exactly once", async () => {
    const { engine, events } = await build(130, []);
    await engine.submitAction({ kind: "acceptQuest", questId: QUEST });
    events.length = 0;

    // freeform turns are 10 minutes each; warnWindow = min(720, 130/4=32) = 32 → warns once ≥98 min pass.
    for (let i = 0; i < 10; i++) await engine.submitPlayerInput("I ask around the yard."); // 100 min
    const warnings = () =>
      events.filter((e) => e.kind === "stateChanged" && e.summary.includes("the window is closing")) as {
        summary: string;
      }[];
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.summary).toContain("The Turning Bond");
    expect(engine.getState().quests[QUEST]).toBe("active");

    await engine.submitPlayerInput("I keep asking."); // 110
    await engine.submitPlayerInput("I keep asking."); // 120
    expect(warnings()).toHaveLength(1); // never nags twice
    await engine.submitPlayerInput("I keep asking."); // 130+ — due
    expect(engine.getState().quests[QUEST]).toBe("failed");
    expect(warnings()).toHaveLength(1);
  });

  test("a generous deadline never fires on an honest pace", async () => {
    const { engine } = await build(10_000);
    await engine.submitAction({ kind: "acceptQuest", questId: QUEST });
    await engine.submitPlayerInput("take the road to the mill");
    await engine.submitPlayerInput("head back down the road");
    await engine.submitPlayerInput("I catch my breath.");
    expect(engine.getState().quests[QUEST]).toBe("active");
  });
});
