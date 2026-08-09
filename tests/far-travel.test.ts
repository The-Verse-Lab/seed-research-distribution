/**
 * Far travel to KNOWN-OF places (r9 F-5's second face, caught live by the first auto-harness run:
 * a quest named Ashford, the classifier's movement plan couldn't ground it, and the old
 * visited-only reach gate refused a town two honest road-legs away — so the narrator walked an
 * imaginary road while the party stood still). Pins:
 *
 * - an UNVISITED but road-connected authored place quotes the journey, then walks it on
 *   confirmation — real legs, real minutes, never a mint;
 * - an UNVISITED place with NO open route reveals NOTHING (same cast-about beat as a place that
 *   does not exist — no "no known road to X" leak for secret rooms);
 * - `knownPlacesFor` feeds the classifier far referents: quest-named places, then visited ones,
 *   never the current room or its adjacent exits;
 * - the classifier user message carries KNOWN_PLACES omit-when-empty.
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
import { buildClassifyUserMessage } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import { knownPlacesFor } from "../src/engine/resolvers/movement.ts";
import type { WorldModel } from "../src/world/model.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
const NO_CHECK = { warranted: false, ability: null, skill: null, dc: null, reason: "" };

/** Gate ⇄ Bridge ⇄ Keep (open roads), plus a Crypt reachable only through a HIDDEN exit. */
function mkPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.far",
    name: "Farworld",
    summary: "A world of long honest roads.",
    locations: [
      {
        id: "loc.gate",
        name: "The Gate",
        description: "A toll gate.",
        exits: [{ to: "loc.bridge", name: "the long road to the bridge", locked: false, hidden: false, minutes: 60 }],
      },
      {
        id: "loc.bridge",
        name: "The Bridge",
        description: "A stone span.",
        exits: [
          { to: "loc.gate", name: "back to the gate", locked: false, hidden: false, minutes: 60 },
          { to: "loc.keep", name: "up to the keep", locked: false, hidden: false, minutes: 120 },
        ],
      },
      {
        id: "loc.keep",
        name: "The Keep",
        description: "A cold hall.",
        exits: [
          { to: "loc.bridge", name: "down to the bridge", locked: false, hidden: false, minutes: 120 },
          { to: "loc.crypt", name: "a concealed stair", locked: false, hidden: true, minutes: 10 },
        ],
      },
      { id: "loc.crypt", name: "The Crypt", description: "A secret dark.", exits: [] },
    ],
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.far",
    name: "Far Campaign",
    worldId: "w.far",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    quests: [
      {
        id: "quest.summons",
        name: "The Summons",
        description: "A writ calls you to The Keep, up past the bridge.",
        state: "offered",
      },
    ],
    startingState: { locationId: "loc.gate", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

const move = (destinationName: string): TurnPlan =>
  ({
    kind: "movement",
    targetId: null,
    destinationLocationId: null,
    destinationName,
    movementMiss: true,
    check: NO_CHECK,
    confidence: 1,
  }) as TurnPlan;

function scripted(plans: TurnPlan[]): TurnClassifier {
  return { classify: async () => plans.shift() ?? move("nowhere") };
}

async function start(plans: TurnPlan[]): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const engine = new GameEngine({
    playset: mkPlayset(),
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    classifier: scripted(plans),
    rng: mulberry32(11),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events };
}

describe("far travel — unvisited but road-connected", () => {
  test("names an UNVISITED keep: journey is quoted (no move), naming it again walks both legs", async () => {
    const { engine, events } = await start([move("The Keep"), move("The Keep")]);
    await engine.submitPlayerInput("head for the keep");
    expect(engine.getState().partyLocationId).toBe("loc.gate"); // quoted, not walked
    const quote = events.find((e) => e.kind === "stateChanged" && e.summary.includes("The road to The Keep"));
    expect(quote).toBeDefined(); // the deterministic receipt (r9 F-5)
    await engine.submitPlayerInput("the keep — let's go");
    expect(engine.getState().partyLocationId).toBe("loc.keep");
    expect(events.some((e) => e.kind === "stateChanged" && e.summary.includes("travels the known roads to The Keep"))).toBe(true);
  });

  test("an UNVISITED place behind a hidden exit reveals nothing — same beat as a place that does not exist", async () => {
    const { engine, events } = await start([move("The Crypt")]);
    await engine.submitPlayerInput("find the crypt");
    expect(engine.getState().partyLocationId).toBe("loc.gate");
    // No travel receipt, no "no known road to The Crypt" leak — the reach degrades to the generic
    // in-place beat exactly like a fabricated name would. The r14 degrade RECEIPT ("No way from
    // here leads to …") is allowed precisely because it is uniform: what must never appear is the
    // shape that confirms existence (a quoted road, a walked journey).
    const summaries = events
      .filter((e) => e.kind === "stateChanged")
      .map((e) => (e as { summary?: string }).summary ?? "");
    expect(summaries.some((s) => s.includes("The road to"))).toBe(false);
    expect(summaries.some((s) => s.includes("travels the known roads"))).toBe(false);

    // The differential pin — the actual no-reveal contract: the receipt for a hidden-but-real
    // place is BYTE-IDENTICAL (modulo the asked-for name) to the receipt for a place that has
    // never existed. Naming The Crypt teaches exactly as much as naming the moon palace: nothing.
    const receiptOf = (evts: GameEvent[]): string =>
      evts
        .filter((e) => e.kind === "stateChanged")
        .map((e) => (e as { summary?: string }).summary ?? "")
        .find((s) => s.includes("No way from here leads to")) ?? "";
    const cryptReceipt = receiptOf(events);
    expect(cryptReceipt).not.toBe("");
    const ghost = await start([move("the moon palace")]);
    await ghost.engine.submitPlayerInput("find the moon palace");
    const ghostReceipt = receiptOf(ghost.events);
    expect(ghostReceipt).not.toBe("");
    expect(cryptReceipt.replace("“The Crypt”", "“the moon palace”")).toBe(ghostReceipt);
  });
});

describe("movement with NO destination at all — the r14 silent branch", () => {
  test("a destination-less move leaves a receipt naming the real ways on", async () => {
    // fixture-combat t8 ("I keep walking west, letting the road unfold…"): the classifier carried no
    // destination name, and the no-destination branch stayed fully silent — the third leg of the
    // inert stretch. Same receipt discipline, reworded for the nameless ask.
    const bare: TurnPlan = {
      kind: "movement",
      targetId: null,
      destinationLocationId: null,
      check: NO_CHECK,
      confidence: 1,
    } as TurnPlan;
    const { engine, events } = await start([bare]);
    await engine.submitPlayerInput("I keep walking west, letting the road unfold beneath my boots.");
    expect(engine.getState().partyLocationId).toBe("loc.gate");
    const receipt = events.find(
      (e) => e.kind === "stateChanged" && (e as { summary?: string }).summary?.includes("No clear way onward"),
    );
    expect(receipt).toBeDefined();
    expect((receipt as { summary: string }).summary).toContain(
      "Ways on from here: the long road to the bridge",
    );
  });
});

describe("knownPlacesFor — the classifier's far referents", () => {
  test("quest-named places surface; current room and adjacent exits never do", async () => {
    const { engine } = await start([]);
    const model = (engine as unknown as { model: WorldModel }).model;
    const playset = mkPlayset();
    const places = knownPlacesFor(model, playset.world, playset.campaign);
    const ids = places.map((p) => p.id);
    expect(ids).toContain("loc.keep"); // named by the offered quest ("The Keep")
    expect(ids).not.toContain("loc.gate"); // where the party stands
    expect(ids).not.toContain("loc.bridge"); // adjacent — EXITS' job
    // The quest also says "the bridge" in lowercase prose, but the adjacent-exit exclusion wins.
  });

  test("visited places join after travel; the crypt (never visited, never quest-named) does not", async () => {
    const { engine } = await start([move("The Keep"), move("The Keep")]);
    await engine.submitPlayerInput("head for the keep");
    await engine.submitPlayerInput("the keep");
    const model = (engine as unknown as { model: WorldModel }).model;
    const playset = mkPlayset();
    const places = knownPlacesFor(model, playset.world, playset.campaign);
    const ids = places.map((p) => p.id);
    expect(ids).toContain("loc.gate"); // visited, no longer current
    expect(ids).not.toContain("loc.crypt");
  });
});

describe("KNOWN_PLACES prompt line", () => {
  const ctx = (over: Partial<ClassifierContext> = {}): ClassifierContext => ({
    playerActorId: "pc.you",
    locationId: "loc.gate",
    locationName: "The Gate",
    exits: [],
    presentEntities: [],
    companionIds: [],
    ...over,
  });

  test("present when knownPlaces is set, absent (byte-identical) otherwise", () => {
    const bare = buildClassifyUserMessage("I head for the keep", ctx());
    expect(bare).not.toContain("KNOWN_PLACES");
    const far = buildClassifyUserMessage("I head for the keep", ctx({ knownPlaces: [{ id: "loc.keep", name: "The Keep" }] }));
    expect(far).toContain("KNOWN_PLACES");
    expect(far).toContain("loc.keep=The Keep");
  });
});
