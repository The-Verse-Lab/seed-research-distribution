/**
 * Quest-reward tests — coin/item payouts on quest completion + the generic adjustCoins effect.
 *
 * `Quest.rewardCoins`/`rewardItems` are paid by the engine's `grantQuestReward` post-command hook
 * (sibling to `surfaceQuestOffers`) the moment a quest transitions INTO "complete" — once, through
 * the reducer's `adjustCoins` / `transferItem` (one writer, replay-safe). The generic `adjustCoins`
 * Effect pays any target (defaulting to the player) from a prebaked event. Completion is driven the
 * way the game drives it: an authored onEnterLocation beat sets the quest complete when the party
 * arrives. Offline + heuristic classifier — deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { PrebakedEventSchema, QuestSchema, type PlaySet } from "../src/content/schema.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import type { GameEvent } from "../src/events/types.ts";
import { byKind } from "./support/harness.ts";

function thistledown(): Promise<PlaySet> {
  return loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url)));
}

function makeEngine(playset: PlaySet): { engine: GameEngine; events: GameEvent[] } {
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

/** An onEnterLocation beat at the green that completes the given quest, once per campaign. */
function completeOnGreen(questId: string) {
  return PrebakedEventSchema.parse({
    id: `event.${questId}-done`,
    when: "onEnterLocation",
    trigger: { allOf: [{ kind: "atLocation", locationId: "loc.green" }] },
    effects: [{ kind: "setQuestState", questId, state: "complete" }],
    once: "campaign",
  });
}

describe("quest rewards", () => {
  test("completing a quest with rewardCoins pays the player once and hands over the reward items", async () => {
    const playset = structuredClone(await thistledown());
    playset.campaign.quests.push(
      QuestSchema.parse({ id: "quest.bounty", name: "A Paid Bounty", state: "active", rewardCoins: 500, rewardItems: ["item.torch"] }),
    );
    playset.campaign.events.push(completeOnGreen("quest.bounty"));
    const { engine, events } = makeEngine(playset);
    await engine.start();
    const before = engine.getState().actors["pc.you"]?.coins ?? 0;

    await engine.submitPlayerInput("go to the green"); // the arrival beat completes the quest

    expect(engine.getState().quests["quest.bounty"]).toBe("complete");
    const paid = byKind(events, "coinsChanged").filter((e) => e.entityId === "pc.you" && e.coins === before + 500);
    expect(paid).toHaveLength(1); // exactly once — the reducer no-ops a same-state set, "complete" is terminal
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.torch");
    expect(byKind(events, "stateChanged").some((e) => e.summary.includes("Reward") && e.summary.includes("5 gp"))).toBe(true);
  });

  test("the reward is not re-paid on a later, unrelated turn", async () => {
    const playset = structuredClone(await thistledown());
    playset.campaign.quests.push(QuestSchema.parse({ id: "quest.bounty", name: "A Paid Bounty", state: "active", rewardCoins: 500 }));
    playset.campaign.events.push(completeOnGreen("quest.bounty"));
    const { engine, events } = makeEngine(playset);
    await engine.start();

    await engine.submitPlayerInput("go to the green"); // completes + pays
    const afterComplete = engine.getState().actors["pc.you"]?.coins ?? 0;
    events.length = 0;

    await engine.submitPlayerInput("look around the green"); // an innocuous turn

    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(afterComplete);
  });

  test("a quest WITHOUT a reward completes narrative-only — not a coin changes hands", async () => {
    const playset = structuredClone(await thistledown());
    playset.campaign.quests.push(QuestSchema.parse({ id: "quest.plain", name: "Unpaid Errand", state: "active" }));
    playset.campaign.events.push(completeOnGreen("quest.plain"));
    const { engine, events } = makeEngine(playset);
    await engine.start();

    await engine.submitPlayerInput("go to the green");

    expect(engine.getState().quests["quest.plain"]).toBe("complete");
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
  });
});

describe("adjustCoins effect", () => {
  test("an adjustCoins effect pays the player by default (no `to`)", async () => {
    const playset = structuredClone(await thistledown());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "event.dropped-purse",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.green" }] },
        effects: [
          { kind: "narrate", text: "A dropped purse glints in the reeds." },
          { kind: "adjustCoins", by: 250 },
        ],
        once: "campaign",
      }),
    );
    const { engine, events } = makeEngine(playset);
    await engine.start();
    const before = engine.getState().actors["pc.you"]?.coins ?? 0;

    await engine.submitPlayerInput("go to the green");

    expect(byKind(events, "coinsChanged").some((e) => e.entityId === "pc.you" && e.coins === before + 250)).toBe(true);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(before + 250);
  });
});
