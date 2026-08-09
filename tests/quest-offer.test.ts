/**
 * Quest opt-in tests — Phase 3 Stage A: the "offered" lifecycle end-to-end.
 *
 * A quest in state "offered" is visibly on the table but never imposed: session start surfaces
 * it in ONE deterministic system line (fresh, resumed, and restarted; omitted when nothing is
 * offered), and the player opts in through the classified questAction — accept → "active",
 * decline → "hidden" (recoverable: a prebaked event/NPC can re-offer later). All mechanics run
 * through the reducer; the offline gateway + heuristic classifier keep every assertion
 * deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { QuestSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { byKind, loadExample, loadThistledown, makeEngine } from "./support/harness.ts";

const QUEST_ID = "quest.missing-caravan";
const QUEST_NAME = "The Missing Caravan";

/** The example playset with its one quest moved to the OFFERED state. */
async function offeredPlayset(): Promise<PlaySet> {
  const playset = structuredClone(await loadExample());
  const quest = playset.campaign.quests.find((q) => q.id === QUEST_ID)!;
  quest.state = "offered";
  return playset;
}

// The in-fiction offer beat: an ephemeral `questOffered` event the client renders as an inline
// Accept/Dismiss card (it replaced the old floating banner + the "on offer" system line).
const offerNotices = (events: GameEvent[]) => byKind(events, "questOffered");

describe("the 'offered' state is additive vocabulary", () => {
  test("QuestSchema parses it; the old states still parse", () => {
    for (const state of ["hidden", "offered", "active", "complete", "failed"] as const) {
      expect(QuestSchema.parse({ id: "q.x", name: "X", state }).state).toBe(state);
    }
  });

  test("bundled worlds (which never contain it) still load", async () => {
    await expect(loadExample()).resolves.toBeDefined();
    await expect(loadThistledown()).resolves.toBeDefined();
  });
});

describe("offered quests are surfaced at session start", () => {
  test("ONE offer beat surfaces the offer, by name and id, for the inline card", async () => {
    const { events } = await makeEngine({ playset: await offeredPlayset() });
    const notices = offerNotices(events);
    expect(notices.length).toBe(1);
    expect(notices[0]!.name).toBe(QUEST_NAME);
    expect(notices[0]!.questId).toBe(QUEST_ID);
  });

  test("omitted entirely when no quest is offered", async () => {
    const { events } = await makeEngine(); // example: the quest starts "active"
    expect(offerNotices(events).length).toBe(0);
  });

  test("a RESUMED session with the quest still on offer repeats the line; an accepted one stays quiet", async () => {
    const playset = await offeredPlayset();
    const first = await makeEngine({ playset });
    expect(offerNotices(first.events).length).toBe(1);

    // Resume without having answered: the offer is still open, so the line comes back.
    const resumed = await makeEngine({ playset, store: first.store });
    expect(offerNotices(resumed.events).length).toBe(1);

    // Accept, then resume again: nothing is on offer any more — the line is omitted.
    await resumed.engine.submitPlayerInput("I accept the task");
    const after = await makeEngine({ playset, store: resumed.store });
    expect(after.engine.getState().quests[QUEST_ID]).toBe("active");
    expect(offerNotices(after.events).length).toBe(0);
  });
});

describe("accept / decline resolve as pure state mechanics", () => {
  test("accepting moves offered → active and emits a stateChanged the narrator can restate", async () => {
    const { engine, events } = await makeEngine({ playset: await offeredPlayset() });
    await engine.submitPlayerInput("I accept the task");
    expect(engine.getState().quests[QUEST_ID]).toBe("active");
    const changed = byKind(events, "stateChanged").filter((e) => e.summary.includes("accepted"));
    expect(changed.length).toBe(1);
    expect(changed[0]!.summary).toContain(QUEST_NAME);
    expect(changed[0]!.changes).toEqual({ questId: QUEST_ID, questState: "active" });
  });

  test("accepting by quest NAME grounds the same way", async () => {
    const { engine } = await makeEngine({ playset: await offeredPlayset() });
    await engine.submitPlayerInput(`I accept ${QUEST_NAME}`);
    expect(engine.getState().quests[QUEST_ID]).toBe("active");
  });

  test("declining moves offered → hidden (recoverable, not failed)", async () => {
    const { engine, events } = await makeEngine({ playset: await offeredPlayset() });
    await engine.submitPlayerInput("I turn down the job");
    expect(engine.getState().quests[QUEST_ID]).toBe("hidden");
    const changed = byKind(events, "stateChanged").filter((e) => e.summary.includes("declined"));
    expect(changed.length).toBe(1);
    expect(changed[0]!.changes).toEqual({ questId: QUEST_ID, questState: "hidden" });
  });

  test("a second accept finds nothing on offer — no double transition, no crash", async () => {
    const { engine, events } = await makeEngine({ playset: await offeredPlayset() });
    await engine.submitPlayerInput("I accept the task");
    await engine.submitPlayerInput("I accept the task");
    expect(engine.getState().quests[QUEST_ID]).toBe("active");
    expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("accepted")).length).toBe(1);
  });

  test("with nothing offered, quest-flavored input never mutates quest state", async () => {
    const { engine } = await makeEngine(); // quest starts "active"
    await engine.submitPlayerInput("I accept the task");
    expect(engine.getState().quests[QUEST_ID]).toBe("active"); // untouched
  });
});
