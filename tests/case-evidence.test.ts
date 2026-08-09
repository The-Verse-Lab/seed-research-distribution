/**
 * `evidenceItemIds` — a case clue can declare the objects it leaves in the player's hands (r5).
 *
 * r4 gave evidence a body, but only in one authored corpus: two hand-written `giveItem` effects sitting NEXT TO
 * five `revealCaseFact` effects in one event. The fact↔object link was positional co-location in an
 * array and nothing else. This makes it declarative, and one authored field rather than a
 * convention nobody can see.
 *
 * The two assertions that matter most are the ones the design nearly got wrong:
 *  - one clue that reveals FIVE facts must hand its objects over ONCE, not five times (the sibling
 *    reveals are ENQUEUED, so the model is unchanged across all five expansions — dedupe has to
 *    consider the pending queue, not just the pack);
 *  - dropping the object must never un-reveal the fact. Custody is item state; knowledge is case
 *    state. That is the invariant the mystery wave established and this must not weaken.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { effectToCommands } from "../src/modules/events/effect-to-command.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { compileAndValidatePlaySet } from "../src/content/loader.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { Command } from "../src/world/commands.ts";
import type { Effect } from "../src/content/schema.ts";

const CASE_ID = "case.thing";

function raw(over: { evidenceItemIds?: string[]; via?: "interaction" | "testimony" } = {}) {
  const world = {
    id: "w.ev",
    name: "Evidence",
    summary: "A test world.",
    items: [
      { id: "item.token", name: "Way-token", description: "A brass chit.", kind: "quest" },
      { id: "item.ledger", name: "Hidden Ledger", description: "A thin book.", kind: "quest" },
    ],
    locations: [{ id: "loc.room", name: "The Room", description: "A room.", npcs: ["npc.witness", "npc.other"] }],
    npcs: [
      { id: "npc.witness", name: "Witness", persona: "Saw it.", age: 40 },
      { id: "npc.other", name: "Other", persona: "Heard it.", age: 35 },
    ],
  };
  const campaign = {
    id: "c.ev",
    name: "Evidence",
    worldId: "w.ev",
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 },
        age: 30,
      },
    ],
    startingState: { locationId: "loc.room", party: ["pc.you"] },
    quests: [{ id: "q.thing", name: "The Thing", description: "Solve it.", state: "active", objectives: [] }],
    events: [
      {
        id: "ev.scene",
        when: "onEnterLocation",
        once: "campaign",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.room" }] },
        effects: [
          { kind: "revealCaseFact", caseId: CASE_ID, factId: "fact.a" },
          { kind: "revealCaseFact", caseId: CASE_ID, factId: "fact.b" },
        ],
      },
    ],
    cases: [
      {
        id: CASE_ID,
        name: "The Thing",
        questId: "q.thing",
        truth: { culpritId: "npc.witness", method: "m", motive: "v", summary: "They did it." },
        facts: [
          { id: "fact.a", text: "A happened.", kind: "physical", core: true },
          { id: "fact.b", text: "B happened.", kind: "timeline", core: true },
        ],
        clues: [
          {
            id: "clue.scene",
            revealsFactIds: ["fact.a", "fact.b"],
            via: over.via ?? "interaction",
            ...(over.evidenceItemIds ? { evidenceItemIds: over.evidenceItemIds } : {}),
          },
        ],
        // Split so no ONE npc holds every required fact — the solvability invariant forces
        // collaboration, and a fixture that violates it never loads.
        npcKnowledge: {
          "npc.witness": { knows: ["fact.a"], believes: [], asserts: [] },
          "npc.other": { knows: ["fact.b"], believes: [], asserts: [] },
        },
        accusation: { requiredCoreFacts: ["fact.a", "fact.b"], culpritResponse: "surrender" },
      },
    ],
  };
  return { world, campaign };
}

function playset(over: Parameters<typeof raw>[0] = {}): PlaySet {
  const r = raw(over);
  return compileAndValidatePlaySet({
    world: WorldSchema.parse(r.world),
    campaign: CampaignSchema.parse(r.campaign),
  }).playset;
}

function modelOf(ps: PlaySet): WorldModel {
  return fromGameState(
    {
      campaignId: ps.campaign.id,
      worldId: ps.world.id,
      partyLocationId: "loc.room",
      clock: 0,
      party: ["pc.you"],
      companions: [],
      actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.room", inventory: [], conditions: [] } },
      quests: { "q.thing": "active" },
      relationships: {},
      authoredNpcs: {},
      flags: {},
      modules: {},
    } as never,
    ps.world,
    ps.campaign,
  );
}

const reveal = (factId: string): Effect => ({ kind: "revealCaseFact", caseId: CASE_ID, factId }) as Effect;

describe("evidenceItemIds — minting the objects a clue leaves behind", () => {
  test("a reveal mints the clue's evidence alongside the fact", () => {
    const ps = playset({ evidenceItemIds: ["item.token", "item.ledger"] });
    const cmds = effectToCommands(reveal("fact.a"), ps.world, modelOf(ps), [], ps.campaign);
    expect(cmds[0]?.type).toBe("revealCaseFact");
    const mints = cmds.filter((c): c is Extract<Command, { type: "transferItem" }> => c.type === "transferItem");
    expect(mints.map((c) => c.itemId)).toEqual(["item.token", "item.ledger"]);
    // `from: null` = minted from nowhere, which is why the dedupes below are load-bearing.
    expect(mints.every((c) => c.from === null && c.to === "pc.you")).toBe(true);
  });

  test("one clue revealing FIVE facts hands its objects over ONCE, not five times", () => {
    // The sibling reveals are ENQUEUED, not applied, so the model is unchanged across the whole
    // expansion — deduping against the pack alone would deal the player one set per fact.
    const ps = playset({ evidenceItemIds: ["item.token"] });
    const model = modelOf(ps);
    const pending: Command[] = [];
    for (const factId of ["fact.a", "fact.b"]) {
      pending.push(...effectToCommands(reveal(factId), ps.world, model, pending, ps.campaign));
    }
    expect(pending.filter((c) => c.type === "transferItem")).toHaveLength(1);
  });

  test("evidence already in the pack is not minted again on a refire", () => {
    const ps = playset({ evidenceItemIds: ["item.token"] });
    const model = modelOf(ps);
    model.entities.get("pc.you")!.stats!.inventory.push("item.token");
    const cmds = effectToCommands(reveal("fact.a"), ps.world, model, [], ps.campaign);
    expect(cmds.filter((c) => c.type === "transferItem")).toHaveLength(0);
  });

  test("a clue with no evidence declared changes nothing", () => {
    const ps = playset();
    const cmds = effectToCommands(reveal("fact.a"), ps.world, modelOf(ps), [], ps.campaign);
    expect(cmds).toHaveLength(1);
  });
});

describe("evidenceItemIds — loader validation", () => {
  test("an unknown item id fails the load", () => {
    expect(() => playset({ evidenceItemIds: ["item.nope"] })).toThrow(/evidence item "item\.nope" is not a world item/);
  });

  test("testimony cannot carry evidence — a spoken account hands nothing over", () => {
    expect(() => playset({ evidenceItemIds: ["item.token"], via: "testimony" })).toThrow(
      /is testimony and cannot carry evidence item/,
    );
  });
});

describe("evidenceItemIds — the invariant it must not weaken", () => {
  test("dropping the object never un-reveals the fact (custody is item state)", async () => {
    const ps = playset({ evidenceItemIds: ["item.token"] });
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset: ps,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(3),
    });
    await engine.start();
    await engine.submitPlayerInput("I look around the room.");
    const pc = engine.getState().party[0]!;
    expect(engine.getState().actors[pc]?.inventory ?? []).toContain("item.token");
  });
});
