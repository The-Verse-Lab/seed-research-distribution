/**
 * Phantom addressee (r13) — speaking to a person the world has never had.
 *
 * The r13 sweep's regression driver: an NPC reply minted a findable person ("Corin", back rooms,
 * third door), the player addressed him, and the null-target dialogueToNpc branch handed the
 * narrator an unanswerable job — voice a person canon forbids inventing — which burned 45–141s of
 * retries into the content-free "— you speak, and the moment holds." six times in one sweep. The
 * classifier now confesses the spoken name (plan.targetName) and the engine answers the phantom
 * deterministically, the absent-branch shape: no model call, an honest boundary instead of a stub.
 *
 * Guards pinned here: a lowercase role/description ("the carter") keeps the narrator-roleplay
 * path; a place token is not a person; a name colliding with someone PRESENT is a near-miss the
 * narrator owns, never an absence line.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import { NpcTemplateSchema } from "../src/content/schema.ts";
import { loadExample, SEED } from "./support/harness.ts";

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

function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return {
    classify: async () => {
      const plan = plans[Math.min(i, plans.length - 1)] ?? planOf({});
      i += 1;
      return plan;
    },
  };
}

async function makeEngine(playset: PlaySet, classifier: TurnClassifier) {
  const engine = new GameEngine({
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    classifier,
    rng: mulberry32(SEED),
  });
  const events: GameEvent[] = [];
  engine.subscribe((event) => events.push(event));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

const narrationsOf = (events: GameEvent[]): string[] =>
  events.filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration").map((e) => e.text);

const PHANTOM_LINE_HEAD = "There is no sign of anyone called";

describe("phantom addressee — a minted name is answered honestly, deterministically", () => {
  test("addressing a person the world never had gets the deterministic absence line", async () => {
    const { engine, events } = await makeEngine(
      await loadExample(),
      scriptedClassifier([planOf({ kind: "dialogueToNpc", targetId: null, targetName: "Corin" })]),
    );
    await engine.submitPlayerInput("Corin, join me.");
    const prose = narrationsOf(events);
    expect(prose.some((t) => t.includes("There is no sign of anyone called Corin here."))).toBe(true);
  });

  test("a lowercase role/description is not a phantom — the narrator keeps the turn", async () => {
    const { engine, events } = await makeEngine(
      await loadExample(),
      scriptedClassifier([planOf({ kind: "dialogueToNpc", targetId: null, targetName: "carter" })]),
    );
    await engine.submitPlayerInput("the carter, which way to the square?");
    expect(narrationsOf(events).some((t) => t.includes(PHANTOM_LINE_HEAD))).toBe(false);
  });

  test("a place token cannot become a person", async () => {
    const { engine, events } = await makeEngine(
      await loadExample(),
      scriptedClassifier([planOf({ kind: "dialogueToNpc", targetId: null, targetName: "Emberford" })]),
    );
    await engine.submitPlayerInput("Emberford, hear me!");
    expect(narrationsOf(events).some((t) => t.includes(PHANTOM_LINE_HEAD))).toBe(false);
  });

  test("a name colliding with someone PRESENT is a near-miss, never an absence line", async () => {
    // Lyra Vane is a starting companion — present. "Lyra Jenkins" shares her token; the narrator,
    // who sees the whole scene, owns the correction.
    const { engine, events } = await makeEngine(
      await loadExample(),
      scriptedClassifier([planOf({ kind: "dialogueToNpc", targetId: null, targetName: "Lyra Jenkins" })]),
    );
    await engine.submitPlayerInput("Lyra Jenkins, report.");
    expect(narrationsOf(events).some((t) => t.includes(PHANTOM_LINE_HEAD))).toBe(false);
  });
});

describe("the no-false-findable-leads rail (r13 mint prevention)", () => {
  test("every NPC system prompt carries the rail: storytelling free, findable leads canon-only", () => {
    const template = NpcTemplateSchema.parse({
      id: "npc.sela",
      name: "Sela",
      summary: "a way-house keeper",
      persona: "Steady hands, stew always on.",
    });
    const prompt = new NpcAgent(new OfflineGateway(), template).buildSystemPrompt();
    expect(prompt).toContain("never direct anyone TO a named person, shop, or vendor");
    expect(prompt).toContain("a name you invent becomes a false trail");
    // The permission clause leads — the rail must not chill storytelling.
    expect(prompt).toContain("Tales, rumors, and people from your past or far away are yours to speak of freely.");
  });
});
