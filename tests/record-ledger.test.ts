/**
 * `# THE RECORD` — the world's own ledger, and the rule that a recorded fact is never rolled for.
 *
 * A 2026-07-24 live playtest's P1: the brief carried lore, memory, relationships,
 * history, whereabouts and case files — and NO quest state. A companion who had walked the whole arc
 * therefore had no record that the contract existed, so when the player said "we signed the bond;
 * the ring is in my pouch" the engine rolled CHA (Persuasion) DC 15 to decide whether to believe
 * them, and the failed roll made the companion's invented counter-canon ("the bond was paid this
 * morning") the stickier truth. Three surfaces are locked here: the brief block, the classifier's
 * view of the record, and the Judge's authoritative-ledger dimension.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { buildNarrationContext, recordBriefLines } from "../src/agents/context.ts";
import { buildClassifyUserMessage, CLASSIFIER_SYSTEM_PROMPT } from "../src/engine/classify.ts";
import { modelExits, modelPresence } from "../src/world/queries.ts";
import { fromGameState } from "../src/world/model.ts";
import type { ClassifierContext } from "../src/engine/turn-plan.ts";
import type { GameState } from "../src/state/types.ts";
import type { PlaySet } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";

async function emberford(): Promise<{ playset: PlaySet; state: GameState }> {
  const playset = await loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/example", import.meta.url)));
  const engine = new GameEngine({ classifier: heuristicClassifier, playset, store: new InMemoryGameStateStore(), gateway: new OfflineGateway() });
  await engine.start();
  return { playset, state: engine.getState() };
}

describe("recordBriefLines", () => {
  test("renders every taken/settled quest with the no-dispute rail, and nothing else", async () => {
    const { playset, state } = await emberford();
    const lines = recordBriefLines(playset.campaign, state);

    expect(lines[0]).toBe("# THE RECORD");
    const body = lines.join("\n");
    // The rail is what stops the model treating a recorded fact as arguable.
    expect(body).toContain("ESTABLISHED FACT");
    expect(body).toContain("never dispute it");
    expect(body).toContain("never require proof");
    expect(body).toContain("- [TAKEN] The Missing Caravan");
  });

  test("labels the settled states, and surfaces completed objectives", async () => {
    const { playset, state } = await emberford();

    const complete = { ...state, quests: { ...state.quests, "quest.missing-caravan": "complete" as const } };
    expect(recordBriefLines(playset.campaign, complete).join("\n")).toContain("- [FINISHED] The Missing Caravan");

    const failed = { ...state, quests: { ...state.quests, "quest.missing-caravan": "failed" as const } };
    expect(recordBriefLines(playset.campaign, failed).join("\n")).toContain("- [FAILED] The Missing Caravan");

    const withObjective = {
      ...state,
      modules: { ...state.modules, objectives: { "quest.missing-caravan": { "obj.find-trail": true } } },
    };
    expect(recordBriefLines(playset.campaign, withObjective).join("\n")).toContain("· done — Find the caravan's trail out of town");
  });

  test("omit-when-empty: a player who has taken nothing adds ZERO lines to the brief", async () => {
    const { playset, state } = await emberford();
    const untaken = { ...state, quests: { "quest.missing-caravan": "hidden" as const } };
    expect(recordBriefLines(playset.campaign, untaken)).toEqual([]);

    const ctx = (s: GameState) =>
      buildNarrationContext({
        world: playset.world,
        campaign: playset.campaign,
        state: s,
        recentEvents: [],
        trigger: "You look about.",
        present: modelPresence(fromGameState(s, playset.world, playset.campaign), playset.world),
        exits: modelExits(fromGameState(s, playset.world, playset.campaign), (id) => id),
      });
    expect(ctx(untaken).contextText).not.toContain("# THE RECORD");
    expect(ctx(untaken).ledger ?? []).toEqual([]);
  });

  test("the ledger reaches the brief AND rides the context for the Continuity Judge", async () => {
    const { playset, state } = await emberford();
    const model = fromGameState(state, playset.world, playset.campaign);
    const nctx = buildNarrationContext({
      world: playset.world,
      campaign: playset.campaign,
      state,
      recentEvents: [],
      trigger: "You look about.",
      present: modelPresence(model, playset.world),
      exits: modelExits(model, (id) => id),
    });

    expect(nctx.contextText).toContain("# THE RECORD");
    // The Judge gets the FACT ROWS only — the header and prompt rail are scaffolding it does not need.
    expect(nctx.ledger).toBeTruthy();
    expect(nctx.ledger!.every((l) => l.startsWith("- ") || l.startsWith("  · "))).toBe(true);
    expect(nctx.ledger!.some((l) => l.includes("The Missing Caravan"))).toBe(true);

    // The block sits in the grounding region, BEFORE the `# NOW` cut point, so it is not over-screened.
    expect(nctx.contextText.indexOf("# THE RECORD")).toBeLessThan(nctx.contextText.indexOf("# NOW"));
  });
});

describe("classifier: a statement of record is not a check", () => {
  const CTX: ClassifierContext = {
    playerActorId: "pc.you",
    locationId: "loc.hall",
    locationName: "Guild Hall",
    exits: [],
    presentEntities: [{ id: "npc.veil", name: "Sergeant Veil" }],
    companionIds: [],
  };

  test("ESTABLISHED_FACTS renders when the player has taken something, and is omitted otherwise", () => {
    const withFacts = buildClassifyUserMessage("we signed the bond", {
      ...CTX,
      establishedFacts: [{ id: "quest.caravan-salvage", name: 'you took on "The Overdue Caravan"' }],
    });
    expect(withFacts).toContain('ESTABLISHED_FACTS: quest.caravan-salvage=you took on "The Overdue Caravan"');

    // Byte-stability for a fresh campaign: no facts ⇒ no line at all.
    expect(buildClassifyUserMessage("we signed the bond", CTX)).not.toContain("ESTABLISHED_FACTS");
    expect(buildClassifyUserMessage("we signed the bond", { ...CTX, establishedFacts: [] })).not.toContain("ESTABLISHED_FACTS");
  });

  test("the prompt forbids rolling to establish something the ledger already records", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("NEVER roll to establish something the world ALREADY RECORDS");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("STATEMENTS OF RECORD");
    // ...while leaving the real cha check intact — the player wanting something NEW still rolls.
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("DO or CONCEDE\n  something new");
  });
});

describe("recordBriefLines — journeys + deadlines (2026-07-25)", () => {
  test("[TRAVELED] rows render the last legs with names, phase, and day — plus the travel rail", async () => {
    const { playset, state } = await emberford();
    const legs = [
      { fromId: "loc.town-square", toId: "loc.tavern", atClock: 480 },
      { fromId: "loc.tavern", toId: "loc.town-square", atClock: 1100 },
    ];
    const withJourneys = { ...state, modules: { ...state.modules, journey: { log: legs } } };
    const body = recordBriefLines(playset.campaign, withJourneys, playset.world).join("\n");
    expect(body).toContain("- [TRAVELED]");
    expect(body).toContain("(set out morning, day 1)");
    expect(body).toContain("(set out dusk, day 1)");
    expect(body).toContain("[TRAVELED] rows are real journeys the party made");
  });

  test("without the world param (or without a journey slice) the output is byte-identical to before", async () => {
    const { playset, state } = await emberford();
    const legacy = recordBriefLines(playset.campaign, state);
    // Same state, world passed, no journey slice: identical.
    expect(recordBriefLines(playset.campaign, state, playset.world)).toEqual(legacy);
    // Journey slice present but world omitted: rows are not rendered (no name source).
    const withJourneys = {
      ...state,
      modules: { ...state.modules, journey: { log: [{ fromId: "a", toId: "b", atClock: 0 }] } },
    };
    expect(recordBriefLines(playset.campaign, withJourneys)).toEqual(legacy);
  });

  test("an armed deadline renders `— due by` on the ACTIVE quest row only", async () => {
    const { playset, state } = await emberford();
    const armed = {
      ...state,
      modules: { ...state.modules, questDeadlines: { "quest.missing-caravan": 480 + 2880 } },
    };
    const body = recordBriefLines(playset.campaign, armed).join("\n");
    expect(body).toContain("— due by morning, day 3");
    // A settled quest never renders a due date, even with a stale armed entry.
    const failed = { ...armed, quests: { ...armed.quests, "quest.missing-caravan": "failed" as const } };
    expect(recordBriefLines(playset.campaign, failed).join("\n")).not.toContain("due by");
  });
});
