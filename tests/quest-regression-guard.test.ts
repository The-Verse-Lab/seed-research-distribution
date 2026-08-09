/**
 * Quest-state regression guard — a reproduced hub re-entry failure.
 *
 * A hand-authored re-entry beat (`onEnterLocation` + `once: "visit"`) set an accepted quest back to
 * `offered` every time the party walked back into the hub. `once: "visit"` is cleared on EVERY
 * location change, so the beat re-armed on each return; the reducer accepted the backwards write and
 * persisted the delta; and everything derived from quest state — the quest projection, the leader's goal
 * hint, every NPC brief — followed the quest back to day one. The player's whole central arc was
 * denied at the moment of payoff.
 *
 * Three layers are locked here: the reducer refuses to un-take a taken quest (while still allowing
 * the real backward edges), a guarded revisit beat cannot re-fire, and the content diagnostic names
 * the authoring mistake at load time.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { fromGameState } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { compileAuthoringLayer } from "../src/content/quest-flow.ts";
import type { Campaign, PlaySet, PrebakedEvent } from "../src/content/schema.ts";

function thistledown(): Promise<PlaySet> {
  return loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url)));
}

describe("reducer: setQuestState transitions", () => {
  test("refuses to un-take a taken quest, and keeps every legitimate backward edge", async () => {
    const playset = await thistledown();
    const engine = new GameEngine({ classifier: heuristicClassifier, playset, store: new InMemoryGameStateStore(), gateway: new OfflineGateway() });
    await engine.start();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);

    // REFUSED — the P0 edges. A quest the player has taken or settled can never go back on the table.
    for (const [from, to] of [
      ["active", "offered"],
      ["active", "hidden"],
      ["complete", "offered"],
      ["complete", "hidden"],
      ["failed", "offered"],
      ["failed", "hidden"],
    ] as const) {
      model.quests.set("quest.souring-ward", from);
      const res = applyCommand(model, { type: "setQuestState", questId: "quest.souring-ward", state: to });
      expect(res.rejected).toBeTruthy();
      expect(model.quests.get("quest.souring-ward")).toBe(from);
    }

    // `complete` is terminal in both directions — a solved quest cannot be re-opened as active either.
    model.quests.set("quest.souring-ward", "complete");
    expect(applyCommand(model, { type: "setQuestState", questId: "quest.souring-ward", state: "active" }).rejected).toBeTruthy();

    // ALLOWED — the real edges the engine and quest-flow beats depend on. Declining an offer
    // (engine.resolveQuestAction) and failing a taken quest (quest-flow fail beats, case loss) must
    // both still work, or the guard would break more than it fixes.
    for (const [from, to] of [
      ["hidden", "offered"],
      ["offered", "hidden"],
      ["offered", "active"],
      ["active", "complete"],
      ["active", "failed"],
      ["failed", "active"],
    ] as const) {
      model.quests.set("quest.souring-ward", from);
      const res = applyCommand(model, { type: "setQuestState", questId: "quest.souring-ward", state: to });
      expect(res.rejected).toBeFalsy();
      expect(model.quests.get("quest.souring-ward")).toBe(to);
    }
  });
});

describe("prebaked events: a revisit cannot re-offer a taken quest", () => {
  test("a guarded once:visit offer beat fires once, then stays quiet on re-entry", async () => {
    const playset = await thistledown();
    // The minimal hub-beat shape: the questState guard is what stops the
    // beat re-arming once the player has taken the job. Without it, `once: "visit"` re-fires forever.
    playset.campaign.events.push({
      id: "ev.green-board",
      when: "onEnterLocation",
      once: "visit",
      trigger: {
        allOf: [
          { kind: "atLocation", locationId: "loc.green" },
          { kind: "questState", questId: "quest.bett-honey", state: "hidden" },
        ],
      },
      effects: [
        { kind: "narrate", text: "BOARD-BEAT" },
        { kind: "setQuestState", questId: "quest.bett-honey", state: "offered" },
      ],
    } as PrebakedEvent);

    const engine = new GameEngine({ classifier: heuristicClassifier, playset, store: new InMemoryGameStateStore(), gateway: new OfflineGateway() });
    const texts: string[] = [];
    engine.subscribe((e) => {
      if (e.kind === "narration") texts.push(e.text);
    });
    await engine.start();

    await engine.submitPlayerInput("go to the green");
    expect(texts.filter((t) => t.includes("BOARD-BEAT")).length).toBe(1);
    expect(engine.getState().quests["quest.bett-honey"]).toBe("offered");

    // Take the job, then walk out and back — the exact playtest path.
    await engine.submitAction({ kind: "acceptQuest", questId: "quest.bett-honey" });
    expect(engine.getState().quests["quest.bett-honey"]).toBe("active");

    texts.length = 0;
    await engine.submitPlayerInput("go to the hart");
    await engine.submitPlayerInput("go to the green");

    // No verbatim intro replay, and — the thing that ended the playtest — no regression.
    expect(texts.some((t) => t.includes("BOARD-BEAT"))).toBe(false);
    expect(engine.getState().quests["quest.bett-honey"]).toBe("active");
  });
});

describe("content diagnostics: unguarded quest offers", () => {
  const campaignWith = (events: PrebakedEvent[], base: Campaign): Campaign => ({ ...base, events: [...base.events, ...events] });

  test("flags a revisit-repeatable beat that sets a quest offered without a questState guard", async () => {
    const playset = await thistledown();
    const bad: PrebakedEvent = {
      id: "ev.unguarded-board",
      when: "onEnterLocation",
      once: "visit",
      trigger: { allOf: [{ kind: "atLocation", locationId: "loc.green" }] },
      effects: [{ kind: "setQuestState", questId: "quest.bett-honey", state: "offered" }],
    } as PrebakedEvent;

    const { diagnostics } = compileAuthoringLayer(playset.world, campaignWith([bad], playset.campaign));
    const hit = diagnostics.find((d) => d.code === "unguardedQuestOffer");
    expect(hit).toBeTruthy();
    expect(hit?.path).toBe("campaign.events.ev.unguarded-board");
  });

  test("stays silent when the beat is guarded, or when it can only fire once per campaign", async () => {
    const playset = await thistledown();
    const guarded: PrebakedEvent = {
      id: "ev.guarded-board",
      when: "onEnterLocation",
      once: "visit",
      trigger: {
        allOf: [
          { kind: "atLocation", locationId: "loc.green" },
          { kind: "questState", questId: "quest.bett-honey", state: "hidden" },
        ],
      },
      effects: [{ kind: "setQuestState", questId: "quest.bett-honey", state: "offered" }],
    } as PrebakedEvent;
    const onceOnly: PrebakedEvent = {
      id: "ev.once-board",
      when: "onEnterLocation",
      once: "campaign",
      trigger: { allOf: [{ kind: "atLocation", locationId: "loc.green" }] },
      effects: [{ kind: "setQuestState", questId: "quest.kiln-summons", state: "offered" }],
    } as PrebakedEvent;

    const { diagnostics } = compileAuthoringLayer(playset.world, campaignWith([guarded, onceOnly], playset.campaign));
    expect(diagnostics.some((d) => d.code === "unguardedQuestOffer")).toBe(false);
  });

  test("the bundled Wakeward campaign has no unguarded quest offers", async () => {
    const bundled = await loadPlaySetFromDir(fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url)));
    const { diagnostics } = compileAuthoringLayer(bundled.world, bundled.campaign);
    expect(diagnostics.filter((d) => d.code === "unguardedQuestOffer")).toEqual([]);
  });
});
