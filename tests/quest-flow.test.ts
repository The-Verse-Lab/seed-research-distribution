/**
 * Quest-flow authoring tests: high-level quest flows and location interactions compile into the
 * ordinary event/effect spine and stay deterministic at runtime.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { compileAndValidatePlaySet } from "../src/content/loader.ts";
import { compileAuthoringLayer } from "../src/content/quest-flow.ts";
import { CampaignSchema, WorldSchema, type Campaign, type PlaySet, type PrebakedEvent, type World } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { byKind } from "./support/harness.ts";

const stats = {
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  maxHp: 12,
  armorClass: 10,
  level: 1,
  speed: 30,
  proficiencies: [],
  spells: [],
};

function world(overrides: Record<string, unknown> = {}): World {
  return WorldSchema.parse({
    id: "world.authoring-test",
    name: "Authoring Test",
    locations: [
      {
        id: "loc.start",
        name: "Start",
        description: "A test start.",
        exits: [{ to: "loc.crossing", locked: false, hidden: false }],
        npcs: ["npc.giver"],
      },
      {
        id: "loc.crossing",
        name: "Crossing",
        description: "A test crossing.",
        exits: [
          { to: "loc.start", locked: false, hidden: false },
          { to: "loc.finish", locked: false, hidden: false },
        ],
        npcs: [],
      },
      {
        id: "loc.finish",
        name: "Finish",
        description: "A test finish.",
        exits: [{ to: "loc.crossing", locked: false, hidden: false }],
        npcs: ["npc.receiver"],
      },
    ],
    npcs: [
      { id: "npc.giver", name: "Giver", persona: "Hands out parcels.", inventory: ["item.parcel"] },
      { id: "npc.receiver", name: "Receiver", persona: "Receives parcels." },
    ],
    items: [
      { id: "item.parcel", name: "Parcel", kind: "quest" },
      { id: "item.badge", name: "Badge", kind: "misc" },
    ],
    ...overrides,
  });
}

function campaign(overrides: Record<string, unknown> = {}): Campaign {
  return CampaignSchema.parse({
    id: "campaign.authoring-test",
    name: "Authoring Test",
    worldId: "world.authoring-test",
    characters: [
      {
        id: "pc.you",
        name: "You",
        ancestry: "Human",
        class: "Courier",
        level: 1,
        stats,
        inventory: [],
        backstory: "",
      },
    ],
    quests: [
      {
        id: "quest.delivery",
        name: "Delivery",
        state: "hidden",
        objectives: [
          { id: "o1", description: "Reach the crossing", done: false },
          { id: "o2", description: "Return the parcel", done: false },
        ],
      },
    ],
    events: [],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: [] },
    ...overrides,
  });
}

function deliveryFlow(): NonNullable<Campaign["questFlows"]>[number] {
  return {
    id: "delivery",
    questId: "quest.delivery",
    template: "delivery",
    offer: {
      locationId: "loc.start",
      npcId: "npc.giver",
      text: "The giver offers a parcel.",
      conditions: [],
      effects: [],
      once: "visit",
    },
    acceptance: {
      locationId: "loc.start",
      npcId: "npc.giver",
      text: "The parcel changes hands.",
      conditions: [],
      effects: [{ kind: "transferItem", itemId: "item.parcel", from: "npc.giver", to: "pc.you" }],
      once: "campaign",
    },
    stages: [
      {
        id: "crossed",
        locationId: "loc.crossing",
        objectiveId: "o1",
        text: "You pass the crossing.",
        conditions: [{ kind: "hasItem", entityId: "pc.you", itemId: "item.parcel" }],
        effects: [{ kind: "setFlag", key: "crossed_with_parcel", value: true }],
        once: "campaign",
      },
    ],
    handIn: {
      locationId: "loc.finish",
      npcId: "npc.receiver",
      objectiveId: "o2",
      itemId: "item.parcel",
      text: "The receiver accepts the parcel.",
      conditions: [{ kind: "flag", key: "crossed_with_parcel", equals: true }],
      effects: [],
      once: "campaign",
    },
    failStates: [],
  };
}

function byId(campaign: Campaign, id: string): PrebakedEvent {
  const found = campaign.events.find((ev) => ev.id === id);
  if (!found) throw new Error(`Missing event ${id}`);
  return found;
}

function interactionPlayset(): PlaySet {
  const raw = {
    world: world({
      locations: [
        {
          id: "loc.start",
          name: "Start",
          description: "A room with a loose stone.",
          exits: [],
          npcs: [],
          interactions: [
            {
              id: "loose-stone",
              kind: "exitReveal",
              mode: "action",
              label: "Loose stone",
              text: "The stone swings inward and reveals a narrow stair.",
              revealExit: { to: "loc.secret", name: "narrow stair" },
              effects: [{ kind: "setFlag", key: "loose_stone_found", value: true }],
            },
          ],
        },
        {
          id: "loc.secret",
          name: "Secret Room",
          description: "A hidden room.",
          exits: [],
          npcs: [],
        },
      ],
      npcs: [],
    }),
    campaign: campaign({ quests: [] }),
  };
  return compileAndValidatePlaySet(raw).playset;
}

describe("quest-flow compiler", () => {
  test("generates stable delivery event ids, strips stale generated events, and preserves manual events", () => {
    const manual: PrebakedEvent = {
      id: "ev.manual",
      when: "onTick",
      trigger: { allOf: [] },
      effects: [{ kind: "narrate", text: "Manual beat." }],
      once: "campaign",
    };
    const stale: PrebakedEvent = {
      id: "qf.delivery.offer",
      when: "onTick",
      trigger: { allOf: [] },
      effects: [{ kind: "narrate", text: "stale" }],
      once: "campaign",
    };
    const compiled = compileAuthoringLayer(world(), campaign({ events: [manual, stale], questFlows: [deliveryFlow()] }));

    expect(compiled.campaign.events.map((ev) => ev.id)).toEqual([
      "ev.manual",
      "qf.delivery.offer",
      "qf.delivery.acceptance",
      "qf.delivery.stage.crossed",
      "qf.delivery.hand-in",
    ]);
    expect(compiled.campaign.events.filter((ev) => ev.id === "qf.delivery.offer")).toHaveLength(1);
    expect(compiled.diagnostics.map((d) => d.code)).toContain("reservedGeneratedEventId");

    const offer = byId(compiled.campaign, "qf.delivery.offer");
    expect(offer.when).toBe("onEnterLocation");
    expect(offer.trigger.allOf).toContainEqual({ kind: "questState", questId: "quest.delivery", state: "hidden" });
    expect(offer.effects).toContainEqual({ kind: "setQuestState", questId: "quest.delivery", state: "offered" });

    const handIn = byId(compiled.campaign, "qf.delivery.hand-in");
    expect(handIn.trigger.allOf).toContainEqual({ kind: "hasItem", entityId: "pc.you", itemId: "item.parcel" });
    expect(handIn.effects).toContainEqual({ kind: "transferItem", itemId: "item.parcel", from: "pc.you", to: "npc.receiver" });
    expect(handIn.effects).toContainEqual({ kind: "setQuestState", questId: "quest.delivery", state: "complete" });
  });

  test("materializes inline quests only in compiled output", () => {
    const compiled = compileAuthoringLayer(
      world(),
      campaign({
        quests: [],
        questFlows: [
          {
            id: "inline",
            questId: "quest.inline",
            template: "investigation",
            quest: {
              id: "quest.author-typo",
              name: "Inline Quest",
              description: "Authored in the flow.",
              objectives: [{ id: "o1", description: "Notice the clue", done: false }],
            },
            offer: { locationId: "loc.start", npcId: "npc.giver", text: "A clue is offered." },
          },
        ],
      }),
    );

    expect(compiled.campaign.quests.map((q) => q.id)).toContain("quest.inline");
    expect(compiled.campaign.quests.map((q) => q.id)).not.toContain("quest.author-typo");
    expect(compiled.campaign.quests.find((q) => q.id === "quest.inline")).toMatchObject({
      name: "Inline Quest",
      state: "hidden",
    });
    expect(compiled.campaign.events.map((ev) => ev.id)).toContain("qf.inline.offer");
  });

  test("compiles action interactions into onCommand events with linkExit effects", () => {
    const compiled = compileAuthoringLayer(interactionPlayset().world, interactionPlayset().campaign);
    const interaction = byId(compiled.campaign, "li.loc.start.loose-stone");

    expect(interaction.when).toBe("onCommand");
    expect(interaction.trigger.allOf).toContainEqual({
      kind: "interactionUsed",
      locationId: "loc.start",
      interactionId: "loose-stone",
    });
    expect(interaction.effects).toContainEqual({ kind: "linkExit", fromLocationId: "loc.start", to: "loc.secret", name: "narrow stair" });
  });

  test("loader validates references against generated interaction output", () => {
    const raw = {
      world: world({
        locations: [
          {
            id: "loc.start",
            name: "Start",
            description: "",
            exits: [],
            npcs: [],
            interactions: [
              {
                id: "broken-reveal",
                kind: "exitReveal",
                mode: "action",
                text: "Broken.",
                revealExit: { to: "loc.missing" },
              },
            ],
          },
        ],
        npcs: [],
      }),
      campaign: campaign({ quests: [], startingState: { locationId: "loc.start", party: ["pc.you"], companions: [] } }),
    };

    expect(() => compileAndValidatePlaySet(raw)).toThrow(/linkExit target.*loc\.missing/);
  });

  test("reports content diagnostics for quest and map authoring gaps", () => {
    const diagnosticWorld = world({
      locations: [
        ...world().locations,
        { id: "loc.orphan", name: "Orphan", description: "", exits: [], npcs: [] },
      ],
      items: [...world().items, { id: "item.unsourced", name: "Unsourced", kind: "quest", description: "", properties: {} }],
    });
    const diagnosticCampaign = campaign({
      quests: [
        ...campaign().quests,
        {
          id: "quest.dangling",
          name: "Dangling Quest",
          description: "No offer or completion path.",
          state: "hidden",
          rewardCoins: 0,
          objectives: [{ id: "o1", description: "Never completed", done: false }],
        },
      ],
      events: [
        {
          id: "qf.old.generated",
          when: "onTick",
          trigger: { allOf: [] },
          effects: [],
          once: "campaign",
        },
        {
          id: "ev.duplicate",
          when: "onTick",
          trigger: { allOf: [] },
          effects: [],
          once: "campaign",
        },
        {
          id: "ev.duplicate",
          when: "onTick",
          trigger: { allOf: [] },
          effects: [],
          once: "campaign",
        },
      ],
      questFlows: [
        {
          ...deliveryFlow(),
          id: "absent-handin",
          handIn: {
            locationId: "loc.start",
            npcId: "npc.receiver",
            objectiveId: "o2",
            itemId: "item.parcel",
            text: "Receiver is not here.",
            conditions: [{ kind: "flag", key: "crossed_with_parcel", equals: true }],
            effects: [],
            once: "campaign",
          },
          stages: [
            ...deliveryFlow().stages,
            {
              id: "unsourced",
              text: "Needs an unsourced item.",
              conditions: [{ kind: "hasItem", entityId: "pc.you", itemId: "item.unsourced" }],
              effects: [],
              once: "campaign",
            },
          ],
        },
      ],
    });

    const codes = compileAuthoringLayer(diagnosticWorld, diagnosticCampaign).diagnostics.map((d) => d.code);
    expect(codes).toContain("reservedGeneratedEventId");
    expect(codes).toContain("duplicateEventId");
    expect(codes).toContain("hiddenQuestNoOffer");
    expect(codes).toContain("questNoCompletionBeat");
    expect(codes).toContain("objectiveNoCompletionBeat");
    expect(codes).toContain("handInNpcAbsent");
    expect(codes).toContain("questItemNoSource");
    expect(codes).toContain("orphanLocation");
  });
});

describe("location interaction runtime", () => {
  test("fires an authored onCommand interaction once, narrates, enqueues effects, and reveals an exit", async () => {
    const playset = interactionPlayset();
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(4),
    });
    const events: GameEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    events.length = 0;

    await engine.submitAction({ kind: "locationInteraction", interactionId: "loose-stone" });

    expect(engine.getState().flags.loose_stone_found).toBe(true);
    expect(byKind(events, "narration").some((e) => e.text.includes("stone swings inward"))).toBe(true);
    expect(byKind(events, "exitLinked")).toEqual([
      expect.objectContaining({ fromLocationId: "loc.start", to: "loc.secret", name: "narrow stair" }),
    ]);
    expect(playset.world.locations.find((l) => l.id === "loc.start")?.exits).toContainEqual(
      expect.objectContaining({ to: "loc.secret", name: "to narrow stair" }),
    );

    events.length = 0;
    await engine.submitAction({ kind: "locationInteraction", interactionId: "loose-stone" });
    expect(byKind(events, "narration").some((e) => e.text.includes("stone swings inward"))).toBe(false);
    expect(byKind(events, "exitLinked")).toEqual([]);
  });
});
