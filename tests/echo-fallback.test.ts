/**
 * Blank-narrator echo fallback (T7) — a freeform turn whose trigger IS the raw player input must
 * degrade to the neutral `echoFallback` line when the narrator comes back empty, never parrot the
 * player's own words back as narration. Engine-authored triggers keep their stripped-prose echo.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { freeformClassifier } from "../src/engine/classify.ts";
import { NARRATOR_HICCUP_LINE } from "../src/modules/narrate.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

function buildPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.echo",
    name: "Echoworld",
    summary: "A quiet world for waiting in.",
    locations: [{ id: "loc.hub", name: "The Hub", description: "A crossroads.", exits: [] }],
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.echo",
    name: "Echo Campaign",
    worldId: "w.echo",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.hub", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

/** A gateway whose every completion is BLANK — the transient empty-narrator failure, post-rescue. */
const blankGateway = {
  complete: async () => ({ text: "" }),
  // eslint-disable-next-line require-yield
  stream: async function* (): AsyncGenerator<never> {
    return;
  },
  embed: async () => ({ embeddings: [] }),
} as unknown as LlmGateway;

describe("blank-narrator echo fallback (T7)", () => {
  test("a passive freeform line degrades to the neutral line, never the raw input", async () => {
    const engine = new GameEngine({
      playset: buildPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: blankGateway,
      classifier: freeformClassifier,
      rng: mulberry32(9),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    const input = "I wait, and hold perfectly still, watching the crossroads.";
    await engine.submitPlayerInput(input);

    const narrations = events.filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration");
    expect(narrations.length).toBeGreaterThan(0);
    const text = narrations.at(-1)!.text;
    // r10 F-6: a player turn the narrator answered with NOTHING says the world hiccuped — honestly,
    // never the four-word shrug and never the raw input parroted back.
    expect(text).toBe(NARRATOR_HICCUP_LINE);
    expect(text).not.toContain("watching the crossroads");
    expect(
      events.some((e) => e.kind === "system" && (e as { code?: string }).code === "narrator-empty"),
    ).toBe(true);
  });

  test("a blank narrator on a CHECK turn reports the outcome, never the player's own sentence (r4 P2)", async () => {
    const input = "I read all three documents side by side, looking for the thread that ties them.";
    const classifier = {
      classify: async () =>
        ({
          kind: "attemptRequiringCheck",
          targetId: null,
          destinationLocationId: null,
          check: { warranted: true, ability: "int", skill: "Investigation", dc: 13, reason: "cross-reference" },
          confidence: 1,
        }) as never,
    };
    const engine = new GameEngine({
      playset: buildPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: blankGateway,
      classifier,
      rng: mulberry32(9),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput(input);

    const narrations = events.filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration");
    const text = narrations.at(-1)!.text;
    // The r4 playtest's worst deduction turn: a SUCCESS degraded to an echo of the player's own
    // sentence and read as "the roll found nothing". The floor now states the outcome + verdict.
    expect(text).not.toContain("side by side");
    expect(text).toMatch(/It works|It fails/);
    expect(text).toContain("vs DC 13");
  });
});

describe("dialogue-turn echo carries the player's words (r3 P3)", () => {
  test("a blank narrator on an unaddressed spoken line quotes the words instead of a bare stub", async () => {
    const spoken = "We had a deal, and I mean to see it kept.";
    const classifier = {
      classify: async () =>
        ({
          kind: "dialogueToNpc",
          targetId: null,
          destinationLocationId: null,
          check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
          confidence: 1,
        }) as never,
    };
    const engine = new GameEngine({
      playset: buildPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: blankGateway,
      classifier,
      rng: mulberry32(9),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput(spoken);

    const narrations = events.filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration");
    const text = narrations.at(-1)?.text ?? "";
    // The turn is no longer a total loss: the spoken line stands, quoted as the player's own.
    expect(text).toContain(`"${spoken}"`);
    expect(text).toContain("the moment holds");
  });
});
