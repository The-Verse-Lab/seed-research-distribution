/**
 * Addressing someone who is not here (r5, playtest r4 P1).
 *
 * The r4 run PAID an NPC to arrange a meeting, was told in prose "she's here — three tables to
 * your left", sat down, addressed her, and got the content-free stub "The moment passes." The
 * cause is structural: `reconcilePlan` clamps `targetId` to PRESENT_ENTITIES, so a person the
 * player has only been TOLD about can never ground, and the turn falls to the generic branch.
 *
 * The engine now grounds the raw line against the AUTHORED roster instead and names the absence.
 * The whereabouts hint is what the PLAYER has witnessed (the sightings slice), never the NPC's
 * true schedule — no omniscience.
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
import { TURN_COSTS } from "../src/rules/costs.ts";

function buildPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.absent",
    name: "Two Rooms",
    summary: "A test world.",
    locations: [
      {
        id: "loc.taproom",
        name: "The Taproom",
        description: "A low room that smells of ash.",
        npcs: ["npc.brann"],
        exits: [{ to: "loc.far", name: "the stair up" }],
      },
      {
        id: "loc.far",
        name: "The Broken Crown",
        description: "A drinking hall across the city.",
        npcs: ["npc.sorrel"],
        exits: [{ to: "loc.taproom", name: "back down the stair" }],
      },
    ],
    npcs: [
      { id: "npc.brann", name: "Brann Coldwater", persona: "A fence and rumour-broker.", age: 44 },
      { id: "npc.sorrel", name: "Sorrel", persona: "A runaway watching the door.", age: 19 },
      // Rostered nowhere, and its first token is a location token — the two guards, in one row.
      { id: "npc.crowd", name: "Crown Shadow", persona: "A face in the crowd.", age: 30 },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.absent",
    name: "Test Campaign",
    worldId: "w.absent",
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 },
        age: 30,
      },
    ],
    startingState: { locationId: "loc.taproom", party: ["pc.you"] },
  });
  return { world, campaign };
}

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

async function run(plans: TurnPlan[], inputs: string[]): Promise<{ events: GameEvent[]; engine: GameEngine }> {
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
  return { events, engine };
}

const narrationText = (events: GameEvent[]): string =>
  events
    .filter((e) => e.kind === "narration")
    .map((e) => (e as { text: string }).text)
    .join("\n");

describe("addressing an absent person (r4 P1)", () => {
  test("naming an authored NPC who is elsewhere states the absence instead of shrugging", async () => {
    // targetId is null — exactly what the real classifier produces, because Sorrel is not in
    // PRESENT_ENTITIES and `reconcilePlan` clamps to that set.
    const { events } = await run(
      [plan({ kind: "dialogueToNpc", targetId: null })],
      ['I sit down across from her. "Sorrel. You brought the list to the Paper-Wife."'],
    );
    const text = narrationText(events);
    expect(text).toContain("There is no sign of Sorrel here.");
    expect(text).not.toContain("The moment passes.");
  });

  test("the absence beat costs a full dialogue beat, not a one-minute refusal", async () => {
    const { engine } = await run(
      [plan({ kind: "dialogueToNpc", targetId: null })],
      ['"Sorrel — over here."'],
    );
    // dialogueToNpc is priced at DEFAULT_TURN_MINUTES; a reach-miss is a beat, not a moment (r4).
    expect(engine.getState().clock).toBe(TURN_COSTS.dialogueToNpc.minutes);
  });

  test("speaking to the room names nobody and keeps the generic line", async () => {
    const { events } = await run(
      [plan({ kind: "dialogueToNpc", targetId: null })],
      ['"Is anyone minding this bar?"'],
    );
    expect(narrationText(events)).not.toContain("There is no sign of");
  });

  test("a PLACE token never binds a person — the Undercroft is not Undercroft Shadow", async () => {
    // Found live on SR: "go to the Undercroft and ask Brann" answered "There is no sign of
    // Undercroft Shadow here", because a crowd template's first token was also a location's.
    const { events } = await run(
      [plan({ kind: "dialogueToNpc", targetId: null })],
      ["Oda, go down to the Broken Crown and ask after the list."],
    );
    expect(narrationText(events)).not.toContain("There is no sign of");
  });

  test("a PRESENT name is never treated as absent", async () => {
    const { events } = await run(
      [plan({ kind: "dialogueToNpc", targetId: "npc.brann" })],
      ['"Brann. I need a name."'],
    );
    expect(narrationText(events)).not.toContain("There is no sign of");
  });
});
