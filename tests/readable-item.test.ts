/**
 * Readable items — the LETTER quest-delivery channel.
 *
 * A carried item with `properties.body` is readable; the `read` verb narrates that body, and an
 * optional `properties.offersQuest` makes the READ itself the in-fiction delivery beat — it flips a
 * hidden quest to "offered", which surfaces the inline `questOffered` card (the same beat a board
 * posting or an NPC's words produce). The offer flip is committed through the reducer at tick end,
 * so it is deterministic here regardless of the narrator. The `read` verb is LLM-classified in the
 * product; these tests drive it with a scripted classifier stub (the test-classifier DSL is frozen).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { byKind, loadExample, makeEngine } from "./support/harness.ts";
import type { PlaySet } from "../src/content/schema.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";

const LETTER = "item.sealed-note";
const QUEST = "quest.bridge-at-dusk";

/** A minimal, always-classifies-freeform base plan the scripted stubs specialize. */
function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}

/** Always classify the player's line as reading the given carried item — no DSL, no LLM. */
function readsClassifier(itemId: string): TurnClassifier {
  return {
    classify: () => Promise.resolve(planOf({ kind: "itemAction", item: { verb: "read", itemId, targetId: null } })),
  };
}

/** Return the scripted plans in order (clamping to the last) — for multi-turn read→accept flows. */
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
}

/**
 * The bundled example playset with a readable letter dropped into the PC's pack. `offersQuest`
 * toggles whether the letter names a quest; `questState` seeds that quest's starting state.
 */
async function letterPlayset(opts: { offersQuest?: boolean; questState?: "hidden" | "active" } = {}): Promise<PlaySet> {
  const p = structuredClone(await loadExample());
  const properties: Record<string, unknown> = { body: "Meet me at the old bridge at dusk. Come alone. — V" };
  if (opts.offersQuest !== false) properties.offersQuest = QUEST;
  p.world.items.push({ id: LETTER, name: "Sealed Note", description: "A folded note, sealed with grey wax.", kind: "quest", properties });
  p.campaign.quests.push({
    id: QUEST,
    name: "The Bridge at Dusk",
    description: "A sealed note names the old bridge at dusk, and a single initial: V.",
    objectives: [],
    state: opts.questState ?? "hidden",
  });
  p.campaign.characters[0]!.inventory.push(LETTER);
  return p;
}

const offersFor = (events: Parameters<typeof byKind>[0], questId: string) =>
  byKind(events, "questOffered").filter((e) => e.questId === questId);

describe("reading a letter delivers a quest offer", () => {
  test("a letter that names a hidden quest offers it on read — the inline card beat fires once", async () => {
    const { engine, events } = await makeEngine({ playset: await letterPlayset(), classifier: readsClassifier(LETTER) });
    expect(engine.getState().quests[QUEST]).toBe("hidden");

    await engine.submitPlayerInput("I break the seal and read the note.");

    expect(engine.getState().quests[QUEST]).toBe("offered");
    const offers = offersFor(events, QUEST);
    expect(offers.length).toBe(1);
    expect(offers[0]!.name).toBe("The Bridge at Dusk");
  });

  test("the offered quest is then acceptable through the normal questAction path", async () => {
    const { engine } = await makeEngine({
      playset: await letterPlayset(),
      classifier: scriptedClassifier([
        planOf({ kind: "itemAction", item: { verb: "read", itemId: LETTER, targetId: null } }),
        planOf({ kind: "questAction", quest: { verb: "accept", questId: QUEST } }),
      ]),
    });
    await engine.submitPlayerInput("I read the note.");
    expect(engine.getState().quests[QUEST]).toBe("offered");
    await engine.submitPlayerInput("I accept the task");
    expect(engine.getState().quests[QUEST]).toBe("active");
  });

  test("re-reading the same letter does not re-offer once the quest has left hidden", async () => {
    const { engine, events } = await makeEngine({ playset: await letterPlayset(), classifier: readsClassifier(LETTER) });
    await engine.submitPlayerInput("I read the note.");
    await engine.submitPlayerInput("I read the note again.");
    expect(engine.getState().quests[QUEST]).toBe("offered");
    expect(offersFor(events, QUEST).length).toBe(1); // the second read is inert — no fresh card
  });
});

describe("reading is safe and inert when there is nothing to offer", () => {
  test("a readable note with no offersQuest narrates but changes no quest state", async () => {
    const { engine, events } = await makeEngine({
      playset: await letterPlayset({ offersQuest: false }),
      classifier: readsClassifier(LETTER),
    });
    await engine.submitPlayerInput("I read the note.");
    // The seeded quest exists but the letter names no quest — nothing flips, nothing is offered.
    expect(engine.getState().quests[QUEST]).toBe("hidden");
    expect(byKind(events, "questOffered").length).toBe(0);
  });

  test("reading a letter whose quest is already active does not knock it back to offered", async () => {
    const { engine, events } = await makeEngine({
      playset: await letterPlayset({ questState: "active" }),
      classifier: readsClassifier(LETTER),
    });
    await engine.submitPlayerInput("I read the note.");
    expect(engine.getState().quests[QUEST]).toBe("active"); // untouched — the hidden-only guard holds
    expect(offersFor(events, QUEST).length).toBe(0);
  });
});
