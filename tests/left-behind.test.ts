/**
 * Left-behind notice (Phase 4, playtest #8) — when the party departs and an NPC the player was JUST
 * addressing never joined the party, they are silently left at the origin. The engine appends a brief
 * "stays behind" note to the travel narration (which the offline narrator echoes), so a would-be
 * companion doesn't just vanish from the prose. A departure with no just-addressed non-member adds
 * nothing. Driven with a sequenced STUB classifier so the intents are exact.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { GameEvent } from "../src/events/types.ts";

function buildPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.leftbehind",
    name: "Two Rooms",
    summary: "A test world.",
    locations: [
      {
        id: "loc.a",
        name: "The Commons",
        description: "A common room.",
        npcs: ["npc.oda"],
        exits: [{ to: "loc.b", name: "the road north" }],
      },
      { id: "loc.b", name: "The Road", description: "A road.", exits: [{ to: "loc.a", name: "back to the commons" }] },
    ],
    npcs: [{ id: "npc.oda", name: "Oda", persona: "A wary sellsword.", age: 35, autonomy: { isPartyMember: false, level: "passive" } }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.leftbehind",
    name: "Test Campaign",
    worldId: "w.leftbehind",
    characters: [{ id: "pc.you", name: "You", stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 }, age: 30 }],
    startingState: { locationId: "loc.a", party: ["pc.you"] },
  });
  return { world, campaign };
}

/** A classifier that serves the Nth plan on the Nth call (the last plan repeats). */
function seqClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)]!) };
}

const plan = (over: Partial<TurnPlan>): TurnPlan =>
  ({
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 0.9,
    ...over,
  }) as TurnPlan;

async function run(plans: TurnPlan[], inputs: string[]): Promise<GameEvent[]> {
  const engine = new GameEngine({
    classifier: seqClassifier(plans),
    playset: buildPlayset(),
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  for (const input of inputs) await engine.submitPlayerInput(input);
  return events;
}

const narrationText = (events: GameEvent[]): string =>
  events.filter((e) => e.kind === "narration").map((e) => (e as { text: string }).text).join("\n");

describe("left-behind notice (playtest #8)", () => {
  test("addressing a present non-member then travelling notes that they stay behind", async () => {
    const events = await run(
      [plan({ kind: "dialogueToNpc", targetId: "npc.oda" }), plan({ kind: "movement", destinationLocationId: "loc.b" })],
      ["Oda, will you help me?", "I head north to the road."],
    );
    expect(narrationText(events)).toContain("Oda stays behind");
  });

  test("travelling WITHOUT a just-addressed non-member adds no notice", async () => {
    const events = await run(
      [plan({ kind: "freeformNarrative" }), plan({ kind: "movement", destinationLocationId: "loc.b" })],
      ["I look around the commons.", "I head north to the road."],
    );
    expect(narrationText(events)).not.toContain("stays behind");
  });
});
